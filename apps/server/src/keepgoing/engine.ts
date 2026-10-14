// The Keep going sweep (T-259 slices 1 and 2; T-104 item 2, T-108 item 1, T-257): the watchdog INSIDE the portal, so it does not stop when
// somebody's machine or network does. A deterministic loop, every 60 seconds: the chats whose policy is on and that are due (their next look
// is stored in SQLite, jittered), at most 100 per round, ONE decision each (`decide`), acted on here: a nudge (the continuation prompt,
// priority `later`, as the portal), a wake (the existing resume path), a question answered "decide yourself", an ended chat recovered in
// place (T-136, as an agent) or continued by a new chat (`continuedFrom`; the policy goes with it), or a report (one notification
// `keepgoing_attention` and one ticket per chat and cause, not repeated while the cause stands). A tool approval is NEVER answered and Bypass
// is NEVER entered: a chat started again is not bypass-capable (only a person's opt-in makes one) and the trail says so. Every action is one
// trail row (`keepgoing_events`) and one platform audit row, with the reason; never message text.
//
// It acts for the chat's OWNER and re-checks, every time, that the owner is an enabled user who may operate the chat. The kill switch
// `keepgoing.enabled` stops every round at once. A portal restart resumes from the stored state: the next due times, the idle period already
// nudged, a continue owed after a wake, the back-off and the reports that stand.

import { randomUUID } from 'node:crypto';
import { isAppError } from '@isnanme/core';
import {
  CHAT_RECOVER_PAUSED,
  KEEPGOING_ACTOR,
  KEEPGOING_CAUSE_TEXT,
  KEEPGOING_CONSTANTS as C,
  KEEPGOING_DEFAULT_PROMPT,
  KEEPGOING_DEFAULT_STATUS_FILE,
  KEEPGOING_QUESTION_ANSWER,
  TICKET_LIMITS,
  notifyPath,
  type ChatKeepGoing,
  type ChatKeepGoingPolicy,
  type ChatRequest,
  type ChatSession,
  type KeepGoingAction,
  type KeepGoingActionKind,
  type KeepGoingCause,
  type KeepGoingChat,
  type KeepGoingList,
  type KeepGoingRestartClass,
  type KeepGoingPause,
} from '@portal/contracts';
import { redact } from '../chat/redact.js';
import type { ClockPort, OwnerPort } from '../autotransfer/ports.js';
import { cleanDetail, type NotifyBus } from '../notify/bus.js';
import type { AuditInput } from '../platform/audit.js';
import { closedByPerson, decide, restartClass, type Decision } from './decide.js';
import { keepGoingCoordinator, keepGoingOn, type KeepGoingSettingsReader } from './settings.js';
import type { KeepGoingStore, PolicyRow } from './store.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const MAX_PER_ROUND = 100;
const JITTER_MS = 15_000;

/** What the sweep uses of the chat controller: no edit in it beyond the session payload's hook. */
export interface KeepGoingChatPort {
  get(id: string): ChatSession | null;
  openRequests(id: string): ChatRequest[];
  send(id: string, uuid: string, text: string, opts: { priority: 'later'; actor: string; actorLabel: string }): Promise<void>;
  respond(id: string, requestId: string, decision: 'deny', opts: { note: string; actor: string }): Promise<void>;
  /** The existing wake path: `control(id, 'resume')` relaunches an interrupted or sleeping chat on its conversation. */
  resume(id: string): Promise<void>;
  /** Slice 2: recover an integrity ending in place (`recover(id, { by: 'agent' })`: the portal's refusals, cap and pause apply). */
  recover(id: string): Promise<void>;
  /**
   * Slice 2: a new chat that continues an ended one (`create` with `continuedFrom`, as `portal:keepgoing`): the same workspace, folder,
   * Claude, title and ticket. Never bypass-capable (FR20: only a person's own opt-in). Its process starts in the background.
   */
  continueChat(ended: ChatSession): Promise<ChatSession>;
}

