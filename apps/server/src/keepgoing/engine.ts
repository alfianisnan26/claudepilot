// The Keep going sweep (T-259 slice 1; T-104 item 2, T-108 item 1): the watchdog INSIDE the portal, so it does not stop when somebody's
// machine or network does. A deterministic loop, every 60 seconds: the chats whose policy is on and that are due (their next look is stored
// in SQLite, jittered), at most 100 per round, ONE decision each (`decide`), acted on here: a nudge (the continuation prompt, priority
// `later`, as the portal), a wake (the existing resume path), a question answered "decide yourself", or a report (one notification
// `keepgoing_attention` and one ticket per chat and cause, not repeated while the cause stands). A tool approval is NEVER answered and Bypass
// is NEVER entered. Every action is one trail row (`keepgoing_events`) and one platform audit row, with the reason; never message text.
//
// It acts for the chat's OWNER and re-checks, every time, that the owner is an enabled user who may operate the chat. The kill switch
// `keepgoing.enabled` stops every round at once. A portal restart resumes from the stored state: the next due times, the idle period already
// nudged, a continue owed after a wake, the back-off and the reports that stand.

import { randomUUID } from 'node:crypto';
import {
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
} from '@portal/contracts';
import { redact } from '../chat/redact.js';
import type { ClockPort, OwnerPort } from '../autotransfer/ports.js';
import { cleanDetail, type NotifyBus } from '../notify/bus.js';
import type { AuditInput } from '../platform/audit.js';
import { decide, type Decision } from './decide.js';
import { keepGoingOn, type KeepGoingSettingsReader } from './settings.js';
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
}

/** Opening and commenting tickets as the portal itself (tickets' `system` caller). */
export interface KeepGoingTicketPort {
  create(req: { type: 'bug'; priority: 'high'; tags: string[]; summary: string; description: string; workspaceId: string | null }): { id: string };
  comment(id: string, text: string): void;
  isOpen(id: string): boolean;
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
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A title or a reason as it may appear in a ticket: one line, redacted, clipped. */
const line = (s: string | null | undefined, n: number) => clip(redact(String(s ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), n);
const hhmm = (at: string) => `${at.slice(11, 16)} UTC`;
const VALID_WORKSPACE = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The continuation prompt with its placeholders filled. */
export function renderPrompt(p: Pick<ChatKeepGoingPolicy, 'prompt' | 'statusFile'>, s: Pick<ChatSession, 'ticketId'>): string {
  return (p.prompt ?? KEEPGOING_DEFAULT_PROMPT).replaceAll('{status}', p.statusFile ?? KEEPGOING_DEFAULT_STATUS_FILE).replaceAll('{ticket}', s.ticketId ?? 'your ticket');
}

export class KeepGoingEngine {
  readonly #d: KeepGoingDeps;
  #timer: (() => void) | null = null;
  #running: Promise<number> | null = null;
  /** The last decision per chat (tests and debugging). */
  readonly last = new Map<string, Decision>();

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
    return rows.length;
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
    const since24 = iso(now - DAY);
    const standing = this.#d.store.standing(s.id);
    const { decision, causes } = decide({
      nowMs: now,
      session: s,
      policy: p,
      requests: s.state === 'ended' ? [] : this.#d.chat.openRequests(s.id),
      nudges24h: this.#d.store.count(s.id, 'nudged', since24),
      wakes24h: this.#d.store.count(s.id, 'woke', since24),
      lastNudgeAt: this.#d.store.lastAt(s.id, 'nudged'),
      standing,
    });
    this.last.set(s.id, decision);
    for (const r of standing) if (!causes.has(r.cause)) this.#d.store.clearReport(s.id, r.cause);
    await this.#act(s, ownerId, p, decision);
    return decision;
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
        return this.#report(s, ownerId, d.cause, d.since);
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
  }

  /** One trail row and one platform audit row: fixed sentences, ids and codes, never message text. */
  #trail(sessionId: string, ownerId: string, kind: KeepGoingActionKind, cause: KeepGoingCause | null, reason: string, extra: Record<string, unknown> = {}): KeepGoingAction {
    const row = this.#d.store.addEvent({ sessionId, ownerId, kind, cause, reason, actor: KEEPGOING_ACTOR });
    this.#d.audit?.record({
      kind: `keepgoing.${kind}`,
      severity: kind === 'reported' || kind === 'failed' || kind === 'capped' ? 'medium' : 'info',
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
  async #report(s: ChatSession, ownerId: string, cause: KeepGoingCause, since: string): Promise<void> {
    const what = KEEPGOING_CAUSE_TEXT[cause];
    // Down follows ended: it is written on the ending's ticket while that is open, not a second ticket for the same stop.
    const known = this.#d.store.report(s.id, cause)?.ticketId ?? (cause === 'down' ? this.#d.store.report(s.id, 'ended')?.ticketId : null) ?? null;
    let ticketId: string | null = null;
    const evidence = this.#evidence(s, cause, since);
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
    this.#changed(s.id);
  }

  /** What a ticket says: the state, the mode, what waits and since when, the last trail entry. Never transcript text, never a secret. */
  #evidence(s: ChatSession, cause: KeepGoingCause, since: string): string {
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
      `- Last Keep going action: ${last ? `${last.at} ${last.kind}: ${last.reason}` : 'none'}`,
      '',
      `Open the chat: ${notifyPath.session(s.id)}`,
      '',
      'Keep going never answers a tool approval and never turns Bypass on (slice 1): a person decides. This ticket is not repeated while the cause stands.',
    ];
    return lines.join('\n');
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
      nudgesToday: this.#d.store.count(sessionId, 'nudged', since24),
      wakesToday: this.#d.store.count(sessionId, 'woke', since24),
      last: this.#d.store.events(sessionId, 1)[0] ?? null,
      paused: !keepGoingOn(this.#d.settings),
    };
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
      detail: { enabled: p.enabled, nudgeAfterMin: p.nudgeAfterMin, maxNudgesPerDay: p.maxNudgesPerDay, maxWakesPerDay: p.maxWakesPerDay, promptDefault: p.prompt === null, promptChars: p.prompt?.length ?? 0, statusFile: p.statusFile },
    });
    this.#changed(sessionId);
    return this.view(sessionId)!;
  }
}
