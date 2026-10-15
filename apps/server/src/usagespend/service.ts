// Usage spend (docs/prd/claude-usage.md §21 to §26): who spent what, budgets with alerts, and spike detection, over the requests the portal
// records (`chat_usage`). The chat controller hands this module three things through its hooks (`onUsage`, `onLaunch`, `sendGate`); the
// rest is reads. Nothing here probes, calls a model or touches a workspace.
//
// Alerts follow the plan windows' machinery (claudeusage/service.ts) without sharing its tables: per budget and period the highest level
// is told once, a snooze makes a crossing quiet (kept, never told later), a sink (`onAlert`) is where push notifications plug in, and a page
// hears of a change through the same live topic (`claudeusage`).
//
// Every background step is wrapped: a failure here is logged once and never reaches the transcript or the person's message (QA-011).

import { randomBytes } from 'node:crypto';
import { AppError, defineErrorCodes } from '@isnanme/core';
import {
  ATTRIBUTION_BY,
  ATTRIBUTION_LEAD_BASIS,
  CHAT_USAGE_RANGES,
  USAGE_THRESHOLDS,
  estimatedFigure,
  measuredFigure,
  spendTokens,
  type AttributionBy,
  type AttributionReport,
  type BudgetSnoozeUntil,
  type BudgetState,
  type BudgetsReport,
  type ChatUsageRange,
  type ChatUsageTotals,
  type SpendAlert,
  type SpendAuditEntry,
  type SpendSummary,
  type SpikeEvent,
  type SpikeKind,
  type SpikeSnoozeUntil,
  type SpikesReport,
  type UsageAlertLevel,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import { OWNER_ACTOR, UI_OWNER, type SpendObject, type Visibility, type Who } from './actor.js';
import { attribute, chainOf, chainRootOf, workspaceNameOf } from './attribution.js';
import { ticketReport } from './ticketReport.js';
import { alertKey, levelOf, MAX_BUDGETS, measure, parseBudget, type BudgetFields } from './budgets.js';
import { addRow, roundUsd, zeroTotals, type UsageRow } from './model.js';
import { DAY, HOUR, periodBounds } from './periods.js';
import { spikeSettingsOf, timezoneOf, type SettingsReader } from './settings.js';
import {
  BASELINE_MS,
  BURST_WINDOW_MIN,
  burstEvidence,
  burstVerdict,
  COOLDOWN_MS,
  MIN,
  outlierEvidence,
  outlierVerdict,
  RATE_WINDOW_MS,
  rateEvidence,
  rateVerdict,
  spikeSummary,
} from './spikes.js';
import { SpendStore, type BudgetMark, type BudgetRow, type SpikeRow } from './store.js';

export const USAGE_BUDGET = 'USAGE_BUDGET';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    USAGE_BUDGET: true;
  }
}
defineErrorCodes({ [USAGE_BUDGET]: { status: 409, message: 'A usage budget is used up.' } });

export interface SpendOptions {
  store: Store;
  settings: SettingsReader;
  /** The persona a workspace has assigned now (its pool id, name and revision), or null for none. Unset, no persona is ever recorded. A throw records nothing. */
  personaOf?: (workspaceId: string) => { id: string; name: string; revision: number } | null;
  /** A persona's name now, since it may have been renamed after a request ran. */
  personaName?: (poolId: string) => string | null;
  /** Whether a workspace exists: a budget on a workspace is checked against it when it is made. Unset, any workspace id is accepted. */
  workspaceExists?: (workspaceId: string) => boolean | Promise<boolean>;
  /**
   * Whether an actor may see an object (several users are coming: docs §26.4). Unset, everyone sees everything, which is how the single owner
   * uses the portal. Asked about the workspace and session of every request a read is built from, and about every budget.
   */
  visible?: Visibility;
  /** Tells open pages something changed (the `claudeusage` live topic). */
  notify?: () => void;
  /** A session's stored workspace (T-42 slice 3: a stable id or a key) as the key usage speaks. Unset: as stored. */
  workspaceKeyOf?: (stored: string) => string;
  now?: () => number;
  log?: (line: string) => void;
}

