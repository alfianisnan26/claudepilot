// Knowledge: one vault's index (Knowledge PRD §10, §11): files, links, tags, aliases, headings, block ids and
// an FTS5 full-text index, in a SQLite file of its own. It is rebuildable from the folder at any time (delete
// it and the next start scans), so it is never backed up and a schema change just rebuilds it. Nothing here
// touches the vault's files; the Vault class keeps this in step with them.

import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { normHeading, type ParsedNote } from './markdown.js';
import { baseName, foldPath, folderOf } from './paths.js';
import { linkBase, NameTable, resolveTarget, type FileRef } from './resolve.js';

/** Bumped when the tables change; an index with another number is deleted and rebuilt. */
export const INDEX_SCHEMA = 2;

const DDL = `
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lpath TEXT NOT NULL UNIQUE,
  disk TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'file')),
  name TEXT NOT NULL,
  lname TEXT NOT NULL,
  folder TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  hash TEXT,
  heading_title TEXT,
  props TEXT,
  words INTEGER NOT NULL DEFAULT 0,
  fm_error TEXT,
  secret INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX files_lname ON files (lname);
CREATE INDEX files_folder ON files (folder);
CREATE INDEX files_mtime ON files (mtime_ms);
CREATE INDEX files_kind ON files (kind);

CREATE TABLE dirs (path TEXT PRIMARY KEY) STRICT;

CREATE TABLE links (
  src INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  style TEXT NOT NULL,
  embed INTEGER NOT NULL,
  target TEXT NOT NULL,
  lbase TEXT NOT NULL,
  heading TEXT,
  block TEXT,
  alias TEXT,
  entity_type TEXT,
  entity_key TEXT,
  line INTEGER NOT NULL,
  dst INTEGER REFERENCES files (id) ON DELETE SET NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  anchor_ok INTEGER
) STRICT;
CREATE INDEX links_src ON links (src);
CREATE INDEX links_dst ON links (dst);
CREATE INDEX links_lbase ON links (lbase);

CREATE TABLE tags (
  file INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (file, tag)
) STRICT;
CREATE INDEX tags_tag ON tags (tag);

CREATE TABLE aliases (
  file INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  lalias TEXT NOT NULL,
  PRIMARY KEY (file, lalias)
) STRICT;
CREATE INDEX aliases_lalias ON aliases (lalias);

CREATE TABLE headings (
  file INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  level INTEGER NOT NULL,
  text TEXT NOT NULL,
  norm TEXT NOT NULL,
  line INTEGER NOT NULL,
  PRIMARY KEY (file, ord)
) STRICT;
CREATE INDEX headings_norm ON headings (file, norm);

CREATE TABLE blocks (
  file INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  line INTEGER NOT NULL,
  PRIMARY KEY (file, id)
) STRICT;

-- Things the scan skipped or flagged: case collisions, symbolic links, names that can't be linked.
CREATE TABLE issues (
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (path, kind)
) STRICT;

CREATE VIRTUAL TABLE fts USING fts5(
  title, path, tags, aliases, body,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
`;

export interface IndexedFile {
  id: number;
  path: string;
  /** The name on disk when it isn't the NFC path. */
  disk: string | null;
  kind: 'note' | 'file';
  name: string;
  folder: string;
  ext: string;
  size: number;
  mtimeMs: number;
  hash: string | null;
  headingTitle: string | null;
  words: number;
  fmError: string | null;
  secret: boolean;
  props: Record<string, unknown> | null;
}

interface FileRow {
  id: number;
  path: string;
  disk: string | null;
  kind: 'note' | 'file';
  name: string;
  folder: string;
  ext: string;
  size: number;
  mtime_ms: number;
  hash: string | null;
  heading_title: string | null;
  props: string | null;
  words: number;
  fm_error: string | null;
  secret: number;
}

const toFile = (r: FileRow): IndexedFile => ({
  id: r.id,
  path: r.path,
  disk: r.disk,
  kind: r.kind,
  name: r.name,
  folder: r.folder,
  ext: r.ext,
  size: r.size,
  mtimeMs: r.mtime_ms,
  hash: r.hash,
  headingTitle: r.heading_title,
  words: r.words,
  fmError: r.fm_error,
  secret: r.secret === 1,
  props: r.props ? (JSON.parse(r.props) as Record<string, unknown>) : null,
});

export interface NoteInput {
  path: string;
  disk: string | null;
  size: number;
  mtimeMs: number;
  hash: string;
  parsed: ParsedNote;
  /** The text to search (the file without its frontmatter block). */
  body: string;
  secret: boolean;
}

export interface FileInput {
  path: string;
  disk: string | null;
  size: number;
  mtimeMs: number;
}

export interface LinkInfo {
  style: 'wiki' | 'md';
  embed: boolean;
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
  entity: { type: string; key: string } | null;
  line: number;
  /** The path it resolves to, or null. */
  to: string | null;
  ambiguous: boolean;
  /** The heading or block asked for isn't in the target. */
  anchorMissing: boolean;
}

export interface BacklinkInfo {
  path: string;
  name: string;
  line: number;
  embed: boolean;
}

export interface GraphNoteRow {
  id: number;
  path: string;
  name: string;
  folder: string;
  title: string | null;
  mtimeMs: number;
}

