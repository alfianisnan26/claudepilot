// Workspace git: the three tables (docs/prd/workspace-git.md §13), over the portal's database. Every read is tolerant (a missing
// table or a locked store reads as nothing), because the portal must start and explain itself on a database it cannot use
// (foundation PRD §6.5). Nothing here is a secret; text that came from a workspace was cleaned before it got here.

import { REPO_EVENT_KINDS, REPO_AUDIT_KINDS, type RepoEvent, type RepoEventData, type RepoEventKind, type RepoEventQuery, type RepoKind, type RepoState, type RepoSyncOutcome } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { NodeCore } from './tree.js';

const DAY = 86_400_000;
/** Events are kept this long (90 days, PRD §8), and at most this many per workspace. */
export const EVENT_KEEP_MS = 90 * DAY;
export const EVENTS_PER_WORKSPACE = 10_000;

export interface StoredRepo extends NodeCore {
  firstSeenAt: string;
  scannedAt: string;
  removedAt: string | null;
  sync: { enabled: boolean; at: string | null; outcome: RepoSyncOutcome | null; note: string | null };
}

export interface WorkspaceRow {
  workspaceId: string;
  /** null: the default folders. */
  roots: string[] | null;
  auto: boolean;
  scanAt: string | null;
  scanMs: number | null;
  scanError: string | null;
  scanTruncated: boolean;
}

export interface NewEvent {
  at: string;
  workspaceId: string;
  repoId: string | null;
  repo: string | null;
  kind: RepoEventKind;
  actor: string;
  /** A Portal MCP token's label as it was when it acted; null for any other actor. */
  actorLabel?: string | null;
  sessionId: string | null;
  summary: string;
  data: RepoEventData;
}

interface RepoSql {
  id: string;
  workspace_id: string;
  path: string;
  name: string;
  kind: string;
  parent_id: string | null;
  main_id: string | null;
  state: string | null;
  error: string | null;
  extra: string;
  sync_enabled: number;
  sync_at: string | null;
  sync_outcome: string | null;
  sync_note: string | null;
  first_seen_at: string;
  scanned_at: string;
  removed_at: string | null;
}

interface EventSql {
  id: number;
  at: string;
  workspace_id: string;
  repo_id: string | null;
  repo: string | null;
  kind: string;
  actor: string;
  actor_label: string | null;
  session_id: string | null;
  summary: string;
  data: string;
}

const KINDS: readonly string[] = ['repo', 'submodule', 'worktree', 'nested', 'missing'];
const OUTCOMES: readonly string[] = ['updated', 'current', 'refused', 'failed'];

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function toRepo(r: RepoSql): StoredRepo {
  const extra = json<unknown>(r.extra, {});
  const e = isObject(extra) ? extra : {};
  const worktree = isObject(e.worktree) ? { locked: e.worktree.locked === true, prunable: e.worktree.prunable === true } : null;
  const sub = isObject(e.submodule) ? e.submodule : null;
  const state = json<unknown>(r.state, null);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    path: r.path,
    name: r.name,
    kind: (KINDS.includes(r.kind) ? r.kind : 'repo') as RepoKind,
    parentId: r.parent_id,
    mainId: r.main_id,
    state: isObject(state) ? (state as unknown as RepoState) : null,
    error: r.error,
    worktree,
    submodule: sub ? { recorded: typeof sub.recorded === 'string' ? sub.recorded : null, url: typeof sub.url === 'string' ? sub.url : null, drifted: sub.drifted === true } : null,
    drifted: typeof e.drifted === 'number' ? e.drifted : 0,
    firstSeenAt: r.first_seen_at,
    scannedAt: r.scanned_at,
    removedAt: r.removed_at,
    sync: { enabled: r.sync_enabled === 1, at: r.sync_at, outcome: r.sync_outcome && OUTCOMES.includes(r.sync_outcome) ? (r.sync_outcome as RepoSyncOutcome) : null, note: r.sync_note },
  };
}

function toEvent(r: EventSql): RepoEvent {
  const data = json<unknown>(r.data, {});
  return {
    id: String(r.id),
    at: r.at,
    workspaceId: r.workspace_id,
    repoId: r.repo_id,
    repo: r.repo,
    kind: ((REPO_EVENT_KINDS as readonly string[]).includes(r.kind) ? r.kind : 'scan_failed') as RepoEventKind,
    actor: r.actor,
    actorLabel: r.actor_label ?? null,
    sessionId: r.session_id,
    summary: r.summary,
    data: isObject(data) ? (data as RepoEventData) : {},
  };
}

