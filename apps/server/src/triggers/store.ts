// The triggers' tables (migration 210, docs/prd/triggers.md §13): `triggers`, `trigger_runs`, `trigger_deliveries` (platform-wide, 7 days)
// and `trigger_counts` (what is counted, not stored). The signing secret and the receiver path's token are SEALED (ENCRYPTED_COLUMNS); the
// receiver finds a trigger by the SHA-256 of its token. Nothing here decides a right: callers pass the owner they checked, and every
// owner-scoped read takes it (null = an admin's view of all).

import { createHash, randomBytes } from 'node:crypto';
import {
  estimatedFigure,
  HOOK_DELIVERY_TTL_DAYS,
  HOOK_PREFIX,
  type CiFailedSpec,
  type CronSpec,
  type Trigger,
  type TriggerAction,
  type TriggerApproval,
  type TriggerEventFacts,
  type TriggerLimits,
  type TriggerReason,
  type TriggerRun,
  type TriggerRunState,
  type TriggerSource,
  type WebhookSpec,
} from '@portal/contracts';
import type { Store } from '../store/store.js';

export const RUN_RETENTION_DAYS = 90;
const EVENT_MAX = 4096;
export const ACTIVE_STATES: TriggerRunState[] = ['starting', 'running'];
export const ENDED_STATES: TriggerRunState[] = ['succeeded', 'failed', 'skipped', 'denied', 'expired', 'stopped'];

