// Claude Code version pinning: the SQL (docs/prd/claude-version-pinning.md §9, migration 300). Three small tables: what Rollback needs
// (the history of applied changes), the canary's runs with the real output of each check, and the audit trail. The runtime stays the
// record of what a workspace runs; nothing here says so. Every read is tolerant (a missing table or a locked store reads as nothing: the
// portal must start and explain itself on a database it cannot use, foundation PRD §6.5); writes need a writable store.

import type {
  ClaudeCanaryMode,
  ClaudeCanaryResult,
  ClaudeCanaryRun,
  ClaudeCanaryRunStatus,
  ClaudeCanarySubject,
  ClaudeCanaryTrigger,
  ClaudeCanaryVerdict,
  ClaudeVersionHistoryEntry,
} from '@portal/contracts';
import { OWNER_ID } from '../authz/seam.js';
import type { Store } from '../store/store.js';

/** How many canary runs are kept: the newest, with their output. */
const KEEP_RUNS = 120;
/** How many audit rows are kept. */
const KEEP_EVENTS = 2000;

export interface HistoryInput {
  workspaceId: string;
  kind: ClaudeVersionHistoryEntry['kind'];
  fromVersion: string | null;
  toVersion: string | null;
  fromImage: string;
  fromImageId: string | null;
  toImage: string;
  canaryRunId: number | null;
  canary: ClaudeVersionHistoryEntry['canary'];
  accepted: string[];
  outcome: ClaudeVersionHistoryEntry['outcome'];
  detail: string | null;
  /** The audit string of whoever acted (`actorString`). */
  actor: string;
  /** Whose the workspace is (a user id) and who made the change (a user id); the owner while there is one user. */
  ownerId?: string;
  createdBy?: string;
}

export interface HistoryRow extends ClaudeVersionHistoryEntry {
  /** Internal: the old image's id, so Rollback finds it even when its tag has moved. */
  fromImageId: string | null;
}

export interface RunInput {
  trigger: ClaudeCanaryTrigger;
  subject: ClaudeCanarySubject;
  version: string | null;
  image: string | null;
  mode: ClaudeCanaryMode;
  status: ClaudeCanaryRunStatus;
  note: string | null;
  suite: number;
  actor: string;
  ownerId?: string;
  createdBy?: string;
}

interface RunRow {
  id: number;
  trigger: ClaudeCanaryTrigger;
  subject: ClaudeCanarySubject;
  version: string | null;
  reported: string | null;
  image: string | null;
  mode: ClaudeCanaryMode;
  status: ClaudeCanaryRunStatus;
  note: string | null;
  started_at: string;
  finished_at: string | null;
  suite: number;
  results: string;
  pass: number;
  fail: number;
  skipped: number;
  actor: string;
}

interface HistoryDbRow {
  id: number;
  at: string;
  workspace_id: string;
  kind: ClaudeVersionHistoryEntry['kind'];
  from_version: string | null;
  to_version: string | null;
  from_image: string;
  from_image_id: string | null;
  to_image: string;
  canary_run_id: number | null;
  canary: ClaudeVersionHistoryEntry['canary'];
  accepted: string;
  outcome: ClaudeVersionHistoryEntry['outcome'];
  detail: string | null;
  actor: string;
}

/** `pass`, `partial` or `fail` from the counts of a finished run; null when it has no results. */
export function verdictOf(pass: number, fail: number, skipped: number): ClaudeCanaryVerdict | null {
  if (pass + fail + skipped === 0) return null;
  if (fail > 0) return 'fail';
  return skipped > 0 ? 'partial' : 'pass';
}

const json = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

export class ClaudeVersionStore {
  constructor(private readonly store: Store) {}

