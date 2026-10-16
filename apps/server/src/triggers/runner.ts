// The pipeline of a fire (docs/prd/triggers.md §7, FR11 to FR20): filters, dedupe, approval, limits, then the session or the ticket, and
// the watch over its cost and minutes. Every source (cron, the receiver, failed CI, Run now) calls `fire`; a person's Approve, Skip and
// Stop come here too. A trigger acts with its OWNER's rights: `can(owner, 'operate', workspace)` is checked when the run starts (and again
// when an approved run starts), never only when the trigger was made (FR14, the seam's adoption rule 6).
//
// What the outside world wrote (titles, bodies, comments, commits, a log tail) reaches the session only inside the quoted block of the
// opening; nothing of it goes into a title, a notification, an audit row or a log line here: those carry ids, names and fixed codes.

import { randomUUID } from 'node:crypto';
import {
  type ChatServerMessage,
  type ChatSession,
  type TriggerEventFacts,
  type TriggerReason,
  type TriggerRun,
  type TriggerRunState,
} from '@portal/contracts';
import type { NotifyBus } from '../notify/bus.js';
import type { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { Caller } from '../tickets/service.js';
import { startOfLocalDay } from './cron.js';
import { firstRefusal, needsApproval, type LimitState } from './limits.js';
import { repoMatch, globMatch } from './normalize.js';
import { ACTIVE_STATES, newRunId, type TriggerRecord, type TriggerStore } from './store.js';
import { renderOpening, sessionTitle, ticketSummary } from './template.js';

/** The chat controller, as far as triggers use it (a fake in tests). */
export interface TriggerChat {
  create(req: { workspaceId: string; title: string; cwd?: string; claudeId?: string; worktree?: Record<string, never> }, opts: { actor: string }): Promise<ChatSession>;
  send(id: string, uuid: string, text: string, opts: { actor: string; actorLabel: string }): Promise<void>;
  control(id: string, op: 'mode', args: { mode: string }, opts: { actor: string }): Promise<void>;
  interrupt(id: string): Promise<void>;
  end(id: string, opts?: { children?: 'end' }): Promise<void>;
  get(id: string): ChatSession | null;
  children(id: string): ChatSession[];
  onEvent(cb: (sessionId: string, msg: ChatServerMessage) => void): () => void;
}

/** The tickets service, as far as triggers use it. */
export interface TriggerTickets {
  create(caller: Caller, req: { summary: string; description?: string; type?: string; priority?: string; tags?: string[]; assignee?: { kind: 'user'; name: string } | null; workspaceId?: string | null }): { id: string };
  startSession(caller: Caller, id: string, req: { workspaceId: string; claudeId?: string; cwd?: string; worktree?: boolean }): Promise<{ session: { id: string } }>;
}

export interface RunnerSettings {
  enabled(): boolean;
  maxParallelTotal(): number;
  maxParallelPerOwner(): number;
  timezone(): string;
}

export interface RunnerDeps {
  store: TriggerStore;
  chat: TriggerChat;
  tickets: TriggerTickets | null;
  owner: PlatformOwner;
  audit: PlatformAudit;
  bus: NotifyBus;
  settings: RunnerSettings;
  /** `ok`, `gone` or `stopped` (not eligible to start a session now). */
  workspaceState(workspaceId: string): Promise<'ok' | 'gone' | 'stopped'>;
  /** The safety net's emergency stop (not built yet: always false). */
  emergency?: () => boolean;
  publish(): void;
  now?: () => Date;
  /** Timers (tests pass a fake clock). */
  setTimer?: (ms: number, fn: () => void) => () => void;
}

/** Who fired: an audit actor (`portal:cron`, `webhook:github`, `ci`, or a person's `user:<id>`). */
export interface FireInput {
  facts: TriggerEventFacts;
  labels?: string[];
  deliveryId?: string | null;
  actor: string;
  /** CI's loop guard, worked out by the CI source. */
  guard?: { cooldown: boolean; selfTriggered: boolean };
  /** Run now and the cron's own times skip the filters (they are not events). */
  unfiltered?: boolean;
}

export type FireResult = { kind: 'run'; run: TriggerRun } | { kind: 'filtered' } | { kind: 'duplicate' } | { kind: 'dropped' };

const STORED_SKIPS_PER_HOUR = 120;
const STOP_GRACE_MS = 5_000;
const NOTIFY_EVERY_MS = 3_600_000;

/** The reason a notification names (notify/templates.ts knows these words). */
const NOTIFY_REASON: Partial<Record<TriggerReason, string>> = {
  cost_run_limit: 'cost_limit',
  time_limit: 'time_limit',
  start_failed: 'failed',
  session_failed: 'failed',
  owner_denied: 'refused',
  owner_disabled: 'refused',
  self_triggered: 'self_triggered',
  cooldown: 'self_triggered',
  day_limit: 'cap',
  cost_day_limit: 'cap',
};

/** Whether a webhook event passes a trigger's filters (FR8): events, actions, repositories, branches, labels; an empty list means any. */
export function webhookMatches(t: TriggerRecord, f: TriggerEventFacts, labels: string[]): boolean {
  const w = t.webhook;
  if (!w || f.source !== 'webhook' || f.provider !== w.provider) return false;
  if (!w.events.includes(f.event as never)) return false;
  if (w.actions.length && !w.actions.includes(f.action ?? '')) return false;
  if (w.repos.length && !(f.repo && w.repos.some((p) => repoMatch(p, f.repo!)))) return false;
  if (w.branches.length && !(f.branch && w.branches.some((p) => globMatch(p, f.branch!)))) return false;
  if (w.labels.length && !labels.some((l) => w.labels.some((x) => x.toLowerCase() === l.toLowerCase()))) return false;
  return true;
}

/** Whether a failed CI run passes a CI trigger's filters (FR10). */
export function ciMatches(t: TriggerRecord, f: TriggerEventFacts): boolean {
  const c = t.ciFailed;
  if (!c || !f.ci) return false;
  if (c.workspaceId && c.workspaceId !== f.ci.workspaceId) return false;
  if (c.repo && c.repo !== f.repo) return false;
  if (c.pipeline && c.pipeline !== f.ci.pipeline) return false;
  if (c.branches.length && !(f.branch && c.branches.some((p) => globMatch(p, f.branch!)))) return false;
  return true;
}

export class TriggerRunner {
  readonly #d: RunnerDeps;
  readonly #now: () => Date;
  readonly #setTimer: (ms: number, fn: () => void) => () => void;
  /** trigger:reason -> when it was last told, so a flood of skips is one notification an hour. */
  readonly #told = new Map<string, number>();
  /** Runs this process is stopping (the session's end that follows is ours, not a failure). */
  readonly #stopping = new Set<string>();
  #off: (() => void) | null = null;

  constructor(d: RunnerDeps) {
    this.#d = d;
    this.#now = d.now ?? (() => new Date());
    this.#setTimer =
      d.setTimer ??
      ((ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      });
  }

  start(): void {
    this.#off ??= this.#d.chat.onEvent((sessionId, msg) => this.#onChat(sessionId, msg));
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
  }

  /* ---------- Firing ---------- */

  /** The database is Locked, Frozen or read-only: nothing starts (R15). */
  locked(): boolean {
    const s = this.#d.store.store;
    return !s.writable || s.trust.state !== 'ok';
  }

  /** One event for one trigger. Never throws for an event's sake: everything ends as a run row, a count, or nothing. */
  async fire(t: TriggerRecord, input: FireInput): Promise<FireResult> {
    const { store } = this.#d;
    if (this.locked()) return { kind: 'dropped' };
    const f = input.facts;
    if (!input.unfiltered) {
      const ok = t.source === 'webhook' ? webhookMatches(t, f, input.labels ?? []) : t.source === 'ci_failed' ? ciMatches(t, f) : true;
      if (!ok) {
        store.count(t.id, 'filtered');
        return { kind: 'filtered' };
      }
    }
    if (input.deliveryId && !store.firstDelivery(t.id, input.deliveryId)) {
      store.count(t.id, 'duplicate');
      return { kind: 'duplicate' };
    }
    // Refusals that make waiting for a person pointless come first; the full list runs again when it starts.
    const early: TriggerReason | null = !this.#d.settings.enabled() ? 'master_off' : !t.enabled ? 'disabled' : null;
    if (early) return this.#skip(t, f, input, early);
    if (needsApproval(t.approval, f)) return this.#pending(t, f, input);
    return { kind: 'run', run: await this.#begin(t, this.#newRun(t, f, input, 'starting', null), input.actor, input.guard) };
  }

  /** A run that is skipped without being tried (a cron time missed while the portal was off). */
  recordSkip(t: TriggerRecord, input: FireInput, reason: TriggerReason): FireResult {
    return this.locked() ? { kind: 'dropped' } : this.#skip(t, input.facts, input, reason);
  }

  #newRun(t: TriggerRecord, f: TriggerEventFacts, input: FireInput, state: TriggerRunState, reason: TriggerReason | null, expiresAt: string | null = null): string {
    const id = newRunId();
    const number = state === 'skipped' ? 0 : this.#d.store.bumpRuns(t.id, f.at);
    this.#d.store.insertRun({ id, triggerId: t.id, ownerId: t.ownerId, number, state, reason, event: f, deliveryId: input.deliveryId ?? null, expiresAt });
    return id;
  }

  #skip(t: TriggerRecord, f: TriggerEventFacts, input: FireInput, reason: TriggerReason): FireResult {
    const { store } = this.#d;
    const hourAgo = new Date(this.#now().getTime() - 3_600_000).toISOString();
    // A flood with a valid signature cannot grow the database: beyond 120 stored skips an hour, skips are only counted (FR7).
    if (store.skipsSince(t.id, hourAgo) >= STORED_SKIPS_PER_HOUR) {
      store.count(t.id, 'dropped');
      return { kind: 'dropped' };
    }
    const id = this.#newRun(t, f, input, 'skipped', reason);
    store.setRun(id, { ended_at: this.#now().toISOString() });
    this.#audit('trigger.skipped', input.actor, t, id, { reason });
    this.#tell(t, id, reason);
    this.#d.publish();
    return { kind: 'run', run: this.#view(id, t) };
  }

  #pending(t: TriggerRecord, f: TriggerEventFacts, input: FireInput): FireResult {
    const expires = new Date(this.#now().getTime() + t.approval.ttlHours * 3_600_000).toISOString();
    const id = this.#newRun(t, f, input, 'pending_approval', null, expires);
    this.#audit('trigger.fired', input.actor, t, id, { state: 'pending_approval', event: f.event });
    this.#d.bus.emit({
      kind: 'trigger_approval',
      subject: { type: 'trigger', id: t.id, workspaceId: t.action.workspaceId },
      facts: { trigger: t.name, event: f.event, runId: id, triggerId: t.id },
      audience: [t.ownerId],
    });
    this.#d.publish();
    return { kind: 'run', run: this.#view(id, t) };
  }

  /** Everything the limit check needs, read now. */
  async #state(t: TriggerRecord, runId: string, guard?: FireInput['guard']): Promise<LimitState> {
    const { store, settings, owner } = this.#d;
    const now = this.#now();
    const tz = t.cron?.tz ?? settings.timezone();
    const today = new Date(startOfLocalDay(tz, now.getTime())).toISOString();
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    const ownerEnabled = owner.userEnabled(t.ownerId);
    const ownerMayOperate = ownerEnabled && owner.can(t.ownerId, 'operate', { type: 'workspace', id: t.action.workspaceId });
    const workspace = ownerMayOperate ? await this.#d.workspaceState(t.action.workspaceId).catch(() => 'gone' as const) : 'ok';
    return {
      masterOn: settings.enabled(),
      enabled: t.enabled,
      ownerEnabled,
      ownerMayOperate,
      locked: this.locked(),
      emergency: this.#d.emergency?.() ?? false,
      workspace,
      cooldown: guard?.cooldown ?? false,
      selfTriggered: guard?.selfTriggered ?? false,
      active: store.activeCounts(t.id, t.ownerId, runId),
      caps: { owner: settings.maxParallelPerOwner(), total: settings.maxParallelTotal() },
      startedLastHour: store.startedSince(t.id, hourAgo),
      startedToday: store.startedSince(t.id, today),
      costToday: store.costSince(t.id, today),
    };
  }

  /** Checks the limits, then starts the action. `runId` is in `starting` (claimed); it ends `running`, `succeeded`, `failed` or `skipped`. */
  async #begin(t: TriggerRecord, runId: string, actor: string, guard?: FireInput['guard']): Promise<TriggerRun> {
    const { store } = this.#d;
    // The run being started is not one of the "already running" it is checked against.
    const state = await this.#state(t, runId, guard);
    const refused = firstRefusal(t.limits, state);
    if (refused) {
      store.setRun(runId, { state: 'skipped', reason: refused, ended_at: this.#now().toISOString() });
      this.#audit('trigger.skipped', actor, t, runId, { reason: refused });
      if (refused === 'owner_denied' || refused === 'owner_disabled') this.#pause(t, refused);
      this.#tell(t, runId, refused);
      this.#d.publish();
      return this.#view(runId, t);
    }
    const startedAt = this.#now().toISOString();
    store.setRun(runId, { started_at: startedAt });
    this.#audit('trigger.fired', actor, t, runId, { action: t.action.type });
    try {
      await this.#act(t, runId);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const reason: TriggerReason = code === 'SESSION_CAP' ? 'parallel_limit' : 'start_failed';
      store.setRun(runId, { state: reason === 'parallel_limit' ? 'skipped' : 'failed', reason, ended_at: this.#now().toISOString(), ...(reason === 'parallel_limit' ? { started_at: null } : {}) });
      // The code only: an error's text can hold what the workspace said.
      console.warn(`[triggers] ${t.id} run ${runId} could not start (${typeof code === 'string' ? code.slice(0, 40) : 'error'})`);
      this.#audit(reason === 'parallel_limit' ? 'trigger.skipped' : 'trigger.stopped', actor, t, runId, { reason, code: typeof code === 'string' ? code.slice(0, 40) : null });
      this.#tell(t, runId, reason);
    }
    this.#d.publish();
    return this.#view(runId, t);
  }

  /** The action itself (FR15 to FR17). */
  async #act(t: TriggerRecord, runId: string): Promise<void> {
    const { store, chat, tickets } = this.#d;
    const row = store.runRow(runId)!;
    const facts = JSON.parse(row.event) as TriggerEventFacts;
    const a = t.action;
    const opening = renderOpening(a.template, t.source, facts, { triggerName: t.name, tz: t.cron?.tz ?? this.#d.settings.timezone(), cron: t.cron?.expr ?? null });
    const actor = `portal:trigger-${t.id}`;
    const label = `Trigger · ${t.name}`;
    if (a.type === 'session') {
      // No Bypass opt-in is ever passed: a trigger's session can never be bypass-capable (R20).
      const s = await chat.create(
        { workspaceId: a.workspaceId, title: sessionTitle(t.name, row.number), ...(a.cwd ? { cwd: a.cwd } : {}), ...(a.claudeId ? { claudeId: a.claudeId } : {}), ...(a.worktree ? { worktree: {} } : {}) },
        { actor },
      );
      store.setRun(runId, { session_id: s.id, state: 'running' });
      if (a.permissionMode !== 'default') await chat.control(s.id, 'mode', { mode: a.permissionMode }, { actor });
      await chat.send(s.id, randomUUID(), opening, { actor, actorLabel: label });
      return;
    }
    if (!tickets) throw Object.assign(new Error('tickets are not available'), { code: 'UNAVAILABLE' });
    const caller: Caller = { kind: 'trigger', triggerId: t.id, ownerId: t.ownerId, label };
    const tk = a.ticket ?? { type: 'task', priority: 'normal', tags: [], assignTo: 'queue' as const };
    const ticket = tickets.create(caller, {
      summary: ticketSummary(t.name, facts),
      description: opening,
      type: tk.type,
      priority: tk.priority,
      tags: [...new Set([...tk.tags, 'trigger'])].slice(0, 10),
      assignee: tk.assignTo === 'owner' ? { kind: 'user', name: 'admin' } : null,
      workspaceId: a.workspaceId,
    });
    store.setRun(runId, { ticket_id: ticket.id });
    if (a.type === 'ticket') {
      store.setRun(runId, { state: 'succeeded', ended_at: this.#now().toISOString() });
      return;
    }
    const res = await tickets.startSession(caller, ticket.id, { workspaceId: a.workspaceId, ...(a.claudeId ? { claudeId: a.claudeId } : {}), ...(a.cwd ? { cwd: a.cwd } : {}), worktree: a.worktree });
    store.setRun(runId, { session_id: res.session.id, state: 'running' });
    // The ticket's own opening went with the start; the mode applies from the session's next request.
    if (a.permissionMode !== 'default') await chat.control(res.session.id, 'mode', { mode: a.permissionMode }, { actor });
  }

  /* ---------- A person's acts ---------- */

  /** Approve a pending run: the limits run again, then it starts. One winner when two approve at once. */
  async approve(t: TriggerRecord, runId: string, actor: string): Promise<TriggerRun | null> {
    const { store } = this.#d;
    const at = this.#now().toISOString();
    if (!store.setRun(runId, { state: 'starting', approved_by: actor, approved_at: at }, ['pending_approval'])) return null;
    this.#audit('trigger.approved', actor, t, runId, {});
    return this.#begin(t, runId, actor);
  }

  skip(t: TriggerRecord, runId: string, actor: string): boolean {
    const ok = this.#d.store.setRun(runId, { state: 'denied', reason: 'denied', ended_at: this.#now().toISOString(), approved_by: actor, approved_at: this.#now().toISOString() }, ['pending_approval']);
    if (ok) {
      this.#audit('trigger.skipped', actor, t, runId, { reason: 'denied' });
      this.#d.publish();
    }
    return ok;
  }

  /** Stop a starting or running run (a person, a limit, or the emergency action): interrupt, then end with its children after 5 s. */
  stopRun(t: TriggerRecord, runId: string, actor: string, reason: TriggerReason | null): boolean {
    const { store, chat } = this.#d;
    const row = store.runRow(runId);
    if (!row || !store.setRun(runId, { state: 'stopped', reason, ended_at: this.#now().toISOString() }, ACTIVE_STATES)) return false;
    this.#audit('trigger.stopped', actor, t, runId, { reason });
    if (reason) this.#tell(t, runId, reason);
    const sid = row.session_id;
    if (sid) {
      this.#stopping.add(sid);
      void chat.interrupt(sid).catch(() => undefined);
      this.#setTimer(STOP_GRACE_MS, () => {
        void chat
          .end(sid, { children: 'end' })
          .catch(() => undefined)
          .finally(() => this.#stopping.delete(sid));
      });
    }
    this.#d.publish();
    return true;
  }

  /* ---------- Watching (FR18) ---------- */

  /** The estimated cost of a session and every session under it. */
  treeCost(sessionId: string, depth = 0): number {
    const s = this.#d.chat.get(sessionId);
    if (!s || depth > 16) return 0;
    let sum = Number.isFinite(s.costUsd) ? s.costUsd : 0;
    for (const c of this.#d.chat.children(sessionId)) sum += this.treeCost(c.id, depth + 1);
    return sum;
  }

  /** The run whose session is this one or above it. */
  #runOfSession(sessionId: string): { runId: string; root: string } | null {
    let s = this.#d.chat.get(sessionId);
    for (let i = 0; s && i < 16; i++) {
      if (/^portal:trigger-/.test(s.startedBy ?? '') || s.startedBy?.startsWith('ticket:')) {
        const run = this.#d.store.runsIn(['running', 'starting', 'succeeded']).find((r) => r.session_id === s!.id);
        if (run) return { runId: run.id, root: s.id };
      }
      if (!s.parentId) return null;
      s = this.#d.chat.get(s.parentId);
    }
    return null;
  }

  #onChat(sessionId: string, msg: ChatServerMessage): void {
    try {
      if (msg.type === 'session' && msg.session.state === 'ended') return this.#ended(msg.session);
      if (msg.type !== 'events') return;
      const results = msg.items.filter((e) => e.kind === 'result' || e.kind === 'error');
      if (!results.length) return;
      const found = this.#runOfSession(sessionId);
      if (!found) return;
      const { store } = this.#d;
      const row = store.runRow(found.runId);
      if (!row) return;
      const t = store.get(row.trigger_id);
      const cost = this.treeCost(found.root);
      store.setRun(row.id, { cost_usd: cost });
      if (row.state !== 'running' || !t) return this.#d.publish();
      if (cost >= t.limits.costUsdPerRun) return void this.stopRun(t, row.id, 'portal:trigger', 'cost_run_limit');
      // The first turn of the run's own session ended (not a sub-agent's): succeeded, or failed on an error.
      const main = results.filter((e) => !e.agentLabel);
      if (sessionId !== found.root || !main.length) return this.#d.publish();
      const failed = main.some((e) => e.kind === 'error' || e.isError === true);
      store.setRun(row.id, { state: failed ? 'failed' : 'succeeded', reason: failed ? 'session_failed' : null, ended_at: this.#now().toISOString() }, ['running']);
      if (failed) this.#tell(t, row.id, 'session_failed');
      this.#d.publish();
    } catch (e) {
      console.error(`[triggers] watching a session failed: ${(e as Error).message}`);
    }
  }

  #ended(s: ChatSession): void {
    if (this.#stopping.has(s.id)) return;
    const { store } = this.#d;
    const run = store.runsIn(ACTIVE_STATES).find((r) => r.session_id === s.id);
    if (!run) return;
    const t = store.get(run.trigger_id);
    // A person closed it: stopped. Anything else (a credential or integrity end, a crash): the session failed.
    const byPerson = s.endedReason === 'closed by operator';
    store.setRun(run.id, { state: byPerson ? 'stopped' : 'failed', reason: byPerson ? null : 'session_failed', ended_at: this.#now().toISOString(), cost_usd: this.treeCost(s.id) }, ACTIVE_STATES);
    if (t && !byPerson) this.#tell(t, run.id, 'session_failed');
    this.#d.publish();
  }

  /** Every minute: the minutes limit of running runs, and pending runs that expired. */
  tick(): void {
    if (this.locked()) return;
    const { store } = this.#d;
    const now = this.#now().getTime();
    for (const r of store.runsIn(['running', 'starting'])) {
      const t = store.get(r.trigger_id);
      if (!t || !r.started_at) continue;
      if (now - Date.parse(r.started_at) >= t.limits.maxMinutes * 60_000) this.stopRun(t, r.id, 'portal:trigger', 'time_limit');
    }
    let expired = false;
    for (const r of store.runsIn(['pending_approval'])) {
      if (r.expires_at && Date.parse(r.expires_at) <= now && store.setRun(r.id, { state: 'expired', reason: 'expired', ended_at: new Date(now).toISOString() }, ['pending_approval'])) {
        const t = store.get(r.trigger_id);
        if (t) this.#audit('trigger.skipped', 'portal:trigger', t, r.id, { reason: 'expired' });
        expired = true;
      }
    }
    if (expired) this.#d.publish();
  }

  /* ---------- Helpers ---------- */

  /** The owner lost the right: the trigger pauses and the owner hears of it (FR14, R19). */
  #pause(t: TriggerRecord, why: 'owner_denied' | 'owner_disabled'): void {
    this.#d.store.setEnabled(t.id, false, why);
    this.#d.store.setNextRun(t.id, null);
  }

  #tell(t: TriggerRecord, runId: string, reason: TriggerReason): void {
    const code = NOTIFY_REASON[reason];
    if (!code) return;
    const key = `${t.id}:${code}`;
    const now = this.#now().getTime();
    // Failures of a run are always told; repeated refusals (a loop, a cap) at most once an hour per trigger.
    if (code === 'cap' || code === 'self_triggered' || code === 'refused') {
      if (now - (this.#told.get(key) ?? 0) < NOTIFY_EVERY_MS) return;
      this.#told.set(key, now);
    }
    this.#d.bus.emit({
      kind: 'trigger_failed',
      subject: { type: 'trigger', id: t.id, workspaceId: t.action.workspaceId },
      facts: { trigger: t.name, reason: code, runId, triggerId: t.id },
      audience: [t.ownerId],
    });
  }

  #audit(kind: string, actor: string, t: TriggerRecord, runId: string, detail: Record<string, unknown>): void {
    this.#d.audit.record({ kind, actor, userId: t.ownerId, subject: `trigger:${t.id}`, severity: kind === 'trigger.stopped' ? 'medium' : 'info', detail: { triggerId: t.id, runId, ...detail } });
  }

  #view(runId: string, t: TriggerRecord): TriggerRun {
    return this.#d.store.view(this.#d.store.runRow(runId)!, t.name);
  }
}