const ALERT_WINDOW_MS = DAY;
const SPIKE_KEEP_MS = 90 * DAY;
const PRUNE_EVERY_MS = 6 * HOUR;
/** The rate rule looks at a Claude at most this often: it scans a week of requests. */
const RATE_EVERY_MS = MIN;
const RANK: Record<UsageAlertLevel, number> = { near: 1, high: 2, exhausted: 3 };
const RANGE_MS: Record<ChatUsageRange, number> = { '30m': 30 * MIN, '1h': HOUR, '12h': 12 * HOUR, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const SPIKE_RANGES = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY } as const;
const BUDGET_SNOOZE: readonly string[] = ['1h', '4h', 'reset'];
const SPIKE_SNOOZE: readonly string[] = ['1h', '4h', 'day'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const iso = (ms: number): string => new Date(ms).toISOString();

/** Whether a budget's scope counts a request of this workspace and Claude. */
export const applies = (scope: BudgetFields['scope'], workspaceId: string, claudeKey: string): boolean =>
  scope.kind === 'all' || (scope.kind === 'workspace' ? scope.id === workspaceId : scope.id === claudeKey);

const fieldsOf = (b: BudgetRow): BudgetFields => ({ name: b.name, scope: b.scope, period: b.period, limitUsd: b.limitUsd, limitTokens: b.limitTokens, mode: b.mode, enabled: b.enabled });

export interface AttributionQuery {
  by?: unknown;
  range?: unknown;
  claudeId?: string;
  workspaceId?: string;
  limit?: unknown;
  /** Only this session and the ones below it (an agent's view of its own tree). */
  sessionId?: string;
  /** By ticket: only tickets closed as done inside the window (T-449). */
  done?: boolean;
}

export class UsageSpend {
  readonly #store: SpendStore;
  readonly #sinks = new Set<(alert: SpendAlert) => void>();
  readonly #warned = new Set<string>();
  readonly #rateAt = new Map<string, number>();
  #prunedAt = 0;

  constructor(private readonly o: SpendOptions) {
    this.#store = new SpendStore(o.store);
    if (o.workspaceKeyOf) this.#store.workspaceKeyOf = o.workspaceKeyOf;
  }

  #now(): number {
    return (this.o.now ?? Date.now)();
  }

  #warn(what: string, e: unknown): void {
    if (this.#warned.has(what)) return;
    this.#warned.add(what);
    (this.o.log ?? ((l) => console.error(`[usage-spend] ${l}`)))(`${what} failed: ${(e as Error)?.message ?? 'unknown'}`);
  }

  get timezone(): string {
    return timezoneOf(this.o.settings);
  }

  /** A page asking for something that needs a write while the portal can't save. */
  #writable(): void {
    if (!this.o.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The portal can’t save changes right now.', { expose: true });
  }

  /** Calls `fn` for each new alert: the seam where push notifications plug in. Returns the way to stop. */
  onAlert(fn: (alert: SpendAlert) => void): () => void {
    this.#sinks.add(fn);
    return () => this.#sinks.delete(fn);
  }

  #raise(alert: SpendAlert): void {
    for (const sink of this.#sinks) {
      try {
        sink(alert);
      } catch (e) {
        this.#warn('an alert sink', e);
      }
    }
  }

  /* ---------- Who may see what (the multi-user seam, §26.4) ---------- */

  /** Whether `actorId` may see an object; everyone may when no rule is installed. A rule that fails hides the object rather than showing it. */
  #sees(actorId: string, kind: SpendObject['kind'], id: string): boolean {
    const rule = this.o.visible;
    if (!rule) return true;
    try {
      return rule(actorId, { kind, id });
    } catch {
      return false;
    }
  }

  /** The requests the actor may see: those of a visible workspace and a visible session (each asked once). */
  #visibleRows(actorId: string, rows: UsageRow[]): UsageRow[] {
    if (!this.o.visible) return rows;
    const workspaces = new Map<string, boolean>();
    const sessions = new Map<string, boolean>();
    const ok = (cache: Map<string, boolean>, kind: SpendObject['kind'], id: string) => {
      let v = cache.get(id);
      if (v === undefined) cache.set(id, (v = this.#sees(actorId, kind, id)));
      return v;
    };
    return rows.filter((r) => ok(workspaces, 'workspace', r.workspaceId) && ok(sessions, 'session', r.sessionId));
  }

  /** What the actor's visible requests used over [fromMs, toMs): the SQL sum for the owner, the filtered rows for anyone behind a rule. */
  #totals(actorId: string, fromMs: number, toMs: number): ChatUsageTotals {
    if (!this.o.visible) return this.#store.sum({ kind: 'all', id: null }, fromMs, toMs);
    const t = zeroTotals();
    for (const r of this.#visibleRows(actorId, this.#store.usageRows(fromMs, toMs))) addRow(t, r);
    return { ...t, costUsd: roundUsd(t.costUsd) };
  }

  /** What a person changed, and who did it and how. Never throws: the audit must not undo the change. */
  #audit(who: Who, action: SpendAuditEntry['action'], objectKind: SpendAuditEntry['objectKind'], objectId: string, summary: string): void {
    try {
      this.#store.addAudit({ at: iso(this.#now()), actor: who.actorId, via: who.via, action, objectKind, objectId, summary });
    } catch (e) {
      this.#warn('the audit trail', e);
    }
  }

  /** "daily budget for api, $10, pauses": one terse line for the audit trail (limits are settings, not usage). */
  #budgetLine(f: BudgetFields): string {
    const limits = [f.limitUsd !== null ? `$${f.limitUsd}` : null, f.limitTokens !== null ? `${f.limitTokens.toLocaleString('en-US')} tokens` : null].filter(Boolean).join(' + ');
    return `${f.period === 'day' ? 'daily' : 'monthly'} budget for ${this.#scopeLabel(f.scope) ?? 'a removed scope'}, ${limits}${f.mode === 'pause' ? ', pauses' : ''}`;
  }

  /** The workspace a budget concerns, for routing its alerts: its own, a Claude's, or none for a budget on everything. */
  #budgetWorkspace(scope: BudgetFields['scope']): string | null {
    if (scope.kind === 'all') return null;
    if (scope.kind === 'workspace') return scope.id;
    if (scope.id!.startsWith('default:')) return scope.id!.slice('default:'.length);
    return this.#store.claudes().get(scope.id!)?.workspaceId ?? null;
  }

  /* ---------- Hooks the chat controller calls ---------- */

  /**
   * A turn was recorded (`chat_usage` rows are in): keep the session's title and links, look at the budgets that count it, and run the
   * spike rules. Never throws.
   */
  onTurn(turn: { sessionId: string; workspaceId: string; claudeId: string | null; atMs: number }, rows: readonly { costUsd: number }[]): void {
    try {
      if (!this.#store.writable) return;
      const at = turn.atMs;
      const claude = this.#store.claudeKey(turn.claudeId, turn.workspaceId);
      const live = this.#store.liveSession(turn.sessionId);
      if (live) this.#store.keepSession({ sessionId: turn.sessionId, ...live }, at);
      let changed = false;
      for (const b of this.#store.budgets()) if (b.enabled && applies(b.scope, turn.workspaceId, claude)) changed = this.#evaluate(b, at) || changed;
      changed = this.#spikes(turn, claude, rows.reduce((t, r) => t + r.costUsd, 0), at) || changed;
      if (at - this.#prunedAt > PRUNE_EVERY_MS) {
        this.#prunedAt = at;
        this.#store.prune(at - SPIKE_KEEP_MS, at);
      }
      if (changed) this.o.notify?.();
    } catch (e) {
      this.#warn('a recorded request', e);
    }
  }

  /**
   * A session's process started: record the persona its workspace has assigned, when that is not what was recorded last (a persona is a pool
   * assigned to the workspace; it is not kept per session). Requests before a session's first record read as "not recorded", never guessed.
   */
  onLaunch(info: { sessionId: string; workspaceId: string }): void {
    try {
      if (!this.#store.writable || !this.o.personaOf) return;
      let p: ReturnType<NonNullable<SpendOptions['personaOf']>>;
      try {
        p = this.o.personaOf(info.workspaceId);
      } catch {
        return; // can't tell what is assigned: record nothing rather than "none"
      }
      const id = p?.id ?? null;
      const last = this.#store.lastPersona(info.sessionId);
      if (last && last.personaId === id) return;
      this.#store.addPersona(info.sessionId, { atMs: this.#now(), personaId: id, name: p?.name ?? null, revision: p?.revision ?? null });
    } catch (e) {
      this.#warn('recording a persona', e);
    }
  }

  /**
   * Before a message is accepted: the refusal when a budget in `pause` mode that counts this session is used up, else null. Only budgets a
   * person set to pause are asked; a budget that can't be read never blocks a message.
   */
  gate(info: { sessionId: string; workspaceId: string; claudeId: string | null }): AppError | null {
    try {
      const pausing = this.#store.budgets().filter((b) => b.enabled && b.mode === 'pause');
      if (!pausing.length) return null;
      const claude = this.#store.claudeKey(info.claudeId, info.workspaceId);
      const now = this.#now();
      for (const b of pausing) {
        if (!applies(b.scope, info.workspaceId, claude)) continue;
        const st = this.#state(b, now);
        if (st.paused) return this.#pausedError(st);
      }
    } catch (e) {
      this.#warn('the budget gate', e);
    }
    return null;
  }

  #pausedError(st: BudgetState): AppError {
    const b = st.budget;
    const amounts = [
      b.limitUsd !== null ? `$${(st.usedUsd.value ?? 0).toFixed(2)} of $${b.limitUsd.toFixed(2)}, estimated` : null,
      b.limitTokens !== null ? `${(st.usedTokens.value ?? 0).toLocaleString('en-US')} of ${b.limitTokens.toLocaleString('en-US')} tokens` : null,
    ].filter(Boolean);
    const resets = new Intl.DateTimeFormat('en-GB', { timeZone: st.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(st.periodEnd));
    return new AppError(USAGE_BUDGET, `The ${this.#label(b, st.scopeLabel)} budget is used up (${amounts.join('; ')}). New messages are paused until it resets on ${resets} (${st.timezone}), or until it is raised or set to alerts only (Usage › Budgets).`, {
      status: 409,
      details: { budgetId: b.id, resetsAt: st.periodEnd, usedPct: st.usedPct.value },
    });
  }

  /* ---------- Budgets ---------- */

  #label(b: { name: string; period: string }, scopeLabel: string | null): string {
    return b.name || `${scopeLabel ?? 'removed'} ${b.period === 'day' ? 'daily' : 'monthly'}`;
  }

  #scopeLabel(scope: BudgetFields['scope']): string | null {
    if (scope.kind === 'all') return 'Everything';
    if (scope.kind === 'workspace') return workspaceNameOf(scope.id!);
    if (scope.id!.startsWith('default:')) return `Default · ${workspaceNameOf(scope.id!.slice('default:'.length))}`;
    const c = this.#store.claudes().get(scope.id!);
    return c ? `${c.name} · ${workspaceNameOf(c.workspaceId)}` : null;
  }

  /** The budget as it stands at `now`: what its period used, against its limits. */
  #state(b: BudgetRow, now: number): BudgetState {
    const tz = this.timezone;
    const { start, end } = periodBounds(b.period, tz, now);
    const used = this.#store.sum(b.scope, start, now + 1);
    const usedUsd = roundUsd(used.costUsd);
    const tokens = spendTokens(used);
    const m = measure({ usd: usedUsd, tokens }, { usd: b.limitUsd, tokens: b.limitTokens });
    const pct = Math.round(m.pct * 10) / 10;
    const level = levelOf(m.pct);
    return {
      budget: { id: b.id, name: b.name, scope: b.scope, period: b.period, limitUsd: b.limitUsd, limitTokens: b.limitTokens, mode: b.mode, enabled: b.enabled, createdBy: b.createdBy, createdAt: b.createdAt, updatedAt: b.updatedAt },
      scopeLabel: this.#scopeLabel(b.scope),
      periodStart: iso(start),
      periodEnd: iso(end),
      timezone: tz,
      usedUsd: estimatedFigure(usedUsd),
      usedTokens: measuredFigure(tokens),
      usedPct: m.limiting === 'usd' ? estimatedFigure(pct) : measuredFigure(pct),
      limiting: m.limiting,
      level,
      paused: b.enabled && b.mode === 'pause' && level === 'exhausted',
      snoozedUntil: b.snoozedUntilMs !== null && b.snoozedUntilMs > now ? iso(b.snoozedUntilMs) : null,
    };
  }

  #budgetAlert(b: BudgetRow, m: BudgetMark, st: Pick<BudgetState, 'scopeLabel' | 'periodEnd'>): SpendAlert {
    const label = this.#label(b, st.scopeLabel);
    const paused = b.mode === 'pause' && m.level === 'exhausted';
    return {
      kind: 'budget',
      id: `budget|${b.id}|${m.level}|${m.periodStartMs}`,
      at: iso(m.atMs),
      level: m.level,
      scope: { kind: b.scope.kind, id: b.scope.id, label: st.scopeLabel },
      owner: b.createdBy,
      workspaceId: this.#budgetWorkspace(b.scope),
      summary: `${label}: ${m.level === 'exhausted' ? 'used up' : `${Math.round(m.usedPct)} %`}${paused ? ' · paused' : ''}`,
      budgetId: b.id,
      budgetName: label,
      scopeLabel: st.scopeLabel,
      usedPct: m.usedPct,
      periodEnd: st.periodEnd,
      paused,
    };
  }

  /** Notes a crossing the budget has not told in this period (once per level and period, quiet while snoozed). True when an alert went out. */
  #evaluate(b: BudgetRow, now: number): boolean {
    const st = this.#state(b, now);
    if (st.level === 'ok') return false;
    const level = st.level;
    const periodStartMs = Date.parse(st.periodStart);
    const told = b.mark && b.mark.periodStartMs === periodStartMs ? b.mark.level : null;
    if (told && RANK[level] <= RANK[told]) return false;
    const snoozed = b.snoozedUntilMs !== null && b.snoozedUntilMs > now;
    const mark: BudgetMark = { level, periodStartMs, atMs: now, usedPct: st.usedPct.value ?? 0, ...(snoozed ? { quiet: true } : {}) };
    this.#store.saveMark(b.id, mark);
    if (snoozed) return false;
    this.#raise(this.#budgetAlert({ ...b, mark }, mark, st));
    return true;
  }

  /** The budgets the actor may see, with what each has used. */
  budgets(actorId: string = OWNER_ACTOR): BudgetsReport {
    const now = this.#now();
    return {
      budgets: this.#store
        .budgets()
        .filter((b) => this.#sees(actorId, 'budget', b.id))
        .map((b) => this.#state(b, now)),
      thresholds: { warn: USAGE_THRESHOLDS.warn, critical: USAGE_THRESHOLDS.critical },
      timezone: this.timezone,
      now: iso(now),
    };
  }

  /** The budgets that count a session's workspace and Claude (what an agent may be told about its own limits). */
  budgetsFor(workspaceId: string, claudeId: string | null): BudgetState[] {
    const now = this.#now();
    const claude = this.#store.claudeKey(claudeId, workspaceId);
    return this.#store
      .budgets()
      .filter((b) => b.enabled && applies(b.scope, workspaceId, claude))
      .map((b) => this.#state(b, now));
  }

  budget(id: string, actorId: string = OWNER_ACTOR): BudgetState {
    const b = this.#store.budget(id);
    if (!b || !this.#sees(actorId, 'budget', id)) throw new AppError('NOT_FOUND', 'No such budget.');
    return this.#state(b, this.#now());
  }

  async #checkScope(scope: BudgetFields['scope']): Promise<void> {
    if (scope.kind === 'workspace' && this.o.workspaceExists && !(await this.o.workspaceExists(scope.id!))) throw invalid('scope', 'That workspace doesn’t exist.');
    if (scope.kind === 'claude') {
      const id = scope.id!;
      if (id.startsWith('default:')) {
        if (this.o.workspaceExists && !(await this.o.workspaceExists(id.slice('default:'.length)))) throw invalid('scope', 'That workspace doesn’t exist.');
      } else if (!this.#store.claudes().has(id)) throw invalid('scope', 'That Claude doesn’t exist.');
    }
  }

  async createBudget(raw: unknown, who: Who = UI_OWNER): Promise<BudgetState> {
    this.#writable();
    const f = parseBudget(raw);
    if (this.#store.budgets().length >= MAX_BUDGETS) throw new AppError('CONFLICT', `There are already ${MAX_BUDGETS} budgets. Remove one first.`);
    await this.#checkScope(f.scope);
    const id = `b_${randomBytes(6).toString('hex')}`;
    const now = this.#now();
    const at = iso(now);
    this.#store.insertBudget({ id, ...f, createdBy: who.actorId, createdAt: at, updatedAt: at });
    this.#audit(who, 'budget.create', 'budget', id, this.#budgetLine(f));
    // A budget made when its period is already past a threshold says so now, not at the next request.
    this.#evaluate(this.#store.budget(id)!, now);
    this.o.notify?.();
    return this.budget(id, who.actorId);
  }

  async updateBudget(id: string, raw: unknown, who: Who = UI_OWNER): Promise<BudgetState> {
    this.#writable();
    const row = this.#store.budget(id);
    if (!row || !this.#sees(who.actorId, 'budget', id)) throw new AppError('NOT_FOUND', 'No such budget.');
    const base = fieldsOf(row);
    const f = parseBudget(raw, base);
    if (f.scope.kind !== base.scope.kind || f.scope.id !== base.scope.id) await this.#checkScope(f.scope);
    const now = this.#now();
    this.#store.updateBudget({ id, ...f, updatedAt: iso(now) }, alertKey(f) !== alertKey(base));
    this.#audit(who, 'budget.update', 'budget', id, this.#budgetLine(f));
    // A budget that pauses can't be snoozed: its alerts are the warning.
    if (f.mode === 'pause' && row.snoozedUntilMs !== null) this.#store.setBudgetSnooze(id, null);
    this.#evaluate(this.#store.budget(id)!, now);
    this.o.notify?.();
    return this.budget(id, who.actorId);
  }

  deleteBudget(id: string, who: Who = UI_OWNER): { id: string } {
    this.#writable();
    const row = this.#store.budget(id);
    if (!row || !this.#sees(who.actorId, 'budget', id)) throw new AppError('NOT_FOUND', 'No such budget.');
    this.#store.deleteBudget(id);
    this.#audit(who, 'budget.delete', 'budget', id, this.#budgetLine(fieldsOf(row)));
    this.o.notify?.();
    return { id };
  }

  snoozeBudget(id: string, until: unknown, who: Who = UI_OWNER): BudgetState {
    this.#writable();
    if (typeof until !== 'string' || !BUDGET_SNOOZE.includes(until)) throw invalid('until', 'Pick 1h, 4h or reset.');
    const b = this.#store.budget(id);
    if (!b || !this.#sees(who.actorId, 'budget', id)) throw new AppError('NOT_FOUND', 'No such budget.');
    if (b.mode === 'pause') throw new AppError('CONFLICT', 'A budget that pauses messages can’t be snoozed. Set it to alerts only first.');
    const now = this.#now();
    const end = until === '1h' ? now + HOUR : until === '4h' ? now + 4 * HOUR : periodBounds(b.period, this.timezone, now).end;
    this.#store.setBudgetSnooze(id, end);
    this.#audit(who, 'budget.snooze', 'budget', id, `snoozed ${until === 'reset' ? 'until it resets' : `for ${until}`}: ${this.#budgetLine(fieldsOf(b))}`);
    this.o.notify?.();
    return this.budget(id, who.actorId);
  }

  unsnoozeBudget(id: string, who: Who = UI_OWNER): BudgetState {
    this.#writable();
    const b = this.#store.budget(id);
    if (!b || !this.#sees(who.actorId, 'budget', id)) throw new AppError('NOT_FOUND', 'No such budget.');
    this.#store.setBudgetSnooze(id, null);
    this.#audit(who, 'budget.unsnooze', 'budget', id, `snooze ended: ${this.#budgetLine(fieldsOf(b))}`);
    this.o.notify?.();
    return this.budget(id, who.actorId);
  }

  /* ---------- Spikes ---------- */

  #cooled(kind: SpikeKind, subject: string, at: number): boolean {
    const last = this.#store.lastSpikeAt(kind, subject);
    return last === null || at - last >= COOLDOWN_MS[kind];
  }

  /** Records an event; an alert goes out unless its subject is snoozed. */
  #record(kind: SpikeKind, subject: string, who: { sessionId: string | null; workspaceId: string; claudeId: string }, evidence: SpikeRow['evidence'], at: number): void {
    const snoozed = (this.#store.spikeSnoozes(at).get(subject) ?? 0) > at;
    // Today everything is the one owner's; with several users this is where the manager of the workspace is found.
    const owner = OWNER_ACTOR;
    const id = this.#store.insertSpike({ atMs: at, kind, subject, sessionId: who.sessionId, workspaceId: who.workspaceId, claudeId: who.claudeId, evidence, alerted: !snoozed, owner });
    if (!snoozed) this.#raise(this.#spikeAlert({ id, atMs: at, kind, subject, sessionId: who.sessionId, workspaceId: who.workspaceId, claudeId: who.claudeId, evidence, owner }));
  }

  /** A spike event as an alert: a rate spike is about a Claude, a loop or a single large request about a session. */
  #spikeAlert(e: Pick<SpikeRow, 'id' | 'atMs' | 'kind' | 'subject' | 'sessionId' | 'workspaceId' | 'claudeId' | 'evidence' | 'owner'>): SpendAlert {
    return {
      kind: 'spike',
      id: `spike|${e.id}`,
      at: iso(e.atMs),
      level: 'near',
      scope: e.kind === 'rate' ? { kind: 'claude', id: e.claudeId, label: this.#claudeName(e.claudeId) } : { kind: 'session', id: e.sessionId, label: null },
      owner: e.owner,
      summary: spikeSummary(e.evidence),
      spikeId: String(e.id),
      spikeKind: e.kind,
      sessionId: e.sessionId,
      // The first row of the continued chain the spike is about: a loop or a large request is recorded under it, a rate spike names it (T-312).
      rootSessionId: e.kind === 'rate' ? e.sessionId : e.subject,
      claudeId: e.claudeId,
      workspaceId: e.workspaceId,
      heuristic: true,
    };
  }

  /** The three rules, for the request just recorded. True when an event was recorded. */
  #spikes(turn: { sessionId: string; workspaceId: string; atMs: number }, claude: string, turnCost: number, at: number): boolean {
    const cfg = spikeSettingsOf(this.o.settings);
    if (!cfg.enabled) return false;
    let hit = false;
    const who = { sessionId: turn.sessionId, workspaceId: turn.workspaceId, claudeId: claude };
    // A chat continued as new rows is one subject (T-312): its rows count together, and the subject (cooldown, snooze) is the chain's first row.
    const known = this.#store.sessions([turn.sessionId]);
    const root = chainRootOf(turn.sessionId, known);

    // A loop between turns: this session (with the rows it continues) finished many requests in a few minutes.
    const w = this.#store.sessionWindow(chainOf(turn.sessionId, known), at - BURST_WINDOW_MIN * MIN, at);
    const burst = burstVerdict(w.requests, { ...cfg, burstWindowMin: BURST_WINDOW_MIN });
    if (burst.state === 'hit' && this.#cooled('burst', root, at)) {
      this.#record('burst', root, who, burstEvidence(burst.evidence.requests, burst.evidence.threshold, w.costUsd), at);
      hit = true;
    }

    // One request far above the median one of this Claude (the median is over the 7 days before it).
    if (turnCost >= cfg.minUsd && turnCost > 0) {
      const out = outlierVerdict(turnCost, this.#store.requestCosts(claude, at - BASELINE_MS, at), cfg);
      if (out.state === 'hit' && this.#cooled('outlier', root, at)) {
        this.#record('outlier', root, who, outlierEvidence(turnCost, out.evidence), at);
        hit = true;
      }
    }

    // The last 15 minutes of this Claude against its usual 15 minutes (checked at most once a minute per Claude).
    if (at - (this.#rateAt.get(claude) ?? -Infinity) >= RATE_EVERY_MS) {
      this.#rateAt.set(claude, at);
      const win = this.#store.claudeWindow(claude, at - RATE_WINDOW_MS, at + 1);
      if (win.costUsd >= cfg.minUsd) {
        const periods = this.#store.activePeriods(claude, at - RATE_WINDOW_MS, at - RATE_WINDOW_MS - BASELINE_MS, RATE_WINDOW_MS);
        const rate = rateVerdict(win.costUsd, periods, cfg);
        if (rate.state === 'hit' && this.#cooled('rate', claude, at)) {
          // The chat that spent most of it: the rows of a continued chain summed under their first row (T-312).
          const all = this.#store.sessions(win.bySession.map((r) => r.sessionId));
          const byRoot = new Map<string, number>();
          for (const r of win.bySession) {
            const k = chainRootOf(r.sessionId, all);
            byRoot.set(k, (byRoot.get(k) ?? 0) + r.costUsd);
          }
          const [lead] = [...byRoot].sort((a, b) => b[1] - a[1]);
          const share = lead && win.costUsd > 0 ? (lead[1] / win.costUsd) * 100 : 0;
          const top = lead && share >= 50 ? { sessionId: lead[0], share: Math.round(share * 100) / 100 } : null;
          this.#record('rate', claude, { ...who, sessionId: top?.sessionId ?? null }, rateEvidence(win.costUsd, rate.evidence, top), at);
          hit = true;
        }
      }
    }
    return hit;
  }

  #spikeEvents(rows: SpikeRow[], now: number): SpikeEvent[] {
    const snoozes = this.#store.spikeSnoozes(now);
    const sessions = this.#store.sessions(rows.flatMap((r) => (r.sessionId ? [r.sessionId] : [])));
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      at: iso(r.atMs),
      heuristic: true as const,
      sessionId: r.sessionId,
      sessionTitle: r.sessionId ? (sessions.get(r.sessionId)?.title ?? null) : null,
      claudeId: r.claudeId,
      claudeName: this.#claudeName(r.claudeId),
      workspaceId: r.workspaceId,
      workspaceName: workspaceNameOf(r.workspaceId),
      evidence: r.evidence,
      summary: spikeSummary(r.evidence),
      alerted: r.alerted,
      owner: r.owner,
      subject: r.subject,
      snoozedUntil: snoozes.has(r.subject) ? iso(snoozes.get(r.subject)!) : null,
    }));
  }

  /** The spike events the actor may see: those of a visible workspace and, when they name one, a visible session. */
  #visibleSpikes(actorId: string, rows: SpikeRow[]): SpikeRow[] {
    if (!this.o.visible) return rows;
    return rows.filter((r) => this.#sees(actorId, 'workspace', r.workspaceId) && (!r.sessionId || this.#sees(actorId, 'session', r.sessionId)));
  }

  spikes(range: unknown = '7d', actorId: string = OWNER_ACTOR): SpikesReport {
    if (typeof range !== 'string' || !(range in SPIKE_RANGES)) throw invalid('range', 'Pick 1d, 7d or 30d.');
    const now = this.#now();
    return {
      range: range as keyof typeof SPIKE_RANGES,
      events: this.#spikeEvents(this.#visibleSpikes(actorId, this.#store.spikesSince(now - SPIKE_RANGES[range as keyof typeof SPIKE_RANGES])), now),
      settings: spikeSettingsOf(this.o.settings),
      now: iso(now),
    };
  }

  snoozeSpikes(subject: unknown, until: unknown, who: Who = UI_OWNER): SpikesReport {
    this.#writable();
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw invalid('subject', 'Name a session or a Claude.');
    if (typeof until !== 'string' || !SPIKE_SNOOZE.includes(until)) throw invalid('until', 'Pick 1h, 4h or day.');
    const now = this.#now();
    this.#store.setSpikeSnooze(subject, now + (until === '1h' ? HOUR : until === '4h' ? 4 * HOUR : DAY));
    this.#audit(who, 'spike.snooze', 'spike_subject', subject, `spike alerts for ${subject} snoozed for ${until}`);
    this.o.notify?.();
    return this.spikes('7d', who.actorId);
  }

  unsnoozeSpikes(subject: unknown, who: Who = UI_OWNER): SpikesReport {
    this.#writable();
    if (typeof subject !== 'string' || !subject.trim()) throw invalid('subject', 'Name a session or a Claude.');
    this.#store.setSpikeSnooze(subject, null);
    this.#audit(who, 'spike.unsnooze', 'spike_subject', subject, `spike alerts for ${subject} no longer snoozed`);
    this.o.notify?.();
    return this.spikes('7d', who.actorId);
  }

  /** The spike events about a session and the ones below it (an agent's view). */
  spikesOf(sessionId: string, range: unknown = '7d', actorId: string = OWNER_ACTOR): SpikeEvent[] {
    const own = new Set([sessionId, ...this.#store.descendants(sessionId)]);
    return this.spikes(range, actorId).events.filter((e) => e.sessionId && own.has(e.sessionId));
  }

  /* ---------- Alerts and the summary ---------- */

  /** The last day's alerts that are not snoozed, newest first (a new device is not told old news: only the current period's budget alerts). */
  alerts(actorId: string = OWNER_ACTOR): SpendAlert[] {
    const now = this.#now();
    const out: SpendAlert[] = [];
    const tz = this.timezone;
    for (const b of this.#store.budgets()) {
      const m = b.mark;
      if (!m || m.quiet || !b.enabled || now - m.atMs > ALERT_WINDOW_MS || !this.#sees(actorId, 'budget', b.id)) continue;
      if (b.snoozedUntilMs !== null && b.snoozedUntilMs > now) continue;
      const bounds = periodBounds(b.period, tz, now);
      if (m.periodStartMs !== bounds.start) continue; // told for a period that is over
      out.push(this.#budgetAlert(b, m, { scopeLabel: this.#scopeLabel(b.scope), periodEnd: iso(bounds.end) }));
    }
    const snoozes = this.#store.spikeSnoozes(now);
    for (const e of this.#visibleSpikes(actorId, this.#store.spikesSince(now - ALERT_WINDOW_MS))) {
      if (!e.alerted || snoozes.has(e.subject)) continue;
      out.push(this.#spikeAlert(e));
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  summary(actorId: string = OWNER_ACTOR): SpendSummary {
    const now = this.#now();
    const tz = this.timezone;
    const states = this.budgets(actorId).budgets;
    const live = states.filter((s) => s.budget.enabled);
    return {
      today: this.#totals(actorId, periodBounds('day', tz, now).start, now + 1),
      week: this.#totals(actorId, periodBounds('week', tz, now).start, now + 1),
      month: this.#totals(actorId, periodBounds('month', tz, now).start, now + 1),
      timezone: tz,
      budgets: {
        total: states.length,
        near: live.filter((s) => s.level === 'near').length,
        high: live.filter((s) => s.level === 'high').length,
        exhausted: live.filter((s) => s.level === 'exhausted').length,
        paused: live.filter((s) => s.paused).length,
      },
      spikes24h: this.#visibleSpikes(actorId, this.#store.spikesSince(now - DAY)).length,
      alerts: this.alerts(actorId),
      now: iso(now),
    };
  }

  /* ---------- Attribution ---------- */

  #claudeName(claudeId: string): string {
    if (claudeId.startsWith('default:')) return 'Default';
    return this.#store.claudes().get(claudeId)?.name ?? 'Claude';
  }

  /** The window's requests grouped by one dimension, for what `actorId` may see (§22). */
  attribution(q: AttributionQuery = {}, actorId: string = OWNER_ACTOR): AttributionReport {
    const by = (q.by ?? 'session') as AttributionBy;
    if (!(ATTRIBUTION_BY as readonly unknown[]).includes(by)) throw invalid('by', `Pick ${ATTRIBUTION_BY.join(', ')}.`);
    const range = (q.range ?? '7d') as ChatUsageRange;
    if (!(CHAT_USAGE_RANGES as readonly unknown[]).includes(range)) throw invalid('range', `Pick ${CHAT_USAGE_RANGES.join(', ')}.`);
    let limit = DEFAULT_LIMIT;
    if (q.limit !== undefined && q.limit !== '') {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw invalid('limit', `Use a whole number from 1 to ${MAX_LIMIT}.`);
      limit = n;
    }
    const now = this.#now();
    const from = now - RANGE_MS[range];
    const tree = q.sessionId ? new Set([q.sessionId, ...this.#store.descendants(q.sessionId)]) : undefined;
    const rows = this.#visibleRows(
      actorId,
      this.#store.usageRows(from, now + 1, { ...(q.claudeId ? { claudeId: q.claudeId } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}), ...(tree ? { sessionIds: tree } : {}) }),
    );
    const ids = new Set(rows.map((r) => r.sessionId));
    const sessions = this.#store.sessions(ids);
    // An agent's view of its own tree starts at its own session: nothing above it is shown, neither its parent nor a chat it continues (T-312),
    // and a continuation link that leaves the tree is not followed.
    if (tree) {
      for (const [id, s] of sessions) {
        if (id === q.sessionId) sessions.set(id, { ...s, parentId: null, continuedFrom: null });
        else if (s.continuedFrom && !tree.has(s.continuedFrom)) sessions.set(id, { ...s, continuedFrom: null });
      }
    }
    const personas = by === 'persona' ? this.#store.personaRecords(ids) : new Map();
    const a =
      by === 'ticket'
        ? ticketReport(this.#store, { rows, sessions, fromMs: from, toMs: now + 1, limit, doneOnly: q.done === true })
        : attribute({
            by,
            rows,
            sessions,
            personas,
            limit,
            claudeName: (claudeId) => this.#claudeName(claudeId),
            personaName: (poolId, recorded) => {
              try {
                return this.o.personaName?.(poolId) ?? recorded ?? 'Persona';
              } catch {
                return recorded ?? 'Persona';
              }
            },
          });
    return {
      by,
      range,
      from: iso(from),
      to: iso(now),
      totals: a.totals,
      side: a.side,
      rows: a.rows,
      coverage: a.coverage,
      more: a.more,
      now: iso(now),
      ...(by === 'ticket' ? { leadBasis: ATTRIBUTION_LEAD_BASIS, ...(q.done === true ? { doneOnly: true } : {}), ...(a.doneByType ? { doneByType: a.doneByType } : {}) } : {}),
    };
  }

  /** The audit trail of what people changed here, newest first (`limit` 1 to 200, default 50). */
  audit(limit: unknown = 50): SpendAuditEntry[] {
    const n = limit === undefined || limit === '' ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw invalid('limit', 'Use a whole number from 1 to 200.');
    return this.#store.audit(n);
  }

  /** The workspace and Claude a session runs in (its live row, else what was kept from its last request), or null when nothing is known of it. */
  sessionScope(sessionId: string): { workspaceId: string; claudeId: string } | null {
    const s = this.#store.sessions([sessionId]).get(sessionId);
    return s ? { workspaceId: s.workspaceId, claudeId: s.claudeId } : null;
  }

  /** Every session below this one, for a caller that needs to tell whether a session is in a tree. */
  descendants(sessionId: string): Set<string> {
    return this.#store.descendants(sessionId);
  }

  /** Test seam: the SQL layer. */
  get store(): SpendStore {
    return this.#store;
  }
}
