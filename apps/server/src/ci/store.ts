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
  /** Migration 782 (T-486): the https upstream it follows, the Secrets & env NAME that reads it, how often (s), the last sync (JSON). */
  upstream_url?: string | null;
  upstream_secret?: string | null;
  upstream_every_s?: number | null;
  upstream_state?: string | null;
  /** Migration 783 (T-486 S2): the Secrets & env NAME whose value signs the upstream's push webhook; null: no webhook. */
  upstream_hook_secret?: string | null;
}

/** A test a gate saw pass only on its rerun (T-95 item 4). */
export interface FlakyRow {
  run_id: string;
  repo: string;
  job: string;
  file: string;
  test: string;
  ticket_id: string | null;
  at: string;
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
  /** The Portal MCP token's label when the actor is a token, as it was then. */
  actor_label: string | null;
  /** Who cancelled the run (an actor string like `actor`; `pipeline` for a run a newer one superseded), a token's label then, and why. */
  cancelled_by?: string | null;
  cancelled_by_label?: string | null;
  cancel_note?: string | null;
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

/** An environment of a remote (migration 610, PRD FR41). */
export interface EnvironmentRow {
  id: string;
  repo_id: string;
  name: string;
  protected: number;
  owner_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  /** Migration 780 (T-110): the auto-approve mode, its window (null: always) and its 'needs a person' globs as JSON (null: the defaults). */
  auto_approve?: 'off' | 'dry' | 'on';
  auto_window?: string | null;
  auto_paths?: string | null;
}

/** One run's job tied to an environment. `gate_key` is the runner's key for that job: never leaves the service except into `cp-ci approve`. */
export interface DeploymentRow {
  id: string;
  run_id: string;
  run_number: number;
  job: string;
  repo_id: string;
  environment: string;
  pipeline: string;
  sha: string;
  ref: string;
  actor: string;
  approval: 'pending' | 'waiting' | 'approved' | 'rejected' | 'auto' | 'expired' | 'skipped';
  gate_key: string | null;
  decided_by: string | null;
  decided_at: string | null;
  outcome: string | null;
  owner_id: string;
  created_by: string;
  created_at: string;
  /** Migration 780 (T-110): the auto-approve rule's verdict on this deployment and its one line; null when the rule did not look. */
  auto_verdict?: 'would' | 'would_not' | null;
  auto_line?: string | null;
  auto_at?: string | null;
  /** Migration 781 (T-110 slice 2): the mode the verdict was made in; null for a verdict of slice 1 (dry) or none. */
  auto_mode?: 'dry' | 'on' | null;
}

/** A message CI sent to a session about a run, or decided not to (migrations 81 and 730). */
export interface MessageRow {
  run_id: string;
  session_id: string;
  ticket_id: string | null;
  at: string;
  /** sent, refused, capped, paused, ended; a bump (FR37a): bumped, bump_refused */
  outcome: string;
  note: string | null;
  /** The run's state it was about: failed, passed, cancelled, waiting; a bump: `bump:prioritise` or `bump:ask`. */
  state: string;
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
  'ticket_id', 'ticket_source', 'session_id', 'concurrency_group', 'cancel_in_progress', 'cancelled_by', 'cancelled_by_label', 'cancel_note',
] as const;
type RunPatch = Partial<Pick<RunRow, (typeof RUN_COLUMNS)[number]>>;
const REPO_COLUMNS = [
  'default_branch', 'protected', 'required_checks', 'merge_only', 'connected', 'hook_state', 'removed_at', 'source_path',
  'upstream_url', 'upstream_secret', 'upstream_every_s', 'upstream_state', 'upstream_hook_secret',
] as const;
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

  /* ---------- Flaky tests (T-95 item 4) ---------- */