export class RepoStore {
  constructor(private readonly store: Store) {}

  /** The portal can write: nothing is scanned or kept otherwise. */
  get writable(): boolean {
    return this.store.writable;
  }

  /** The repositories of a workspace (or of all), the ones no longer there included on request. */
  rows(workspaceId?: string, opts: { removed?: boolean } = {}): StoredRepo[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      const where = [workspaceId ? 'workspace_id = ?' : '', opts.removed ? '' : 'removed_at IS NULL'].filter(Boolean).join(' AND ');
      const sql = `SELECT * FROM repos${where ? ` WHERE ${where}` : ''} ORDER BY path`;
      return (db.prepare(sql).all(...(workspaceId ? [workspaceId] : [])) as unknown as RepoSql[]).map(toRepo);
    } catch {
      return [];
    }
  }

  row(id: string): StoredRepo | null {
    const db = this.store.db;
    if (!db) return null;
    try {
      const r = db.prepare('SELECT * FROM repos WHERE id = ? AND removed_at IS NULL').get(id) as unknown as RepoSql | undefined;
      return r ? toRepo(r) : null;
    } catch {
      return null;
    }
  }

  /** Writes what a scan found. A row that exists (a removed one included) keeps when it was first seen and its sync settings. */
  save(nodes: NodeCore[], now: string): void {
    const db = this.store.db;
    if (!db || !this.store.writable || !nodes.length) return;
    const stmt = db.prepare(
      `INSERT INTO repos (id, workspace_id, path, name, kind, parent_id, main_id, state, error, extra, first_seen_at, scanned_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id, main_id = excluded.main_id,
         state = excluded.state, error = excluded.error, extra = excluded.extra, scanned_at = excluded.scanned_at, removed_at = NULL`,
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const n of nodes) {
        stmt.run(
          n.id,
          n.workspaceId,
          n.path,
          n.name,
          n.kind,
          n.parentId,
          n.mainId,
          n.state ? JSON.stringify(n.state) : null,
          n.error,
          JSON.stringify({ worktree: n.worktree, submodule: n.submodule, drifted: n.drifted }),
          now,
          now,
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  markRemoved(ids: string[], now: string): void {
    const db = this.store.db;
    if (!db || !this.store.writable || !ids.length) return;
    const stmt = db.prepare('UPDATE repos SET removed_at = ? WHERE id = ? AND removed_at IS NULL');
    for (const id of ids) stmt.run(now, id);
  }

  setSync(id: string, enabled: boolean): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('UPDATE repos SET sync_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  recordSync(id: string, at: string, outcome: RepoSyncOutcome, note: string | null): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('UPDATE repos SET sync_at = ?, sync_outcome = ?, sync_note = ? WHERE id = ?').run(at, outcome, note, id);
  }

  workspace(workspaceId: string): WorkspaceRow | null {
    const db = this.store.db;
    if (!db) return null;
    try {
      const r = db.prepare('SELECT * FROM repo_workspaces WHERE workspace_id = ?').get(workspaceId) as
        | { workspace_id: string; roots: string | null; auto: number; scan_at: string | null; scan_ms: number | null; scan_error: string | null; scan_truncated: number }
        | undefined;
      if (!r) return null;
      const roots = json<unknown>(r.roots, null);
      return {
        workspaceId: r.workspace_id,
        roots: Array.isArray(roots) && roots.every((x) => typeof x === 'string') ? (roots as string[]) : null,
        auto: r.auto === 1,
        scanAt: r.scan_at,
        scanMs: r.scan_ms,
        scanError: r.scan_error,
        scanTruncated: r.scan_truncated === 1,
      };
    } catch {
      return null;
    }
  }

  /** The settings the person chose; a workspace that has none yet is created with the defaults. */
  saveSettings(workspaceId: string, now: string, s: { roots?: string[] | null; auto?: boolean }): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('INSERT INTO repo_workspaces (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING').run(workspaceId, now);
    if (s.roots !== undefined) db.prepare('UPDATE repo_workspaces SET roots = ?, updated_at = ? WHERE workspace_id = ?').run(s.roots === null ? null : JSON.stringify(s.roots), now, workspaceId);
    if (s.auto !== undefined) db.prepare('UPDATE repo_workspaces SET auto = ?, updated_at = ? WHERE workspace_id = ?').run(s.auto ? 1 : 0, now, workspaceId);
  }

  saveScan(workspaceId: string, now: string, r: { ms: number; error: string | null; truncated: boolean }): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('INSERT INTO repo_workspaces (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING').run(workspaceId, now);
    db.prepare('UPDATE repo_workspaces SET scan_at = ?, scan_ms = ?, scan_error = ?, scan_truncated = ? WHERE workspace_id = ?').run(now, r.ms, r.error, r.truncated ? 1 : 0, workspaceId);
  }

  /** Every workspace that has rows or settings. */
  workspaceIds(): string[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      return (db.prepare('SELECT workspace_id FROM repo_workspaces UNION SELECT DISTINCT workspace_id FROM repos').all() as { workspace_id: string }[]).map((r) => r.workspace_id);
    } catch {
      return [];
    }
  }

  addEvents(events: NewEvent[]): number[] {
    const db = this.store.db;
    if (!db || !this.store.writable || !events.length) return [];
    const stmt = db.prepare('INSERT INTO repo_events (at, workspace_id, repo_id, repo, kind, actor, actor_label, session_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const ids: number[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of events) ids.push(Number(stmt.run(e.at, e.workspaceId, e.repoId, e.repo, e.kind, e.actor, e.actorLabel ?? null, e.sessionId, e.summary, JSON.stringify(e.data)).lastInsertRowid));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return ids;
  }

  /** Newest first. `next` is the cursor of the page after this one. */
  events(q: RepoEventQuery & { limit?: number }): { events: RepoEvent[]; next: string | null } {
    const db = this.store.db;
    if (!db) return { events: [], next: null };
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 50)));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.workspaceId) {
      where.push('workspace_id = ?');
      args.push(q.workspaceId);
    }
    if (q.repoId) {
      where.push('repo_id = ?');
      args.push(q.repoId);
    }
    const kinds = (q.group === 'audit' ? [...REPO_AUDIT_KINDS] : (q.kind ?? '').split(',').map((k) => k.trim()).filter(Boolean)).filter((k): k is RepoEventKind => (REPO_EVENT_KINDS as readonly string[]).includes(k));
    if (q.group === 'audit' || q.kind) {
      if (!kinds.length) return { events: [], next: null };
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      args.push(...kinds);
    }
    if (q.before && /^\d{1,15}$/.test(q.before)) {
      where.push('id < ?');
      args.push(Number(q.before));
    }
    try {
      const rows = db.prepare(`SELECT * FROM repo_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1) as unknown as EventSql[];
      const page = rows.slice(0, limit).map(toEvent);
      return { events: page, next: rows.length > limit ? page[page.length - 1]!.id : null };
    } catch {
      return { events: [], next: null };
    }
  }

  /** Retention (§8): events older than 90 days and beyond the per-workspace cap; rows of repositories gone for as long. */
  purge(nowMs: number): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    const cut = new Date(nowMs - EVENT_KEEP_MS).toISOString();
    try {
      db.prepare('DELETE FROM repo_events WHERE at < ?').run(cut);
      for (const w of db.prepare('SELECT workspace_id, count(*) AS n FROM repo_events GROUP BY workspace_id HAVING n > ?').all(EVENTS_PER_WORKSPACE) as { workspace_id: string; n: number }[]) {
        db.prepare('DELETE FROM repo_events WHERE workspace_id = ? AND id <= (SELECT id FROM repo_events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(w.workspace_id, w.workspace_id, EVENTS_PER_WORKSPACE);
      }
      db.prepare('DELETE FROM repos WHERE removed_at IS NOT NULL AND removed_at < ?').run(cut);
      db.prepare('DELETE FROM repos WHERE scanned_at < ?').run(cut);
    } catch {
      // housekeeping never stops anything
    }
  }

  /** A removed workspace: its repositories and settings go; its events stay until they age out. */
  forgetWorkspace(workspaceId: string): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    try {
      db.prepare('DELETE FROM repos WHERE workspace_id = ?').run(workspaceId);
      db.prepare('DELETE FROM repo_workspaces WHERE workspace_id = ?').run(workspaceId);
    } catch {
      // nothing to forget
    }
  }
}