  get #db() {
    return this.store.db;
  }

  get writable(): boolean {
    return !!this.#db && this.store.writable;
  }

  /* ---------- Portal meta: the default pin and the last candidate reading ---------- */

  meta<T>(key: string): T | null {
    try {
      const row = this.#db?.prepare('SELECT value FROM portal_meta WHERE key = ?').get(`claude_version:${key}`) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : null;
    } catch {
      return null;
    }
  }

  setMeta(key: string, value: unknown): void {
    if (!this.writable) return;
    this.#db!.prepare('INSERT INTO portal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`claude_version:${key}`, JSON.stringify(value));
  }

  /* ---------- History ---------- */

  addHistory(input: HistoryInput, at = new Date()): number {
    const r = this.#db!
      .prepare(
        `INSERT INTO claude_version_history (at, workspace_id, kind, from_version, to_version, from_image, from_image_id, to_image, canary_run_id, canary, accepted, outcome, detail, actor, owner_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at.toISOString(), input.workspaceId, input.kind, input.fromVersion, input.toVersion, input.fromImage, input.fromImageId, input.toImage, input.canaryRunId, input.canary, JSON.stringify(input.accepted), input.outcome, input.detail, input.actor, input.ownerId ?? OWNER_ID, input.createdBy ?? OWNER_ID);
    return Number(r.lastInsertRowid);
  }

  #history(row: HistoryDbRow): HistoryRow {
    return {
      id: row.id,
      at: row.at,
      workspaceId: row.workspace_id,
      kind: row.kind,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      fromImage: row.from_image,
      fromImageId: row.from_image_id,
      toImage: row.to_image,
      canaryRunId: row.canary_run_id,
      canary: row.canary,
      accepted: json<string[]>(row.accepted, []),
      outcome: row.outcome,
      detail: row.detail,
      actor: row.actor,
    };
  }

  /** A workspace's history, newest first. */
  history(workspaceId: string, limit = 50): HistoryRow[] {
    try {
      const rows = this.#db?.prepare('SELECT * FROM claude_version_history WHERE workspace_id = ? ORDER BY id DESC LIMIT ?').all(workspaceId, Math.max(1, Math.min(limit, 200))) as unknown as HistoryDbRow[] | undefined;
      return (rows ?? []).map((r) => this.#history(r));
    } catch {
      return [];
    }
  }

  /** The newest applied change of every workspace (the rollback targets), by workspace id. */
  latestApplied(): Map<string, HistoryRow> {
    const out = new Map<string, HistoryRow>();
    try {
      const rows = this.#db?.prepare(`SELECT * FROM claude_version_history WHERE outcome = 'applied' ORDER BY id DESC`).all() as unknown as HistoryDbRow[] | undefined;
      for (const r of rows ?? []) if (!out.has(r.workspace_id)) out.set(r.workspace_id, this.#history(r));
    } catch {
      // nothing
    }
    return out;
  }

  /* ---------- Canary runs ---------- */

  startRun(input: RunInput, at = new Date()): number {
    const r = this.#db!
      .prepare(`INSERT INTO claude_canary_runs (trigger, subject, version, image, mode, status, note, started_at, suite, actor, owner_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.trigger, input.subject, input.version, input.image, input.mode, input.status, input.note, at.toISOString(), input.suite, input.actor, input.ownerId ?? OWNER_ID, input.createdBy ?? OWNER_ID);
    const id = Number(r.lastInsertRowid);
    this.#db!.prepare('DELETE FROM claude_canary_runs WHERE id NOT IN (SELECT id FROM claude_canary_runs ORDER BY id DESC LIMIT ?)').run(KEEP_RUNS);
    return id;
  }

  /** Writes the run as it stands: its status, note, what the CLI reported, and every result so far (the counts follow). */
  saveRun(id: number, patch: { status?: ClaudeCanaryRunStatus; note?: string | null; version?: string | null; reported?: string | null; image?: string | null; results?: ClaudeCanaryResult[]; finished?: boolean }, at = new Date()): void {
    if (!this.writable) return;
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const add = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), args.push(v));
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.note !== undefined) add('note', patch.note);
    if (patch.version !== undefined) add('version', patch.version);
    if (patch.reported !== undefined) add('reported', patch.reported);
    if (patch.image !== undefined) add('image', patch.image);
    if (patch.results) {
      add('results', JSON.stringify(patch.results));
      add('pass', patch.results.filter((r) => r.status === 'pass').length);
      add('fail', patch.results.filter((r) => r.status === 'fail').length);
      add('skipped', patch.results.filter((r) => r.status === 'skipped').length);
    }
    if (patch.finished) add('finished_at', at.toISOString());
    if (!sets.length) return;
    this.#db!.prepare(`UPDATE claude_canary_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  #run(row: RunRow): ClaudeCanaryRun {
    const done = row.status === 'done' || row.status === 'error';
    return {
      id: row.id,
      trigger: row.trigger,
      subject: row.subject,
      version: row.version,
      reported: row.reported,
      image: row.image,
      mode: row.mode,
      status: row.status,
      note: row.note,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      suite: row.suite,
      results: json<ClaudeCanaryResult[]>(row.results, []),
      pass: row.pass,
      fail: row.fail,
      skipped: row.skipped,
      verdict: done || row.status === 'unavailable' ? verdictOf(row.pass, row.fail, row.skipped) : null,
      actor: row.actor,
    };
  }

  run(id: number): ClaudeCanaryRun | null {
    try {
      const row = this.#db?.prepare('SELECT * FROM claude_canary_runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
      return row ? this.#run(row) : null;
    } catch {
      return null;
    }
  }

  /** Runs, newest first. `subject` and `version` narrow them. */
  runs(opts: { limit?: number; subject?: ClaudeCanarySubject; version?: string; status?: ClaudeCanaryRunStatus } = {}): ClaudeCanaryRun[] {
    try {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (opts.subject) (where.push('subject = ?'), args.push(opts.subject));
      if (opts.version) (where.push('version = ?'), args.push(opts.version));
      if (opts.status) (where.push('status = ?'), args.push(opts.status));
      const rows = this.#db
        ?.prepare(`SELECT * FROM claude_canary_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
        .all(...args, Math.max(1, Math.min(opts.limit ?? 30, 200))) as unknown as RunRow[] | undefined;
      return (rows ?? []).map((r) => this.#run(r));
    } catch {
      return [];
    }
  }

  /** Runs still marked running: the portal stopped in the middle of them. */
  interruptRunning(note: string, at = new Date()): number {
    if (!this.writable) return 0;
    const r = this.#db!.prepare(`UPDATE claude_canary_runs SET status = 'error', note = ?, finished_at = ? WHERE status = 'running'`).run(note, at.toISOString());
    return Number(r.changes);
  }

  /** The versions a canary passed on (every check passed or was skipped, none failed), for "tested". */
  testedVersions(): string[] {
    try {
      const rows = this.#db?.prepare(`SELECT DISTINCT COALESCE(reported, version) AS v FROM claude_canary_runs WHERE status = 'done' AND fail = 0 AND pass > 0 AND COALESCE(reported, version) IS NOT NULL`).all() as { v: string }[] | undefined;
      return (rows ?? []).map((r) => r.v);
    } catch {
      return [];
    }
  }

  /* ---------- Audit ---------- */

  audit(action: string, who: { actor: string }, fields: { workspaceId?: string | null; version?: string | null; detail?: string | null } = {}, at = new Date()): void {
    if (!this.writable) return;
    try {
      this.#db!.prepare('INSERT INTO claude_version_events (at, actor, action, workspace_id, version, detail, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(at.toISOString(), who.actor, action, fields.workspaceId ?? null, fields.version ?? null, fields.detail ?? null, OWNER_ID);
      this.#db!.prepare('DELETE FROM claude_version_events WHERE id NOT IN (SELECT id FROM claude_version_events ORDER BY id DESC LIMIT ?)').run(KEEP_EVENTS);
    } catch (e) {
      console.error(`[claude-version] audit not written: ${(e as Error).message}`);
    }
  }

  events(limit = 100): { id: number; at: string; actor: string; action: string; workspaceId: string | null; version: string | null; detail: string | null }[] {
    try {
      const rows = this.#db?.prepare('SELECT * FROM claude_version_events ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(limit, 500))) as
        | { id: number; at: string; actor: string; action: string; workspace_id: string | null; version: string | null; detail: string | null }[]
        | undefined;
      return (rows ?? []).map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, workspaceId: r.workspace_id, version: r.version, detail: r.detail }));
    } catch {
      return [];
    }
  }
}