/** Opening and commenting tickets as the portal itself (tickets' `system` caller). */
export interface KeepGoingTicketPort {
  create(req: { type: 'bug'; priority: 'high'; tags: string[]; summary: string; description: string; workspaceId: string | null }): { id: string };
  comment(id: string, text: string): void;
  isOpen(id: string): boolean;
  /** A ticket that exists and is closed (an unknown one is not). */
  isClosed?(id: string): boolean;
}

export interface KeepGoingDeps {
  chat: KeepGoingChatPort;
  owner: OwnerPort;
  clock: ClockPort;
  store: KeepGoingStore;
  settings: KeepGoingSettingsReader | null;
  bus: Pick<NotifyBus, 'emit'> | null;
  audit: { record(e: AuditInput): void } | null;
  tickets: KeepGoingTicketPort | null;
  /** A number in [0, 1) for the jitter (tests pass a constant). */
  random?: () => number;
  /** A chat's payload changed (its counts, its last action): the controller tells its tabs. */
  changed?: (sessionId: string) => void;
  /** The Home card's live topic `keepgoing`: an action, or a watched chat's state changed. */
  publish?: () => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A title or a reason as it may appear in a ticket: one line, redacted, clipped. */
const line = (s: string | null | undefined, n: number) => clip(redact(String(s ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), n);
const hhmm = (at: string) => `${at.slice(11, 16)} UTC`;
const short = (id: string) => id.slice(0, 8);
/** The newest first, ids at most this far back over `continuedFrom` (cycle safe). */
const LINEAGE_MAX = 50;
const VALID_WORKSPACE = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The continuation prompt with its placeholders filled. */
export function renderPrompt(p: Pick<ChatKeepGoingPolicy, 'prompt' | 'statusFile'>, s: Pick<ChatSession, 'ticketId'>): string {
  return (p.prompt ?? KEEPGOING_DEFAULT_PROMPT).replaceAll('{status}', p.statusFile ?? KEEPGOING_DEFAULT_STATUS_FILE).replaceAll('{ticket}', s.ticketId ?? 'your ticket');
}

/**
 * The first message of a chat started again (slice 2): which chat it continues and why that one ended (redacted, one line), what is gone,
 * then the policy's own prompt (the brief the person set, its status file, its ticket). The supervisor's continuation kickoff, generalised.
 */
export function continuationBrief(p: Pick<ChatKeepGoingPolicy, 'prompt' | 'statusFile'>, ended: Pick<ChatSession, 'id' | 'endedReason' | 'ticketId'>): string {
  return [
    `This chat continues the chat ${ended.id}, which ended (${line(ended.endedReason ?? 'no reason recorded', 160)}); the portal's Keep going started it again in the same folder.`,
    'The sub-agents and background tasks of the old chat are gone: look at git worktree list and git status in each worktree for work that is not merged, keep what is good, and go on.',
    '',
    renderPrompt(p, ended),
  ].join('\n');
}

/** The state as a list shows it. */
const listState = (s: ChatSession): KeepGoingChat['state'] => (s.waiting > 0 ? 'waiting' : s.state === 'idle' && s.process === 'asleep' ? 'asleep' : s.state);

export class KeepGoingEngine {
  readonly #d: KeepGoingDeps;
  #timer: (() => void) | null = null;
  #running: Promise<number> | null = null;
  /** The last decision per chat (tests and debugging). */
  readonly last = new Map<string, Decision>();
  /** What each watched chat looked like at its last look: a change tells the Home card (`publish`). */
  readonly #seen = new Map<string, string>();
  #dirty = false;

  constructor(deps: KeepGoingDeps) {
    this.#d = deps;
  }

  start(): void {
    if (this.#timer) return;
    this.#d.store.sweep();
    const tick = () => {
      this.#timer = this.#d.clock.timer(C.roundSec * 1000, tick);
      void this.round();
    };
    this.#timer = this.#d.clock.timer(C.roundSec * 1000, tick);
  }

  stop(): void {
    this.#timer?.();
    this.#timer = null;
  }

  /** One round (the timer calls it; tests too). Rounds never overlap: a round asked for while one runs returns that one's count. */
  round(): Promise<number> {
    if (this.#running) return this.#running;
    this.#running = this.#round().finally(() => (this.#running = null));
    return this.#running;
  }

  async #round(): Promise<number> {
    if (!keepGoingOn(this.#d.settings) || !this.#d.store.writable) return 0;
    const now = this.#d.clock.now();
    const rows = this.#d.store.due(iso(now), MAX_PER_ROUND);
    for (const p of rows) {
      // The next look first, so an action that throws or hangs never makes a chat due again at once.
      const jitter = Math.floor((this.#d.random ?? Math.random)() * JITTER_MS);
      this.#d.store.patchState(p.sessionId, { nextDueAt: iso(this.#d.clock.now() + C.roundSec * 1000 + jitter) });
      try {
        await this.look(p);
      } catch (e) {
        console.error(`[keepgoing] a look at a chat failed: ${(e as Error).message}`);
      }
    }
    if (this.#dirty) {
      this.#dirty = false;
      this.#publish();
    }
    return rows.length;
  }

  #publish(): void {
    try {
      this.#d.publish?.();
    } catch {
      // a page that is told nothing reads it at its next load
    }
  }

  /** The chat and its ended predecessors' ids, newest first (`continuedFrom` back, bounded, cycle safe). */
  #lineage(s: ChatSession): string[] {
    const ids = [s.id];
    let cur: ChatSession | null = s;
    while (cur?.continuedFrom && ids.length < LINEAGE_MAX && !ids.includes(cur.continuedFrom)) {
      ids.push(cur.continuedFrom);
      cur = this.#d.chat.get(cur.continuedFrom);
    }
    return ids;
  }

  #ownerOk(s: ChatSession): string | null {
    const subject = { type: 'session' as const, id: s.id, workspaceId: s.workspaceId };
    const ownerId = this.#d.owner.ownersOf(subject)[0] ?? null;
    if (!ownerId || !this.#d.owner.userEnabled(ownerId) || !this.#d.owner.can(ownerId, 'operate', subject)) return null;
    return ownerId;
  }

  /** One decision for one chat, and the action. */
  async look(p: PolicyRow): Promise<Decision | null> {
    const now = this.#d.clock.now();
    const s = this.#d.chat.get(p.sessionId);
    if (!s) {
      this.#d.store.patchState(p.sessionId, { enabled: false });
      this.#trail(p.sessionId, p.ownerId, 'stood_down', null, 'The chat is gone: Keep going turned itself off.');
      return null;
    }
    const ownerId = this.#ownerOk(s);
    if (!ownerId) return null; // its owner may no longer operate it: nothing is done in their name
    const sig = `${s.state}|${s.process}|${s.mode}|${s.waiting}`;
    if (this.#seen.get(s.id) !== sig) (this.#seen.set(s.id, sig), (this.#dirty = true));
    const since24 = iso(now - DAY);
    const ended = s.state === 'ended';
    const held = this.pauseOf(p);
    // An ending is marked quietly the first time the sweep sees it (no ticket, no notification): `down` counts from there. While a pause
    // holds the chat the mark moves with the clock, so the 15 minutes of "left down" count from the resume, not from the pause.
    if (ended && !closedByPerson(s) && (held || !this.#d.store.standing(s.id).some((r) => r.cause === 'ended'))) this.#d.store.putReport(s.id, ownerId, 'ended', iso(now), null);
    const standing = this.#d.store.standing(s.id);
    const endedMark = standing.find((r) => r.cause === 'ended')?.since ?? null;
    const lastRefusal = ended ? this.#d.store.lastAt(s.id, 'recover_refused') : null;
    const { decision, causes } = decide({
      nowMs: now,
      session: s,
      policy: p,
      requests: ended ? [] : this.#d.chat.openRequests(s.id),
      nudges24h: this.#d.store.count(s.id, 'nudged', since24),
      wakes24h: this.#d.store.count(s.id, 'woke', since24),
      lastNudgeAt: this.#d.store.lastAt(s.id, 'nudged'),
      standing,
      ...(ended
        ? {
            restarts24h: this.#d.store.restarts(this.#lineage(s), since24),
            recoverRefused: !!lastRefusal && !!endedMark && lastRefusal >= endedMark,
            ticketClosed: !!s.ticketId && this.#ticketClosed(s.ticketId),
          }
        : {}),
    });
    this.last.set(s.id, decision);
    for (const r of standing) if (!causes.has(r.cause)) this.#d.store.clearReport(s.id, r.cause);
    // Paused (slice 3): the state is recorded above (the look, the reports that clear), but nothing is done: no nudge, wake, answer, recover,
    // new chat or report. Turning itself off (a person closed the chat, its ticket closed) touches only the policy and still happens.
    if (held && decision.act !== 'stand_down') return decision;
    await this.#act(s, ownerId, p, decision);
    return decision;
  }

  #ticketClosed(id: string): boolean {
    try {
      return this.#d.tickets?.isClosed?.(id) === true;
    } catch {
      return false;
    }
  }

  async #act(s: ChatSession, ownerId: string, p: PolicyRow, d: Decision): Promise<void> {
    const now = this.#d.clock.now();
    switch (d.act) {
      case 'none':
        return;
      case 'stand_down':
        this.#d.store.patchState(s.id, { enabled: false });
        this.#trail(s.id, ownerId, 'stood_down', null, d.reason);
        return this.#changed(s.id);
      case 'report':
        return this.#report(s, ownerId, d.cause, d.since, d.why);
      case 'recover':
        return this.#recover(s, ownerId);
      case 'restart':
        return this.#restart(s, ownerId, p, d.cls);
      case 'capped': {
        const what = d.what === 'nudges' ? `${p.maxNudgesPerDay} nudges` : `${p.maxWakesPerDay} wakes`;
        this.#trail(s.id, ownerId, 'capped', 'cap', `${what} in 24 hours: left for a person.`);
        return this.#report(s, ownerId, 'cap', iso(now));
      }
      case 'answer': {
        const kind = d.request.kind === 'elicitation' ? 'An elicitation' : 'A question';
        try {
          await this.#d.chat.respond(s.id, d.request.requestId, 'deny', { note: KEEPGOING_QUESTION_ANSWER, actor: KEEPGOING_ACTOR });
          this.#trail(s.id, ownerId, 'answered', null, `${kind} was answered: decide yourself by the written defaults.`);
        } catch (e) {
          this.#failed(s, ownerId, `${kind} could not be answered`, e);
        }
        return this.#changed(s.id);
      }
      case 'wake': {
        try {
          await this.#d.chat.resume(s.id);
          this.#d.store.patchState(s.id, { continueOwed: true });
          this.#trail(s.id, ownerId, 'woke', null, d.why === 'interrupted' ? 'Interrupted: woken.' : 'Asleep and due a nudge: woken.');
        } catch (e) {
          this.#failed(s, ownerId, 'The chat could not be woken', e);
          if (!this.#d.store.standing(s.id).some((r) => r.cause === 'wake_failed')) await this.#report(s, ownerId, 'wake_failed', iso(now));
        }
        return this.#changed(s.id);
      }
      case 'nudge': {
        try {
          await this.#d.chat.send(s.id, randomUUID(), renderPrompt(p, s), { priority: 'later', actor: KEEPGOING_ACTOR, actorLabel: 'Keep going' });
          // The idle period this nudge belongs to ends with it: the next one starts at the chat's activity after it.
          const after = this.#d.chat.get(s.id);
          this.#d.store.patchState(s.id, { nudgedPeriod: after?.lastActivityAt ?? s.lastActivityAt, continueOwed: false });
          this.#trail(s.id, ownerId, 'nudged', null, d.why === 'after_wake' ? 'Woken: told to continue.' : `Idle for ${d.idleMin} min: told to continue.`);
        } catch (e) {
          this.#failed(s, ownerId, 'The nudge did not go through', e);
        }
        return this.#changed(s.id);
      }
    }
  }

  #changed(id: string): void {
    try {
      this.#d.changed?.(id);
    } catch {
      // a tab that is told nothing reads it at its next load
    }
    this.#publish();
  }

  /**
   * An integrity ending, recovered in place (T-136) as an agent: the portal's own rules decide (a suspicious line, the day's cap, a person's
   * close are refused; the pause and a recovery under way mean "next round"). A refusal is one `recover_refused` row: the next round starts
   * a new chat instead. Anything else (the launch failed) backs off and is tried again.
   */
  async #recover(s: ChatSession, ownerId: string): Promise<void> {
    try {
      await this.#d.chat.recover(s.id);
      this.#trail(s.id, ownerId, 'recovered', null, `Ended for integrity (${s.endedFor?.classified ?? 'unclassified'}): recovered in place.`);
    } catch (e) {
      const code = isAppError(e) ? e.code : null;
      const why = (isAppError(e) ? (e.details as { recover?: unknown } | null)?.recover : null) ?? null;
      if (code === CHAT_RECOVER_PAUSED || (code === 'CONFLICT' && why === null)) return; // the pause, or a recovery under way: next round
      if (code && (code.startsWith('RECOVER_') || code === 'CONFLICT' || code === 'NOT_FOUND')) {
        this.#trail(s.id, ownerId, 'recover_refused', null, `Recover in place refused (${code}${typeof why === 'string' ? `, ${why}` : ''}): a new chat continues it.`);
      } else this.#failed(s, ownerId, 'Recover in place failed', e);
    }
    this.#changed(s.id);
  }

  /**
   * A new chat continues the ended one (T-270 `continuedFrom`: its unfinished tickets move with it): the policy is carried to it and turned
   * off on the ended one, the ended one's reports are cleared (its open ticket says where it went on), and the first message is the
   * continuation brief. A refused or failed start backs off and reports the chat left down at once (T-257 item 1).
   */
  async #restart(s: ChatSession, ownerId: string, p: PolicyRow, cls: KeepGoingRestartClass): Promise<void> {
    let fresh: ChatSession;
    try {
      fresh = await this.#d.chat.continueChat(s);
    } catch (e) {
      this.#failed(s, ownerId, 'A new chat could not be started', e);
      const code = (e as { code?: unknown })?.code;
      if (!this.#d.store.standing(s.id).some((r) => r.cause === 'down')) {
        await this.#report(s, ownerId, 'down', this.#d.store.report(s.id, 'ended')?.since ?? iso(this.#d.clock.now()), `a new chat could not be started (${typeof code === 'string' ? code : 'error'})`);
      }
      return this.#changed(s.id);
    }
    this.#d.store.carryPolicy(s.id, fresh.id);
    const mode = s.bypassCapable ? ' It starts in the default mode: Bypass is a person’s choice and is not carried.' : '';
    this.#trail(s.id, ownerId, 'restarted', cls, `Ended (${cls}): started again as ${short(fresh.id)}.${mode}`, { to: fresh.id, cls });
    this.#d.store.addEvent({ sessionId: fresh.id, ownerId, kind: 'set', cause: null, reason: `Carried over from ${short(s.id)}, which ended: started again by Keep going.`, actor: KEEPGOING_ACTOR });
    for (const r of this.#d.store.standing(s.id)) {
      if (r.ticketId && r.cause !== 'ended') {
        try {
          if (this.#d.tickets?.isOpen(r.ticketId)) this.#d.tickets.comment(r.ticketId, `Started again: the chat ${fresh.id} continues it (${notifyPath.session(fresh.id)}).`);
        } catch {
          // the ticket says less; the trail has it
        }
      }
      this.#d.store.clearReport(s.id, r.cause);
    }
    try {
      await this.#d.chat.send(fresh.id, randomUUID(), continuationBrief(p, s), { priority: 'later', actor: KEEPGOING_ACTOR, actorLabel: 'Keep going' });
    } catch (e) {
      // The new chat waits idle: the next look tells it to continue at once.
      this.#d.store.patchState(fresh.id, { continueOwed: true });
      const code = (e as { code?: unknown })?.code;
      this.#trail(fresh.id, ownerId, 'failed', null, `The new chat did not get its brief (${typeof code === 'string' ? code : 'error'}): told to continue at the next look.`);
    }
    this.#changed(s.id);
    this.#changed(fresh.id);
  }

  /** One trail row and one platform audit row: fixed sentences, ids and codes, never message text. */
  #trail(sessionId: string, ownerId: string, kind: KeepGoingActionKind, cause: KeepGoingCause | KeepGoingRestartClass | null, reason: string, extra: Record<string, unknown> = {}): KeepGoingAction {
    const row = this.#d.store.addEvent({ sessionId, ownerId, kind, cause, reason, actor: KEEPGOING_ACTOR });
    this.#d.audit?.record({
      kind: `keepgoing.${kind}`,
      severity: kind === 'reported' || kind === 'failed' || kind === 'capped' || kind === 'restarted' || kind === 'recover_refused' ? 'medium' : 'info',
      actor: KEEPGOING_ACTOR,
      userId: ownerId,
      subject: `session:${sessionId}`,
      detail: { cause, reason, ...extra },
    });
    return row;
  }

  #failed(s: ChatSession, ownerId: string, what: string, e: unknown): void {
    const code = (e as { code?: unknown })?.code;
    this.#d.store.patchState(s.id, { backoffUntil: iso(this.#d.clock.now() + C.backoffMin * MIN) });
    this.#trail(s.id, ownerId, 'failed', null, `${what} (${typeof code === 'string' ? code : 'error'}): tried again in ${C.backoffMin} min.`);
  }

  /** The report: one ticket per chat and cause (a comment while its ticket is open), one notification, one trail row. Never throws. */
  async #report(s: ChatSession, ownerId: string, cause: KeepGoingCause, since: string, why?: string): Promise<void> {
    const what = KEEPGOING_CAUSE_TEXT[cause];
    // Down follows ended: it is written on the ending's ticket while that is open, not a second ticket for the same stop.
    const known = this.#d.store.report(s.id, cause)?.ticketId ?? (cause === 'down' ? this.#d.store.report(s.id, 'ended')?.ticketId : null) ?? null;
    let ticketId: string | null = null;
    const evidence = this.#evidence(s, cause, since, why);
    try {
      const t = this.#d.tickets;
      if (t && known && t.isOpen(known)) {
        t.comment(known, `${cause === 'down' ? 'Still not running' : 'Again'}: ${what} since ${since}.\n\n${evidence}`);
        ticketId = known;
      } else if (t) {
        const title = line(s.title || 'Untitled chat', 60);
        ticketId = t.create({
          type: 'bug',
          priority: 'high',
          tags: ['watchdog'],
          summary: clip(`${title}: ${what} since ${hhmm(since)}`, TICKET_LIMITS.summary),
          description: evidence,
          workspaceId: VALID_WORKSPACE.test(s.workspaceId) ? s.workspaceId : null,
        }).id;
      }
    } catch (e) {
      console.error(`[keepgoing] the ticket for a report could not be written: ${(e as Error).message}`);
    }
    this.#d.store.putReport(s.id, ownerId, cause, since, ticketId);
    this.#trail(s.id, ownerId, 'reported', cause, `Reported: ${what}${ticketId ? ` (${ticketId})` : ''}.`, { ticket: ticketId });
    const ws = s.workspaceId.includes('/') ? s.workspaceId.slice(s.workspaceId.indexOf('/') + 1) : s.workspaceId;
    this.#d.bus?.emit({
      kind: 'keepgoing_attention',
      subject: { type: 'session', id: s.id, workspaceId: s.workspaceId },
      facts: { workspace: ws, what: cause, ...(ticketId ? { ticket: ticketId } : {}) },
      // The chat's title is written by agents: only a destination that asked for the detail gets it, labelled untrusted.
      detail: cleanDetail(s.title || 'Untitled chat', 120),
      audience: [ownerId],
    });
    if (cause === 'down') await this.#escalate(s, ownerId, ticketId);
    this.#changed(s.id);
  }

  /**
   * T-257 item 4: a chat left down is told to the coordinator's chat too (the setting `keepgoing.coordinator`, else the chat's parent), as a
   * message at priority later, as the portal. Fixed words and ids only (the chat's title is agent text). Only a coordinator chat that runs and
   * that the owner may operate; never the chat itself. One `escalated` trail row; never throws.
   */
  async #escalate(s: ChatSession, ownerId: string, ticketId: string | null): Promise<void> {
    const id = keepGoingCoordinator(this.#d.settings) ?? s.parentId ?? null;
    if (!id || id === s.id) return;
    const c = this.#d.chat.get(id);
    if (!c || c.state === 'ended' || !this.#d.owner.can(ownerId, 'operate', { type: 'session', id: c.id, workspaceId: c.workspaceId })) return;
    const text = [
      `Keep going: the chat ${s.id} in ${s.workspaceId} is left down (${KEEPGOING_CAUSE_TEXT.down}) and needs a person or its coordinator${ticketId ? `; the ticket is ${ticketId}` : ''}.`,
      `Open it: ${notifyPath.session(s.id)}. Recover it or continue it, or say on the ticket why it stays down.`,
    ].join('\n');
    try {
      await this.#d.chat.send(c.id, randomUUID(), text, { priority: 'later', actor: KEEPGOING_ACTOR, actorLabel: 'Keep going' });
      this.#trail(s.id, ownerId, 'escalated', 'down', `Told the coordinator's chat ${short(c.id)}.`, { coordinator: c.id });
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      this.#trail(s.id, ownerId, 'failed', 'down', `The coordinator's chat ${short(c.id)} could not be told (${typeof code === 'string' ? code : 'error'}).`);
    }
  }

  /** What a ticket says: the state, the mode, what waits and since when, the last trail entry. Never transcript text, never a secret. */
  #evidence(s: ChatSession, cause: KeepGoingCause, since: string, why?: string): string {
    const requests = s.state === 'ended' ? [] : this.#d.chat.openRequests(s.id);
    const oldest = [...requests].sort((a, b) => ms(a.createdAt) - ms(b.createdAt))[0];
    const [last] = this.#d.store.events(s.id, 1);
    const lines = [
      `Keep going (the portal's watchdog) found this and cannot repair it by itself: **${KEEPGOING_CAUSE_TEXT[cause]}**.`,
      '',
      `- Chat: ${s.id} ("${line(s.title || 'Untitled', 80)}") in ${s.workspaceId}${s.claudeName ? `, on Claude ${line(s.claudeName, 40)}` : ''}`,
      `- Since: ${since}`,
      `- State: ${s.state}, process ${s.process}, mode ${s.mode}${s.bypassCapable ? ' (bypass-capable)' : ''}`,
      `- Waiting: ${requests.length ? `${requests.length} (${line(oldest!.toolName ?? oldest!.kind, 40)}: ${line(oldest!.title, 60)}, since ${oldest!.createdAt})` : 'nothing'}`,
      ...(s.state === 'ended' ? [`- Ended: ${line(s.endedReason ?? 'no reason recorded', 200)}`] : []),
      ...(why ? [`- Left down because: ${line(why, 240)}`] : []),
      `- Last Keep going action: ${last ? `${last.at} ${last.kind}: ${last.reason}` : 'none'}`,
      '',
      `Open the chat: ${notifyPath.session(s.id)}`,
      '',
      'Keep going never answers a tool approval and never turns Bypass on: a person decides. This ticket is not repeated while the cause stands.',
    ];
    return lines.join('\n');
  }

  /* ---------- the pause switch (slice 3) ---------- */

  /** The pause that holds a policy's chat: all first, then its program; null when none does. */
  pauseOf(p: Pick<PolicyRow, 'program'>, pauses: KeepGoingPause[] = this.#d.store.pauses()): KeepGoingPause | null {
    return pauses.find((x) => x.program === null) ?? (p.program ? (pauses.find((x) => x.program === p.program) ?? null) : null);
  }

  /**
   * Pauses or resumes a program (null: all); the route or the tool checked who may (a platform admin, an admin token). One audit row
   * `keepgoing.pause` either way. A resume makes the program's chats due and starts a round at once.
   */
  setPause(program: string | null, paused: boolean, by: string, userId: string | null, reason: string | null): { pause: KeepGoingPause | null; changed: boolean } {
    const was = this.#d.store.pauses().find((x) => x.program === program) ?? null;
    let pause: KeepGoingPause | null = null;
    let changed: boolean;
    if (paused) {
      pause = this.#d.store.pause(program, reason ?? 'Paused.', by);
      changed = !was || was.reason !== pause.reason;
    } else {
      changed = this.#d.store.resume(program);
      if (changed) this.#d.store.dueNow(program);
    }
    if (changed) {
      this.#d.audit?.record({
        kind: 'keepgoing.pause',
        severity: 'info',
        actor: by,
        userId,
        subject: `keepgoing:${program ?? 'all'}`,
        detail: { program, paused, reasonChars: pause?.reason.length ?? 0 },
      });
      for (const p of this.#d.store.enabled()) if (program === null || p.program === program) this.#changed(p.sessionId);
      this.#publish();
      if (!paused) void this.round();
    }
    return { pause, changed };
  }

  /* ---------- the policy, for the routes and the session payload ---------- */

  /** What the session payload carries, or null when the chat never had a policy. */
  view(sessionId: string): ChatKeepGoing | null {
    const p = this.#d.store.policy(sessionId);
    if (!p) return null;
    const since24 = iso(this.#d.clock.now() - DAY);
    return {
      enabled: p.enabled,
      nudgeAfterMin: p.nudgeAfterMin,
      prompt: p.prompt,
      statusFile: p.statusFile,
      maxNudgesPerDay: p.maxNudgesPerDay,
      maxWakesPerDay: p.maxWakesPerDay,
      program: p.program ?? null,
      nudgesToday: this.#d.store.count(sessionId, 'nudged', since24),
      wakesToday: this.#d.store.count(sessionId, 'woke', since24),
      last: this.#d.store.events(sessionId, 1)[0] ?? null,
      paused: !keepGoingOn(this.#d.settings) || !!this.pauseOf(p),
      pause: this.pauseOf(p),
      standing: this.#d.store
        .standing(sessionId)
        .map((r) => r.cause)
        .filter((c) => c !== 'ended'),
    };
  }

  /**
   * The Home card: the chats with Keep going on that `visible` lets the caller see (the route asks the seam), the ones with a cause standing
   * first, then by their last action, newest first. A policy whose chat is gone is left out (the sweep turns it off).
   */
  list(visible: (s: ChatSession) => boolean): KeepGoingList {
    const chats: KeepGoingChat[] = [];
    for (const p of this.#d.store.enabled()) {
      const s = this.#d.chat.get(p.sessionId);
      if (!s || !visible(s)) continue;
      const kg = this.view(s.id);
      if (kg) chats.push({ sessionId: s.id, title: s.title || 'Untitled chat', workspaceId: s.workspaceId, state: listState(s), mode: s.mode, keepGoing: kg });
    }
    const rank = (c: KeepGoingChat) => (c.keepGoing.standing?.length ? 0 : 1);
    chats.sort((a, b) => rank(a) - rank(b) || (b.keepGoing.last?.at ?? '').localeCompare(a.keepGoing.last?.at ?? ''));
    return { paused: !keepGoingOn(this.#d.settings), pauses: this.#d.store.pauses(), chats };
  }

  /** A person's (or an admin token's) change; the route checked who may. One trail row and one audit row. */
  set(sessionId: string, ownerId: string, by: string, patch: Partial<ChatKeepGoingPolicy>): ChatKeepGoing {
    const was = this.#d.store.policy(sessionId);
    const p = this.#d.store.setPolicy(sessionId, ownerId, by, patch);
    const reason = p.enabled && !was?.enabled ? 'Turned on by a person.' : !p.enabled && was?.enabled ? 'Turned off by a person.' : 'Changed by a person.';
    this.#d.store.addEvent({ sessionId, ownerId, kind: 'set', cause: null, reason, actor: by });
    this.#d.audit?.record({
      kind: 'keepgoing.set',
      severity: 'info',
      actor: by,
      userId: ownerId,
      subject: `session:${sessionId}`,
      detail: { enabled: p.enabled, program: p.program ?? null, nudgeAfterMin: p.nudgeAfterMin, maxNudgesPerDay: p.maxNudgesPerDay, maxWakesPerDay: p.maxWakesPerDay, promptDefault: p.prompt === null, promptChars: p.prompt?.length ?? 0, statusFile: p.statusFile },
    });
    this.#changed(sessionId);
    return this.view(sessionId)!;
  }
}
