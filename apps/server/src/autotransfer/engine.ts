// The auto transfer engine (docs/prd/auto-transfer.md §7 to §9): it listens to the chat controller's events (no edit in the controller),
// notices a turn boundary (a main-thread `result`, then the chat back at `idle`), queues the chat, and evaluates it off the event path, one
// at a time per chat (a burst of boundaries is one evaluation). The decision is `decide()`; this file gathers its inputs and acts on it:
// a card, a warning, a wait, or a move through the Move flow (`switchClaude`), each with its trail (an `autotransfer_events` row, a platform
// audit row, a notification through the bus). It also notices an Undo (the chat back on the Claude it left) and pauses that chat.
//
// It acts for the chat's OWNER (PLAN-10): the owner's settings, the owner's Claudes (`can(owner, 'operate', claude)`), and the owner must
// still be an enabled user who may operate the chat; it re-checks that every time it runs (a job acts as the user and re-checks `can`).

import {
  AUTO_CONSTANTS,
  type AutoClaudeRef,
  type AutoEngineState,
  type AutoFacts,
  type AutoMode,
  type AutoReason,
  type AutoRefusal,
  type AutoSessionState,
  type AutoTransferEvent,
  type AutoTransferSettings,
  CHAT_FOLDER_UNTRUSTED,
  type ChatServerMessage,
  type ChatSession,
  type ClaudeUsage,
} from '@portal/contracts';
import { AppError } from '@isnanme/core';
import type { AuditInput } from '../platform/audit.js';
import type { NotifyBus } from '../notify/bus.js';
import { decide, effectiveMode, leftFor, modelFamily, sourceReading, type DecideCounters, type Decision } from './decide.js';
import type { ChatPort, ClockPort, OwnerPort, UsagePort } from './ports.js';
import { effectiveSettings, platformSettings, type AutoSettingsReader } from './settings.js';
import type { AutoStore, SessionRow, StoredSuggestion } from './store.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** The actor of everything the engine does by itself. */
export const ENGINE_ACTOR = 'portal:autotransfer';
/** A deferred move is looked at again this often. */
const RECHECK_MS = 60_000;
/** Every chat at or under the threshold, waiting or working, is looked at again this often (T-105): the tick, jittered up to 20 s. */
const TICK_MS = AUTO_CONSTANTS.waitRecheckMin * MIN;
const JITTER_MS = 20_000;
/** A new usage reading asks for a tick too (T-105 item 2): a burst of readings is one tick, and never sooner than this after the last one. */
const REFRESH_DEBOUNCE_MS = 5_000;
const REFRESH_MIN_GAP_MS = 30_000;
/** The refusals that make a chat at or under the threshold wait for quota rather than give up (T-105 R3). */
const WAIT_CODES: ReadonlySet<string> = new Set(['no_destination', 'destination_busy', 'session_cap', 'day_cap', 'paused']);
/** What the engine says to a chat (fixed text over names and numbers; never anyone else's words). */
const STEER_TEXT = (claude: string, leftPct: number, to: string) =>
  `Your Claude (${claude}) is at ${leftPct}% left: finish the current step, commit and push your work, then stop. The portal moves this chat to ${to} and you continue there.`;
const CONTINUE_TEXT = (to: string, why: 'exhausted' | 'steered') =>
  `Moved to ${to} by the portal (${why === 'exhausted' ? 'the Claude you were on ran out of quota' : 'as announced'}). Continue where you stopped.`;

export interface EngineDeps {
  chat: ChatPort;
  usage: UsagePort;
  owner: OwnerPort;
  clock: ClockPort;
  store: AutoStore;
  settings: AutoSettingsReader | null;
  bus: Pick<NotifyBus, 'emit'> | null;
  audit: { record(e: AuditInput): void } | null;
  publish: () => void;
}

