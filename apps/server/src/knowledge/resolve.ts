// Knowledge: which file a link points at (Knowledge PRD FR11). Obsidian's rules as documented: links are
// case-insensitive; `.md` is optional; a link can be a bare name (`[[Note]]`), a path from the vault root
// (`[[Folder/Note]]`), a path relative to the linking note (`[x](../Note.md)`), or the tail of a path. When
// several files fit, our own deterministic tie-break applies, because Obsidian's isn't documented: the same
// folder as the linking note, then the closest folder, then the shortest path, then alphabetical.

import { foldPath } from './paths.js';

export interface FileRef {
  id: number;
  path: string;
  /** Lowercased NFC path. */
  lpath: string;
  kind: 'note' | 'file';
  /** Lowercased link name: a note's file name without `.md`, a file's whole name. */
  lname: string;
  folder: string;
}

/** Every file of a vault by link name and by path, for resolving links without touching the database. */
export class NameTable {
  readonly #byName = new Map<string, FileRef[]>();
  readonly #byPath = new Map<string, FileRef>();

  add(f: FileRef): void {
    this.#byPath.set(f.lpath, f);
    const list = this.#byName.get(f.lname);
    if (list) list.push(f);
    else this.#byName.set(f.lname, [f]);
  }

  remove(f: FileRef): void {
    if (this.#byPath.get(f.lpath)?.id === f.id) this.#byPath.delete(f.lpath);
    const list = this.#byName.get(f.lname);
    if (!list) return;
    const next = list.filter((x) => x.id !== f.id);
    if (next.length) this.#byName.set(f.lname, next);
    else this.#byName.delete(f.lname);
  }

  byName(lname: string): readonly FileRef[] {
    return this.#byName.get(lname) ?? [];
  }

  byPath(lpath: string): FileRef | undefined {
    return this.#byPath.get(lpath);
  }

  get size(): number {
    return this.#byPath.size;
  }

  clear(): void {
    this.#byName.clear();
    this.#byPath.clear();
  }
}

export interface ResolveInput {
  target: string;
  embed: boolean;
}

export interface Resolution {
  file: FileRef | null;
  /** More than one file fits the link and the tie-break chose. */
  ambiguous: boolean;
}

const NONE: Resolution = { file: null, ambiguous: false };

/** A name's file extension when it looks like an attachment (`.png`, `.pdf`), for choosing files before notes. */
const FILE_EXT = /\.(?!md$)[a-z0-9]{1,8}$/i;

/** `folder` plus a relative path with `.` and `..` resolved; null when it climbs out of the vault. */
export function joinRelative(folder: string, rel: string): string | null {
  const out = folder ? folder.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

function commonPrefix(a: string, b: string): number {
  const x = a ? a.split('/') : [];
  const y = b ? b.split('/') : [];
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** The candidate the tie-break prefers. */
export function closest(cands: readonly FileRef[], srcFolder: string): FileRef {
  return [...cands].sort((a, b) => {
    const sa = a.folder === srcFolder ? 1 : 0;
    const sb = b.folder === srcFolder ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const ca = commonPrefix(a.folder, srcFolder);
    const cb = commonPrefix(b.folder, srcFolder);
    if (ca !== cb) return cb - ca;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  })[0]!;
}

/** The lowercased last segment of a link target with a trailing `.md` removed: what `lbase` indexes. */
export function linkBase(target: string): string {
  const last = target.slice(target.lastIndexOf('/') + 1);
  return foldPath(last.replace(/\.md$/i, ''));
}

export function resolveTarget(table: NameTable, input: ResolveInput, srcFolder: string): Resolution {
  const raw = input.target.trim();
  if (!raw) return NONE;
  const rooted = raw.startsWith('/');
  const t = rooted ? raw.replace(/^\/+/, '') : raw;
  if (!t) return NONE;
  const isMd = /\.md$/i.test(t);
  const stem = isMd ? t.slice(0, -3) : t;
  const hasPath = t.includes('/');
  const wantsFile = !isMd && (input.embed || FILE_EXT.test(t));

  const lookup = (kind: 'note' | 'file'): Resolution => {
    const key = foldPath(kind === 'note' ? stem : t);
    const ext = kind === 'note' ? '.md' : '';
    if (!hasPath) {
      const cands = table.byName(key).filter((f) => f.kind === kind);
      if (!cands.length) return NONE;
      return { file: closest(cands, srcFolder), ambiguous: cands.length > 1 };
    }
    // A path: from the vault root, then relative to the linking note, then as the tail of a longer path.
    const exact = table.byPath(key + ext);
    if (exact && exact.kind === kind) return { file: exact, ambiguous: false };
    if (rooted) return NONE;
    const rel = joinRelative(srcFolder, key);
    if (rel !== null) {
      const hit = table.byPath(foldPath(rel) + ext);
      if (hit && hit.kind === kind) return { file: hit, ambiguous: false };
    }
    const lastSeg = key.slice(key.lastIndexOf('/') + 1);
    const cands = table.byName(lastSeg).filter((f) => f.kind === kind && f.lpath.endsWith(`/${key}${ext}`));
    if (!cands.length) return NONE;
    return { file: closest(cands, srcFolder), ambiguous: cands.length > 1 };
  };

  if (isMd) return lookup('note');
  const order: ('note' | 'file')[] = wantsFile ? ['file', 'note'] : ['note', 'file'];
  for (const kind of order) {
    const r = lookup(kind);
    if (r.file) return r;
  }
  return NONE;
}

/** The shortest link text that still finds `file` from anywhere: its name when no other file shares it, else its path. */
export function linkTextFor(table: NameTable, file: FileRef): string {
  const name = file.kind === 'note' ? file.path.replace(/\.md$/i, '') : file.path;
  const base = name.slice(name.lastIndexOf('/') + 1);
  const same = table.byName(file.lname).filter((f) => f.kind === file.kind);
  return same.length <= 1 ? base : name;
}
