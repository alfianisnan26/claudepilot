// Knowledge: the durable record of a vault, in the portal's own database (Knowledge PRD §11): the text of
// every changed version of a note with who made it, which session, ticket, token or person read or wrote
// which note (the context graph's edges), and the audit of what was refused or done. The notes themselves
// are files; this is what must survive a lost index and ride in database backups.
//
// Notes are never logged here beyond `kg_versions.content`, which is the history the person asked for.

import { deflateSync, inflateSync } from 'node:zlib';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Store } from '../store/store.js';
import { KnowledgeError } from './errors.js';
import type { KnowledgeLimits } from './limits.js';

export type ActorKind = 'user' | 'agent' | 'system' | 'external';
export type VersionOp = 'create' | 'edit' | 'append' | 'rename' | 'delete' | 'restore' | 'import' | 'sync' | 'external';
export type EdgeKind = 'read' | 'created' | 'edited' | 'appended' | 'deleted';
export type EdgeSourceKind = 'session' | 'ticket' | 'token' | 'user' | 'workspace';

export interface Actor {
  /** `ui`, `portal-mcp:<token id>`, `session:<id>`, `ticket:<id>`, `workspace:<id>`, `import`, `sync`, `external`, `system`. */
  id: string;
  kind: ActorKind;
}

/** What an actor string means: people are `ui`; the portal's own jobs are system; everything else is an agent. */
export function parseActor(id: string): Actor {
  if (id === 'ui') return { id, kind: 'user' };
  if (id === 'external') return { id, kind: 'external' };
  if (id === 'system' || id === 'import' || id === 'sync') return { id, kind: 'system' };
  return { id, kind: 'agent' };
}

/** The context-graph source an actor stands for. */
export function edgeSource(actor: Actor): { kind: EdgeSourceKind; id: string } | null {
  const colon = actor.id.indexOf(':');
  const type = colon > 0 ? actor.id.slice(0, colon) : actor.id;
  const key = colon > 0 ? actor.id.slice(colon + 1) : '';
  if (type === 'session' && key) return { kind: 'session', id: key };
  if (type === 'ticket' && key) return { kind: 'ticket', id: key };
  if (type === 'portal-mcp' && key) return { kind: 'token', id: key };
  if (type === 'workspace' && key) return { kind: 'workspace', id: key };
  if (actor.id === 'ui') return { kind: 'user', id: 'ui' };
  return null;
}

export interface VersionRow {
  id: number;
  vaultId: string;
  path: string;
  op: VersionOp;
  actor: string;
  actorKind: ActorKind;
  baseHash: string | null;
  hash: string | null;
  size: number;
  hasContent: boolean;
  fromPath: string | null;
  note: string;
  state: 'pending' | 'ok';
  at: string;
}

interface Raw {
  id: number;
  vault_id: string;
  path: string;
  op: VersionOp;
  actor: string;
  actor_kind: ActorKind;
  base_hash: string | null;
  hash: string | null;
  size: number;
  has_content: number;
  from_path: string | null;
  note: string;
  state: 'pending' | 'ok';
  at: string;
}

const COLUMNS = 'id, vault_id, path, op, actor, actor_kind, base_hash, hash, size, (content IS NOT NULL) AS has_content, from_path, note, state, at';

const toRow = (r: Raw): VersionRow => ({
  id: r.id,
  vaultId: r.vault_id,
  path: r.path,
  op: r.op,
  actor: r.actor,
  actorKind: r.actor_kind,
  baseHash: r.base_hash,
  hash: r.hash,
  size: r.size,
  hasContent: r.has_content === 1,
  fromPath: r.from_path,
  note: r.note,
  state: r.state,
  at: r.at,
});

export interface NewVersion {
  vaultId: string;
  path: string;
  op: VersionOp;
  actor: Actor;
  baseHash: string | null;
  hash: string | null;
  /** The note's text after the change; null for rename and delete markers. */
  content: string | null;
  fromPath?: string | null;
  note?: string;
}

export interface EdgeTouch {
  vaultId: string;
  path: string;
  sourceKind: EdgeSourceKind;
  sourceId: string;
  kind: EdgeKind;
  count: number;
  lastAt: string;
}

export interface Authorship {
  count: number;
  lastActor: string | null;
  lastKind: ActorKind | null;
  lastAt: string | null;
  /** The note has history and every row is an agent's: it is theirs, not a person's. */
  agentOnly: boolean;
}