  get flakyReady(): boolean {
    try {
      this.#db.prepare('SELECT 1 FROM ci_flaky LIMIT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  /** The test's latest sighting that has a ticket, and how many runs have seen it (this one included once it is stored). */
  flakyOf(repo: string, file: string, test: string): { ticketId: string | null; runs: number } {
    const last = this.#db.prepare('SELECT ticket_id FROM ci_flaky WHERE repo = ? AND file = ? AND test = ? AND ticket_id IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1').get(repo, file, test) as { ticket_id: string } | undefined;
    const n = this.#db.prepare('SELECT count(*) AS n FROM ci_flaky WHERE repo = ? AND file = ? AND test = ?').get(repo, file, test) as { n: number };
    return { ticketId: last?.ticket_id ?? null, runs: Number(n.n) };
  }

  /** Records a sighting; false when this run already recorded that test. */
  insertFlaky(f: FlakyRow): boolean {
    return Number(this.#writableDb.prepare('INSERT OR IGNORE INTO ci_flaky (run_id, repo, job, file, test, ticket_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(f.run_id, f.repo, f.job, f.file, f.test, f.ticket_id, f.at).changes) > 0;
  }

  setFlakyTicket(runId: string, repo: string, file: string, test: string, ticketId: string): void {
    this.#writableDb.prepare('UPDATE ci_flaky SET ticket_id = ? WHERE run_id = ? AND repo = ? AND file = ? AND test = ?').run(ticketId, runId, repo, file, test);
  }

  flakyOfRun(runId: string): FlakyRow[] {
    if (!this.flakyReady) return [];
    return this.#db.prepare('SELECT run_id, repo, job, file, test, ticket_id, at FROM ci_flaky WHERE run_id = ? ORDER BY rowid').all(runId) as unknown as FlakyRow[];
  }

  /* ---------- Messages to sessions (PRD FR37) ---------- */

  insertMessage(m: MessageRow): void {
    this.#writableDb.prepare('INSERT INTO ci_messages (run_id, session_id, ticket_id, at, outcome, note, state) VALUES (?, ?, ?, ?, ?, ?, ?)').run(m.run_id, m.session_id, m.ticket_id, m.at, m.outcome, m.note, m.state);
  }

  /** Whether this run's state was already reported (or decided not to be): each is said once. */
  reported(runId: string, state: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM ci_messages WHERE run_id = ? AND state = ?').get(runId, state);
  }

  /** What CI told a run's session, or why not, oldest first. */
  messagesOfRun(runId: string): MessageRow[] {
    return this.#db.prepare('SELECT run_id, session_id, ticket_id, at, outcome, note, state FROM ci_messages WHERE run_id = ? ORDER BY id').all(runId) as unknown as MessageRow[];
  }

  /** Messages actually sent for a ticket (or, without one, a session) since a time. */
  sentSince(by: { ticketId: string | null; sessionId: string }, since: string): number {
    const row = by.ticketId
      ? this.#db.prepare("SELECT count(*) AS n FROM ci_messages WHERE ticket_id = ? AND outcome = 'sent' AND at > ?").get(by.ticketId, since)
      : this.#db.prepare("SELECT count(*) AS n FROM ci_messages WHERE ticket_id IS NULL AND session_id = ? AND outcome = 'sent' AND at > ?").get(by.sessionId, since);
    return Number((row as { n: number }).n);
  }

  /** Bumps of a run, or into a session, since a time (FR37a's limits). Bump rows have the state `bump:<mode>`. */
  bumpsSince(by: { runId: string } | { sessionId: string }, since: string): number {
    const row =
      'runId' in by
        ? this.#db.prepare("SELECT count(*) AS n FROM ci_messages WHERE run_id = ? AND state LIKE 'bump:%' AND at > ?").get(by.runId, since)
        : this.#db.prepare("SELECT count(*) AS n FROM ci_messages WHERE session_id = ? AND state LIKE 'bump:%' AND at > ?").get(by.sessionId, since);
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

  /* ---------- Environments and deployments (PRD FR41) ---------- */

  /** Whether the tables of migration 610 are there (a database the migration has not reached can still run CI, just without deployments). */
  get deploymentsReady(): boolean {
    try {
      this.#db.prepare('SELECT 1 FROM ci_deployments LIMIT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  environments(repoId: string): EnvironmentRow[] {
    return this.#db.prepare('SELECT * FROM ci_environments WHERE repo_id = ? ORDER BY name').all(repoId) as unknown as EnvironmentRow[];
  }

  environment(repoId: string, name: string): EnvironmentRow | undefined {
    return this.#db.prepare('SELECT * FROM ci_environments WHERE repo_id = ? AND name = ?').get(repoId, name) as unknown as EnvironmentRow | undefined;
  }

  /** The environment, made protected when it does not exist yet (the safe default: a new name never deploys unattended). */
  ensureEnvironment(repoId: string, name: string, by: string, id: string): EnvironmentRow {
    const now = new Date().toISOString();
    this.#writableDb
      .prepare('INSERT OR IGNORE INTO ci_environments (id, repo_id, name, protected, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(id, repoId, name, now, now, by);
    return this.environment(repoId, name)!;
  }

  setProtected(id: string, value: boolean, by: string): void {
    this.#writableDb.prepare('UPDATE ci_environments SET protected = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(value ? 1 : 0, new Date().toISOString(), by, id);
  }

  /* ---------- The auto-approve rule (T-110, PRD FR41a) ---------- */

  /** Whether the columns of migrations 780 and 781 are there. */
  get autoApproveReady(): boolean {
    try {
      this.#db.prepare('SELECT auto_approve FROM ci_environments LIMIT 1').get();
      this.#db.prepare('SELECT auto_verdict, auto_mode FROM ci_deployments LIMIT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  setAutoApprove(id: string, patch: { mode: 'off' | 'dry' | 'on'; window: string | null; paths: string | null }, by: string): void {
    this.#writableDb
      .prepare('UPDATE ci_environments SET auto_approve = ?, auto_window = ?, auto_paths = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(patch.mode, patch.window, patch.paths, new Date().toISOString(), by, id);
  }

  /** Records the rule's verdict on a deployment, once: a second look at the same deployment writes nothing. */
  setAutoVerdict(id: string, verdict: 'would' | 'would_not', line: string, at: string, mode: 'dry' | 'on'): boolean {
    return (
      Number(this.#writableDb.prepare('UPDATE ci_deployments SET auto_verdict = ?, auto_line = ?, auto_at = ?, auto_mode = ? WHERE id = ? AND auto_verdict IS NULL').run(verdict, line, at, mode, id).changes) > 0
    );
  }

  /** Mode `on`: how the rule's claimed approval ended (approved, or not after all); only a verdict already claimed in mode `on` changes. */
  settleAutoVerdict(id: string, verdict: 'would' | 'would_not', line: string): boolean {
    return Number(this.#writableDb.prepare("UPDATE ci_deployments SET auto_verdict = ?, auto_line = ? WHERE id = ? AND auto_mode = 'on'").run(verdict, line, id).changes) > 0;
  }

  /**
   * The deployments of an environment the rule approved, or (dry) would have approved, newest first. `rule:<environment>` is the actor of a
   * real rule approval (mode `on`, slice 2); both count for the daily cap, one at a time and the previous deploy.
   */
  ruleDeployments(repoId: string, environment: string, limit = 50): (DeploymentRow & { run_status: string | null })[] {
    return this.#db
      .prepare(
        `SELECT d.*, r.status AS run_status FROM ci_deployments d LEFT JOIN ci_runs r ON r.id = d.run_id
         WHERE d.repo_id = ? AND d.environment = ? AND (d.auto_verdict = 'would' OR d.decided_by = ?) ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
      )
      .all(repoId, environment, `rule:${environment}`, limit) as unknown as (DeploymentRow & { run_status: string | null })[];
  }

  /** The last deployment of an environment that was released and held: its job passed and its run passed (verify too), newest first. */
  lastReleased(repoId: string, environment: string, exceptRun: string): DeploymentRow | undefined {
    return this.#db
      .prepare(
        `SELECT d.* FROM ci_deployments d JOIN ci_runs r ON r.id = d.run_id
         WHERE d.repo_id = ? AND d.environment = ? AND d.run_id <> ? AND d.approval IN ('approved', 'auto') AND d.outcome = 'passed' AND r.status = 'passed'
         ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
      )
      .get(repoId, environment, exceptRun) as unknown as DeploymentRow | undefined;
  }

  insertDeployment(d: DeploymentRow): void {
    const keys = Object.keys(d) as (keyof DeploymentRow)[];
    this.#writableDb.prepare(`INSERT INTO ci_deployments (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => d[k] ?? null));
  }

  deploymentsOfRun(runId: string): DeploymentRow[] {
    if (!this.deploymentsReady) return [];
    return this.#db.prepare('SELECT * FROM ci_deployments WHERE run_id = ? ORDER BY created_at, job').all(runId) as unknown as DeploymentRow[];
  }

  deployment(runId: string, job: string): DeploymentRow | undefined {
    return this.#db.prepare('SELECT * FROM ci_deployments WHERE run_id = ? AND job = ?').get(runId, job) as unknown as DeploymentRow | undefined;
  }

  deploymentsOf(repoId: string, environment: string, limit = 20): DeploymentRow[] {
    return this.#db.prepare('SELECT * FROM ci_deployments WHERE repo_id = ? AND environment = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(repoId, environment, limit) as unknown as DeploymentRow[];
  }

  /** Moves a deployment's approval; `from` makes it a compare-and-set, so two people deciding at once can not both win. */
  updateDeployment(id: string, patch: Partial<Pick<DeploymentRow, 'approval' | 'gate_key' | 'decided_by' | 'decided_at' | 'outcome'>>, from?: DeploymentRow['approval'][]): boolean {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return false;
    const guard = from?.length ? ` AND approval IN (${from.map(() => '?').join(', ')})` : '';
    return Number(this.#writableDb.prepare(`UPDATE ci_deployments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?${guard}`).run(...keys.map((k) => patch[k] ?? null), id, ...(from ?? [])).changes) > 0;
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
    // Deployments are the environments' history: kept a year, past their runs.
    if (this.deploymentsReady) db.prepare('DELETE FROM ci_deployments WHERE created_at < ?').run(new Date(Date.now() - 365 * 86_400_000).toISOString());
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