interface Inputs {
  s: ChatSession;
  ownerId: string;
  platform: AutoTransferSettings;
  settings: AutoTransferSettings;
  row: SessionRow | null;
  mode: AutoMode;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export class AutoTransferEngine {
  readonly #d: EngineDeps;
  #off: (() => void) | null = null;
  /** Chats that ended a main-thread turn and wait to be back at `idle`. */
  readonly #boundary = new Set<string>();
  /** Per chat: an evaluation running, and whether another was asked for meanwhile. */
  readonly #queue = new Map<string, { again: boolean }>();
  readonly #timers = new Map<string, () => void>();
  /** Moves this engine is making: chat → destination (counted on the destination; their session changes are not an Undo). */
  readonly #inflight = new Map<string, string>();
  /** Chats with an automatic move in the last day: watched for an Undo. */
  readonly #moved = new Set<string>();
  /** Chats with an open card: closed when the chat ends or moves. */
  readonly #cards = new Set<string>();
  /** The last evaluation of each chat, for tests and the state route. */
  readonly last = new Map<string, Decision>();
  #sweep: (() => void) | null = null;
  #tick: (() => void) | null = null;
  #offUsage: (() => void) | null = null;
  #refresh: (() => void) | null = null;
  #lastTickMs = Number.NEGATIVE_INFINITY;
  #ticking = false;
  #idle: Promise<void> = Promise.resolve();

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  start(): void {
    if (this.#off) return;
    const now = this.#d.clock.now();
    for (const id of this.#d.store.recentlyMoved(now - DAY)) this.#moved.add(id);
    for (const p of this.#d.store.pending()) this.#wake(p.sessionId, Math.max(0, ms(p.at) - now));
    this.#off = this.#d.chat.onEvent((id, msg) => this.#onChat(id, msg));
    const sweep = () => {
      this.#d.store.sweep();
      this.#sweep = this.#d.clock.timer(6 * 60 * MIN, sweep);
    };
    sweep();
    const tick = () => {
      this.#tick = this.#d.clock.timer(TICK_MS + Math.random() * JITTER_MS, tick);
      void this.tick().catch((e: unknown) => console.error(`[autotransfer] tick failed: ${(e as Error).message}`));
    };
    this.#tick = this.#d.clock.timer(TICK_MS + Math.random() * JITTER_MS, tick);
    this.#offUsage = this.#d.usage.onReading?.(() => this.usageRefreshed()) ?? null;
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
    this.#sweep?.();
    this.#tick?.();
    this.#tick = null;
    this.#offUsage?.();
    this.#offUsage = null;
    this.#refresh?.();
    this.#refresh = null;
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
  }

  /** Resolves when no evaluation is queued or running (tests). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await this.#idle;
      await new Promise((r) => setImmediate(r));
      if (!this.#queue.size && !this.#inflight.size) return;
    }
  }

  /* ---------- the event path: notice, queue, never act here ---------- */

  #onChat(id: string, msg: ChatServerMessage): void {
    try {
      if (msg.type === 'events') {
        if (msg.items.some((e) => e.kind === 'result' && !e.agentLabel)) {
          this.#boundary.add(id);
          if (this.#d.chat.get(id)?.state === 'idle') this.#boundaryReached(id);
        }
      } else if (msg.type === 'session') {
        const s = msg.session;
        this.#watch(s);
        if (this.#boundary.has(id) && s.state === 'idle' && !s.switching) this.#boundaryReached(id);
      } else if (msg.type === 'removed') {
        this.#forget(id);
      }
    } catch (e) {
      console.error(`[autotransfer] ${(e as Error).message}`);
    }
  }

  #boundaryReached(id: string): void {
    this.#boundary.delete(id);
    this.enqueue(id);
  }

  #forget(id: string): void {
    this.#boundary.delete(id);
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    this.#moved.delete(id);
    this.#cards.delete(id);
  }

  /** Asks for an evaluation of a chat; a burst is one evaluation. */
  enqueue(id: string): void {
    const q = this.#queue.get(id);
    if (q) {
      q.again = true;
      return;
    }
    const entry = { again: false };
    this.#queue.set(id, entry);
    const run = async () => {
      do {
        entry.again = false;
        try {
          await this.evaluate(id);
        } catch (e) {
          console.error(`[autotransfer] evaluation of a chat failed: ${(e as Error).message}`);
        }
      } while (entry.again);
      this.#queue.delete(id);
    };
    this.#idle = this.#idle.then(() => undefined, () => undefined).then(() => new Promise<void>((r) => setImmediate(() => run().then(r, r))));
  }

  /** Re-evaluates a chat after `delay` (a pause ending, a deferral's next look). One timer per chat. */
  #wake(id: string, delay: number): void {
    this.#timers.get(id)?.();
    this.#timers.set(
      id,
      this.#d.clock.timer(delay, () => {
        this.#timers.delete(id);
        this.enqueue(id);
      }),
    );
  }

  /** A chat's state changed: an Undo, a move by a person, an end, a card to close. */
  #watch(s: ChatSession): void {
    if (this.#inflight.has(s.id) || s.switching) return;
    if (s.state === 'ended') {
      if (this.#cards.has(s.id)) this.#closeCard(s.id, 'expired');
      const row = this.#d.store.session(s.id);
      if (row?.waitingSince || row?.steeredPeriod) this.#d.store.patchSession(s.id, row.ownerId, { waitingSince: null, waitingCode: null, steeredPeriod: null });
      this.#forget(s.id);
      return;
    }
    if (this.#cards.has(s.id)) {
      const open = this.#d.store.openSuggestion(s.id);
      if (!open) this.#cards.delete(s.id);
      else if (open.from.id !== s.claudeId) this.#closeCard(s.id, 'superseded');
    }
    if (!this.#moved.has(s.id)) return;
    const now = this.#d.clock.now();
    const [last] = this.#d.store.sessionEvents(s.id, now - DAY, ['moved', 'undone']);
    if (!last || last.kind !== 'moved') {
      this.#moved.delete(s.id);
      return;
    }
    if (last.to?.id === s.claudeId) return;
    this.#moved.delete(s.id);
    if (last.from?.id !== s.claudeId) return; // moved on elsewhere by a person: not an Undo
    // The chat is back on the Claude it left within a day: an Undo. No move by itself for 2 hours.
    const until = now + AUTO_CONSTANTS.undoPauseMin * MIN;
    this.#d.store.patchSession(s.id, last.userId, { pausedUntil: iso(until), lastClaudeId: s.claudeId, deferSince: null });
    this.#record({ ...this.#base(s, last.userId, last.mode), kind: 'undone', from: last.to, to: last.from, handoffId: last.handoffId, actor: 'ui' }, 'info');
    this.#wake(s.id, until - now);
    this.#d.publish();
  }

  /* ---------- the tick (T-105): not only at a turn boundary ---------- */

  /**
   * Every chat whose source is at or under the threshold (working or idle), and every chat waiting for quota, is evaluated again: a long
   * turn crosses the threshold without a boundary, and a chat with nowhere to go has no next boundary at all. One usage report per owner
   * (the monitor's snapshot, never a probe). Off when the platform's mode is off.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#tickOnce();
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * The usage monitor has a new reading (a probe, a chat's live `rate_limit_info`): a tick soon, so a chat crossing the threshold mid-turn
   * is steered within seconds rather than at the next 2-minute tick. Cheap: a burst is one tick, at most one every 30 s, none while one runs.
   */
  usageRefreshed(): void {
    if (this.#refresh || !this.#off) return;
    const delay = Math.max(REFRESH_DEBOUNCE_MS, this.#lastTickMs + REFRESH_MIN_GAP_MS - this.#d.clock.now());
    this.#refresh = this.#d.clock.timer(delay, () => {
      this.#refresh = null;
      void this.tick().catch((e: unknown) => console.error(`[autotransfer] tick failed: ${(e as Error).message}`));
    });
  }

  async #tickOnce(): Promise<void> {
    const platform = platformSettings(this.#d.settings);
    if (platform.mode === 'off') return;
    const now = this.#d.clock.now();
    this.#lastTickMs = now;
    const reports = new Map<string, Promise<ClaudeUsage[]>>();
    for (const s of this.#d.chat.list()) {
      if (s.state === 'ended' || s.process === 'gone' || this.#inflight.has(s.id) || s.switching) continue;
      const ownerId = this.#ownerOf(s.id);
      if (!ownerId) continue;
      const prefs = this.#d.store.prefs(ownerId);
      const row = this.#d.store.session(s.id);
      if (effectiveMode(platform.mode, prefs.mode, row?.mode ?? null) === 'off') continue;
      if (row?.waitingSince) {
        this.enqueue(s.id);
        continue;
      }
      let report = reports.get(ownerId);
      if (!report) {
        report = this.#d.usage.report({ actorId: ownerId }).then((r) => r.claudes);
        reports.set(ownerId, report);
      }
      const claudes = await report.catch(() => [] as ClaudeUsage[]);
      const src = claudes.find((c) => c.claudeId === s.claudeId);
      if (!src || src.runsOn !== 'plan' || !src.checkedAt) continue;
      const settings = effectiveSettings(platform, prefs);
      const threshold = this.#d.store.claude(ownerId, s.claudeId).thresholdPct ?? settings.thresholdPct;
      const reading = sourceReading(src, s.model, threshold, settings.useProjection, now);
      if (reading?.reason) this.enqueue(s.id);
    }
  }

  /* ---------- the evaluation ---------- */

  #ownerOf(sessionId: string): string | null {
    return this.#d.owner.ownersOf({ type: 'session', id: sessionId })[0] ?? null;
  }

  #counters(s: ChatSession, ownerId: string, row: { pausedUntil: string | null; deferSince: string | null } | null): DecideCounters {
    const now = this.#d.clock.now();
    const ev = this.#d.store.sessionEvents(s.id, now - DAY, ['moved', 'failed']);
    const moved = ev.filter((e) => e.kind === 'moved');
    // The caps count only moves that were not forced by an exhausted source (T-105 item 4); the pause and the ping-pong guard see them all.
    const counted = moved.filter((e) => e.reason !== 'exhausted');
    return {
      pausedUntilMs: row?.pausedUntil ? ms(row.pausedUntil) : null,
      lastMoveMs: moved.length ? Math.max(...moved.map((e) => ms(e.at))) : null,
      movesSession24h: counted.length,
      movesOwner24h: this.#d.store.countOwner(ownerId, 'moved', now - DAY, 'exhausted'),
      failures24h: ev.filter((e) => e.kind === 'failed' && e.actor === ENGINE_ACTOR).length,
      deferSinceMs: row?.deferSince ? ms(row.deferSince) : null,
      left: moved
        .filter((e) => e.from && now - ms(e.at) < AUTO_CONSTANTS.pingPongMin * MIN)
        .map((e) => ({ claudeId: e.from!.id, atMs: ms(e.at), resetsAtMs: e.facts?.resetsAt.value ? ms(e.facts.resetsAt.value) : null })),
    };
  }

  #load(workspaceId: string, self: string) {
    const sessions = this.#d.chat.list({ workspaceId });
    return (claudeId: string) =>
      sessions.filter((x) => x.id !== self && x.claudeId === claudeId && x.state !== 'ended' && x.process === 'live' && !x.archivedAt).length +
      [...this.#inflight.entries()].filter(([sid, to]) => sid !== self && to === claudeId).length;
  }

  /** Everything `decide` needs for a chat, or null when the chat is gone or has no owner. */
  async #inputs(id: string): Promise<Inputs | null> {
    const s = this.#d.chat.get(id);
    if (!s || s.state === 'ended') return null;
    const ownerId = this.#ownerOf(id);
    if (!ownerId) return null;
    const platform = platformSettings(this.#d.settings);
    const prefs = this.#d.store.prefs(ownerId);
    const settings = effectiveSettings(platform, prefs);
    const row = this.#d.store.session(id);
    const mode = effectiveMode(platform.mode, prefs.mode, row?.mode ?? null);
    return { s, ownerId, platform, settings, row, mode };
  }

  async #decide(x: Inputs, withOptions: boolean) {
    const { s, ownerId, settings, row, mode } = x;
    const now = this.#d.clock.now();
    const claudes = (await this.#d.usage.report({ actorId: ownerId })).claudes;
    const pooled = claudes.find((c) => c.claudeId === s.claudeId)?.runsOn === 'pool';
    const own = this.#d.owner;
    const ownerOk = own.userEnabled(ownerId) && own.can(ownerId, 'operate', { type: 'session', id: s.id, workspaceId: s.workspaceId });
    const cfg = this.#d.store.claude(ownerId, s.claudeId);
    const base = {
      nowMs: now,
      mode,
      settings,
      claudeThresholdPct: cfg.thresholdPct,
      destinations: cfg.destinations,
      session: s,
      pooled,
      claudes,
      ownerOk,
      allow: (claudeId: string) => own.can(ownerId, 'operate', { type: 'claude', id: claudeId, workspaceId: s.workspaceId }),
      options: null,
      load: this.#load(s.workspaceId, s.id),
      counters: this.#counters(s, ownerId, row),
      recommend: this.#d.usage.recommend,
    };
    let d = decide(base);
    // The Move flow's check runs commands in the workspace: asked only once the cheap steps (1 to 6) have passed.
    if (withOptions && d.act !== 'none') {
      const options = await this.#d.chat.switchOptions(s.id).catch(() => null);
      d = decide({ ...base, options });
    }
    return { d, claudes };
  }

  /** Evaluates one chat now (the queue calls this; tests too). */
  async evaluate(id: string): Promise<Decision | null> {
    const x = await this.#inputs(id);
    if (!x) return null;
    const { s, ownerId, settings, mode } = x;
    if (mode === 'off') {
      if (this.#cards.has(id) || this.#d.store.openSuggestion(id)) this.#closeCard(id, 'expired');
      if (this.#d.store.session(id)?.waitingSince) this.#d.store.patchSession(id, ownerId, { waitingSince: null, waitingCode: null });
      return null;
    }
    if (this.#inflight.has(id)) return null;
    const { d, claudes } = await this.#decide(x, true);
    this.last.set(id, d);
    const now = this.#d.clock.now();
    const row = this.#d.store.patchSession(id, ownerId, { lastEvalAt: iso(now), lastClaudeId: s.claudeId });
    const ctx = { s, ownerId, mode };
    // Waiting for quota (T-105 R3): nothing can take the chat while its source is at or under the threshold. Said once (the `waiting` row,
    // alongside the warning or refusal below), then looked at again by the tick until a destination passes, the source recovers, the
    // chat ends or the mode goes off; the state shows on the chat. `resumed` closes it.
    const low = d.reading?.reason != null;
    const holds = low && (d.act === 'warn' || (d.act === 'none' && WAIT_CODES.has(d.code)));
    if (holds && !row.waitingSince) {
      const code = d.act === 'warn' ? d.code : (d as { code: AutoRefusal }).code;
      this.#d.store.patchSession(id, ownerId, { waitingSince: iso(now), waitingCode: code });
      this.#record({ ...this.#base(s, ownerId, mode), kind: 'waiting', reason: d.reading!.reason, facts: { ...d.reading!.facts, ...this.#nextFreeFacts(s, claudes, settings.thresholdPct, now) }, code }, 'medium');
    } else if (!holds && row.waitingSince && (d.act === 'move' || d.act === 'suggest' || d.act === 'wait' || (d.act === 'none' && d.code === 'above_threshold'))) {
      this.#d.store.patchSession(id, ownerId, { waitingSince: null, waitingCode: null });
      this.#record({ ...this.#base(s, ownerId, mode), kind: 'resumed', reason: d.reading?.reason ?? null, facts: d.reading?.facts ?? null, to: d.act === 'move' || d.act === 'wait' || d.act === 'suggest' ? d.to : null, code: d.act === 'none' ? d.code : null }, 'info');
    }
    switch (d.act) {
      case 'none': {
        if (d.code === 'above_threshold' || d.code === 'stale_reading' || d.code === 'pooled' || d.code === 'no_plan_reading' || d.code === 'owner_denied') {
          // The source recovered (or can no longer be judged): an open card closes, a waiting move stops waiting.
          if (this.#d.store.openSuggestion(id)) this.#closeCard(id, 'expired');
          if (row.deferSince) this.#d.store.patchSession(id, ownerId, { deferSince: null });
        }
        if (d.code === 'session_cap' || d.code === 'day_cap' || d.code === 'owner_denied') {
          const key = `${d.code}|${s.claudeId}|${d.reading?.window.resetsAt ?? ''}`;
          if (row.refusedKey !== key) {
            this.#d.store.patchSession(id, ownerId, { refusedKey: key });
            this.#record({ ...this.#base(s, ownerId, mode), kind: 'refused', reason: d.reading?.reason ?? null, facts: d.reading?.facts ?? null, code: d.code }, 'medium');
          }
        }
        if (d.code === 'paused' && row.pausedUntil && ms(row.pausedUntil) > now) this.#wake(id, ms(row.pausedUntil) - now);
        break;
      }
      case 'warn': {
        if (this.#d.store.openSuggestion(id)) this.#closeCard(id, 'superseded');
        if (row.warnedPeriod !== d.period) {
          this.#d.store.patchSession(id, ownerId, { warnedPeriod: d.period, deferSince: null });
          this.#record({ ...this.#base(s, ownerId, mode), kind: 'warned', reason: d.reading.reason, facts: d.reading.facts, code: d.code }, 'medium');
          this.#notify(s, ownerId, { warned: true, leftPct: d.reading.leftPct });
        }
        break;
      }
      case 'suggest':
        this.#suggest(ctx, d);
        if (d.why === 'deferred') this.#d.store.patchSession(id, ownerId, { deferSince: null });
        break;
      case 'wait': {
        if (!row.deferSince) {
          this.#d.store.patchSession(id, ownerId, { deferSince: iso(now) });
          this.#record({ ...this.#base(s, ownerId, mode), kind: 'deferred', reason: d.reason, from: this.#from(s), to: d.to, facts: d.facts, code: 'busy' }, 'info');
        }
        // A turn runs (T-105 item 2): the chat is told once per source window period to finish its step and stop; the move comes at the boundary.
        if (s.state === 'working' && row.steeredPeriod !== d.period) await this.#steer(s, ownerId, mode, d, settings.dryRun);
        this.#wake(id, RECHECK_MS);
        break;
      }
      case 'move':
        await this.#move(s, ownerId, { to: d.to, handoff: d.handoff, reason: d.reason, facts: d.facts, mode, settings, actor: ENGINE_ACTOR, auto: true, steered: row.steeredPeriod !== null });
        break;
    }
    this.#d.publish();
    return d;
  }

  /** The steer (T-105 item 2): one message, priority next, as the portal; recorded as `steered`, remembered per period. Dry run: recorded only. */
  async #steer(s: ChatSession, ownerId: string, mode: AutoMode, d: Extract<Decision, { act: 'wait' }>, dryRun: boolean): Promise<void> {
    const base = { ...this.#base(s, ownerId, mode), reason: d.reason, to: d.to, facts: d.facts, code: 'busy' as const };
    this.#d.store.patchSession(s.id, ownerId, { steeredPeriod: d.period });
    if (dryRun) {
      this.#record({ ...base, kind: 'dry_run', actor: `${ENGINE_ACTOR}:steer` }, 'info');
      return;
    }
    try {
      await this.#d.chat.send(s.id, STEER_TEXT(s.claudeName ?? 'Claude', d.reading.leftPct, d.to.name), { priority: 'next', actor: ENGINE_ACTOR, actorLabel: 'Auto move' });
      this.#record({ ...base, kind: 'steered' }, 'info');
    } catch (e) {
      this.#d.store.patchSession(s.id, ownerId, { steeredPeriod: null });
      console.error(`[autotransfer] could not tell a chat to stop: ${(e as Error).message}`);
    }
  }

  /** The soonest moment a delegated Claude or the source frees up for this chat: the earliest reset among their binding windows at or under the threshold. */
  #nextFreeAt(s: ChatSession, claudes: ClaudeUsage[], thresholdPct: number, now: number): string | null {
    const family = modelFamily(s.model);
    let best: number | null = null;
    for (const c of claudes) {
      if (c.runsOn !== 'plan' || c.workspaceId !== s.workspaceId) continue;
      const left = leftFor(c, family, now);
      if (left === null || left > thresholdPct) continue;
      for (const w of c.windows) {
        if (!w.resetsAt || w.usedPct === null) continue;
        const at = ms(w.resetsAt);
        if (Number.isFinite(at) && at > now && (best === null || at < best)) best = at;
      }
    }
    return best === null ? null : iso(best);
  }

  #nextFreeFacts(s: ChatSession, claudes: ClaudeUsage[], thresholdPct: number, now: number): Partial<AutoFacts> {
    const at = this.#nextFreeAt(s, claudes, thresholdPct, now);
    return at ? { etaAt: { value: at, basis: 'measured' } as AutoFacts['etaAt'] } : {};
  }

  #from(s: ChatSession): AutoClaudeRef {
    return { id: s.claudeId, name: s.claudeName ?? 'Claude' };
  }

  #base(s: ChatSession, ownerId: string, mode: AutoMode): Omit<AutoTransferEvent, 'id' | 'at' | 'kind' | 'actor'> & { actor: string } {
    return { userId: ownerId, sessionId: s.id, workspaceId: s.workspaceId, mode, reason: null, from: this.#from(s), to: null, facts: null, handoff: null, handoffId: null, code: null, actor: ENGINE_ACTOR };
  }

  /** One trail row and one platform audit row (names, ids, numbers, codes: never message text). */
  #record(e: Omit<AutoTransferEvent, 'id' | 'at'>, severity: AuditInput['severity']): AutoTransferEvent {
    const row = this.#d.store.addEvent(e);
    this.#d.audit?.record({
      kind: `autotransfer.${e.kind}`,
      severity,
      actor: e.actor,
      userId: e.userId,
      subject: `session:${e.sessionId}`,
      detail: {
        workspace: e.workspaceId,
        mode: e.mode,
        reason: e.reason,
        from: e.from?.id ?? null,
        fromName: e.from?.name ?? null,
        to: e.to?.id ?? null,
        toName: e.to?.name ?? null,
        leftPct: e.facts?.leftPct.value ?? null,
        leftBasis: e.facts?.leftPct.basis ?? null,
        thresholdPct: e.facts?.thresholdPct ?? null,
        destLeftPct: e.facts?.destLeftPct?.value ?? null,
        etaAt: e.facts?.etaAt?.value ?? null,
        handoff: e.handoff,
        handoffId: e.handoffId,
        code: e.code,
      },
    });
    return row;
  }

  /** The `auto_move` notification: fixed text over names and numbers (notify/templates.ts). */
  #notify(s: ChatSession, ownerId: string, f: { to?: string; suggested?: boolean; warned?: boolean; blocked?: 'trust'; leftPct: number }): void {
    const ws = s.workspaceId.includes('/') ? s.workspaceId.slice(s.workspaceId.indexOf('/') + 1) : s.workspaceId;
    this.#d.bus?.emit({
      kind: 'auto_move',
      subject: { type: 'session', id: s.id, workspaceId: s.workspaceId },
      facts: { workspace: ws, leftPct: f.leftPct, ...(f.to ? { to: f.to } : {}), ...(f.suggested ? { suggested: true } : {}), ...(f.warned ? { warned: true } : {}), ...(f.blocked ? { blocked: f.blocked } : {}) },
      audience: [ownerId],
    });
  }

  #closeCard(id: string, state: 'expired' | 'superseded' | 'moved'): void {
    const open = this.#d.store.openSuggestion(id);
    if (open) this.#d.store.closeSuggestion(open.id, state);
    this.#cards.delete(id);
    this.#d.publish();
  }

  #suggest(ctx: { s: ChatSession; ownerId: string; mode: AutoMode }, d: Extract<Decision, { act: 'suggest' }>): void {
    const { s, ownerId, mode } = ctx;
    const open = this.#d.store.openSuggestion(s.id);
    if (open && open.to.id === d.to.id && open.reason === d.reason && open.from.id === s.claudeId) {
      this.#d.store.refreshSuggestion(open.id, { alternatives: d.alternatives, facts: d.facts, dropped: d.dropped, handoff: d.handoff, why: d.why });
      return;
    }
    if (open) this.#d.store.closeSuggestion(open.id, 'superseded');
    this.#d.store.addSuggestion({ ownerId, sessionId: s.id, reason: d.reason, from: this.#from(s), to: d.to, alternatives: d.alternatives, facts: d.facts, handoff: d.handoff, dropped: d.dropped, why: d.why });
    this.#cards.add(s.id);
    this.#record({ ...this.#base(s, ownerId, mode), kind: 'suggested', reason: d.reason, to: d.to, facts: d.facts, handoff: d.handoff, code: d.why === 'deferred' ? 'busy' : null }, 'info');
    this.#notify(s, ownerId, { to: d.to.name, suggested: true, leftPct: d.reading.leftPct });
  }

  /** The move: the Move flow, then the trail. Never throws. */
  async #move(
    s: ChatSession,
    ownerId: string,
    m: { to: AutoClaudeRef; handoff: 'ask' | 'skip'; reason: AutoReason; facts: AutoFacts; mode: AutoMode; settings: { minPauseMin: number; dryRun?: boolean }; actor: string; auto: boolean; steered?: boolean },
  ): Promise<boolean> {
    // A move that changes the model says which model it left, so Undo can switch back (T-29).
    const from = m.to.model ? { ...this.#from(s), model: modelFamily(s.model) } : this.#from(s);
    const inPlace = m.to.id === s.claudeId;
    const base = { ...this.#base(s, ownerId, m.mode), reason: m.reason, from, to: m.to, facts: m.facts, handoff: m.handoff, actor: m.actor };
    if (m.auto && m.settings.dryRun) {
      // The live check (T-105 item 5): what would happen, in the trail; nothing moves, nothing is said, no pause.
      this.#record({ ...base, kind: 'dry_run', actor: `${ENGINE_ACTOR}:move` }, 'info');
      this.#d.publish();
      return false;
    }
    this.#inflight.set(s.id, m.to.id);
    // After an automatic move the chat goes on by itself (T-105 item 3) when its last turn ended on the limit or it was told to stop for the move.
    const why: 'exhausted' | 'steered' | null = m.auto ? (m.reason === 'exhausted' ? 'exhausted' : m.steered ? 'steered' : null) : null;
    try {
      if (!inPlace) await this.#d.chat.switchClaude(s.id, m.to.id, { handoff: m.handoff });
      if (m.to.model) await this.#d.chat.setModel(s.id, m.to.model);
      const now = this.#d.clock.now();
      // The move's id, from the "Moved to" row the Move flow wrote: the page finds the divider by it.
      const after = Math.max(0, (s.lastSeq ?? 0) - 1);
      const marker = this.#d.chat.history(s.id, after).findLast((e) => e.kind === 'system' && e.transfer?.handoffId && e.transfer.toClaude === m.to.name);
      this.#d.store.patchSession(s.id, ownerId, { pausedUntil: iso(now + m.settings.minPauseMin * MIN), lastClaudeId: m.to.id, deferSince: null, warnedPeriod: null, refusedKey: null, steeredPeriod: null, waitingSince: null, waitingCode: null });
      this.#closeCard(s.id, 'moved');
      this.#record({ ...base, kind: 'moved', handoffId: marker?.transfer?.handoffId ?? null }, m.auto ? 'medium' : 'info');
      if (m.auto) this.#notify(s, ownerId, { to: m.to.name, leftPct: m.facts.leftPct.value ?? 0 });
      this.#moved.add(s.id);
      this.#wake(s.id, m.settings.minPauseMin * MIN);
      if (why) await this.#continue(s, ownerId, m.mode, m.to, why);
      return true;
    } catch (e) {
      const now = this.#d.clock.now();
      this.#d.store.patchSession(s.id, ownerId, { pausedUntil: iso(now + m.settings.minPauseMin * MIN), deferSince: null });
      const code = e instanceof AppError ? e.code : 'error';
      // A folder whose settings changed since it was trusted stops every move until someone trusts it again: say so, loudly (T-38).
      const untrusted = code === CHAT_FOLDER_UNTRUSTED;
      this.#record({ ...base, kind: 'failed', code: untrusted ? 'folder_untrusted' : 'move_failed' }, 'medium');
      if (untrusted && m.auto) this.#notify(s, ownerId, { to: m.to.name, blocked: 'trust', leftPct: m.facts.leftPct.value ?? 0 });
      console.error(`[autotransfer] a move did not finish (${code})`);
      this.#wake(s.id, m.settings.minPauseMin * MIN);
      return false;
    } finally {
      this.#inflight.delete(s.id);
      this.#d.publish();
    }
  }

  /** The continuation after an automatic move (T-105 item 3): one short message on the new Claude, priority next; recorded as `continued`. */
  async #continue(s: ChatSession, ownerId: string, mode: AutoMode, to: AutoClaudeRef, why: 'exhausted' | 'steered'): Promise<void> {
    try {
      await this.#d.chat.send(s.id, CONTINUE_TEXT(to.name, why), { priority: 'next', actor: ENGINE_ACTOR, actorLabel: 'Auto move' });
      this.#record({ ...this.#base(s, ownerId, mode), kind: 'continued', reason: why === 'exhausted' ? 'exhausted' : 'low', to, code: null }, 'info');
    } catch (e) {
      console.error(`[autotransfer] could not continue a moved chat: ${(e as Error).message}`);
    }
  }

  /** What the engine waits for, per live chat the caller may view (`GET /api/autotransfer/state`, T-105 item 5). */
  async engineState(userId: string): Promise<AutoEngineState> {
    const platform = platformSettings(this.#d.settings);
    const sessions: AutoEngineState['sessions'] = [];
    for (const s of this.#d.chat.list()) {
      if (s.state === 'ended' || !this.#d.owner.can(userId, 'view', { type: 'session', id: s.id, workspaceId: s.workspaceId })) continue;
      const last = this.last.get(s.id) ?? null;
      const st = await this.state(s.id, userId);
      sessions.push({
        sessionId: s.id,
        workspaceId: s.workspaceId,
        claudeId: s.claudeId,
        state: s.state,
        leftPct: last?.reading?.leftPct ?? null,
        last: last ? { act: last.act, code: 'code' in last ? (last.code ?? null) : null } : null,
        waiting: st.waiting,
        pendingMove: st.pendingMove,
      });
    }
    return { dryRun: platform.dryRun, sessions };
  }

  /* ---------- the card's buttons and the chat's own mode (routes call these for the signed-in user) ---------- */

  /** A suggestion the user may answer, or 404 (another user's id answers like an unknown one). */
  #ownSuggestion(id: string, userId: string): StoredSuggestion & { session: ChatSession } {
    const sug = /^sug_[0-9a-f]{12}$/.test(id) ? this.#d.store.suggestion(id) : null;
    const session = sug ? this.#d.chat.get(sug.sessionId) : null;
    if (!sug || !session || sug.ownerId !== userId || !this.#d.owner.can(userId, 'view', { type: 'session', id: session.id })) throw new AppError('NOT_FOUND', 'No such suggestion.');
    if (!this.#d.owner.can(userId, 'operate', { type: 'session', id: session.id })) throw new AppError('FORBIDDEN', 'You can’t do that here.');
    if (sug.state !== 'open') throw new AppError('CONFLICT', 'This suggestion was already answered.');
    return { ...sug, session };
  }

  /** "Move" (or "Always automatic" after it set the mode): the card is the confirmation. The safeguards other than the pause apply. */
  async answerMove(id: string, userId: string, actor: string, to?: string, opts: { always?: boolean } = {}): Promise<AutoSessionState> {
    const sug = this.#ownSuggestion(id, userId);
    const s = sug.session;
    if (s.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    if (this.#inflight.has(s.id) || s.switching) throw new AppError('CONFLICT', 'This chat is already moving.');
    const dest = to === undefined || to === sug.to.id ? sug.to : sug.alternatives.find((a) => a.id === to);
    if (!dest) throw new AppError('VALIDATION_FAILED', 'Pick one of the suggested Claudes.', { details: { to: 'Not offered.' } });
    if (!this.#d.owner.can(userId, 'operate', { type: 'claude', id: dest.id, workspaceId: s.workspaceId })) throw new AppError('NOT_FOUND', 'No such Claude.');
    const x = await this.#inputs(s.id);
    if (!x) throw new AppError('NOT_FOUND', 'No such suggestion.');
    if (opts.always) {
      if (x.platform.mode !== 'auto') throw new AppError('CONFLICT', 'Moves without asking are off for this portal.');
      this.#d.store.patchSession(s.id, userId, { mode: 'auto' });
      this.#record({ ...this.#base(s, userId, 'auto'), kind: 'mode_set', actor }, 'info');
    }
    const counters = this.#counters(s, userId, null);
    if (counters.movesSession24h >= x.settings.maxPerSessionPerDay) throw new AppError('CONFLICT', 'This chat has moved as often as allowed today.', { details: { code: 'session_cap' satisfies AutoRefusal } });
    if (counters.movesOwner24h >= x.settings.maxPerDay) throw new AppError('CONFLICT', 'Chats have moved as often as allowed today.', { details: { code: 'day_cap' satisfies AutoRefusal } });
    if (!this.#d.store.closeSuggestion(sug.id, opts.always ? 'always' : 'moved')) throw new AppError('CONFLICT', 'This suggestion was already answered.');
    this.#cards.delete(s.id);
    // The Move flow waits for a running turn itself and the page shows the move's progress live: the answer returns at once.
    const mode = opts.always ? 'auto' : x.mode;
    void this.#move(s, userId, { to: dest, handoff: sug.handoff, reason: sug.reason, facts: sug.facts, mode, settings: x.settings, actor, auto: false });
    return this.state(s.id, userId);
  }

  async answerLater(id: string, userId: string, actor: string): Promise<AutoSessionState> {
    const sug = this.#ownSuggestion(id, userId);
    if (!this.#d.store.closeSuggestion(sug.id, 'later')) throw new AppError('CONFLICT', 'This suggestion was already answered.');
    this.#cards.delete(sug.sessionId);
    const now = this.#d.clock.now();
    const until = now + AUTO_CONSTANTS.laterMin * MIN;
    this.#d.store.patchSession(sug.sessionId, userId, { pausedUntil: iso(until) });
    const x = await this.#inputs(sug.sessionId);
    this.#record({ ...this.#base(sug.session, userId, x?.mode ?? 'ask'), kind: 'declined', reason: sug.reason, to: sug.to, facts: sug.facts, code: 'paused', actor }, 'info');
    this.#wake(sug.sessionId, until - now);
    this.#d.publish();
    return this.state(sug.sessionId, userId);
  }

  /** The chat's own mode (null follows its owner's). */
  async setMode(sessionId: string, userId: string, actor: string, mode: AutoMode | null): Promise<AutoSessionState> {
    const s = this.#d.chat.get(sessionId)!;
    this.#d.store.patchSession(sessionId, userId, { mode });
    const x = await this.#inputs(sessionId);
    this.#record({ ...this.#base(s, userId, x?.mode ?? 'off'), kind: 'mode_set', actor, code: null }, 'info');
    if (x?.mode === 'off') this.#closeCard(sessionId, 'expired');
    else this.enqueue(sessionId);
    this.#d.publish();
    return this.state(sessionId, userId);
  }

  /** What the chat's page shows (`AutoSessionState`), for the user asking (the route checked `view`). */
  async state(sessionId: string, userId: string): Promise<AutoSessionState> {
    const s = this.#d.chat.get(sessionId);
    const now = this.#d.clock.now();
    const row = this.#d.store.session(sessionId);
    const ownerId = this.#ownerOf(sessionId) ?? userId;
    const x = s ? await this.#inputs(sessionId) : null;
    const mode = x?.mode ?? 'off';
    let applicable = mode !== 'off';
    let why: AutoRefusal | null = mode === 'off' ? 'mode_off' : null;
    let claudes: ClaudeUsage[] = [];
    if (s) {
      claudes = (await this.#d.usage.report({ actorId: ownerId })).claudes;
      const src = claudes.find((c) => c.claudeId === s.claudeId);
      if (src?.runsOn === 'pool') (applicable = false), (why = 'pooled');
      else if (!src || src.runsOn !== 'plan' || !src.checkedAt) (applicable = false), (why = why ?? 'no_plan_reading');
    }
    // A card older than a day expires.
    let open = this.#d.store.openSuggestion(sessionId);
    if (open && now - ms(open.at) > DAY) {
      this.#d.store.closeSuggestion(open.id, 'expired');
      open = null;
    }
    const events = this.#d.store.sessionEvents(sessionId, now - DAY, ['moved', 'undone']);
    const movesToday = events.filter((e) => e.kind === 'moved').length;
    let lastMove: AutoSessionState['lastMove'] = null;
    const latest = events[0];
    if (latest?.kind === 'moved' && latest.actor === ENGINE_ACTOR && latest.from && ownerId === userId) {
      lastMove = { event: latest, undo: latest.from.model && latest.to?.model ? this.#undoableModel(s, latest.from.model) : this.#undoable(s, latest.from.id, claudes, now) };
    }
    const pausedUntil = row?.pausedUntil && ms(row.pausedUntil) > now ? row.pausedUntil : null;
    const pending = open && open.ownerId === userId ? (({ ownerId: _o, why: _w, ...rest }) => rest)(open) : null;
    const waiting: AutoSessionState['waiting'] =
      s && row?.waitingSince ? { since: row.waitingSince, code: (row.waitingCode ?? 'no_destination') as AutoRefusal, nextFreeAt: this.#nextFreeAt(s, claudes, x?.settings.thresholdPct ?? 10, now) } : null;
    const last = this.last.get(sessionId);
    let pendingMove: AutoSessionState['pendingMove'] = null;
    if (s && row?.steeredPeriod && last?.act === 'wait' && last.period === row.steeredPeriod) {
      const steered = this.#d.store.sessionEvents(sessionId, now - DAY, ['steered', 'dry_run'])[0];
      pendingMove = { to: last.to, reason: last.reason, steeredAt: steered?.at ?? null };
    }
    return { sessionId, mode: row?.mode ?? null, effectiveMode: mode, applicable, why, pending, pausedUntil, movesToday, lastMove, waiting, pendingMove };
  }

  /** Whether a model change can be undone: the chat is open and runs on another model than the one it left (T-29). */
  #undoableModel(s: ChatSession | null, model: string): { ok: boolean; reason: string | null } {
    if (!s || s.state === 'ended') return { ok: false, reason: 'The session has ended.' };
    if (modelFamily(s.model) === model) return { ok: false, reason: 'Already back.' };
    return { ok: true, reason: null };
  }

  /** Whether the Claude a chat left can take it back now (the Undo button; the Move dialog checks again). */
  #undoable(s: ChatSession | null, claudeId: string, claudes: ClaudeUsage[], now: number): { ok: boolean; reason: string | null } {
    if (!s || s.state === 'ended') return { ok: false, reason: 'The session has ended.' };
    if (s.claudeId === claudeId) return { ok: false, reason: 'Already back.' };
    const c = claudes.find((x) => x.claudeId === claudeId);
    if (!c || c.runsOn === 'none' || c.state === 'signed_out') return { ok: false, reason: 'Signed out.' };
    const out = c.windows.find((w) => (w.key === 'session' || w.key === 'week') && (w.usedPct ?? 0) >= 100 && w.resetsAt && ms(w.resetsAt) > now);
    if (out) return { ok: false, reason: 'Out of quota until it resets.' };
    return { ok: true, reason: null };
  }
}