export class Journal {
  constructor(
    private readonly store: Store,
    private readonly limits: KnowledgeLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get db(): DatabaseSync {
    const db = this.store.db;
    if (!db) throw new KnowledgeError('UNAVAILABLE', 'The portal’s database isn’t available, so notes can’t be recorded right now.');
    return db;
  }

  /** Writes need a writable database (a database from a newer portal is read-only). */
  assertWritable(): void {
    if (!this.store.writable) throw new KnowledgeError('UNAVAILABLE', 'The portal’s database is read-only, so notes can’t be changed right now.');
  }

  /* ---------- Versions ---------- */

  /** Records a change as pending, before its file is written. Returns the row id. */
  begin(v: NewVersion): number {
    this.assertWritable();
    const content = v.content === null ? null : deflateSync(Buffer.from(v.content, 'utf8'));
    const size = v.content === null ? 0 : Buffer.byteLength(v.content);
    const r = this.db
      .prepare(
        "INSERT INTO kg_versions (vault_id, path, op, actor, actor_kind, base_hash, hash, size, content, from_path, note, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(v.vaultId, v.path, v.op, v.actor.id, v.actor.kind, v.baseHash, v.hash, size, content, v.fromPath ?? null, (v.note ?? '').slice(0, 200), this.now().toISOString());
    return Number(r.lastInsertRowid);
  }

  /**
   * The file landed: the row is final. A change by the same actor to the same note within the coalescing
   * window replaces the previous row (autosave makes one version, not one per keystroke), keeping that
   * row's base; then the note's oldest versions beyond the cap are dropped.
   */
  commit(id: number): void {
    const db = this.db;
    const row = db.prepare(`SELECT ${COLUMNS} FROM kg_versions WHERE id = ?`).get(id) as Raw | undefined;
    if (!row) return;
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE kg_versions SET state = 'ok' WHERE id = ?").run(id);
      const prev = db
        .prepare(`SELECT ${COLUMNS} FROM kg_versions WHERE vault_id = ? AND path = ? AND id < ? AND state = 'ok' ORDER BY id DESC LIMIT 1`)
        .get(row.vault_id, row.path, id) as Raw | undefined;
      if (
        prev &&
        prev.actor === row.actor &&
        (prev.op === 'create' || prev.op === 'edit' || prev.op === 'append') &&
        (row.op === 'edit' || row.op === 'append') &&
        prev.has_content === 1 &&
        Date.parse(row.at) - Date.parse(prev.at) < this.limits.coalesceMs
      ) {
        db.prepare('UPDATE kg_versions SET base_hash = ?, op = ? WHERE id = ?').run(prev.base_hash, prev.op === 'create' ? 'create' : row.op, id);
        db.prepare('DELETE FROM kg_versions WHERE id = ?').run(prev.id);
      }
      db.prepare(
        'DELETE FROM kg_versions WHERE vault_id = ? AND path = ? AND id NOT IN (SELECT id FROM kg_versions WHERE vault_id = ? AND path = ? ORDER BY id DESC LIMIT ?)',
      ).run(row.vault_id, row.path, row.vault_id, row.path, this.limits.versionsPerNote);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The file write failed: the pending row goes. */
  abort(id: number): void {
    this.db.prepare("DELETE FROM kg_versions WHERE id = ? AND state = 'pending'").run(id);
  }

  /** A change with no file write to wait for (a rename or delete marker, an external change). */
  record(v: NewVersion): number {
    const id = this.begin(v);
    this.commit(id);
    return id;
  }

  /**
   * After a start: rows left pending by a crash. `fileHash(path)` is the hash of the note on disk now (or
   * null); a pending row whose hash matches the file landed, any other one never did.
   */
  settlePending(vaultId: string, fileHash: (path: string) => string | null): { landed: number; dropped: number } {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM kg_versions WHERE vault_id = ? AND state = 'pending'`).all(vaultId) as unknown as Raw[];
    let landed = 0;
    let dropped = 0;
    for (const r of rows) {
      if (r.hash !== null && fileHash(r.path) === r.hash) {
        this.commit(r.id);
        landed++;
      } else {
        this.abort(r.id);
        dropped++;
      }
    }
    return { landed, dropped };
  }

  hasRows(vaultId: string, path: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' LIMIT 1").get(vaultId, path);
  }

  latest(vaultId: string, path: string): VersionRow | null {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' ORDER BY id DESC LIMIT 1`).get(vaultId, path) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  /** Newest first. */
  history(vaultId: string, path: string, limit = 200): VersionRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' ORDER BY id DESC LIMIT ?`).all(vaultId, path, limit) as unknown as Raw[]).map(toRow);
  }

  /** One version with its text (null for markers). */
  version(vaultId: string, id: number): { row: VersionRow; content: string | null } | null {
    const r = this.db.prepare(`SELECT ${COLUMNS}, content FROM kg_versions WHERE vault_id = ? AND id = ? AND state = 'ok'`).get(vaultId, id) as (Raw & { content: Uint8Array | null }) | undefined;
    if (!r) return null;
    return { row: toRow(r), content: r.content ? inflateSync(Buffer.from(r.content)).toString('utf8') : null };
  }

  /** The version just before `id` for the same note, for showing what a change did. */
  before(vaultId: string, id: number): { row: VersionRow; content: string | null } | null {
    const cur = this.db.prepare('SELECT path FROM kg_versions WHERE vault_id = ? AND id = ?').get(vaultId, id) as { path: string } | undefined;
    if (!cur) return null;
    const prev = this.db.prepare("SELECT id FROM kg_versions WHERE vault_id = ? AND path = ? AND id < ? AND state = 'ok' AND content IS NOT NULL ORDER BY id DESC LIMIT 1").get(vaultId, cur.path, id) as { id: number } | undefined;
    return prev ? this.version(vaultId, prev.id) : null;
  }

  /** The text of the newest version that has any, so a deleted note can be restored. */
  lastContent(vaultId: string, path: string): { id: number; content: string; at: string } | null {
    const r = this.db.prepare("SELECT id, at, content FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' AND content IS NOT NULL ORDER BY id DESC LIMIT 1").get(vaultId, path) as { id: number; at: string; content: Uint8Array } | undefined;
    return r ? { id: r.id, at: r.at, content: inflateSync(Buffer.from(r.content)).toString('utf8') } : null;
  }

  authorship(vaultId: string, path: string): Authorship {
    const last = this.db.prepare("SELECT actor, actor_kind, at FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' ORDER BY id DESC LIMIT 1").get(vaultId, path) as { actor: string; actor_kind: ActorKind; at: string } | undefined;
    if (!last) return { count: 0, lastActor: null, lastKind: null, lastAt: null, agentOnly: false };
    const c = this.db.prepare("SELECT count(*) AS n, sum(CASE WHEN actor_kind != 'agent' THEN 1 ELSE 0 END) AS others FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok'").get(vaultId, path) as { n: number; others: number | null };
    return { count: c.n, lastActor: last.actor, lastKind: last.actor_kind, lastAt: last.at, agentOnly: (c.others ?? 0) === 0 };
  }

  /** Paths of notes (in one vault) that only agents have ever written, for the "written by agents" badge. */
  agentOnlyPaths(vaultId: string, paths: string[]): Set<string> {
    const out = new Set<string>();
    if (!paths.length) return out;
    const stmt = this.db.prepare("SELECT 1 FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' AND actor_kind != 'agent' LIMIT 1");
    const any = this.db.prepare("SELECT 1 FROM kg_versions WHERE vault_id = ? AND path = ? AND state = 'ok' LIMIT 1");
    for (const p of paths) if (any.get(vaultId, p) && !stmt.get(vaultId, p)) out.add(p);
    return out;
  }

  /** A rename keeps the history and the edges. */
  renamePath(vaultId: string, from: string, to: string): void {
    this.db.prepare('UPDATE kg_versions SET path = ? WHERE vault_id = ? AND path = ?').run(to, vaultId, from);
    this.db.prepare('UPDATE OR REPLACE kg_edges SET path = ? WHERE vault_id = ? AND path = ?').run(to, vaultId, from);
  }

  /** Oldest versions go first when a vault's history outgrows its cap, never the newest row of a note. */
  prune(vaultId: string): number {
    const db = this.db;
    const size = () => (db.prepare('SELECT coalesce(sum(length(content)), 0) AS n FROM kg_versions WHERE vault_id = ?').get(vaultId) as { n: number }).n;
    let removed = 0;
    while (size() > this.limits.journalBytesPerVault) {
      const r = db
        .prepare('DELETE FROM kg_versions WHERE id IN (SELECT id FROM kg_versions v WHERE vault_id = ? AND id != (SELECT max(id) FROM kg_versions w WHERE w.vault_id = v.vault_id AND w.path = v.path) ORDER BY id LIMIT 200)')
        .run(vaultId);
      if (Number(r.changes) === 0) break;
      removed += Number(r.changes);
    }
    // Deleted notes are restorable for a while; after that their history goes with them.
    const cutoff = new Date(this.now().getTime() - this.limits.deletedNoteDays * 86_400_000).toISOString();
    const gone = db
      .prepare("SELECT DISTINCT path FROM kg_versions v WHERE vault_id = ? AND id = (SELECT max(id) FROM kg_versions w WHERE w.vault_id = v.vault_id AND w.path = v.path) AND op = 'delete' AND at < ?")
      .all(vaultId, cutoff) as unknown as { path: string }[];
    for (const g of gone) removed += Number(db.prepare('DELETE FROM kg_versions WHERE vault_id = ? AND path = ?').run(vaultId, g.path).changes);
    return removed;
  }

  /* ---------- Edges ---------- */

  edge(vaultId: string, path: string, actor: Actor, kind: EdgeKind): void {
    const source = edgeSource(actor);
    if (!source) return;
    const at = this.now().toISOString();
    this.db
      .prepare(
        'INSERT INTO kg_edges (vault_id, path, source_kind, source_id, kind, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (vault_id, path, source_kind, source_id, kind) DO UPDATE SET count = count + 1, last_at = excluded.last_at',
      )
      .run(vaultId, path, source.kind, source.id, kind, at, at);
  }

  /** Who touched which note since a time, newest first: what the context graph draws. */
  touches(since: Date, o: { vaults?: string[] | null; kinds?: EdgeKind[]; limit: number }): EdgeTouch[] {
    const where = ['last_at >= ?'];
    const params: SQLInputValue[] = [since.toISOString()];
    if (o.vaults) {
      if (!o.vaults.length) return [];
      where.push(`vault_id IN (${o.vaults.map(() => '?').join(', ')})`);
      params.push(...o.vaults);
    }
    if (o.kinds?.length) {
      where.push(`kind IN (${o.kinds.map(() => '?').join(', ')})`);
      params.push(...o.kinds);
    }
    const rows = this.db
      .prepare(`SELECT vault_id, path, source_kind, source_id, kind, count, last_at FROM kg_edges WHERE ${where.join(' AND ')} ORDER BY last_at DESC LIMIT ?`)
      .all(...params, o.limit) as unknown as { vault_id: string; path: string; source_kind: EdgeSourceKind; source_id: string; kind: EdgeKind; count: number; last_at: string }[];
    return rows.map((r) => ({ vaultId: r.vault_id, path: r.path, sourceKind: r.source_kind, sourceId: r.source_id, kind: r.kind, count: r.count, lastAt: r.last_at }));
  }

  /** Notes in a vault that agents touched in the last `days`, and how many agent writes there were. */
  agentWritesSince(vaultId: string, since: Date): number {
    return (this.db.prepare("SELECT count(*) AS n FROM kg_versions WHERE vault_id = ? AND actor_kind = 'agent' AND state = 'ok' AND at >= ?").get(vaultId, since.toISOString()) as { n: number }).n;
  }

  /* ---------- Audit ---------- */

  audit(a: { vaultId?: string | null; actor: string; op: string; path?: string | null; outcome: 'ok' | 'conflict' | 'denied' | 'refused' | 'error'; detail?: string; bytes?: number | null }): void {
    try {
      this.db
        .prepare('INSERT INTO kg_audit (at, vault_id, actor, op, path, outcome, detail, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.now().toISOString(), a.vaultId ?? null, a.actor, a.op, a.path ?? null, a.outcome, (a.detail ?? '').slice(0, 300), a.bytes ?? null);
    } catch {
      // The audit must never take a note write down with it.
    }
  }

  recentAudit(vaultId: string | null, limit: number): { id: number; at: string; vaultId: string | null; actor: string; op: string; path: string | null; outcome: string; detail: string; bytes: number | null }[] {
    const rows = (vaultId
      ? this.db.prepare('SELECT * FROM kg_audit WHERE vault_id = ? ORDER BY id DESC LIMIT ?').all(vaultId, limit)
      : this.db.prepare('SELECT * FROM kg_audit ORDER BY id DESC LIMIT ?').all(limit)) as unknown as { id: number; at: string; vault_id: string | null; actor: string; op: string; path: string | null; outcome: string; detail: string; bytes: number | null }[];
    return rows.map((r) => ({ id: r.id, at: r.at, vaultId: r.vault_id, actor: r.actor, op: r.op, path: r.path, outcome: r.outcome, detail: r.detail, bytes: r.bytes }));
  }

  /** Drops audit rows older than `days`. */
  pruneAudit(days = 90): void {
    this.db.prepare('DELETE FROM kg_audit WHERE at < ?').run(new Date(this.now().getTime() - days * 86_400_000).toISOString());
  }

  /** Changes of any note in a vault, newest first: the activity feed. */
  activity(vaultId: string, limit: number): VersionRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM kg_versions WHERE vault_id = ? AND state = 'ok' ORDER BY id DESC LIMIT ?`).all(vaultId, limit) as unknown as Raw[]).map(toRow);
  }

  /** Run a statement by hand (tests and migrations of this module's own data). */
  exec(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }
}
