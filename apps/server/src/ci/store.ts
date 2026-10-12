// The CI tables (migration 80, PRD §12): thin typed reads and writes. All SQL for CI is here; the service decides what to do.

import { AppError } from '@isnanme/core';
import type { Store } from '../store/store.js';

export interface RepoRow {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  default_branch: string;
  protected: string;
  required_checks: string;
  merge_only: number;
  source_path: string | null;
  connected: string;
  hook_state: string;
  created_at: string;
  removed_at: string | null;
}

export interface RunRow {
  id: string;
  number: number;
  workspace_id: string;
  repo_id: string;
  repo: string;
  pipeline: string;
  trigger: string;
  event_id: string | null;
  ref: string;
  branch: string | null;
  tag: string | null;
  sha: string;
  base_sha: string | null;
  subject: string | null;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  reason: string | null;
  actor: string;
  inputs: string;
  ticket_id: string | null;
  ticket_source: string | null;
  session_id: string | null;
  rerun_of: string | null;
  concurrency_group: string | null;
  cancel_in_progress: number;
  plan: string | null;
  state: string | null;
  diagnostics: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  archived: number;
}

export interface EventRow {
  workspace_id: string;
  id: string;
  repo_id: string | null;
  repo: string;
  kind: string;
  ref: string;
  old_sha: string;
  new_sha: string;
  via: string;
  at: string;
  outcome: string;
  note: string | null;
}

export interface LogRow {
  run_id: string;
  job: string;
  step: number;
  bytes: number;
  omitted: number;
  text: string;
}

export interface RunFilter {
  workspace?: string;
  repoId?: string;
  pipeline?: string;
  branch?: string;
  statuses?: string[];
  ticket?: string;
  session?: string;
  before?: string;
  limit?: number;
}

const RUN_COLUMNS = [
  'status', 'reason', 'plan', 'state', 'diagnostics', 'attempts', 'started_at', 'finished_at', 'duration_ms', 'archived', 'subject',
  'ticket_id', 'ticket_source', 'session_id', 'concurrency_group', 'cancel_in_progress',
] as const;
type RunPatch = Partial<Pick<RunRow, (typeof RUN_COLUMNS)[number]>>;
const REPO_COLUMNS = ['default_branch', 'protected', 'required_checks', 'merge_only', 'connected', 'hook_state', 'removed_at', 'source_path'] as const;
type RepoPatch = Partial<Pick<RepoRow, (typeof REPO_COLUMNS)[number]>>;

export class CiStore {
  constructor(private readonly store: Store) {}

  get #db() {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }

