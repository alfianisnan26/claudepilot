// Knowledge: one vault, the files on disk and everything that keeps them honest (Knowledge PRD FR1 to FR17).
// The notes are files and are the truth; this class is the only thing that touches them. It reads and writes
// atomically, checks versions, journals every change, keeps the index in step, and notices what other tools
// did to the folder. Policy (who may write what) is the service's; this is mechanics.
//
// Everything that changes a note is synchronous, so two changes can't interleave. Only the scan and the
// import yield to the event loop, and each slice of those re-reads what it acts on.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { redact } from '../chat/redact.js';
import { attachmentType, classifyFile } from './attachments.js';
import { KnowledgeError } from './errors.js';
import { VaultIndex, type IndexedFile } from './indexdb.js';
import { Journal, type Actor, type VersionOp } from './journal.js';
import { knowledgeLimits, type KnowledgeLimits } from './limits.js';
import { endOfSection, normHeading, parseNote, type ParsedNote } from './markdown.js';
import { baseName, cleanPath, ensureDir, extOf, folderOf, foldPath, isHiddenName, isNotePath, MAX_DEPTH, resolveSafe } from './paths.js';
import { applyEdits, isRelativeDest, rewriteLink } from './rewrite.js';
import { joinRelative, resolveTarget, type FileRef } from './resolve.js';
import type { ZipOut } from './zip.js';

const EXTERNAL: Actor = { id: 'external', kind: 'external' };
// ignoreBOM: a byte-order mark stays in the text, so a person's edit can put it back as it found it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A note's version: the first 16 hex characters of the SHA-256 of its bytes. */
export const hashOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

export interface VaultConfig {
  id: string;
  /** The vault's folder. It must exist, or be creatable (a vault the portal owns). */
  root: string;
  readOnly: boolean;
  indexFile: string;
  journal: Journal;
  limits?: KnowledgeLimits;
  now?: () => Date;
  /** Mode for files the portal creates: 0600 in the data directory, 0644 in an operator's folder. */
  fileMode?: number;
  log?: (message: string) => void;
}

export interface NoteRead {
  path: string;
  text: string;
  version: string;
  size: number;
  mtimeMs: number;
  file: IndexedFile;
}

export interface WriteOptions {
  actor: Actor;
  /** The version the writer last saw; required to change an existing note. */
  baseVersion?: string | null;
  /** The writer means to create: an existing note is an error rather than a replace. */
  create?: boolean;
  op?: VersionOp;
  note?: string;
}

export interface WriteResult {
  path: string;
  version: string;
  created: boolean;
  unchanged: boolean;
  size: number;
  mtimeMs: number;
  /** Notes for the writer; empty for now (the service adds the secret-shaped warning for a person's write). */
  warnings: string[];
}

export interface ScanResult {
  files: number;
  notes: number;
  added: number;
  changed: number;
  removed: number;
  renamed: number;
  issues: number;
  ms: number;
}

interface Entry {
  path: string;
  disk: string | null;
  size: number;
  mtimeMs: number;
  kind: 'note' | 'file';
}

interface Current {
  bytes: Buffer;
  text: string;
  hash: string;
  st: Stats;
  file: IndexedFile | null;
}

export type ConflictPolicy = 'skip' | 'keep-both' | 'overwrite';

export type ImportOutcome = 'added' | 'skipped' | 'overwritten' | 'renamed';

export class Vault {
  readonly id: string;
  /** The real path of the vault's folder: every check is against this. */
  readonly root: string;
  readonly readOnly: boolean;
  readonly index: VaultIndex;
  readonly limits: KnowledgeLimits;
  readonly #journal: Journal;
  readonly #now: () => Date;
  readonly #mode: number;
  readonly #log: (m: string) => void;
  #scanning: Promise<ScanResult> | null = null;
  #followUp: Promise<ScanResult> | null = null;
  #lastScanAt = 0;
  #lastResult: ScanResult | null = null;
  #closed = false;

  constructor(cfg: VaultConfig) {
    this.id = cfg.id;
    this.readOnly = cfg.readOnly;
    this.limits = cfg.limits ?? knowledgeLimits();
    this.#journal = cfg.journal;
    this.#now = cfg.now ?? (() => new Date());
    this.#mode = cfg.fileMode ?? 0o600;
    this.#log = cfg.log ?? (() => {});
    mkdirSync(cfg.root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(cfg.root);
    this.index = new VaultIndex(cfg.indexFile);
    this.#cleanTemporary();
    if (!this.readOnly) this.#settlePending();
  }

  close(): void {
    this.#closed = true;
    this.index.close();
  }

  get scanning(): boolean {
    return this.#scanning !== null;
  }

  get lastScanAt(): number {
    return this.#lastScanAt;
  }

  get lastScan(): ScanResult | null {
    return this.#lastResult;
  }

  /* ---------- Reading ---------- */

  #diskRel(path: string): string {
    return this.index.get(path)?.disk ?? path;
  }