export interface TriggerRow {
  id: string;
  owner_id: string;
  created_by: string;
  name: string;
  enabled: number;
  source: TriggerSource;
  spec: string;
  action: string;
  limits: string;
  approval: string;
  secret: string | null;
  secret_mode: 'generated' | 'provided';
  path_token: string | null;
  token_hash: string | null;
  paused: string | null;
  runs: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface RunRow {
  id: string;
  trigger_id: string;
  owner_id: string;
  number: number;
  at: string;
  state: TriggerRunState;
  reason: string | null;
  event: string;
  delivery_id: string | null;
  session_id: string | null;
  ticket_id: string | null;
  cost_usd: number;
  started_at: string | null;
  ended_at: string | null;
  expires_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

/** The parts of a trigger the pipeline works with, parsed. */
export interface TriggerRecord {
  id: string;
  ownerId: string;
  name: string;
  enabled: boolean;
  source: TriggerSource;
  cron: CronSpec | null;
  webhook: WebhookSpec | null;
  ciFailed: CiFailedSpec | null;
  action: TriggerAction;
  limits: TriggerLimits;
  approval: TriggerApproval;
  secretMode: 'generated' | 'provided';
  secretSet: boolean;
  paused: string | null;
  runs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const newTriggerId = () => `trg_${randomBytes(6).toString('hex')}`;
export const newRunId = () => `run_${randomBytes(6).toString('hex')}`;
export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const slot = (id: string, column: 'secret' | 'path_token') => ({ table: 'triggers', row: id, column });

export function recordOf(r: TriggerRow): TriggerRecord {
  const spec = JSON.parse(r.spec) as { cron?: CronSpec; webhook?: WebhookSpec; ciFailed?: CiFailedSpec };
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    enabled: r.enabled === 1,
    source: r.source,
    cron: r.source === 'cron' ? (spec.cron ?? null) : null,
    webhook: r.source === 'webhook' ? (spec.webhook ?? null) : null,
    ciFailed: r.source === 'ci_failed' ? (spec.ciFailed ?? null) : null,
    action: JSON.parse(r.action) as TriggerAction,
    limits: JSON.parse(r.limits) as TriggerLimits,
    approval: JSON.parse(r.approval) as TriggerApproval,
    secretMode: r.secret_mode,
    secretSet: r.secret !== null,
    paused: r.paused,
    runs: r.runs,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** What to write for a new or changed trigger. */
export interface TriggerWrite {
  name: string;
  enabled: boolean;
  source: TriggerSource;
  cron: CronSpec | null;
  webhook: WebhookSpec | null;
  ciFailed: CiFailedSpec | null;
  action: TriggerAction;
  limits: TriggerLimits;
  approval: TriggerApproval;
  nextRunAt: string | null;
}

const specJson = (w: Pick<TriggerWrite, 'source' | 'cron' | 'webhook' | 'ciFailed'>) =>
  JSON.stringify(w.source === 'cron' ? { cron: w.cron } : w.source === 'webhook' ? { webhook: w.webhook } : { ciFailed: w.ciFailed });

export class TriggerStore {
  constructor(
    readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db) throw new Error('The database is not available.');
    return db;
  }

  get writable(): boolean {
    return this.store.writable;
  }

  /* ---------- Triggers ---------- */

  row(id: string): TriggerRow | null {
    if (!this.store.db || typeof id !== 'string' || id.length > 40) return null;
    return (this.store.db.prepare('SELECT * FROM triggers WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as TriggerRow | undefined) ?? null;
  }

  get(id: string): TriggerRecord | null {
    const r = this.row(id);
    return r ? recordOf(r) : null;
  }

  /** Live triggers of an owner, or of everyone (`null`), newest first. */
  list(ownerId: string | null): TriggerRecord[] {
    if (!this.store.db) return [];
    const rows = (
      ownerId === null
        ? this.store.db.prepare('SELECT * FROM triggers WHERE deleted_at IS NULL ORDER BY created_at DESC').all()
        : this.store.db.prepare('SELECT * FROM triggers WHERE deleted_at IS NULL AND owner_id = ? ORDER BY created_at DESC').all(ownerId)
    ) as unknown as TriggerRow[];
    return rows.map(recordOf);
  }

  /** Every live trigger of a source (the scheduler, the CI source). */
  bySource(source: TriggerSource): TriggerRecord[] {
    if (!this.store.db) return [];
    return (this.store.db.prepare('SELECT * FROM triggers WHERE deleted_at IS NULL AND source = ?').all(source) as unknown as TriggerRow[]).map(recordOf);
  }

  /** The receiver's lookup: by the hash of the path token, never by the token. */
  byTokenHash(hash: string): TriggerRow | null {
    if (!this.store.db) return null;
    return (this.store.db.prepare('SELECT * FROM triggers WHERE token_hash = ? AND deleted_at IS NULL').get(hash) as unknown as TriggerRow | undefined) ?? null;
  }

  insert(id: string, ownerId: string, createdBy: string, w: TriggerWrite): void {
    const at = this.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO triggers (id, owner_id, created_by, name, enabled, source, spec, action, limits, approval, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ownerId, createdBy, w.name, w.enabled ? 1 : 0, w.source, specJson(w), JSON.stringify(w.action), JSON.stringify(w.limits), JSON.stringify(w.approval), w.nextRunAt, at, at);
  }

  update(id: string, w: TriggerWrite): void {
    this.#db
      .prepare('UPDATE triggers SET name = ?, enabled = ?, spec = ?, action = ?, limits = ?, approval = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(w.name, w.enabled ? 1 : 0, specJson(w), JSON.stringify(w.action), JSON.stringify(w.limits), JSON.stringify(w.approval), w.nextRunAt, this.now().toISOString(), id);
  }

  setEnabled(id: string, enabled: boolean, paused: string | null): void {
    this.#db.prepare('UPDATE triggers SET enabled = ?, paused = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, paused, this.now().toISOString(), id);
  }

  setNextRun(id: string, nextRunAt: string | null): void {
    this.#db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
  }

  /** The trigger fired: its run counter and last time; returns the run's number. */
  bumpRuns(id: string, at: string): number {
    this.#db.prepare('UPDATE triggers SET runs = runs + 1, last_run_at = ? WHERE id = ?').run(at, id);
    return Number((this.#db.prepare('SELECT runs FROM triggers WHERE id = ?').get(id) as { runs: number } | undefined)?.runs ?? 0);
  }

  /** Soft delete: the secret, the token and its hash go at once (the path answers 404); runs stay 90 days. */
  remove(id: string): void {
    const at = this.now().toISOString();
    this.#db.prepare('UPDATE triggers SET deleted_at = ?, enabled = 0, secret = NULL, path_token = NULL, token_hash = NULL, next_run_at = NULL, updated_at = ? WHERE id = ?').run(at, at, id);
  }

  /* ---------- Sealed values ---------- */

  /** A new receiver token (`cpwh_` + 24 random bytes), sealed, its hash for lookup. Returns the token. Throws while Locked. */
  newPathToken(id: string): string {
    const box = this.store.secrets;
    if (!box) throw new Error('locked');
    const token = `cpwh_${randomBytes(24).toString('base64url')}`;
    this.#db.prepare('UPDATE triggers SET path_token = ?, token_hash = ?, updated_at = ? WHERE id = ?').run(box.seal(token, slot(id, 'path_token')), tokenHash(token), this.now().toISOString(), id);
    return token;
  }

  /** Sets the signing secret (sealed); null clears it (every delivery then answers 401). Throws while Locked. */
  setSecret(id: string, secret: string | null, mode: 'generated' | 'provided'): void {
    const box = this.store.secrets;
    if (secret !== null && !box) throw new Error('locked');
    this.#db.prepare('UPDATE triggers SET secret = ?, secret_mode = ?, updated_at = ? WHERE id = ?').run(secret === null ? null : box!.seal(secret, slot(id, 'secret')), mode, this.now().toISOString(), id);
  }

  /** The signing secret, or null (none set, Locked, or sealed under another key). */
  secret(row: TriggerRow): string | null {
    const box = this.store.secrets;
    if (!box || !row.secret) return null;
    try {
      return box.open(row.secret, slot(row.id, 'secret'));
    } catch {
      return null;
    }
  }

  /** The receiver path, `/hooks/<token>`, for the owner's own page; '' while Locked. */
  path(row: TriggerRow): string {
    const box = this.store.secrets;
    if (!box || !row.path_token) return '';
    try {
      return `${HOOK_PREFIX}${box.open(row.path_token, slot(row.id, 'path_token'))}`;
    } catch {
      return '';
    }
  }

  /* ---------- Runs ---------- */

  insertRun(r: { id: string; triggerId: string; ownerId: string; number: number; state: TriggerRunState; reason: TriggerReason | null; event: TriggerEventFacts; deliveryId: string | null; expiresAt?: string | null }): void {
    let event = JSON.stringify(r.event);
    if (event.length > EVENT_MAX) event = JSON.stringify({ ...r.event, untrusted: {} });
    this.#db
      .prepare('INSERT INTO trigger_runs (id, trigger_id, owner_id, created_by, number, at, state, reason, event, delivery_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.triggerId, r.ownerId, r.ownerId, r.number, r.event.at, r.state, r.reason, event, r.deliveryId, r.expiresAt ?? null);
  }

  runRow(id: string): RunRow | null {
    if (!this.store.db || typeof id !== 'string' || id.length > 40) return null;
    return (this.store.db.prepare('SELECT * FROM trigger_runs WHERE id = ?').get(id) as unknown as RunRow | undefined) ?? null;
  }

  /** Changes a run's state; with `from`, only when it is still in one of those states (one winner). Returns whether it changed. */
  setRun(id: string, patch: Partial<{ state: TriggerRunState; reason: TriggerReason | null; session_id: string | null; ticket_id: string | null; cost_usd: number; started_at: string | null; ended_at: string | null; approved_by: string | null; approved_at: string | null; expires_at: string | null }>, from?: TriggerRunState[]): boolean {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    if (!cols.length) return false;
    const where = from?.length ? ` AND state IN (${from.map(() => '?').join(', ')})` : '';
    const r = this.#db.prepare(`UPDATE trigger_runs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?${where}`).run(...cols.map((c) => patch[c] ?? null), id, ...(from ?? []));
    return Number(r.changes) > 0;
  }

  view(r: RunRow, triggerName: string): TriggerRun {
    return {
      id: r.id,
      triggerId: r.trigger_id,
      triggerName,
      ownerId: r.owner_id,
      at: r.at,
      state: r.state,
      reason: (r.reason as TriggerReason | null) ?? null,
      event: JSON.parse(r.event) as TriggerEventFacts,
      deliveryId: r.delivery_id,
      sessionId: r.session_id,
      ticketId: r.ticket_id,
      costUsd: estimatedFigure(Math.round(r.cost_usd * 10_000) / 10_000),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      approval: r.approved_by && r.approved_at ? { by: r.approved_by, at: r.approved_at } : null,
    };
  }

  /** A page of runs, newest first: of one trigger, or of an owner (null: everyone's). */
  runs(f: { triggerId?: string; ownerId: string | null; before?: string; limit?: number; state?: TriggerRunState }): { rows: RunRow[]; next: string | null } {
    if (!this.store.db) return { rows: [], next: null };
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.triggerId) (where.push('trigger_id = ?'), args.push(f.triggerId));
    if (f.ownerId !== null) (where.push('owner_id = ?'), args.push(f.ownerId));
    if (f.state) (where.push('state = ?'), args.push(f.state));
    if (f.before) (where.push('at < ?'), args.push(f.before));
    const limit = Math.max(1, Math.min(200, Math.floor(f.limit ?? 50)));
    const rows = this.store.db.prepare(`SELECT * FROM trigger_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (state = 'pending_approval') DESC, at DESC, id DESC LIMIT ${limit + 1}`).all(...args) as unknown as RunRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return { rows: page, next: more ? (page[page.length - 1]?.at ?? null) : null };
  }

  /** Runs in these states (the watcher, expiry, the parallel caps). */
  runsIn(states: TriggerRunState[]): RunRow[] {
    if (!this.store.db) return [];
    return this.store.db.prepare(`SELECT * FROM trigger_runs WHERE state IN (${states.map(() => '?').join(', ')})`).all(...states) as unknown as RunRow[];
  }

  /** Active (`starting` or `running`) runs: of this trigger, of its owner, of all. */
  activeCounts(triggerId: string, ownerId: string, exceptRunId?: string): { trigger: number; owner: number; total: number } {
    const rows = this.runsIn(ACTIVE_STATES).filter((r) => r.id !== exceptRunId);
    return { trigger: rows.filter((r) => r.trigger_id === triggerId).length, owner: rows.filter((r) => r.owner_id === ownerId).length, total: rows.length };
  }

  /** Runs of a trigger that STARTED (have a start time) at or after `sinceIso`. */
  startedSince(triggerId: string, sinceIso: string): number {
    if (!this.store.db) return 0;
    return Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_id = ? AND started_at IS NOT NULL AND started_at >= ?').get(triggerId, sinceIso) as { n: number }).n);
  }

  /** The estimated cost of the runs of a trigger started at or after `sinceIso`. */
  costSince(triggerId: string, sinceIso: string): number {
    if (!this.store.db) return 0;
    return Number((this.store.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM trigger_runs WHERE trigger_id = ? AND started_at IS NOT NULL AND started_at >= ?').get(triggerId, sinceIso) as { c: number }).c);
  }

  /** Stored skips of a trigger in the last hour (FR7: at most 120 are stored). */
  skipsSince(triggerId: string, sinceIso: string): number {
    if (!this.store.db) return 0;
    return Number((this.store.db.prepare("SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_id = ? AND state = 'skipped' AND at >= ?").get(triggerId, sinceIso) as { n: number }).n);
  }

  /** The runs of a trigger (any state) whose session or ticket is known: for the CI loop guard. */
  startedWork(triggerId: string): { sessionId: string | null; ticketId: string | null }[] {
    if (!this.store.db) return [];
    return (this.store.db.prepare('SELECT session_id, ticket_id FROM trigger_runs WHERE trigger_id = ? AND (session_id IS NOT NULL OR ticket_id IS NOT NULL)').all(triggerId) as { session_id: string | null; ticket_id: string | null }[]).map((r) => ({ sessionId: r.session_id, ticketId: r.ticket_id }));
  }

  /** CI events of a trigger since a time, for the loop guard (cooldown and the daily cap per branch): their facts. */
  ciRunsSince(triggerId: string, sinceIso: string): TriggerEventFacts[] {
    if (!this.store.db) return [];
    return (this.store.db.prepare("SELECT event FROM trigger_runs WHERE trigger_id = ? AND at >= ? AND state NOT IN ('skipped')").all(triggerId, sinceIso) as { event: string }[]).map((r) => JSON.parse(r.event) as TriggerEventFacts);
  }

  /* ---------- Deliveries and counts ---------- */

  /** Records a delivery id for 7 days; false when it was already there (a duplicate). */
  firstDelivery(triggerId: string, deliveryId: string): boolean {
    const r = this.#db.prepare('INSERT OR IGNORE INTO trigger_deliveries (trigger_id, delivery_id, at) VALUES (?, ?, ?)').run(triggerId, deliveryId, this.now().toISOString());
    return Number(r.changes) > 0;
  }

  count(triggerId: string, kind: 'filtered' | 'duplicate' | 'dropped' | 'ignored'): void {
    if (!this.store.writable) return;
    const day = this.now().toISOString().slice(0, 10);
    this.#db.prepare('INSERT INTO trigger_counts (trigger_id, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (trigger_id, day, kind) DO UPDATE SET n = n + 1').run(triggerId, day, kind);
  }

  counts(triggerId: string, day: string): Record<string, number> {
    if (!this.store.db) return {};
    const rows = this.store.db.prepare('SELECT kind, n FROM trigger_counts WHERE trigger_id = ? AND day = ?').all(triggerId, day) as { kind: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  /** Retention: delivery ids after 7 days, runs and counts after 90, deleted triggers after 90. */
  sweep(): void {
    if (!this.store.writable) return;
    const now = this.now().getTime();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    this.#db.prepare('DELETE FROM trigger_deliveries WHERE at < ?').run(ago(HOOK_DELIVERY_TTL_DAYS));
    this.#db.prepare(`DELETE FROM trigger_runs WHERE at < ? AND state IN (${ENDED_STATES.map(() => '?').join(', ')})`).run(ago(RUN_RETENTION_DAYS), ...ENDED_STATES);
    this.#db.prepare('DELETE FROM trigger_counts WHERE day < ?').run(ago(RUN_RETENTION_DAYS).slice(0, 10));
    this.#db.prepare('DELETE FROM triggers WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(ago(RUN_RETENTION_DAYS));
  }
}

/** A trigger as the wire carries it (`Trigger`): never the secret, the path only for its own page. */
export function triggerView(rec: TriggerRecord, extra: { path: string; runsToday: number; costToday: number }): Trigger {
  return {
    id: rec.id,
    ownerId: rec.ownerId,
    name: rec.name,
    enabled: rec.enabled,
    source: rec.source,
    cron: rec.cron,
    webhook: rec.webhook ? { ...rec.webhook, path: extra.path, secretSet: rec.secretSet, secretMode: rec.secretMode } : null,
    ciFailed: rec.ciFailed,
    action: rec.action,
    limits: rec.limits,
    approval: rec.approval,
    nextRunAt: rec.enabled ? rec.nextRunAt : null,
    lastRunAt: rec.lastRunAt,
    runsToday: extra.runsToday,
    costToday: estimatedFigure(Math.round(extra.costToday * 100) / 100),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}