  get #writableDb() {
    const db = this.store.writable ? this.store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now, so CI can’t be changed.');
    return db;
  }

  /** Whether the tables exist (a database from before this feature, or one a migration failed on). */
  get ready(): boolean {
    try {
      this.#db.prepare('SELECT 1 FROM ci_runs LIMIT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  tx<T>(fn: () => T): T {
    const db = this.#writableDb;
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------- Remotes ---------- */

  repos(workspaceId?: string): RepoRow[] {
    return (workspaceId
      ? this.#db.prepare('SELECT * FROM ci_repos WHERE removed_at IS NULL AND workspace_id = ? ORDER BY created_at').all(workspaceId)
      : this.#db.prepare('SELECT * FROM ci_repos WHERE removed_at IS NULL ORDER BY created_at').all()) as unknown as RepoRow[];
  }

  repo(id: string): RepoRow | undefined {
    return this.#db.prepare('SELECT * FROM ci_repos WHERE id = ?').get(id) as unknown as RepoRow | undefined;
  }

  repoByName(workspaceId: string, name: string): RepoRow | undefined {
    return this.#db.prepare('SELECT * FROM ci_repos WHERE workspace_id = ? AND name = ? AND removed_at IS NULL').get(workspaceId, name) as unknown as RepoRow | undefined;
  }

  insertRepo(r: Omit<RepoRow, 'removed_at'>): void {
    this.#writableDb
      .prepare('INSERT INTO ci_repos (id, workspace_id, name, path, default_branch, protected, required_checks, merge_only, source_path, connected, hook_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.workspace_id, r.name, r.path, r.default_branch, r.protected, r.required_checks, r.merge_only, r.source_path, r.connected, r.hook_state, r.created_at);
  }

  updateRepo(id: string, patch: RepoPatch): void {
    const keys = Object.keys(patch) as (keyof RepoPatch)[];
    if (!keys.length) return;
    this.#writableDb.prepare(`UPDATE ci_repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
  }

  /** Workspaces that have at least one remote: the ones the portal polls. */
  workspacesWithRepos(): string[] {
    return (this.#db.prepare('SELECT DISTINCT workspace_id FROM ci_repos WHERE removed_at IS NULL').all() as { workspace_id: string }[]).map((r) => r.workspace_id);
  }

  /* ---------- Events ---------- */

  eventSeen(workspaceId: string, id: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM ci_events WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
  }

  insertEvent(e: EventRow): void {
    this.#writableDb
      .prepare('INSERT OR IGNORE INTO ci_events (workspace_id, id, repo_id, repo, kind, ref, old_sha, new_sha, via, at, outcome, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.workspace_id, e.id, e.repo_id, e.repo, e.kind, e.ref, e.old_sha, e.new_sha, e.via, e.at, e.outcome, e.note);
  }

  events(repoId: string, limit = 50): EventRow[] {
    return this.#db.prepare('SELECT * FROM ci_events WHERE repo_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(repoId, limit) as unknown as EventRow[];
  }

  /* ---------- Runs ---------- */

  nextNumber(repoId: string): number {
    return Number((this.#db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM ci_runs WHERE repo_id = ?').get(repoId) as { n: number }).n);
  }

  insertRun(r: RunRow): void {
    const keys = Object.keys(r) as (keyof RunRow)[];
    this.#writableDb.prepare(`INSERT INTO ci_runs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => r[k] ?? null));
  }

  run(id: string): RunRow | undefined {
    return this.#db.prepare('SELECT * FROM ci_runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  }

  updateRun(id: string, patch: RunPatch): void {
    const keys = Object.keys(patch) as (keyof RunPatch)[];
    if (!keys.length) return;
    this.#writableDb.prepare(`UPDATE ci_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
  }

  /** Runs matching the filters, newest first, with how many match and how many of those are not finished. */
  listRuns(f: RunFilter): { rows: RunRow[]; total: number; active: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.workspace) (where.push('workspace_id = ?'), args.push(f.workspace));
    if (f.repoId) (where.push('repo_id = ?'), args.push(f.repoId));
    if (f.pipeline) (where.push('pipeline = ?'), args.push(f.pipeline));
    if (f.branch) (where.push('branch = ?'), args.push(f.branch));
    if (f.ticket) (where.push('ticket_id = ?'), args.push(f.ticket));
    if (f.session) (where.push('session_id = ?'), args.push(f.session));
    if (f.statuses?.length) (where.push(`status IN (${f.statuses.map(() => '?').join(', ')})`), args.push(...f.statuses));
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.#db.prepare(`SELECT count(*) AS n FROM ci_runs ${sql}`).get(...args) as { n: number }).n);
    const active = Number((this.#db.prepare(`SELECT count(*) AS n FROM ci_runs ${sql ? `${sql} AND` : 'WHERE'} status IN ('queued', 'running')`).get(...args) as { n: number }).n);
    let page = sql;
    const pageArgs = [...args];
    if (f.before) {
      const before = this.run(f.before);
      if (before) {
        page = `${sql ? `${sql} AND` : 'WHERE'} (created_at < ? OR (created_at = ? AND id < ?))`;
        pageArgs.push(before.created_at, before.created_at, before.id);
      }
    }
    const rows = this.#db.prepare(`SELECT * FROM ci_runs ${page} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...pageArgs, Math.max(1, Math.min(f.limit ?? 50, 200))) as unknown as RunRow[];
    return { rows, total, active };
  }

  runningRuns(workspaceId: string): RunRow[] {
    return this.#db.prepare("SELECT * FROM ci_runs WHERE workspace_id = ? AND status = 'running' ORDER BY created_at").all(workspaceId) as unknown as RunRow[];
  }

  queuedRuns(workspaceId: string): RunRow[] {
    return this.#db.prepare("SELECT * FROM ci_runs WHERE workspace_id = ? AND status = 'queued' ORDER BY created_at, id").all(workspaceId) as unknown as RunRow[];
  }

  /** Workspaces with a run that is not finished: polled even when no remote is listed (a removed one still has runs to finish). */
  workspacesWithActiveRuns(): string[] {
    return (this.#db.prepare("SELECT DISTINCT workspace_id FROM ci_runs WHERE status IN ('queued', 'running')").all() as { workspace_id: string }[]).map((r) => r.workspace_id);
  }

  /** Runs of a concurrency group in a remote that are queued or running, other than `exceptId`. */
  activeInGroup(repoId: string, group: string, exceptId: string): RunRow[] {
    return this.#db.prepare("SELECT * FROM ci_runs WHERE repo_id = ? AND concurrency_group = ? AND id <> ? AND status IN ('queued', 'running') ORDER BY created_at").all(repoId, group, exceptId) as unknown as RunRow[];
  }

  /** Finished runs whose logs the portal does not have yet. */
  unarchived(limit = 20): RunRow[] {
    return this.#db.prepare("SELECT * FROM ci_runs WHERE archived = 0 AND status IN ('passed', 'failed', 'cancelled') AND state IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RunRow[];
  }

  /** The newest run of each branch and pipeline of a remote (what a branch row shows). */
  latestByBranch(repoId: string): RunRow[] {
    return this.#db
      .prepare(
        `SELECT r.* FROM ci_runs r JOIN (SELECT branch, pipeline, MAX(created_at) AS at FROM ci_runs WHERE repo_id = ? AND branch IS NOT NULL GROUP BY branch, pipeline) l
         ON r.repo_id = ? AND r.branch = l.branch AND r.pipeline = l.pipeline AND r.created_at = l.at`,
      )
      .all(repoId, repoId) as unknown as RunRow[];
  }

  activeCount(repoId: string): number {
    return Number((this.#db.prepare("SELECT count(*) AS n FROM ci_runs WHERE repo_id = ? AND status IN ('queued', 'running')").get(repoId) as { n: number }).n);
  }

  /* ---------- Logs ---------- */

  saveLogs(runId: string, rows: Omit<LogRow, 'run_id'>[]): void {
    this.tx(() => {
      const db = this.#writableDb;
      db.prepare('DELETE FROM ci_logs WHERE run_id = ?').run(runId);
      const insert = db.prepare('INSERT INTO ci_logs (run_id, job, step, bytes, omitted, text) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of rows) insert.run(runId, r.job, r.step, r.bytes, r.omitted, r.text);
      db.prepare('UPDATE ci_runs SET archived = 1 WHERE id = ?').run(runId);
    });
  }

  log(runId: string, job: string, step: number): LogRow | undefined {
    return this.#db.prepare('SELECT * FROM ci_logs WHERE run_id = ? AND job = ? AND step = ?').get(runId, job, step) as unknown as LogRow | undefined;
  }

  /* ---------- Messages to sessions (PRD FR37) ---------- */

  insertMessage(m: { run_id: string; session_id: string; ticket_id: string | null; at: string; outcome: string; note: string | null }): void {
    this.#writableDb.prepare('INSERT INTO ci_messages (run_id, session_id, ticket_id, at, outcome, note) VALUES (?, ?, ?, ?, ?, ?)').run(m.run_id, m.session_id, m.ticket_id, m.at, m.outcome, m.note);
  }

  /** Messages actually sent for a ticket (or, without one, a session) since a time. */
  sentSince(by: { ticketId: string | null; sessionId: string }, since: string): number {
    const row = by.ticketId
      ? this.#db.prepare("SELECT count(*) AS n FROM ci_messages WHERE ticket_id = ? AND outcome = 'sent' AND at > ?").get(by.ticketId, since)
      : this.#db.prepare("SELECT count(*) AS n FROM ci_messages WHERE ticket_id IS NULL AND session_id = ? AND outcome = 'sent' AND at > ?").get(by.sessionId, since);
    return Number((row as { n: number }).n);
  }

  /** Whether a pause was already recorded for this session since a time (so it is said once). */
  pausedSince(sessionId: string, since: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM ci_messages WHERE session_id = ? AND outcome = 'paused' AND at > ?").get(sessionId, since);
  }

  /** Failed runs of a branch since a time, and since its last pass (whichever is later). */
  failureStreak(repoId: string, branch: string, since: string): number {
    return Number(
      (
        this.#db
          .prepare(
            `SELECT count(*) AS n FROM ci_runs WHERE repo_id = ? AND branch = ? AND status = 'failed' AND finished_at > ?
             AND finished_at > COALESCE((SELECT MAX(finished_at) FROM ci_runs WHERE repo_id = ? AND branch = ? AND status = 'passed'), '')`,
          )
          .get(repoId, branch, since, repoId, branch) as { n: number }
      ).n,
    );
  }

  /** The kept log of one step, if the run's logs are in the portal. */
  keptLog(runId: string, job: string, step: number): string | null {
    return this.log(runId, job, step)?.text ?? null;
  }

  /* ---------- Merges ---------- */

  insertMerge(m: { id: string; repo_id: string; source: string; target: string; strategy: string; result_sha: string | null; actor: string; at: string; outcome: string; note: string | null }): void {
    this.#writableDb
      .prepare('INSERT INTO ci_merges (id, repo_id, source, target, strategy, result_sha, actor, at, outcome, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.repo_id, m.source, m.target, m.strategy, m.result_sha, m.actor, m.at, m.outcome, m.note);
  }

  /* ---------- Retention ---------- */

  /** Deletes run records past their age and, per workspace, past the newest `keep`; event records past theirs. Returns how many runs went. */
  prune(opts: { runDays: number; eventDays: number; keepPerWorkspace: number }): number {
    const db = this.#writableDb;
    const runCut = new Date(Date.now() - opts.runDays * 86_400_000).toISOString();
    const eventCut = new Date(Date.now() - opts.eventDays * 86_400_000).toISOString();
    db.prepare('DELETE FROM ci_events WHERE at < ?').run(eventCut);
    db.prepare('DELETE FROM ci_messages WHERE at < ?').run(new Date(Date.now() - 7 * 86_400_000).toISOString());
    let n = Number(db.prepare("DELETE FROM ci_runs WHERE status IN ('passed', 'failed', 'cancelled') AND created_at < ?").run(runCut).changes);
    for (const { workspace_id } of db.prepare('SELECT DISTINCT workspace_id FROM ci_runs').all() as { workspace_id: string }[]) {
      n += Number(
        db
          .prepare("DELETE FROM ci_runs WHERE workspace_id = ? AND status IN ('passed', 'failed', 'cancelled') AND id NOT IN (SELECT id FROM ci_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)")
          .run(workspace_id, workspace_id, opts.keepPerWorkspace).changes,
      );
    }
    return n;
  }
}