export interface QuickHit {
  path: string;
  name: string;
  kind: 'note' | 'file';
  /** The alias that matched, when it was one. */
  alias: string | null;
  mtimeMs: number;
}

export interface TreeFolder {
  name: string;
  path: string;
  /** Files under it, all levels. */
  count: number;
}

export interface ParsedQuery {
  words: string[];
  phrases: string[][];
  exclude: string[];
  tags: string[];
  folders: string[];
  files: string[];
  /** The last word is still being typed (no trailing space), so it matches as a prefix. */
  prefix: boolean;
}

/** node:sqlite rows have no prototype; callers get ordinary objects. */
const plain = <T>(rows: unknown[]): T[] => rows.map((r) => ({ ...(r as object) }) as T);

const wordsOf = (s: string): string[] => s.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];

/** Splits what a person typed into terms and filters. Never throws; nothing here reaches FTS5 unquoted. */
export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { words: [], phrases: [], exclude: [], tags: [], folders: [], files: [], prefix: false };
  const tokens = [...q.matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/gu)];
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i]!;
    if (m[2] !== undefined) {
      const ws = wordsOf(m[2]);
      if (!ws.length) continue;
      if (m[1] === '-') out.exclude.push(...ws);
      else out.phrases.push(ws);
      continue;
    }
    const neg = m[3] === '-';
    const tok = m[4]!;
    const colon = tok.indexOf(':');
    if (colon > 0) {
      const key = tok.slice(0, colon).toLowerCase();
      const value = tok.slice(colon + 1).replace(/^#/, '');
      if (key === 'tag' && value) {
        out.tags.push(value.toLowerCase());
        continue;
      }
      if ((key === 'folder' || key === 'path') && value) {
        out.folders.push(value.replace(/\/+$/, '').toLowerCase());
        continue;
      }
      if (key === 'file' && value) {
        out.files.push(value.toLowerCase());
        continue;
      }
    }
    const ws = wordsOf(tok);
    if (!ws.length) continue;
    if (neg) out.exclude.push(...ws);
    else {
      out.words.push(...ws);
      if (i === tokens.length - 1 && !/\s$/.test(q)) out.prefix = true;
    }
  }
  return out;
}

const quote = (w: string) => `"${w.replace(/"/g, '""')}"`;

/** The FTS5 expression for a parsed query, or null when it has no positive term. */
export function ftsExpression(p: ParsedQuery): string | null {
  const parts: string[] = [];
  p.words.forEach((w, i) => parts.push(quote(w) + (p.prefix && i === p.words.length - 1 ? '*' : '')));
  for (const ph of p.phrases) parts.push(quote(ph.join(' ')));
  if (!parts.length) return null;
  const positive = parts.join(' AND ');
  if (!p.exclude.length) return positive;
  return `(${positive}) NOT (${p.exclude.map(quote).join(' OR ')})`;
}

export interface SearchRow {
  id: number;
  path: string;
  name: string;
  headingTitle: string | null;
  mtimeMs: number;
  words: number;
  rank: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export interface IndexStats {
  notes: number;
  files: number;
  bytes: number;
  tags: number;
  unresolved: number;
  folders: number;
  lastChangeMs: number | null;
}

export class VaultIndex {
  readonly db: DatabaseSync;
  readonly names = new NameTable();
  readonly #stmts = new Map<string, StatementSync>();
  #quick: { path: string; name: string; lname: string; lpath: string; kind: 'note' | 'file'; aliases: string[]; mtimeMs: number }[] | null = null;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = this.#open();
    this.#loadNames();
  }

