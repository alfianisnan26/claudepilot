// Keep going's rows (migration 790): a chat's policy and the sweep's state for it, the trail (one row per action: fixed sentences, never
// message text), and the reports (one row per chat and cause; `cleared_at` null while it stands). The trail is kept 30 days.

import {
  KEEPGOING_ACTIONS,
  KEEPGOING_BOUNDS as B,
  KEEPGOING_CAUSES,
  KEEPGOING_PAUSE_ALL,
  KEEPGOING_RESTART_CLASSES,
  type ChatKeepGoingPolicy,
  type KeepGoingAction,
  type KeepGoingActionKind,
  type KeepGoingCause,
  type KeepGoingPause,
  type KeepGoingRestartClass,
} from '@portal/contracts';
import type { Store } from '../store/store.js';

const DAY_MS = 86_400_000;
const RETENTION_MS = 30 * DAY_MS;

/** A chat's policy and the sweep's own state for it. */
export interface PolicyRow extends ChatKeepGoingPolicy {
  sessionId: string;
  ownerId: string;
  /** When the sweep looks at it next (null: at the next round). */
  nextDueAt: string | null;
  /** The idle period already nudged: the chat's `lastActivityAt` after the nudge. */
  nudgedPeriod: string | null;
  /** A wake happened: the next look at an idle chat nudges at once. */
  continueOwed: boolean;
  /** After a failed action: left alone until then. */
  backoffUntil: string | null;
  updatedAt: string;
}

export interface ReportRow {
  sessionId: string;
  cause: KeepGoingCause;
  since: string;
  reportedAt: string;
  clearedAt: string | null;
  ticketId: string | null;
}

export type StatePatch = Partial<Pick<PolicyRow, 'nextDueAt' | 'nudgedPeriod' | 'continueOwed' | 'backoffUntil' | 'enabled'>>;

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const asAction = (v: unknown): KeepGoingActionKind => ((KEEPGOING_ACTIONS as readonly unknown[]).includes(v) ? (v as KeepGoingActionKind) : 'failed');
const asCause = (v: unknown): KeepGoingCause | null => ((KEEPGOING_CAUSES as readonly unknown[]).includes(v) ? (v as KeepGoingCause) : null);

function policyOf(r: Raw): PolicyRow {
  return {
    sessionId: String(r.session_id),
    ownerId: String(r.owner_id),
    enabled: r.enabled === 1,
    nudgeAfterMin: num(r.nudge_after_min, B.nudgeAfterMin.default),
    prompt: str(r.prompt),
    statusFile: str(r.status_file),
    maxNudgesPerDay: num(r.max_nudges, B.maxNudgesPerDay.default),
    maxWakesPerDay: num(r.max_wakes, B.maxWakesPerDay.default),
    program: str(r.program),
    nextDueAt: str(r.next_due_at),
    nudgedPeriod: str(r.nudged_period),
    continueOwed: r.continue_owed === 1,
    backoffUntil: str(r.backoff_until),
    updatedAt: String(r.updated_at),
  };
}

const reportOf = (r: Raw): ReportRow => ({
  sessionId: String(r.session_id),
  cause: asCause(r.cause) ?? 'ended',
  since: String(r.since),
  reportedAt: String(r.reported_at),
  clearedAt: str(r.cleared_at),
  ticketId: str(r.ticket_id),
});