  /** Opens a regular file without following a symlink; null when it isn't there. */
  #openRead(diskRel: string): { fd: number; st: Stats } | null {
    const abs = resolveSafe(this.root, diskRel);
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (code === 'ELOOP') throw new KnowledgeError('INVALID_PATH', 'That path is a symbolic link, which a vault never follows.');
      throw e;
    }
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, st };
  }

  #readAll(fd: number, size: number): Buffer {
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, got);
      if (n === 0) break;
      got += n;
    }
    return got === size ? buf : buf.subarray(0, got);
  }

  /** The note's bytes now, from disk. Null when it isn't there. */
  #current(rel: string): Current | null {
    const disk = this.#diskRel(rel);
    const opened = this.#openRead(disk);
    if (!opened) return null;
    try {
      if (opened.st.size > this.limits.noteBytes * 4) throw new KnowledgeError('TOO_LARGE', 'That note is too large to open.');
      const bytes = this.#readAll(opened.fd, opened.st.size);
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new KnowledgeError('UNSUPPORTED_TYPE', 'That file isn’t UTF-8 text, so it can’t be opened as a note.');
      }
      return { bytes, text, hash: hashOf(bytes), st: opened.st, file: this.index.get(rel) };
    } finally {
      closeSync(opened.fd);
    }
  }

  /** The note as it is on disk now (the index is brought up to date if it was behind). Throws NOT_FOUND. */
  readNote(path: string): NoteRead {
    const rel = this.#resolveExisting(path);
    const cur = this.#current(rel);
    if (!cur) {
      this.index.removeFile(rel);
      throw new KnowledgeError('NOT_FOUND', 'That note doesn’t exist.');
    }
    let file = cur.file;
    if (!file || file.hash !== cur.hash || file.size !== cur.st.size) file = this.#indexNote(rel, cur.text, cur.hash, cur.st);
    return { path: rel, text: cur.text, version: cur.hash, size: cur.st.size, mtimeMs: cur.st.mtimeMs, file };
  }

  /** The note's path as the vault spells it when it exists (matched exactly, then without regard to case), else null. */
  has(path: string): string | null {
    try {
      return this.#resolveExisting(path);
    } catch (e) {
      if (e instanceof KnowledgeError && (e.reason === 'NOT_FOUND' || e.reason === 'INVALID_PATH')) return null;
      throw e;
    }
  }

  /** The path a request names, matched exactly or, failing that, case-insensitively (links are). */
  #resolveExisting(path: string): string {
    const rel = cleanPath(path, { strict: false });
    if (!isNotePath(rel)) throw new KnowledgeError('INVALID_PATH', 'A note’s path ends in .md.');
    if (this.index.get(rel)) return rel;
    const folded = this.index.getByFolded(rel);
    if (folded) return folded.path;
    // Not in the index: it may have been created outside the portal since the last scan.
    if (this.#openAndClose(rel)) return rel;
    throw new KnowledgeError('NOT_FOUND', 'That note doesn’t exist.');
  }

  #openAndClose(rel: string): boolean {
    const o = this.#openRead(rel);
    if (!o) return false;
    closeSync(o.fd);
    return true;
  }

  /* ---------- Writing ---------- */

  #assertWritable() {
    if (this.readOnly) throw new KnowledgeError('READ_ONLY', 'This vault is read-only.');
  }

  /** Writes `bytes` to `diskRel` all at once or not at all: a temporary file beside it, flushed, then renamed over it. */
  #atomicWrite(diskRel: string, bytes: Buffer): Stats {
    const abs = resolveSafe(this.root, diskRel);
    ensureDir(this.root, folderOf(diskRel));
    let mode = this.#mode;
    try {
      mode = lstatSync(abs).mode & 0o777;
    } catch {
      // a new file
    }
    const tmp = join(dirname(abs), `.pilot-${randomBytes(8).toString('hex')}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, abs);
    } catch (e) {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw e;
    }
    try {
      const dfd = openSync(dirname(abs), constants.O_RDONLY);
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // some filesystems can't flush a folder; the rename above is still atomic
    }
    return statSync(abs);
  }

  /** A new note's text as it will be stored: the existing file's byte-order mark and line endings are kept. */
  #shape(text: string, cur: Current | null): string {
    if (!cur) return text;
    let out = text;
    const crlf = (cur.text.match(/\r\n/g) ?? []).length;
    const lf = (cur.text.match(/(?<!\r)\n/g) ?? []).length;
    if (crlf > lf && !out.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
    if (cur.text.startsWith('﻿') && !out.startsWith('﻿')) out = `﻿${out}`;
    return out;
  }

  #checkRoom(addBytes: number, addFiles: number) {
    const s = this.index.stats();
    if (s.notes + s.files + addFiles > this.limits.vaultFiles) throw new KnowledgeError('LIMIT_REACHED', `A vault holds at most ${this.limits.vaultFiles.toLocaleString('en')} files.`);
    if (s.bytes + addBytes > this.limits.vaultBytes) throw new KnowledgeError('LIMIT_REACHED', 'This vault is full.');
  }

  /** Creates or replaces a note. Existing notes need `baseVersion` (FR7). */
  writeNote(path: string, content: string, o: WriteOptions): WriteResult {
    this.#assertWritable();
    const rel = cleanPath(path, { strict: true });
    if (!/\.md$/.test(rel)) throw new KnowledgeError('INVALID_PATH', 'A note’s path ends in .md.');
    if (typeof content !== 'string') throw new KnowledgeError('INVALID_INPUT', 'A note’s content must be text.');
    const existing = this.index.get(rel) ?? this.index.getByFolded(rel);
    const cur = this.#current(existing?.path ?? rel);
    const target = existing?.path ?? rel;
    if (cur) {
      if (o.create) throw new KnowledgeError('EXISTS', 'A note with that name already exists.', { currentVersion: cur.hash });
      if (!o.baseVersion) throw new KnowledgeError('CONFLICT', 'That note already exists. Read it first and write with its version.', { currentVersion: cur.hash, content: cur.text.replace(/^﻿/, ''), deleted: false });
      if (o.baseVersion !== cur.hash) throw new KnowledgeError('CONFLICT', 'That note changed since you read it.', { currentVersion: cur.hash, content: cur.text.replace(/^﻿/, ''), deleted: false });
    } else {
      if (o.baseVersion) throw new KnowledgeError('CONFLICT', 'That note was deleted since you read it.', { currentVersion: null, content: null, deleted: true });
      const clash = this.index.getByFolded(rel);
      if (clash && clash.path !== rel) throw new KnowledgeError('EXISTS', `A note named “${clash.path}” already exists (names differ only by case).`);
    }
    return this.#commit(target, this.#shape(content, cur), cur, o);
  }

  /** Adds text to the end of a note, or to the end of a heading's section (made if missing). Creates the note if it isn't there. */
  appendNote(path: string, text: string, o: WriteOptions & { heading?: string | null }): WriteResult {
    this.#assertWritable();
    const rel = cleanPath(path, { strict: true });
    if (!/\.md$/.test(rel)) throw new KnowledgeError('INVALID_PATH', 'A note’s path ends in .md.');
    const existing = this.index.get(rel) ?? this.index.getByFolded(rel);
    const target = existing?.path ?? rel;
    const cur = this.#current(target);
    if (!cur) {
      const clash = this.index.getByFolded(rel);
      if (clash && clash.path !== rel) throw new KnowledgeError('EXISTS', `A note named “${clash.path}” already exists (names differ only by case).`);
      const first = o.heading ? `## ${o.heading.trim()}\n\n${text.replace(/\s+$/, '')}\n` : `${text.replace(/\s+$/, '')}\n`;
      return this.#commit(target, first, null, { ...o, op: o.op ?? 'create' });
    }
    const eol = (cur.text.match(/\r\n/g) ?? []).length > (cur.text.match(/(?<!\r)\n/g) ?? []).length ? '\r\n' : '\n';
    const add = text.replace(/\r?\n/g, eol).replace(/\s+$/, '');
    let next: string;
    const heading = o.heading?.trim();
    if (heading) {
      const parsed = parseNote(cur.text, this.limits);
      const at = endOfSection(cur.text, parsed, normHeading(heading));
      if (at === null) next = `${cur.text.replace(/\s+$/, '')}${eol}${eol}## ${heading}${eol}${eol}${add}${eol}`;
      else {
        // `at` is just after the section's last line of text; what follows is its trailing blank lines and the next heading.
        const after = cur.text.slice(at);
        next = `${cur.text.slice(0, at)}${eol}${add}${after === '' ? eol : ''}${after}`;
      }
    } else {
      const sep = cur.text === '' || cur.text.endsWith('\n') ? '' : eol;
      next = `${cur.text}${sep}${add}${eol}`;
    }
    return this.#commit(target, next, cur, { ...o, op: o.op ?? 'append', baseVersion: cur.hash });
  }

  /** Replaces one exact, unique occurrence of `oldText`: a small change that doesn't rewrite what the writer last saw. */
  editNote(path: string, oldText: string, newText: string, o: WriteOptions): WriteResult {
    this.#assertWritable();
    const rel = this.#resolveExisting(path);
    const cur = this.#current(rel);
    if (!cur) throw new KnowledgeError('NOT_FOUND', 'That note doesn’t exist.');
    if (!o.baseVersion) throw new KnowledgeError('CONFLICT', 'Read the note first and edit with its version.', { currentVersion: cur.hash, content: cur.text.replace(/^﻿/, ''), deleted: false });
    if (o.baseVersion !== cur.hash) throw new KnowledgeError('CONFLICT', 'That note changed since you read it.', { currentVersion: cur.hash, content: cur.text.replace(/^﻿/, ''), deleted: false });
    if (!oldText) throw new KnowledgeError('INVALID_INPUT', 'Say which text to replace.');
    const text = cur.text.replace(/^﻿/, '');
    const first = text.indexOf(oldText);
    if (first < 0) throw new KnowledgeError('NOT_UNIQUE', 'That text isn’t in the note.', { matches: 0 });
    if (text.indexOf(oldText, first + 1) >= 0) throw new KnowledgeError('NOT_UNIQUE', 'That text appears more than once. Include more around it to pick one.', { matches: 2 });
    return this.#commit(rel, this.#shape(text.slice(0, first) + newText + text.slice(first + oldText.length), cur), cur, { ...o, op: o.op ?? 'edit' });
  }

  #commit(rel: string, content: string, cur: Current | null, o: WriteOptions): WriteResult {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > this.limits.noteBytes) throw new KnowledgeError('TOO_LARGE', `A note can be at most ${Math.round(this.limits.noteBytes / 1024)} KB.`);
    const hash = hashOf(bytes);
    if (cur && hash === cur.hash) return { path: rel, version: hash, created: false, unchanged: true, size: bytes.length, mtimeMs: cur.st.mtimeMs, warnings: [] };
    if (!cur) this.#checkRoom(bytes.length, 1);
    // The journal first: a change that can't be recorded isn't made. A note's first row is what it was before.
    if (cur && !this.#journal.hasRows(this.id, rel))
      this.#journal.record({ vaultId: this.id, path: rel, op: 'external', actor: EXTERNAL, baseHash: null, hash: cur.hash, content: cur.text, note: 'original' });
    const op: VersionOp = o.op ?? (cur ? 'edit' : 'create');
    const jid = this.#journal.begin({ vaultId: this.id, path: rel, op, actor: o.actor, baseHash: cur?.hash ?? null, hash, content, note: o.note });
    let st: Stats;
    try {
      st = this.#atomicWrite(this.#diskRel(rel), bytes);
    } catch (e) {
      this.#journal.abort(jid);
      throw e;
    }
    this.#journal.commit(jid);
    this.#indexNote(rel, content, hash, st);
    return { path: rel, version: hash, created: !cur, unchanged: false, size: bytes.length, mtimeMs: st.mtimeMs, warnings: [] };
  }

  #indexNote(rel: string, text: string, hash: string, st: Stats): IndexedFile {
    const parsed = parseNote(text, this.limits);
    const body = text.slice(parsed.bodyStart);
    const secret = redact(text) !== text;
    this.index.upsertNote({ path: rel, disk: this.index.get(rel)?.disk ?? null, size: st.size, mtimeMs: st.mtimeMs, hash, parsed, body, secret });
    this.index.addDir(folderOf(rel));
    return this.index.get(rel)!;
  }

  /** Whether a text contains something shaped like a credential (the house redactor's patterns). */
  static looksSecret(text: string): boolean {
    return redact(text) !== text;
  }

  /* ---------- Rename, delete, restore ---------- */

  /**
   * Moves a note, then rewrites the links to it in other notes to the new name, each in its own style (FR10),
   * as ordinary journaled changes by the same actor, yielding to the event loop as it goes (a hub note can
   * have thousands). The move itself is one atomic rename; a crash before the rewrites leaves links
   * unresolved (link health lists them), never text lost. Links are found from the index (which links
   * resolved to the note, and the text hash the index read); a note that changed since is left alone. The
   * moved note's own relative Markdown links are fixed when it changes folder.
   */
  async renameNote(from: string, to: string, o: { actor: Actor; rewriteLinks?: boolean }): Promise<{ path: string; rewritten: string[]; renamed: boolean }> {
    this.#assertWritable();
    const fromRel = this.#resolveExisting(from);
    const toRel = cleanPath(to, { strict: true });
    if (!/\.md$/.test(toRel)) throw new KnowledgeError('INVALID_PATH', 'A note’s path ends in .md.');
    if (toRel === fromRel) return { path: toRel, rewritten: [], renamed: false };
    const clash = this.index.getByFolded(toRel);
    if (clash && clash.path !== fromRel) throw new KnowledgeError('EXISTS', `“${clash.path}” already exists.`);
    const file = this.index.get(fromRel);
    if (!file) throw new KnowledgeError('NOT_FOUND', 'That note doesn’t exist.');
    const cur = this.#current(fromRel);
    if (!cur) throw new KnowledgeError('NOT_FOUND', 'That note doesn’t exist.');

    // What resolved to it, and what the moved note itself points at by path, before the names change.
    const rewrite = o.rewriteLinks !== false;
    const inbound = rewrite ? this.index.inboundLinks(file.id) : [];
    const outbound = rewrite && folderOf(fromRel) !== folderOf(toRel) ? this.index.outgoing(file.id).filter((l) => l.style === 'md' && l.to && !l.entity && l.to !== fromRel) : [];

    ensureDir(this.root, folderOf(toRel));
    const absFrom = resolveSafe(this.root, this.#diskRel(fromRel));
    const absTo = resolveSafe(this.root, toRel);
    if (foldPath(fromRel) !== foldPath(toRel)) {
      // The target must not exist (a rename never overwrites); the index said so, the disk is the check.
      try {
        lstatSync(absTo);
        throw new KnowledgeError('EXISTS', `“${toRel}” already exists.`);
      } catch (e) {
        if (e instanceof KnowledgeError) throw e;
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    renameSync(absFrom, absTo);
    this.#journal.renamePath(this.id, fromRel, toRel);
    this.#journal.record({ vaultId: this.id, path: toRel, op: 'rename', actor: o.actor, baseHash: cur.hash, hash: cur.hash, content: null, fromPath: fromRel });
    this.index.removeFile(fromRel);
    const st = statSync(absTo);
    this.#indexNote(toRel, cur.text, cur.hash, st);

    const rewritten: string[] = [];
    if (!rewrite) return { path: toRel, rewritten, renamed: true };
    const moved = this.index.names.byPath(foldPath(toRel))!;
    const sources = new Map<string, { hash: string | null; rows: typeof inbound }>();
    for (const r of inbound) {
      const g = sources.get(r.src) ?? { hash: r.hash, rows: [] };
      g.rows.push(r);
      sources.set(r.src, g);
    }
    let n = 0;
    for (const [src, { hash, rows }] of sources) {
      if (++n % 20 === 0) await tick();
      if (this.#closed) break;
      const srcPath = src === fromRel ? toRel : src;
      const read = this.#current(srcPath);
      // The rows describe the text the index read; if the note changed since, its links are left alone.
      if (!read || read.hash !== hash) continue;
      const changes: { start: number; end: number; text: string }[] = [];
      for (const l of parseNote(read.text, this.limits).links) {
        if (l.entity || !l.target) continue;
        if (!rows.some((r) => r.target === l.target && r.line === l.line && r.embed === l.embed && r.style === l.style)) continue;
        changes.push({ start: l.start, end: l.end, text: rewriteLink(read.text.slice(l.start, l.end), l, { srcFolder: folderOf(srcPath), moved, table: this.index.names }) });
      }
      const next = applyEdits(read.text, changes);
      if (next === read.text) continue;
      this.#commit(srcPath, next, read, { actor: o.actor, baseVersion: read.hash, op: 'edit', note: `link to ${baseName(fromRel)} updated` });
      rewritten.push(srcPath);
    }

    // The moved note's own relative links, when it changed folder: point them at what they pointed at.
    if (outbound.length) {
      const read = this.#current(toRel);
      if (read) {
        const changes: { start: number; end: number; text: string }[] = [];
        for (const l of parseNote(read.text, this.limits).links) {
          const was = outbound.find((r) => r.target === l.target && r.line === l.line && r.embed === l.embed);
          if (!was || l.style !== 'md' || !was.to || !isRelativeDest(read.text.slice(l.start, l.end))) continue;
          // Found by its path from the new folder? Then it still points where it did.
          const byPath = joinRelative(folderOf(toRel), l.target);
          if (byPath !== null && foldPath(byPath) === foldPath(was.to)) continue;
          const dest = this.index.names.byPath(foldPath(was.to));
          if (dest) changes.push({ start: l.start, end: l.end, text: rewriteLink(read.text.slice(l.start, l.end), l, { srcFolder: folderOf(toRel), moved: dest, table: this.index.names }) });
        }
        const next = applyEdits(read.text, changes);
        if (next !== read.text) {
          this.#commit(toRel, next, read, { actor: o.actor, baseVersion: read.hash, op: 'edit', note: 'links updated for the new folder' });
          if (!rewritten.includes(toRel)) rewritten.push(toRel);
        }
      }
    }
    return { path: toRel, rewritten, renamed: true };
  }

  /** Deletes a note. Its last text stays in history, so it can be restored. */
  deleteNote(path: string, o: { actor: Actor }): void {
    this.#assertWritable();
    const rel = this.#resolveExisting(path);
    const cur = this.#current(rel);
    if (!cur) throw new KnowledgeError('NOT_FOUND', 'That note doesn’t exist.');
    if (!this.#journal.hasRows(this.id, rel)) this.#journal.record({ vaultId: this.id, path: rel, op: 'external', actor: EXTERNAL, baseHash: null, hash: cur.hash, content: cur.text, note: 'original' });
    const jid = this.#journal.begin({ vaultId: this.id, path: rel, op: 'delete', actor: o.actor, baseHash: cur.hash, hash: null, content: null });
    try {
      unlinkSync(resolveSafe(this.root, this.#diskRel(rel)));
    } catch (e) {
      this.#journal.abort(jid);
      throw e;
    }
    this.#journal.commit(jid);
    this.index.removeFile(rel);
  }

  /** Writes an old version back as a new change. A deleted note is made again. */
  restoreVersion(path: string, versionId: number, o: { actor: Actor }): WriteResult {
    this.#assertWritable();
    const rel = cleanPath(path, { strict: false });
    const v = this.#journal.version(this.id, versionId);
    if (!v || v.row.path !== rel || v.content === null) throw new KnowledgeError('NOT_FOUND', 'That version doesn’t exist.');
    const existing = this.index.get(rel);
    const cur = existing ? this.#current(rel) : null;
    return this.#commit(rel, this.#shape(v.content, cur), cur, { actor: o.actor, baseVersion: cur?.hash ?? null, op: 'restore', note: `restored the version of ${v.row.at}` });
  }

  /** Whether `path`'s note was deleted and can be restored: its newest history row is a delete. */
  deletedNotes(): { path: string; at: string }[] {
    const rows = this.#journal.db
      .prepare("SELECT path, at FROM kg_versions v WHERE vault_id = ? AND state = 'ok' AND id = (SELECT max(id) FROM kg_versions w WHERE w.vault_id = v.vault_id AND w.path = v.path) AND op = 'delete' ORDER BY at DESC LIMIT 200")
      .all(this.id) as unknown as { path: string; at: string }[];
    return rows.map((r) => ({ path: r.path, at: r.at }));
  }

  /* ---------- Attachments ---------- */

  /** An attachment opened for reading: a file descriptor the caller must close, its type and size. */
  openFile(path: string): { fd: number; size: number; mtimeMs: number; type: NonNullable<ReturnType<typeof attachmentType>>; path: string } {
    const rel = cleanPath(path, { strict: false });
    const type = attachmentType(rel);
    if (!type) throw new KnowledgeError('UNSUPPORTED_TYPE', 'That kind of file isn’t served.');
    const file = this.index.get(rel) ?? this.index.getByFolded(rel);
    const opened = this.#openRead(file?.disk ?? file?.path ?? rel);
    if (!opened) throw new KnowledgeError('NOT_FOUND', 'That file doesn’t exist.');
    return { fd: opened.fd, size: opened.st.size, mtimeMs: opened.st.mtimeMs, type, path: file?.path ?? rel };
  }

  /** Stores an attachment; the type is decided by its extension alone. An existing name is an error. */
  writeFile(path: string, bytes: Buffer, o: { actor: Actor }): { path: string; size: number } {
    this.#assertWritable();
    const rel = cleanPath(path, { strict: true });
    if (isNotePath(rel)) throw new KnowledgeError('INVALID_PATH', 'Notes are written as notes, not as files.');
    const cls = classifyFile(rel);
    if (cls.kind !== 'attachment') throw new KnowledgeError('UNSUPPORTED_TYPE', `.${extOf(rel) || '?'} files aren’t kept in a vault.`, { extension: extOf(rel) });
    if (bytes.length > this.limits.attachmentBytes) throw new KnowledgeError('TOO_LARGE', `A file can be at most ${Math.round(this.limits.attachmentBytes / 1024 / 1024)} MB.`);
    if (this.index.getByFolded(rel)) throw new KnowledgeError('EXISTS', 'A file with that name already exists.');
    this.#checkRoom(bytes.length, 1);
    const st = this.#atomicWrite(rel, bytes);
    this.index.upsertAttachment({ path: rel, disk: null, size: st.size, mtimeMs: st.mtimeMs });
    this.index.addDir(folderOf(rel));
    this.#journal.audit({ vaultId: this.id, actor: o.actor.id, op: 'upload', path: rel, outcome: 'ok', bytes: bytes.length });
    return { path: rel, size: st.size };
  }

  /** Makes an empty folder. */
  makeFolder(path: string): void {
    this.#assertWritable();
    const rel = cleanPath(path, { strict: true, folder: true });
    if (!rel) return;
    ensureDir(this.root, rel);
    this.index.addDir(rel);
  }

  /* ---------- Import and export ---------- */

  /** A path that is free in the vault: `Name.md` becomes `Name (2).md`, `Name (3).md`, … */
  uniquePath(rel: string): string {
    if (!this.index.getByFolded(rel)) return rel;
    const dot = rel.lastIndexOf('.');
    const slash = rel.lastIndexOf('/');
    const hasExt = dot > slash + 1;
    const stem = hasExt ? rel.slice(0, dot) : rel;
    const ext = hasExt ? rel.slice(dot) : '';
    for (let i = 2; i < 10_000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!this.index.getByFolded(candidate)) return candidate;
    }
    throw new KnowledgeError('LIMIT_REACHED', 'Too many files with that name.');
  }

  /** Brings one file from an import into the vault under the conflict policy. Notes and attachments only; the caller classified it. */
  importFile(rel: string, data: Buffer, policy: ConflictPolicy, actor: Actor): { outcome: ImportOutcome; path: string } {
    this.#assertWritable();
    const kind = isNotePath(rel) ? 'note' : 'file';
    const existing = this.index.getByFolded(rel);
    let target = rel;
    let outcome: ImportOutcome = 'added';
    if (existing) {
      if (policy === 'skip') return { outcome: 'skipped', path: existing.path };
      if (policy === 'keep-both') {
        target = this.uniquePath(rel);
        outcome = 'renamed';
      } else {
        target = existing.path;
        outcome = 'overwritten';
      }
    }
    if (kind === 'note') {
      let text: string;
      try {
        text = decoder.decode(data);
      } catch {
        throw new KnowledgeError('UNSUPPORTED_TYPE', `${rel} isn’t UTF-8 text.`);
      }
      if (data.length > this.limits.noteBytes) throw new KnowledgeError('TOO_LARGE', `${rel} is larger than a note can be.`);
      const cur = outcome === 'overwritten' ? this.#current(target) : null;
      if (cur && cur.hash === hashOf(data)) return { outcome: 'skipped', path: target };
      if (!cur) this.#checkRoom(data.length, 1);
      if (cur && !this.#journal.hasRows(this.id, target)) this.#journal.record({ vaultId: this.id, path: target, op: 'external', actor: EXTERNAL, baseHash: null, hash: cur.hash, content: cur.text, note: 'original' });
      const hash = hashOf(data);
      const jid = outcome === 'overwritten' ? this.#journal.begin({ vaultId: this.id, path: target, op: 'import', actor, baseHash: cur?.hash ?? null, hash, content: text, note: 'import overwrote it' }) : null;
      let st: Stats;
      try {
        st = this.#atomicWrite(this.#diskRel(target), data);
      } catch (e) {
        if (jid !== null) this.#journal.abort(jid);
        throw e;
      }
      if (jid !== null) this.#journal.commit(jid);
      this.#indexNote(target, text, hash, st);
    } else {
      if (data.length > this.limits.attachmentBytes) throw new KnowledgeError('TOO_LARGE', `${rel} is larger than an attachment can be.`);
      this.#checkRoom(data.length, existing && outcome === 'overwritten' ? 0 : 1);
      const st = this.#atomicWrite(this.#diskRel(target), data);
      this.index.upsertAttachment({ path: target, disk: this.index.get(target)?.disk ?? null, size: st.size, mtimeMs: st.mtimeMs });
      this.index.addDir(folderOf(target));
    }
    return { outcome, path: target };
  }

  /** Every file as a zip entry, read one at a time as the stream asks. */
  *exportEntries(): Generator<ZipOut> {
    const rows = this.index.db.prepare('SELECT path, disk, kind FROM files ORDER BY path').all() as unknown as { path: string; disk: string | null; kind: 'note' | 'file' }[];
    for (const r of rows) {
      const opened = this.#openRead(r.disk ?? r.path);
      if (!opened) continue;
      try {
        const data = this.#readAll(opened.fd, opened.st.size);
        const store = r.kind === 'file' && /^(png|jpe?g|gif|webp|avif|mp3|m4a|ogg|flac|mp4|webm|mov|zip|docx|xlsx|pptx|pdf)$/.test(extOf(r.path));
        yield { name: r.path, data, mtime: new Date(opened.st.mtimeMs), store };
      } finally {
        closeSync(opened.fd);
      }
    }
  }

  /* ---------- Scanning ---------- */

  #cleanTemporary(): void {
    // Temporary files from a write that never finished: dot-named, so nothing else sees them.
    const cutoff = Date.now() - 60 * 60_000;
    const walk = (abs: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(abs, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!isHiddenName(e.name)) walk(p, depth + 1);
        } else if (/^\.pilot-[0-9a-f]{16}\.tmp$/.test(e.name)) {
          try {
            if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
          } catch {
            // gone already
          }
        }
      }
    };
    walk(this.root, 0);
  }

  #settlePending(): void {
    try {
      const r = this.#journal.settlePending(this.id, (path) => {
        const opened = this.#openRead(path);
        if (!opened) return null;
        try {
          return hashOf(this.#readAll(opened.fd, opened.st.size));
        } finally {
          closeSync(opened.fd);
        }
      });
      if (r.landed || r.dropped) this.#log(`[knowledge] ${this.id}: settled ${r.landed} change(s) a crash left pending, dropped ${r.dropped}`);
    } catch {
      // the database may be unavailable; the scan still runs
    }
  }

  /** Lists the folder: files to index, folders, and what was skipped or flagged. */
  #walk(): { entries: Entry[]; dirs: string[]; issues: { path: string; kind: string; detail: string }[] } {
    const entries: Entry[] = [];
    const dirs: string[] = [];
    const issues: { path: string; kind: string; detail: string }[] = [];
    const stack: { abs: string; rel: string; depth: number }[] = [{ abs: this.root, rel: '', depth: 0 }];
    while (stack.length) {
      const { abs, rel, depth } = stack.pop()!;
      let list;
      try {
        list = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of list) {
        if (isHiddenName(d.name)) continue;
        const diskRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) {
          issues.push({ path: diskRel, kind: 'symlink', detail: 'Symbolic links are never followed.' });
          continue;
        }
        if (d.isDirectory()) {
          if (depth + 1 >= MAX_DEPTH) {
            issues.push({ path: diskRel, kind: 'too-deep', detail: `Folders are read to ${MAX_DEPTH} levels.` });
            continue;
          }
          dirs.push(diskRel.normalize('NFC'));
          stack.push({ abs: join(abs, d.name), rel: diskRel, depth: depth + 1 });
          continue;
        }
        if (!d.isFile()) continue;
        const nfc = diskRel.normalize('NFC');
        try {
          cleanPath(nfc, { strict: false });
        } catch (e) {
          issues.push({ path: diskRel, kind: 'invalid-name', detail: (e as Error).message });
          continue;
        }
        const cls = classifyFile(nfc);
        if (cls.kind === 'skip') {
          if (cls.reason !== 'hidden') issues.push({ path: nfc, kind: cls.reason === 'dangerous' ? 'skipped-dangerous' : 'skipped-type', detail: `.${cls.ext || '?'} files aren’t kept in a vault.` });
          continue;
        }
        let st: Stats;
        try {
          st = lstatSync(join(abs, d.name));
        } catch {
          continue;
        }
        if (cls.kind === 'note' && st.size > this.limits.noteBytes) {
          issues.push({ path: nfc, kind: 'too-large', detail: 'Larger than a note can be.' });
          continue;
        }
        if (cls.kind === 'attachment' && st.size > this.limits.attachmentBytes) {
          issues.push({ path: nfc, kind: 'too-large', detail: 'Larger than an attachment can be.' });
          continue;
        }
        entries.push({ path: nfc, disk: nfc === diskRel ? null : diskRel, size: st.size, mtimeMs: st.mtimeMs, kind: cls.kind === 'note' ? 'note' : 'file' });
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const seen = new Map<string, string>();
    const unique: Entry[] = [];
    for (const e of entries) {
      const key = foldPath(e.path);
      const first = seen.get(key);
      if (first) {
        issues.push({ path: e.path, kind: 'case-collision', detail: `Differs from “${first}” only by case; skipped so the vault stays portable.` });
        continue;
      }
      seen.set(key, e.path);
      unique.push(e);
    }
    if (unique.length > this.limits.vaultFiles) {
      issues.push({ path: '', kind: 'too-many-files', detail: `Only the first ${this.limits.vaultFiles.toLocaleString('en')} files are read.` });
      unique.length = this.limits.vaultFiles;
    }
    return { entries: unique, dirs, issues };
  }

  /**
   * Compares the folder with the index and brings the index up to date: files found, changed or gone,
   * renames recognized by identical content, outside edits journaled. Yields to the event loop between
   * slices of 100 files, and each slice reads what it acts on, so a write made meanwhile is never undone.
   */
  scan(): Promise<ScanResult> {
    if (!this.#scanning) return this.#start();
    // A change may have landed after the running scan listed the folder: one more scan follows it, and whoever
    // asks while one runs gets that one (several askers share it; none gets a result older than the ask).
    if (!this.#followUp) {
      const next = () => {
        this.#followUp = null;
        return this.#start();
      };
      this.#followUp = this.#scanning.then(next, next);
    }
    return this.#followUp;
  }

  #start(): Promise<ScanResult> {
    const run = this.#scanOnce().finally(() => {
      this.#scanning = null;
    });
    this.#scanning = run;
    return run;
  }

  /** A scan in the background when the last one is older than `maxAgeMs`. */
  scanIfStale(maxAgeMs = 5000): void {
    if (this.#closed || this.#scanning || Date.now() - this.#lastScanAt < maxAgeMs) return;
    void this.scan().catch((e: unknown) => this.#log(`[knowledge] ${this.id}: scan failed: ${(e as Error).message}`));
  }

  async #scanOnce(): Promise<ScanResult> {
    const started = Date.now();
    const { entries, dirs, issues } = this.#walk();
    const snap = this.index.snapshot();
    const seen = new Set<string>();
    const todo: Entry[] = [];
    for (const e of entries) {
      seen.add(e.path);
      const s = snap.get(e.path);
      if (!s || s.kind !== e.kind || s.size !== e.size || s.mtimeMs !== Math.floor(e.mtimeMs) || (s.disk ?? null) !== e.disk) todo.push(e);
    }
    const gone = [...snap.keys()].filter((p) => !seen.has(p));
    let added = 0;
    let changed = 0;
    let removed = 0;
    let renamed = 0;
    const newHashes = new Map<string, string>();
    const journaled = !this.readOnly;

    for (let i = 0; i < todo.length; i += 100) {
      if (this.#closed) break;
      this.index.tx(() => {
        for (const e of todo.slice(i, i + 100)) {
          const isNew = !snap.has(e.path);
          if (e.kind === 'file') {
            this.index.upsertAttachment({ path: e.path, disk: e.disk, size: e.size, mtimeMs: e.mtimeMs });
            if (isNew) added++;
            else changed++;
            continue;
          }
          // Read it fresh: the walk's numbers may be a moment old.
          const opened = this.#openRead(e.disk ?? e.path);
          if (!opened) continue;
          let bytes: Buffer;
          try {
            bytes = this.#readAll(opened.fd, opened.st.size);
          } finally {
            closeSync(opened.fd);
          }
          let text: string;
          try {
            text = decoder.decode(bytes);
          } catch {
            issues.push({ path: e.path, kind: 'not-utf8', detail: 'Not UTF-8 text, so not read as a note.' });
            this.index.removeFile(e.path);
            continue;
          }
          const hash = hashOf(bytes);
          const prev = snap.get(e.path);
          if (!isNew && prev && prev.hash === hash) {
            // Only its time changed (a checkout, a copy): keep everything read from it.
            this.index.touch(e.path, e.disk, bytes.length, e.mtimeMs);
            continue;
          }
          if (journaled) this.#journalExternal(e.path, text, hash);
          this.#indexNoteAs(e.path, e.disk, text, hash, bytes.length, e.mtimeMs);
          newHashes.set(hash, e.path);
          if (isNew) added++;
          else changed++;
        }
      });
      await tick();
    }

    // Gone files: a note that reappeared under another name with the same content was renamed.
    for (let i = 0; i < gone.length; i += 100) {
      if (this.#closed) break;
      this.index.tx(() => {
        for (const p of gone.slice(i, i + 100)) {
          if (this.#existsOnDisk(p)) continue;
          const s = snap.get(p)!;
          const dest = s.kind === 'note' && s.hash ? newHashes.get(s.hash) : undefined;
          if (dest && dest !== p && journaled && this.#journal.hasRows(this.id, p)) {
            this.#journal.renamePath(this.id, p, dest);
            this.#journal.record({ vaultId: this.id, path: dest, op: 'rename', actor: EXTERNAL, baseHash: s.hash, hash: s.hash, content: null, fromPath: p, note: 'renamed outside the portal' });
            renamed++;
          } else if (journaled && s.kind === 'note' && this.#journal.hasRows(this.id, p)) {
            const last = this.#journal.latest(this.id, p);
            if (last && last.op !== 'delete') this.#journal.record({ vaultId: this.id, path: p, op: 'delete', actor: EXTERNAL, baseHash: last.hash, hash: null, content: null, note: 'deleted outside the portal' });
          }
          this.index.removeFile(p);
          removed++;
        }
      });
      await tick();
    }

    this.index.replaceDirs(dirs);
    this.index.setIssues(issues);
    const stats = this.index.stats();
    this.#lastScanAt = Date.now();
    this.#lastResult = { files: stats.files + stats.notes, notes: stats.notes, added, changed, removed, renamed, issues: issues.length, ms: Date.now() - started };
    if (added || changed || removed || renamed) this.#log(`[knowledge] ${this.id}: scanned ${this.#lastResult.files.toLocaleString('en')} files in ${this.#lastResult.ms} ms (${added} added, ${changed} changed, ${removed} removed, ${renamed} renamed)`);
    return this.#lastResult;
  }

  #existsOnDisk(rel: string): boolean {
    try {
      lstatSync(resolveSafe(this.root, this.#diskRel(rel)));
      return true;
    } catch {
      return false;
    }
  }

  /** A note found changed (or new) on disk that the portal didn't write: if it has history, the new text is recorded. */
  #journalExternal(rel: string, text: string, hash: string): void {
    try {
      const last = this.#journal.latest(this.id, rel);
      if (!last || last.hash === hash) return;
      this.#journal.record({ vaultId: this.id, path: rel, op: 'external', actor: EXTERNAL, baseHash: last.hash, hash, content: text, note: 'changed outside the portal' });
    } catch {
      // history is best effort here; the index must still catch up
    }
  }

  #indexNoteAs(rel: string, disk: string | null, text: string, hash: string, size: number, mtimeMs: number): void {
    const parsed = parseNote(text, this.limits);
    this.index.upsertNote({ path: rel, disk, size, mtimeMs, hash, parsed, body: text.slice(parsed.bodyStart), secret: redact(text) !== text });
  }

  /** The parse of a note's current text, for views that need more than the index keeps. */
  parse(text: string): ParsedNote {
    return parseNote(text, this.limits);
  }

  /** The file refs of this vault's names (for rewriting and resolving outside this class). */
  ref(path: string): FileRef | undefined {
    return this.index.names.byPath(foldPath(path));
  }
}