  #open(): DatabaseSync {
    let db = new DatabaseSync(this.file, { enableForeignKeyConstraints: true, timeout: 5000 });
    let version = 0;
    try {
      version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    } catch {
      version = -1;
    }
    if (version !== INDEX_SCHEMA) {
      db.close();
      for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) rmSync(f, { force: true });
      db = new DatabaseSync(this.file, { enableForeignKeyConstraints: true, timeout: 5000 });
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(DDL);
      db.exec(`PRAGMA user_version = ${INDEX_SCHEMA}`);
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY');
    return db;
  }

  #stmt(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  #loadNames() {
    this.names.clear();
    for (const r of this.#stmt('SELECT id, path, lpath, kind, lname, folder FROM files').all() as unknown as { id: number; path: string; lpath: string; kind: 'note' | 'file'; lname: string; folder: string }[])
      this.names.add({ id: r.id, path: r.path, lpath: r.lpath, kind: r.kind, lname: r.lname, folder: r.folder });
  }

  close() {
    this.#stmts.clear();
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Counts the changes made to the index (each transaction that committed), so what is derived from it can tell it is out of date. */
  generation = 0;

  /** Runs `fn` in one transaction (nested calls join the outer one). */
  #depth = 0;
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.db.exec('BEGIN');
    this.#depth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      this.generation++;
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.#loadNames();
      this.#quick = null;
      throw e;
    } finally {
      this.#depth--;
    }
  }

  /* ---------- Files ---------- */

  get(path: string): IndexedFile | null {
    const r = this.#stmt('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
    return r ? toFile(r) : null;
  }

  getByFolded(path: string): IndexedFile | null {
    const r = this.#stmt('SELECT * FROM files WHERE lpath = ?').get(foldPath(path)) as FileRow | undefined;
    return r ? toFile(r) : null;
  }

  byId(id: number): IndexedFile | null {
    const r = this.#stmt('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
    return r ? toFile(r) : null;
  }

  /** What the scan compares the folder with: path to size, mtime, hash. */
  snapshot(): Map<string, { id: number; kind: 'note' | 'file'; size: number; mtimeMs: number; hash: string | null; disk: string | null }> {
    const m = new Map<string, { id: number; kind: 'note' | 'file'; size: number; mtimeMs: number; hash: string | null; disk: string | null }>();
    for (const r of this.#stmt('SELECT id, path, kind, size, mtime_ms, hash, disk FROM files').all() as unknown as { id: number; path: string; kind: 'note' | 'file'; size: number; mtime_ms: number; hash: string | null; disk: string | null }[])
      m.set(r.path, { id: r.id, kind: r.kind, size: r.size, mtimeMs: r.mtime_ms, hash: r.hash, disk: r.disk });
    return m;
  }

  #fileRow(path: string, kind: 'note' | 'file', disk: string | null, size: number, mtimeMs: number, extra: { hash: string | null; headingTitle: string | null; props: string | null; words: number; fmError: string | null; secret: number }): { id: number; created: boolean } {
    const folder = folderOf(path);
    const base = baseName(path);
    const name = kind === 'note' ? base.replace(/\.md$/i, '') : base;
    const lname = foldPath(name);
    const ext = kind === 'file' && base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
    const existing = this.#stmt('SELECT id, lname, lpath, kind, folder, path FROM files WHERE path = ?').get(path) as { id: number; lname: string; lpath: string; kind: 'note' | 'file'; folder: string; path: string } | undefined;
    const params: SQLInputValue[] = [disk, kind, name, lname, folder, ext, size, Math.floor(mtimeMs), extra.hash, extra.headingTitle, extra.props, extra.words, extra.fmError, extra.secret];
    if (existing) {
      this.#stmt(
        'UPDATE files SET disk = ?, kind = ?, name = ?, lname = ?, folder = ?, ext = ?, size = ?, mtime_ms = ?, hash = ?, heading_title = ?, props = ?, words = ?, fm_error = ?, secret = ? WHERE id = ?',
      ).run(...params, existing.id);
      return { id: existing.id, created: false };
    }
    const r = this.#stmt(
      'INSERT INTO files (path, lpath, disk, kind, name, lname, folder, ext, size, mtime_ms, hash, heading_title, props, words, fm_error, secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(path, foldPath(path), ...params);
    const id = Number(r.lastInsertRowid);
    this.names.add({ id, path, lpath: foldPath(path), kind, lname, folder });
    return { id, created: true };
  }

  /** Adds or updates a note and everything read from it; returns whether it is new. */
  upsertNote(n: NoteInput): { id: number; created: boolean } {
    return this.tx(() => {
      const p = n.parsed;
      const props = Object.keys(p.frontmatter).length ? JSON.stringify(p.frontmatter) : null;
      const { id, created } = this.#fileRow(n.path, 'note', n.disk, n.size, n.mtimeMs, {
        hash: n.hash,
        headingTitle: p.title,
        props,
        words: p.words,
        fmError: p.frontmatterError,
        secret: n.secret ? 1 : 0,
      });
      for (const t of ['links', 'tags', 'aliases', 'headings', 'blocks']) this.#stmt(`DELETE FROM ${t} WHERE ${t === 'links' ? 'src' : 'file'} = ?`).run(id);
      for (const t of p.tags) this.#stmt('INSERT OR IGNORE INTO tags (file, tag, source) VALUES (?, ?, ?)').run(id, t.tag, t.source);
      for (const a of p.aliases) this.#stmt('INSERT OR IGNORE INTO aliases (file, alias, lalias) VALUES (?, ?, ?)').run(id, a, foldPath(a));
      p.headings.forEach((h, i) => this.#stmt('INSERT INTO headings (file, ord, level, text, norm, line) VALUES (?, ?, ?, ?, ?, ?)').run(id, i, h.level, h.text, h.norm, h.line));
      for (const b of p.blocks) this.#stmt('INSERT OR IGNORE INTO blocks (file, id, line) VALUES (?, ?, ?)').run(id, b.id, b.line);

      const folder = folderOf(n.path);
      const insertLink = this.#stmt(
        'INSERT INTO links (src, style, embed, target, lbase, heading, block, alias, entity_type, entity_key, line, dst, ambiguous, anchor_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const l of p.links) {
        let dst: number | null = null;
        let ambiguous = 0;
        let anchorOk: number | null = null;
        if (!l.entity) {
          if (!l.target) dst = id;
          else {
            const r = resolveTarget(this.names, { target: l.target, embed: l.embed }, folder);
            dst = r.file?.id ?? null;
            ambiguous = r.ambiguous ? 1 : 0;
          }
          if (dst !== null && (l.heading || l.block)) anchorOk = dst === id ? this.#anchorIn(p, l.heading, l.block) : this.#anchorOf(dst, l.heading, l.block);
        }
        insertLink.run(id, l.style, l.embed ? 1 : 0, l.target, l.entity ? foldPath(`${l.entity.type}:${l.entity.key}`) : linkBase(l.target), l.heading, l.block, l.alias, l.entity?.type ?? null, l.entity?.key ?? null, l.line, dst, ambiguous, anchorOk);
      }

      this.#stmt('DELETE FROM fts WHERE rowid = ?').run(id);
      this.#stmt('INSERT INTO fts (rowid, title, path, tags, aliases, body) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        [baseName(n.path).replace(/\.md$/i, ''), p.title ?? ''].join(' '),
        n.path,
        p.tags.map((t) => t.tag).join(' '),
        p.aliases.join(' '),
        n.body,
      );
      if (created) this.reresolve([foldPath(baseName(n.path).replace(/\.md$/i, ''))]);
      else this.#recheckAnchors(id);
      this.#quick = null;
      return { id, created };
    });
  }

  /** A file's size and time changed but its content didn't: update just those. */
  touch(path: string, disk: string | null, size: number, mtimeMs: number): void {
    this.#stmt('UPDATE files SET disk = ?, size = ?, mtime_ms = ? WHERE path = ?').run(disk, size, Math.floor(mtimeMs), path);
  }

  /** Adds or updates an attachment (no content is read). */
  upsertAttachment(f: FileInput): { id: number; created: boolean } {
    return this.tx(() => {
      const r = this.#fileRow(f.path, 'file', f.disk, f.size, f.mtimeMs, { hash: null, headingTitle: null, props: null, words: 0, fmError: null, secret: 0 });
      if (r.created) this.reresolve([foldPath(baseName(f.path))]);
      this.#quick = null;
      return r;
    });
  }

  removeFile(path: string): boolean {
    return this.tx(() => {
      const row = this.#stmt('SELECT id, lname, kind FROM files WHERE path = ?').get(path) as { id: number; lname: string; kind: 'note' | 'file' } | undefined;
      if (!row) return false;
      const ref = this.names.byPath(foldPath(path));
      if (ref) this.names.remove(ref);
      this.#stmt('DELETE FROM fts WHERE rowid = ?').run(row.id);
      this.#stmt('DELETE FROM files WHERE id = ?').run(row.id);
      this.reresolve([row.lname]);
      this.#quick = null;
      return true;
    });
  }

  /** Links whose target name is one of `lnames` are resolved again (a file with that name appeared, went, or moved). */
  reresolve(lnames: Iterable<string>): void {
    const select = this.#stmt(
      'SELECT l.rowid AS rid, l.src, l.target, l.embed, l.dst, l.ambiguous, l.heading, l.block, l.anchor_ok, f.folder FROM links l JOIN files f ON f.id = l.src WHERE l.lbase = ? AND l.entity_type IS NULL AND l.target != \'\'',
    );
    const update = this.#stmt('UPDATE links SET dst = ?, ambiguous = ?, anchor_ok = ? WHERE rowid = ?');
    for (const name of new Set(lnames)) {
      for (const r of select.all(name) as unknown as { rid: number; src: number; target: string; embed: number; dst: number | null; ambiguous: number; heading: string | null; block: string | null; anchor_ok: number | null; folder: string }[]) {
        const res = resolveTarget(this.names, { target: r.target, embed: r.embed === 1 }, r.folder);
        const dst = res.file?.id ?? null;
        const anchor = dst !== null && (r.heading || r.block) ? this.#anchorOf(dst, r.heading, r.block) : null;
        if (dst !== r.dst || (res.ambiguous ? 1 : 0) !== r.ambiguous || anchor !== r.anchor_ok) update.run(dst, res.ambiguous ? 1 : 0, anchor, r.rid);
      }
    }
  }

  #anchorIn(p: ParsedNote, heading: string | null, block: string | null): number {
    if (heading) return p.headings.some((h) => h.norm === normHeading(heading.split('#').pop()!)) ? 1 : 0;
    if (block) return p.blocks.some((b) => b.id === block) ? 1 : 0;
    return 1;
  }

  #anchorOf(file: number, heading: string | null, block: string | null): number {
    if (heading) return this.#stmt('SELECT 1 FROM headings WHERE file = ? AND norm = ?').get(file, normHeading(heading.split('#').pop()!)) ? 1 : 0;
    if (block) return this.#stmt('SELECT 1 FROM blocks WHERE file = ? AND id = ?').get(file, block) ? 1 : 0;
    return 1;
  }

  /** After a note changed, links into it that name a heading or block are checked against the new text. */
  #recheckAnchors(file: number) {
    const rows = this.#stmt('SELECT rowid AS rid, heading, block, anchor_ok FROM links WHERE dst = ? AND (heading IS NOT NULL OR block IS NOT NULL)').all(file) as unknown as { rid: number; heading: string | null; block: string | null; anchor_ok: number | null }[];
    for (const r of rows) {
      const ok = this.#anchorOf(file, r.heading, r.block);
      if (ok !== r.anchor_ok) this.#stmt('UPDATE links SET anchor_ok = ? WHERE rowid = ?').run(ok, r.rid);
    }
  }

  addDir(path: string) {
    if (!path) return;
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) this.#stmt('INSERT OR IGNORE INTO dirs (path) VALUES (?)').run(parts.slice(0, i).join('/'));
  }

  replaceDirs(paths: Iterable<string>) {
    this.tx(() => {
      this.db.exec('DELETE FROM dirs');
      for (const p of paths) this.addDir(p);
    });
  }

  setIssues(issues: { path: string; kind: string; detail?: string }[]) {
    this.tx(() => {
      this.db.exec('DELETE FROM issues');
      for (const i of issues) this.#stmt('INSERT OR REPLACE INTO issues (path, kind, detail) VALUES (?, ?, ?)').run(i.path, i.kind, i.detail ?? '');
    });
  }

  issues(): { path: string; kind: string; detail: string }[] {
    return plain(this.#stmt('SELECT path, kind, detail FROM issues ORDER BY kind, path LIMIT 500').all());
  }

  /* ---------- Reading ---------- */

  /** Folders and files directly in `folder`, folders first. */
  listFolder(folder: string): { folders: TreeFolder[]; files: IndexedFile[] } {
    const prefix = folder ? `${folder}/` : '';
    const counts = this.#stmt('SELECT folder, count(*) AS n FROM files GROUP BY folder').all() as unknown as { folder: string; n: number }[];
    const dirs = this.#stmt('SELECT path FROM dirs').all() as unknown as { path: string }[];
    const children = new Map<string, number>();
    for (const d of dirs) {
      if (!d.path.startsWith(prefix) || d.path === folder) continue;
      const first = d.path.slice(prefix.length).split('/')[0]!;
      if (!children.has(first)) children.set(first, 0);
    }
    for (const c of counts) {
      if (c.folder === folder || !c.folder.startsWith(prefix)) continue;
      const first = c.folder.slice(prefix.length).split('/')[0]!;
      children.set(first, (children.get(first) ?? 0) + c.n);
    }
    const folders = [...children.entries()]
      .map(([name, count]) => ({ name, path: prefix + name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const files = (this.#stmt('SELECT * FROM files WHERE folder = ? ORDER BY lname').all(folder) as unknown as FileRow[]).map(toFile);
    return { folders, files };
  }

  outgoing(fileId: number): LinkInfo[] {
    const rows = this.#stmt(
      'SELECT l.style, l.embed, l.target, l.heading, l.block, l.alias, l.entity_type, l.entity_key, l.line, l.ambiguous, l.anchor_ok, d.path AS to_path FROM links l LEFT JOIN files d ON d.id = l.dst WHERE l.src = ? ORDER BY l.rowid',
    ).all(fileId) as unknown as { style: 'wiki' | 'md'; embed: number; target: string; heading: string | null; block: string | null; alias: string | null; entity_type: string | null; entity_key: string | null; line: number; ambiguous: number; anchor_ok: number | null; to_path: string | null }[];
    return rows.map((r) => ({
      style: r.style,
      embed: r.embed === 1,
      target: r.target,
      heading: r.heading,
      block: r.block,
      alias: r.alias,
      entity: r.entity_type ? { type: r.entity_type, key: r.entity_key ?? '' } : null,
      line: r.line,
      to: r.to_path,
      ambiguous: r.ambiguous === 1,
      anchorMissing: r.anchor_ok === 0,
    }));
  }

  backlinks(fileId: number, limit = 500): BacklinkInfo[] {
    const rows = this.#stmt(
      'SELECT f.path, f.name, l.line, l.embed FROM links l JOIN files f ON f.id = l.src WHERE l.dst = ? AND l.src != ? ORDER BY f.lname, l.line LIMIT ?',
    ).all(fileId, fileId, limit) as unknown as { path: string; name: string; line: number; embed: number }[];
    return rows.map((r) => ({ path: r.path, name: r.name, line: r.line, embed: r.embed === 1 }));
  }

  /** The links that resolve to a file: for each, the note it's in (with the hash the index read) and where in it, so a rename can rewrite them. */
  inboundLinks(fileId: number): { src: string; hash: string | null; target: string; line: number; embed: boolean; style: 'wiki' | 'md' }[] {
    const rows = this.#stmt(
      "SELECT f.path AS src, f.hash AS hash, l.target, l.line, l.embed, l.style FROM links l JOIN files f ON f.id = l.src WHERE l.dst = ? AND l.entity_type IS NULL AND l.target != '' ORDER BY f.path, l.line",
    ).all(fileId) as unknown as { src: string; hash: string | null; target: string; line: number; embed: number; style: 'wiki' | 'md' }[];
    return rows.map((r) => ({ src: r.src, hash: r.hash, target: r.target, line: r.line, embed: r.embed === 1, style: r.style }));
  }

  backlinkCount(fileId: number): number {
    return (this.#stmt('SELECT count(DISTINCT src) AS n FROM links WHERE dst = ? AND src != ?').get(fileId, fileId) as { n: number }).n;
  }

  tagsOf(fileId: number): string[] {
    return (this.#stmt('SELECT tag FROM tags WHERE file = ? ORDER BY tag').all(fileId) as unknown as { tag: string }[]).map((r) => r.tag);
  }

  aliasesOf(fileId: number): string[] {
    return (this.#stmt('SELECT alias FROM aliases WHERE file = ? ORDER BY alias').all(fileId) as unknown as { alias: string }[]).map((r) => r.alias);
  }

  headingsOf(fileId: number): { level: number; text: string; line: number }[] {
    return plain(this.#stmt('SELECT level, text, line FROM headings WHERE file = ? ORDER BY ord').all(fileId));
  }

  tags(prefix = ''): { tag: string; count: number }[] {
    if (prefix) {
      const p = prefix.toLowerCase().replace(/^#/, '');
      return plain(this.#stmt("SELECT tag, count(*) AS count FROM tags WHERE tag = ? OR tag LIKE ? ESCAPE '\\' GROUP BY tag ORDER BY count DESC, tag LIMIT 1000").all(p, `${likeEscape(p)}%`));
    }
    return plain(this.#stmt('SELECT tag, count(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag LIMIT 2000').all());
  }

  recent(limit: number, kind: 'note' | 'file' = 'note'): IndexedFile[] {
    return (this.#stmt('SELECT * FROM files WHERE kind = ? ORDER BY mtime_ms DESC, path LIMIT ?').all(kind, limit) as unknown as FileRow[]).map(toFile);
  }

  /** Notes that mention `text` without linking to `fileId`, found by phrase search. */
  mentions(fileId: number, phrases: string[], limit = 50): { path: string; name: string }[] {
    const expr = phrases
      .map((p) => wordsOf(p))
      .filter((w) => w.length)
      .map((w) => quote(w.join(' ')))
      .join(' OR ');
    if (!expr) return [];
    const rows = this.#stmt(
      `SELECT f.path, f.name FROM fts CROSS JOIN files f ON f.id = fts.rowid WHERE fts MATCH ? AND f.id != ? AND +f.kind = 'note'
       AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src = f.id AND l.dst = ?) ORDER BY bm25(fts, 1.0, 1.0, 1.0, 1.0, 5.0) LIMIT ?`,
    ).all(`body : (${expr})`, fileId, fileId, limit);
    return plain(rows);
  }

  /* ---------- Graph (bulk reads: the graph builder works on these in memory) ---------- */

  // Each takes the ids of the notes to read for (a local graph), or reads the whole vault.

  graphNotes(ids?: number[]): GraphNoteRow[] {
    const cols = "id, path, name, folder, heading_title AS title, mtime_ms AS mtimeMs FROM files WHERE kind = 'note'";
    return plain(ids ? this.#stmt(`SELECT ${cols} AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) : this.#stmt(`SELECT ${cols}`).all());
  }

  /** Attachments some note links to or embeds. */
  graphFiles(ids?: number[]): GraphNoteRow[] {
    const cols = "f.id, f.path, f.name, f.folder, NULL AS title, f.mtime_ms AS mtimeMs FROM files f WHERE f.kind = 'file'";
    return plain(
      ids
        ? this.#stmt(`SELECT ${cols} AND EXISTS (SELECT 1 FROM links l WHERE l.dst = f.id AND l.src IN (SELECT value FROM json_each(?)))`).all(JSON.stringify(ids))
        : this.#stmt(`SELECT ${cols} AND EXISTS (SELECT 1 FROM links l WHERE l.dst = f.id)`).all(),
    );
  }

  /** Resolved links from notes to files, one row each (the builder adds up a pair that links twice). */
  graphLinks(ids?: number[]): { src: number; dst: number; embed: number }[] {
    const cols = 'src, dst, embed FROM links WHERE dst IS NOT NULL AND dst != src';
    return plain(ids ? this.#stmt(`SELECT ${cols} AND src IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) : this.#stmt(`SELECT ${cols}`).all());
  }

  /** Links to names no file has, one row per note and name. */
  graphUnresolved(ids?: number[]): { src: number; key: string; target: string; n: number }[] {
    const cols = "src, lbase AS key, min(target) AS target, count(*) AS n FROM links WHERE dst IS NULL AND entity_type IS NULL AND target != ''";
    const group = 'GROUP BY src, lbase';
    return plain(ids ? this.#stmt(`SELECT ${cols} AND src IN (SELECT value FROM json_each(?)) ${group}`).all(JSON.stringify(ids)) : this.#stmt(`SELECT ${cols} ${group}`).all());
  }

  /** Links to things of the portal (`[[ticket:T-1]]`), one row per note and thing. */
  graphEntities(): (GraphNoteRow & { type: string; key: string; n: number })[] {
    return plain(
      this.#stmt(
        `SELECT f.id, f.path, f.name, f.folder, f.heading_title AS title, f.mtime_ms AS mtimeMs, l.entity_type AS type, l.entity_key AS key, count(*) AS n
         FROM links l JOIN files f ON f.id = l.src WHERE l.entity_type IS NOT NULL AND l.entity_key IS NOT NULL GROUP BY l.src, l.entity_type, l.entity_key`,
      ).all(),
    );
  }

  graphTags(ids?: number[]): { file: number; tag: string }[] {
    return plain(ids ? this.#stmt('SELECT file, tag FROM tags WHERE file IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) : this.#stmt('SELECT file, tag FROM tags').all());
  }

  /** How many other files each of `ids` is linked to, either way (what sizes a node). */
  degrees(ids: number[]): Map<number, number> {
    const json = JSON.stringify(ids);
    const rows = this.#stmt(
      `SELECT n, count(*) AS degree FROM (
         SELECT src AS n, dst AS o FROM links WHERE src IN (SELECT value FROM json_each(?)) AND dst IS NOT NULL AND dst != src
         UNION
         SELECT dst AS n, src AS o FROM links WHERE dst IN (SELECT value FROM json_each(?)) AND src != dst
       ) GROUP BY n`,
    ).all(json, json) as unknown as { n: number; degree: number }[];
    return new Map(rows.map((r) => [r.n, r.degree]));
  }

  /**
   * The notes within `depth` link steps of one note (either direction), nearest first, at most `budget`. A level that
   * would pass the budget keeps its most linked notes. Followed in the index, so a note's neighbourhood doesn't read
   * the whole vault; attachments are not walked through (two notes with the same picture aren't linked by it).
   */
  nearNotes(center: number, depth: number, budget: number): { ids: number[]; complete: boolean } {
    const seen = new Set<number>([center]);
    const order = [center];
    let frontier = [center];
    let complete = true;
    for (let d = 0; d < depth && frontier.length; d++) {
      const json = JSON.stringify(frontier);
      const rows = this.#stmt(
        `SELECT o.other FROM (
           SELECT dst AS other FROM links WHERE src IN (SELECT value FROM json_each(?)) AND dst IS NOT NULL
           UNION
           SELECT src AS other FROM links WHERE dst IN (SELECT value FROM json_each(?))
         ) o JOIN files f ON f.id = o.other AND f.kind = 'note'`,
      ).all(json, json) as unknown as { other: number }[];
      let next = rows.map((r) => r.other).filter((id) => !seen.has(id));
      if (order.length + next.length > budget) {
        const rank = this.degrees(next);
        next.sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || a - b);
        next = next.slice(0, Math.max(0, budget - order.length));
        complete = false;
      }
      for (const id of next) {
        seen.add(id);
        order.push(id);
      }
      frontier = next;
      if (!complete) break;
    }
    return { ids: order, complete };
  }

  /* ---------- Search ---------- */

  search(q: ParsedQuery, limit: number, offset: number): { rows: SearchRow[]; total: number } {
    const expr = ftsExpression(q);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    for (const t of q.tags) {
      where.push("EXISTS (SELECT 1 FROM tags tg WHERE tg.file = f.id AND (tg.tag = ? OR tg.tag LIKE ? ESCAPE '\\'))");
      params.push(t, `${likeEscape(t)}/%`);
    }
    for (const fo of q.folders) {
      where.push("(f.folder = ? COLLATE NOCASE OR f.folder LIKE ? ESCAPE '\\')");
      params.push(fo, `${likeEscape(fo)}/%`);
    }
    for (const fl of q.files) {
      where.push("f.lpath LIKE ? ESCAPE '\\'");
      params.push(`%${likeEscape(fl)}%`);
    }
    // `+` keeps SQLite from walking `files` by this column and probing FTS5 once per file: the full-text match drives the join.
    where.push("+f.kind = 'note'");
    const filter = where.length ? ` AND ${where.join(' AND ')}` : '';
    if (expr) {
      const rows = this.db
        .prepare(
          `SELECT f.id, f.path, f.name, f.heading_title AS headingTitle, f.mtime_ms AS mtimeMs, f.words, bm25(fts, 10.0, 4.0, 5.0, 5.0, 1.0) AS rank
           FROM fts CROSS JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?${filter} ORDER BY rank, f.path LIMIT ? OFFSET ?`,
        )
        .all(expr, ...params, limit, offset);
      const total = (this.db.prepare(`SELECT count(*) AS n FROM fts CROSS JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?${filter}`).get(expr, ...params) as { n: number }).n;
      return { rows: plain<SearchRow>(rows), total };
    }
    // Filters only: newest first.
    const rows = this.db
      .prepare(`SELECT f.id, f.path, f.name, f.heading_title AS headingTitle, f.mtime_ms AS mtimeMs, f.words, 0 AS rank FROM files f WHERE 1 = 1${filter} ORDER BY f.mtime_ms DESC, f.path LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = (this.db.prepare(`SELECT count(*) AS n FROM files f WHERE 1 = 1${filter}`).get(...params) as { n: number }).n;
    return { rows: plain<SearchRow>(rows), total };
  }

  /** Titles, aliases and paths matching what was typed, best first: for the quick switcher and link completion. */
  quick(q: string, limit: number, kinds: 'note' | 'all' = 'note'): QuickHit[] {
    if (!this.#quick) {
      const aliasRows = this.#stmt('SELECT file, alias FROM aliases').all() as unknown as { file: number; alias: string }[];
      const byFile = new Map<number, string[]>();
      for (const a of aliasRows) {
        const l = byFile.get(a.file);
        if (l) l.push(a.alias);
        else byFile.set(a.file, [a.alias]);
      }
      this.#quick = (this.#stmt('SELECT id, path, name, lname, lpath, kind, mtime_ms FROM files').all() as unknown as { id: number; path: string; name: string; lname: string; lpath: string; kind: 'note' | 'file'; mtime_ms: number }[]).map((r) => ({
        path: r.path,
        name: r.name,
        lname: r.lname,
        lpath: r.lpath,
        kind: r.kind,
        aliases: byFile.get(r.id) ?? [],
        mtimeMs: r.mtime_ms,
      }));
    }
    const tokens = foldPath(q).split(/\s+/).filter(Boolean);
    const scored: { hit: QuickHit; score: number }[] = [];
    for (const f of this.#quick) {
      if (kinds === 'note' && f.kind !== 'note') continue;
      let score = 0;
      let alias: string | null = null;
      for (const tok of tokens) {
        const inName = f.lname.indexOf(tok);
        let s = 0;
        if (f.lname === tok) s = 1000;
        else if (inName === 0) s = 500;
        else if (inName > 0) s = 300 - Math.min(inName, 100);
        else {
          const a = f.aliases.find((x) => foldPath(x).includes(tok));
          if (a) {
            s = 250;
            alias = a;
          } else if (f.lpath.includes(tok)) s = 100;
          else if (isSubsequence(tok, f.lname)) s = 40;
          else {
            s = -1;
          }
        }
        if (s < 0) {
          score = -1;
          break;
        }
        score += s;
      }
      if (tokens.length === 0) score = 1;
      if (score < 0) continue;
      scored.push({ hit: { path: f.path, name: f.name, kind: f.kind, alias, mtimeMs: f.mtimeMs }, score: score - f.lname.length / 1000 });
    }
    scored.sort((a, b) => b.score - a.score || b.hit.mtimeMs - a.hit.mtimeMs || a.hit.path.localeCompare(b.hit.path));
    return scored.slice(0, limit).map((s) => s.hit);
  }

  /* ---------- Health and numbers ---------- */

  stats(): IndexStats {
    const k = this.#stmt('SELECT kind, count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files GROUP BY kind').all() as unknown as { kind: string; n: number; bytes: number }[];
    const notes = k.find((x) => x.kind === 'note')?.n ?? 0;
    const files = k.find((x) => x.kind === 'file')?.n ?? 0;
    const bytes = k.reduce((s, x) => s + x.bytes, 0);
    const tags = (this.#stmt('SELECT count(DISTINCT tag) AS n FROM tags').get() as { n: number }).n;
    const unresolved = (this.#stmt("SELECT count(*) AS n FROM links WHERE dst IS NULL AND entity_type IS NULL AND target != ''").get() as { n: number }).n;
    const folders = (this.#stmt('SELECT count(*) AS n FROM dirs').get() as { n: number }).n;
    const last = (this.#stmt('SELECT max(mtime_ms) AS m FROM files').get() as { m: number | null }).m;
    return { notes, files, bytes, tags, unresolved, folders, lastChangeMs: last };
  }

  health(): {
    unresolved: { target: string; count: number; sources: string[] }[];
    ambiguous: { target: string; count: number; sources: string[] }[];
    anchors: { path: string; target: string; heading: string | null; block: string | null; line: number }[];
    embeds: { path: string; target: string; line: number }[];
    orphans: string[];
    duplicates: { name: string; paths: string[] }[];
    issues: { path: string; kind: string; detail: string }[];
  } {
    // Groups of links by target with up to three source notes each, in one pass over the links (a per-group lookup would
    // scan them all again for every group).
    const group = (where: string) => {
      const rows = this.db
        .prepare(
          `WITH g AS (SELECT lower(l.target) AS k, min(l.target) AS target, count(*) AS n FROM links l WHERE ${where} GROUP BY k ORDER BY n DESC, k LIMIT 300),
                pairs AS (SELECT DISTINCT g.k AS k, f.path AS path FROM links l JOIN g ON g.k = lower(l.target) JOIN files f ON f.id = l.src WHERE ${where}),
                s AS (SELECT k, path, row_number() OVER (PARTITION BY k ORDER BY path) AS rn FROM pairs)
           SELECT g.k AS k, g.target AS target, g.n AS n, s.path AS path FROM g JOIN s ON s.k = g.k AND s.rn <= 3 ORDER BY g.n DESC, g.k, s.path`,
        )
        .all() as unknown as { k: string; target: string; n: number; path: string }[];
      const out: { target: string; count: number; sources: string[] }[] = [];
      for (const r of rows) {
        const last = out[out.length - 1];
        if (last && last.target === r.target) last.sources.push(r.path);
        else out.push({ target: r.target, count: r.n, sources: [r.path] });
      }
      return out;
    };
    const unresolvedWhere = "l.dst IS NULL AND l.entity_type IS NULL AND l.target != '' AND l.embed = 0";
    const ambiguousWhere = 'l.ambiguous = 1';
    const anchors = plain<{ path: string; target: string; heading: string | null; block: string | null; line: number }>(
      this.#stmt('SELECT f.path, l.target, l.heading, l.block, l.line FROM links l JOIN files f ON f.id = l.src WHERE l.anchor_ok = 0 ORDER BY f.path, l.line LIMIT 300').all(),
    );
    const embeds = plain<{ path: string; target: string; line: number }>(
      this.#stmt(
        "SELECT f.path, l.target, l.line FROM links l JOIN files f ON f.id = l.src WHERE l.embed = 1 AND l.dst IS NULL AND l.entity_type IS NULL AND l.target != '' ORDER BY f.path, l.line LIMIT 300",
      ).all(),
    );
    const orphans = (
      this.#stmt(
        "SELECT f.path FROM files f WHERE f.kind = 'note' AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src = f.id AND l.dst != f.id) AND NOT EXISTS (SELECT 1 FROM links l WHERE l.dst = f.id AND l.src != f.id) ORDER BY f.path LIMIT 500",
      ).all() as unknown as { path: string }[]
    ).map((r) => r.path);
    const dups = this.#stmt("SELECT lname FROM files WHERE kind = 'note' GROUP BY lname HAVING count(*) > 1 ORDER BY lname LIMIT 200").all() as unknown as { lname: string }[];
    const duplicates = dups.map((d) => ({
      name: d.lname,
      paths: (this.#stmt("SELECT path FROM files WHERE kind = 'note' AND lname = ? ORDER BY path").all(d.lname) as unknown as { path: string }[]).map((r) => r.path),
    }));
    return { unresolved: group(unresolvedWhere), ambiguous: group(ambiguousWhere), anchors, embeds, orphans, duplicates, issues: this.issues() };
  }
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

export type { FileRef };