export class KeepGoingStore {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #db() {
    return this.store.db;
  }
  /** Null while the store is read-only (frozen, locked): nothing is written and the sweep acts on nothing. */
  get #w() {
    return this.store.writable ? this.store.db : null;
  }
  get writable(): boolean {
    return !!this.#w;
  }
  #at() {
    return this.now().toISOString();
  }

  /* ---------- the policy ---------- */

  policy(sessionId: string): PolicyRow | null {
    const r = this.#db?.prepare('SELECT * FROM keepgoing_policies WHERE session_id = ?').get(sessionId) as Raw | undefined;
    return r ? policyOf(r) : null;
  }

  /** Writes a person's choice (fields absent stay); a new row starts from the defaults. Turning it on makes the chat due at once. */
  setPolicy(sessionId: string, ownerId: string, by: string, patch: Partial<ChatKeepGoingPolicy>): PolicyRow {
    const db = this.#w;
    if (!db) throw new Error('read-only');
    const at = this.#at();
    const was = this.policy(sessionId);
    const next: ChatKeepGoingPolicy = {
      enabled: patch.enabled ?? was?.enabled ?? false,
      nudgeAfterMin: patch.nudgeAfterMin ?? was?.nudgeAfterMin ?? B.nudgeAfterMin.default,
      prompt: patch.prompt !== undefined ? patch.prompt : (was?.prompt ?? null),
      statusFile: patch.statusFile !== undefined ? patch.statusFile : (was?.statusFile ?? null),
      maxNudgesPerDay: patch.maxNudgesPerDay ?? was?.maxNudgesPerDay ?? B.maxNudgesPerDay.default,
      maxWakesPerDay: patch.maxWakesPerDay ?? was?.maxWakesPerDay ?? B.maxWakesPerDay.default,
      program: patch.program !== undefined ? patch.program : (was?.program ?? null),
    };
    const turnedOn = next.enabled && !was?.enabled;
    if (!was) {
      db.prepare(
        `INSERT INTO keepgoing_policies (session_id, owner_id, created_by, enabled, nudge_after_min, prompt, status_file, max_nudges, max_wakes, program, next_due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, ownerId, by, next.enabled ? 1 : 0, next.nudgeAfterMin, next.prompt, next.statusFile, next.maxNudgesPerDay, next.maxWakesPerDay, next.program ?? null, null, at, at);
    } else {
      db.prepare(
        `UPDATE keepgoing_policies SET enabled = ?, nudge_after_min = ?, prompt = ?, status_file = ?, max_nudges = ?, max_wakes = ?, program = ?, updated_at = ?${turnedOn ? ', next_due_at = NULL, backoff_until = NULL' : ''}
         WHERE session_id = ?`,
      ).run(next.enabled ? 1 : 0, next.nudgeAfterMin, next.prompt, next.statusFile, next.maxNudgesPerDay, next.maxWakesPerDay, next.program ?? null, at, sessionId);
    }
    return this.policy(sessionId)!;
  }

  /** The sweep's own state. */
  patchState(sessionId: string, p: StatePatch): void {
    const db = this.#w;
    if (!db) return;
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), vals.push(v));
    if (p.nextDueAt !== undefined) set('next_due_at', p.nextDueAt);
    if (p.nudgedPeriod !== undefined) set('nudged_period', p.nudgedPeriod);
    if (p.continueOwed !== undefined) set('continue_owed', p.continueOwed ? 1 : 0);
    if (p.backoffUntil !== undefined) set('backoff_until', p.backoffUntil);
    if (p.enabled !== undefined) set('enabled', p.enabled ? 1 : 0);
    if (!sets.length) return;
    db.prepare(`UPDATE keepgoing_policies SET ${sets.join(', ')} WHERE session_id = ?`).run(...vals, sessionId);
  }

  /** Policies that are on and due now, the longest waiting first; at most `limit`. */
  due(nowIso: string, limit: number): PolicyRow[] {
    const rows = this.#db?.prepare('SELECT * FROM keepgoing_policies WHERE enabled = 1 AND (next_due_at IS NULL OR next_due_at <= ?) ORDER BY next_due_at IS NOT NULL, next_due_at LIMIT ?').all(nowIso, limit) as Raw[] | undefined;
    return (rows ?? []).map(policyOf);
  }

  /** Every policy that is on (the Home card), at most `limit`. */
  enabled(limit = 200): PolicyRow[] {
    const rows = this.#db?.prepare('SELECT * FROM keepgoing_policies WHERE enabled = 1 ORDER BY updated_at DESC LIMIT ?').all(limit) as Raw[] | undefined;
    return (rows ?? []).map(policyOf);
  }

  /**
   * A chat was started again as `to` (slice 2): its policy goes with it, as the person set it (who set it first stays `created_by`), on and
   * due at once; the ended chat's policy is turned off, so the sweep looks only at the new one. One transaction.
   */
  carryPolicy(from: string, to: string): PolicyRow | null {
    const db = this.#w;
    const was = this.policy(from);
    if (!db || !was) return null;
    const at = this.#at();
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO keepgoing_policies (session_id, owner_id, created_by, enabled, nudge_after_min, prompt, status_file, max_nudges, max_wakes, program, next_due_at, created_at, updated_at)
         SELECT ?, owner_id, created_by, 1, nudge_after_min, prompt, status_file, max_nudges, max_wakes, program, NULL, ?, ? FROM keepgoing_policies WHERE session_id = ?
         ON CONFLICT (session_id) DO UPDATE SET enabled = 1, nudge_after_min = excluded.nudge_after_min, prompt = excluded.prompt, status_file = excluded.status_file, program = excluded.program,
           max_nudges = excluded.max_nudges, max_wakes = excluded.max_wakes, next_due_at = NULL, backoff_until = NULL, updated_at = excluded.updated_at`,
      ).run(to, at, at, from);
      db.prepare('UPDATE keepgoing_policies SET enabled = 0, updated_at = ? WHERE session_id = ?').run(at, from);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return this.policy(to);
  }

  /* ---------- the pause switch (slice 3) ---------- */

  /** The pauses that stand: all first, then by program. */
  pauses(): KeepGoingPause[] {
    const rows = this.#db?.prepare('SELECT * FROM keepgoing_pauses ORDER BY scope').all() as Raw[] | undefined;
    return (rows ?? []).map((r) => ({ program: r.scope === KEEPGOING_PAUSE_ALL ? null : String(r.scope), reason: String(r.reason), since: String(r.since), by: String(r.by) }));
  }

  /** Pauses a program (null: all); a pause that stands keeps its `since` and takes the new reason. */
  pause(program: string | null, reason: string, by: string): KeepGoingPause {
    const db = this.#w;
    if (!db) throw new Error('read-only');
    db.prepare('INSERT INTO keepgoing_pauses (scope, reason, since, by) VALUES (?, ?, ?, ?) ON CONFLICT (scope) DO UPDATE SET reason = excluded.reason, by = excluded.by').run(
      program ?? KEEPGOING_PAUSE_ALL,
      reason,
      this.#at(),
      by,
    );
    return this.pauses().find((p) => p.program === program)!;
  }

  /** Resumes a program (null: all); false when it was not paused. */
  resume(program: string | null): boolean {
    const db = this.#w;
    if (!db) throw new Error('read-only');
    return Number(db.prepare('DELETE FROM keepgoing_pauses WHERE scope = ?').run(program ?? KEEPGOING_PAUSE_ALL).changes) > 0;
  }

  /** Makes every policy that is on and in `program` (null: all) due at the next round (a resume looks again at once; a back-off after a failure stands). */
  dueNow(program: string | null): void {
    const db = this.#w;
    if (!db) return;
    if (program === null) db.prepare('UPDATE keepgoing_policies SET next_due_at = NULL WHERE enabled = 1').run();
    else db.prepare('UPDATE keepgoing_policies SET next_due_at = NULL WHERE enabled = 1 AND program = ?').run(program);
  }

  /** Removes a chat's policy (the chat was deleted). */
  forget(sessionId: string): void {
    const db = this.#w;
    if (!db) return;
    db.prepare('DELETE FROM keepgoing_policies WHERE session_id = ?').run(sessionId);
  }

  /* ---------- the trail ---------- */

  /** `cause`: a report's cause, or for `restarted` the class of the ending (read back by `restarts`, shown as no cause). */
  addEvent(e: { sessionId: string; ownerId: string; kind: KeepGoingActionKind; cause?: KeepGoingCause | KeepGoingRestartClass | null; reason: string; actor: string }): KeepGoingAction {
    const at = this.#at();
    this.#w?.prepare('INSERT INTO keepgoing_events (session_id, owner_id, at, kind, cause, reason, actor) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.sessionId, e.ownerId, at, e.kind, e.cause ?? null, e.reason.slice(0, 300), e.actor);
    return { at, kind: e.kind, cause: asCause(e.cause), reason: e.reason.slice(0, 300) };
  }

  /** The starts again over these chats (a lineage) since then, with the class of each ending, oldest first. */
  restarts(sessionIds: readonly string[], sinceIso: string): { at: string; cls: KeepGoingRestartClass }[] {
    if (!sessionIds.length) return [];
    const marks = sessionIds.map(() => '?').join(', ');
    const rows = this.#db?.prepare(`SELECT at, cause FROM keepgoing_events WHERE kind = 'restarted' AND at > ? AND session_id IN (${marks}) ORDER BY at`).all(sinceIso, ...sessionIds) as Raw[] | undefined;
    return (rows ?? []).map((r) => ({ at: String(r.at), cls: (KEEPGOING_RESTART_CLASSES as readonly unknown[]).includes(r.cause) ? (r.cause as KeepGoingRestartClass) : 'other' }));
  }

  count(sessionId: string, kind: KeepGoingActionKind, sinceIso: string): number {
    const r = this.#db?.prepare('SELECT count(*) AS n FROM keepgoing_events WHERE session_id = ? AND kind = ? AND at > ?').get(sessionId, kind, sinceIso) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  /** The time of the newest action of a kind, or null. */
  lastAt(sessionId: string, kind: KeepGoingActionKind): string | null {
    const r = this.#db?.prepare('SELECT max(at) AS at FROM keepgoing_events WHERE session_id = ? AND kind = ?').get(sessionId, kind) as { at: string | null } | undefined;
    return r?.at ?? null;
  }

  events(sessionId: string, limit = 20): KeepGoingAction[] {
    const rows = this.#db?.prepare('SELECT at, kind, cause, reason FROM keepgoing_events WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit) as Raw[] | undefined;
    return (rows ?? []).map((r) => ({ at: String(r.at), kind: asAction(r.kind), cause: asCause(r.cause), reason: String(r.reason) }));
  }

  /* ---------- the reports ---------- */

  report(sessionId: string, cause: KeepGoingCause): ReportRow | null {
    const r = this.#db?.prepare('SELECT * FROM keepgoing_reports WHERE session_id = ? AND cause = ?').get(sessionId, cause) as Raw | undefined;
    return r ? reportOf(r) : null;
  }

  /** The causes reported and not cleared. */
  standing(sessionId: string): ReportRow[] {
    const rows = this.#db?.prepare('SELECT * FROM keepgoing_reports WHERE session_id = ? AND cleared_at IS NULL').all(sessionId) as Raw[] | undefined;
    return (rows ?? []).map(reportOf);
  }

  /** A cause reported now (a row that had cleared stands again and keeps its ticket). */
  putReport(sessionId: string, ownerId: string, cause: KeepGoingCause, since: string, ticketId: string | null): void {
    this.#w
      ?.prepare(
        `INSERT INTO keepgoing_reports (session_id, cause, owner_id, since, reported_at, cleared_at, ticket_id) VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (session_id, cause) DO UPDATE SET since = excluded.since, reported_at = excluded.reported_at, cleared_at = NULL, ticket_id = coalesce(excluded.ticket_id, ticket_id)`,
      )
      .run(sessionId, cause, ownerId, since, this.#at(), ticketId);
  }

  clearReport(sessionId: string, cause: KeepGoingCause): void {
    this.#w?.prepare('UPDATE keepgoing_reports SET cleared_at = ? WHERE session_id = ? AND cause = ? AND cleared_at IS NULL').run(this.#at(), sessionId, cause);
  }

  /** Drops trail rows older than 30 days. */
  sweep(): void {
    this.#w?.prepare('DELETE FROM keepgoing_events WHERE at < ?').run(new Date(this.now().getTime() - RETENTION_MS).toISOString());
  }
}
