// Knowledge: the one place a user-supplied path becomes a place on disk (Knowledge PRD FR5, §17.1).
// Everything else works with the cleaned, NFC-normalized, `/`-separated relative paths this returns and
// reaches the filesystem only through `resolveSafe` / `ensureDir`, which refuse symlinks on the way.
//
// Two strengths: `strict` for names the portal is about to create (API, MCP, rename), which also keep a vault
// portable to macOS and Windows, and lenient for what is already on disk or in an upload, where the person's
// own file names are theirs to keep (only what can't be a safe path at all is refused).

import { lstatSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { KnowledgeError } from './errors.js';

export const MAX_PATH_CHARS = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_DEPTH = 32;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Bidirectional controls and zero-width characters: a name can use them to look like another name. */
const BIDI_ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
/** Obsidian refuses `* " \ / < > : | ?` in names and warns that `# ^ [ ]` break links; new names avoid all of them. */
const FORBIDDEN_IN_NEW = /[<>:"|?*\\#^[\]]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Names that are never part of a vault (Knowledge PRD FR4): dot-entries and what other systems leave behind. */
const JUNK_NAMES = new Set(['thumbs.db', 'desktop.ini', '__macosx', '.ds_store']);

export function isHiddenName(segment: string): boolean {
  return segment.startsWith('.') || JUNK_NAMES.has(segment.toLowerCase()) || segment.startsWith('~$');
}

/** Whether any part of a relative path is hidden (a dot-entry or junk), so the scan and import skip it. */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some(isHiddenName);
}

export interface CleanOptions {
  /** New names: also refuse what would break links or a Windows or macOS copy of the vault. */
  strict: boolean;
  /** The path names a folder: an empty path (the root) is allowed and a trailing `/` is dropped. */
  folder?: boolean;
}

function fail(message: string, path?: string): never {
  throw new KnowledgeError('INVALID_PATH', message, path === undefined ? undefined : { path: path.slice(0, 200) });
}

/**
 * Checks and normalizes a vault-relative path. Throws KnowledgeError('INVALID_PATH') with a plain reason:
 * absolute paths and drive letters, backslashes, empty, `.` and `..` segments, control characters, dot
 * names, over-long names and depth, and in strict mode the characters and names above.
 */
export function cleanPath(raw: unknown, opts: CleanOptions): string {
  if (typeof raw !== 'string') fail('A path must be text.');
  if (raw.length > MAX_PATH_CHARS * 2) fail(`A path can be at most ${MAX_PATH_CHARS} characters.`);
  if (CONTROL.test(raw)) fail('A path can’t contain control characters.');
  if (raw.includes('\\')) fail('Use / between folders, not \\.', raw);
  let p = raw.normalize('NFC');
  if (opts.folder && p.endsWith('/')) p = p.replace(/\/+$/, '');
  if (p === '') {
    if (opts.folder) return '';
    fail('A path can’t be empty.');
  }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) fail('A path must be relative to the vault, not absolute.', raw);
  if (p.length > MAX_PATH_CHARS) fail(`A path can be at most ${MAX_PATH_CHARS} characters.`);
  const parts = p.split('/');
  if (parts.length > MAX_DEPTH) fail(`Folders can be at most ${MAX_DEPTH} levels deep.`);
  for (const seg of parts) checkSegment(seg, opts.strict, raw);
  return p;
}

function checkSegment(seg: string, strict: boolean, whole: string): void {
  if (seg === '') fail('A path can’t have an empty part (a double or trailing /).', whole);
  if (seg === '.' || seg === '..') fail('A path can’t contain . or .. parts.', whole);
  if (seg.startsWith('.')) fail('Names that start with a dot are hidden and never part of a vault.', whole);
  if (Buffer.byteLength(seg) > MAX_SEGMENT_BYTES) fail(`A name can be at most ${MAX_SEGMENT_BYTES} bytes.`, whole);
  if (!strict) return;
  if (FORBIDDEN_IN_NEW.test(seg)) fail('A name can’t contain any of < > : " | ? * \\ # ^ [ ].', whole);
  if (BIDI_ZERO_WIDTH.test(seg)) fail('A name can’t contain invisible or direction-changing characters.', whole);
  if (/^\s|[\s.]$/.test(seg)) fail('A name can’t start with a space or end with a space or a dot.', whole);
  if (WINDOWS_RESERVED.test(seg.split('.')[0]!)) fail(`“${seg}” is a reserved name on Windows.`, whole);
  if (isHiddenName(seg)) fail('That name is reserved.', whole);
}

/** A note is a `.md` file. */
export const isNotePath = (path: string): boolean => /\.md$/i.test(path);

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A note's link name: its file name without `.md`. */
export const noteName = (path: string): string => baseName(path).replace(/\.md$/i, '');

/** Lowercase extension without the dot, or ''. */
export function extOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Where a path sits for case-insensitive comparison: lowercased NFC. */
export const foldPath = (path: string): string => path.normalize('NFC').toLowerCase();

/** `a/b/c.md` under `a/b` or `a`; the root contains everything. */
export const isUnder = (path: string, folder: string): boolean => folder === '' || path === folder || path.startsWith(`${folder}/`);

/* ---------- Touching the disk ---------- */

/**
 * The absolute path for `rel` under `root` (which must already be a real path), checking every component
 * that exists: none may be a symlink, and every one but the last must be a directory. Components that don't
 * exist yet are fine; `ensureDir` creates them one at a time. A check and a later open aren't atomic, so
 * opens of the final component add O_NOFOLLOW; this keeps the vault free of surprises for anyone but a
 * process that already has the portal's own file access.
 */
export function resolveSafe(root: string, rel: string): string {
  const parts = rel === '' ? [] : rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') break;
      if (code === 'ENOTDIR') fail('A part of that path is a file, not a folder.', rel);
      throw e;
    }
    if (st.isSymbolicLink()) fail('That path goes through a symbolic link, which a vault never follows.', rel);
    if (i < parts.length - 1 && !st.isDirectory()) fail('A part of that path is a file, not a folder.', rel);
  }
  const abs = parts.length ? join(root, ...parts) : root;
  if (abs !== root && !abs.startsWith(root + sep)) fail('That path is outside the vault.', rel);
  return abs;
}

/** Creates the folders of `rel` (a folder path) under `root`, one level at a time, never through a symlink. */
export function ensureDir(root: string, rel: string): string {
  const parts = rel === '' ? [] : rel.split('/');
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirSync(cur, { mode: 0o700 });
      continue;
    }
    if (st.isSymbolicLink()) fail('That path goes through a symbolic link, which a vault never follows.', rel);
    if (!st.isDirectory()) fail('A part of that path is a file, not a folder.', rel);
  }
  return cur;
}
