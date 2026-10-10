// Chat sessions: Files and Diff (chat-sessions PRD §13, FR32–FR34). Runs cp-session's `ls`, `cat` and
// `diff` in the session's workspace through short execs, and turns what they print into the contract's
// ChatFolder, a download stream and ChatDiff. The path policy lives in the host script (host.ts); here
// a path is only made absolute and tidy before it's asked about.

import { posix } from 'node:path';
import { AppError, isAppError } from '@isnanme/core';
import { CHAT_MAX_DOWNLOAD_BYTES, type ChatDiff, type ChatDiffFile, type ChatFileEntry, type ChatFolder } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { HOME, type ExecSession } from '../workspaces/runtime.js';
import { CP_SESSION_PATH, HOST_REFUSED, HOST_TOO_LARGE } from './host.js';

export interface FilesOptions {
  /**
   * Brings cp-session up to date in the workspace before the command (the controller's installer):
   * a workspace whose sessions started before Files existed still has a host without `ls`/`cat`/`diff`.
   * A failure doesn't stop the command; if the command then fails too, the failure is what's reported
   * (an out-of-date host refuses commands it doesn't know).
   */
  install?: (workspaceId: string) => Promise<void>;
  /** How long the command may run; for a download, how long until its first byte. */
  timeoutMs?: number;
}

/** How long bringing the host up to date, and then starting the exec, may each take. */
const START_MS = 20_000;
const LS_TIMEOUT_MS = 30_000;
/** Each of the host's git calls has 30 s. */
const DIFF_TIMEOUT_MS = 120_000;
const DOWNLOAD_START_MS = 30_000;
/** Output kept from `ls` and `diff`; the host stays well below both, so this only guards memory. */
const LS_MAX_OUTPUT = 2_000_000;
const DIFF_MAX_OUTPUT = 8_000_000;
/** A diff lists at most this many files, then reads `truncated`. */
export const DIFF_MAX_FILES = 2_000;
const MAX_PATH = 4096;
const TRUNCATED = '\n#truncated\n';

const REFUSED = {
  ls: 'Can’t open that folder. It may be gone or not a folder, and only the workspace’s home folder can be browsed, apart from the portal’s own files.',
  cat: 'Can’t download that file. It may be gone or not a regular file, and only files in the workspace’s home folder can be downloaded, apart from the portal’s own files.',
  diff: 'Can’t read the session’s folder. It may be gone, or it’s outside the workspace’s home folder.',
} as const;
const FAILED = { ls: 'Couldn’t list that folder', cat: 'Couldn’t read that file', diff: 'Couldn’t read the changes' } as const;

/* ---------- Paths ---------- */

/** "/a//b/../c/" → "/a/c". */
function tidy(path: string): string {
  const p = posix.normalize(path);
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** An absolute workspace path from a request, tidied; anything else is a 400. */
export function workspacePath(raw: string): string {
  if (!raw.startsWith('/') || raw.length > MAX_PATH || raw.includes('\0'))
    throw new AppError('BAD_REQUEST', 'Use an absolute path in the workspace, like /home/node/project.');
  return tidy(raw);
}

/** The folder a session runs in (its stored `cwd`, the home folder when unset), or null when there's no such session. */
export function sessionFolder(store: Store, sessionId: string): string | null {
  const row = store.db?.prepare('SELECT cwd FROM chat_sessions WHERE id = ?').get(sessionId) as { cwd: unknown } | undefined;
  if (!row) return null;
  const cwd = typeof row.cwd === 'string' ? row.cwd.trim() : '';
  return cwd ? tidy(posix.resolve(HOME, cwd)) : HOME;
}

/* ---------- Running host commands ---------- */

function split(workspaceId: string): [string, string] {
  const i = workspaceId.indexOf('/');
  if (i <= 0 || i === workspaceId.length - 1) throw new AppError('VALIDATION_FAILED', `Bad workspace id “${workspaceId}”.`);
  return [workspaceId.slice(0, i), workspaceId.slice(i + 1)];
}

/** A started command, and why bringing the host up to date failed first (if it did). */
interface Started {
  exec: ExecSession;
  installError: unknown;
}

/** One line of a message, bounded, for showing. */
const oneLine = (e: unknown) => (e instanceof Error ? e.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '');

const tooSlow = () => new AppError('SERVICE_UNAVAILABLE', 'The workspace took too long to answer. Try again.', { expose: true });

/** Waits at most `ms` for `p`; a value that only arrives later goes to `late` (to be closed). */
function within<T>(p: Promise<T>, ms: number, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(tooSlow());
    }, ms);
    p.then(
      (v) => {
        if (done) return late?.(v);
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Starts one cp-session command. A stopped or unreachable workspace is a readable 503. */
async function start(workspaces: Workspaces, workspaceId: string, args: string[], opts: FilesOptions): Promise<Started> {
  const [target, name] = split(workspaceId);
  let installError: unknown = null;
  if (opts.install) await within(opts.install(workspaceId), START_MS).catch((e: unknown) => void (installError = e ?? new Error('')));
  try {
    const exec = await within(workspaces.exec(target, name, ['sh', CP_SESSION_PATH, ...args]), START_MS, (late) => late.close());
    return { exec, installError };
  } catch (e) {
    // Already readable (the workspace no longer exists, or took too long): as it is.
    if (isAppError(e) && (e.status < 500 || e.expose)) throw e;
    const why = oneLine(e);
    throw new AppError('SERVICE_UNAVAILABLE', why ? `Couldn’t reach the workspace: ${why}` : 'Couldn’t reach the workspace. Is it running?', { expose: true, cause: e });
  }
}
const tooLarge = (limit: number) =>
  new AppError('PAYLOAD_TOO_LARGE', `That file is over ${Math.floor(limit / 1_000_000)} MB, too large to download here.`);

/**
 * Turns a host exit code into the matching error; 0 passes. When the host couldn't be brought up to
 * date, a failure is put down to that (an old host refuses `ls`, `cat` and `diff` alike).
 */
function check(code: number | null, what: 'ls' | 'cat' | 'diff', installError: unknown, limit = CHAT_MAX_DOWNLOAD_BYTES): void {
  if (code === 0) return;
  if (code === HOST_TOO_LARGE && what === 'cat') throw tooLarge(limit);
  if (installError)
    throw new AppError('SERVICE_UNAVAILABLE', oneLine(installError) || 'Couldn’t bring the workspace’s chat host up to date.', { expose: true, cause: installError });
  if (code === HOST_REFUSED) throw new AppError('BAD_REQUEST', REFUSED[what]);
  throw new AppError('SERVICE_UNAVAILABLE', `${FAILED[what]} (exit ${code ?? 'unknown'}).`, { expose: true });
}

/**
 * Collects a command's output as bytes until it exits. Past `max` bytes the rest is dropped and the
 * exec closed (`cut`); past `timeoutMs` it's closed and fails.
 */
function collect(exec: ExecSession, max: number, timeoutMs: number): Promise<{ code: number | null; out: Buffer; cut: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => settle(() => (exec.close(), reject(tooSlow()))), timeoutMs);
    exec.onData((b) => {
      if (done) return;
      if (size + b.length > max) {
        chunks.push(b.subarray(0, max - size));
        settle(() => (exec.close(), resolve({ code: null, out: Buffer.concat(chunks), cut: true })));
        return;
      }
      chunks.push(b);
      size += b.length;
    });
    // Let output already on its way land before the exit is acted on.
    exec.onExit((code) => setImmediate(() => settle(() => resolve({ code, out: Buffer.concat(chunks), cut: false }))));
  });
}

/* ---------- Folders ---------- */

const TYPES: Record<string, ChatFileEntry['type']> = { f: 'file', d: 'dir', l: 'symlink' };
/** `<type>\t<size>\t<mtime-epoch>\t<name>`; the name is the rest of the line and may hold tabs. */
const LS_LINE = /^([A-Za-z])\t(\d+)\t(-?\d+(?:\.\d+)?)\t(.+)$/;
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Reads `ls` output into a folder: folders first, then the rest, each by name. Sizes are for files only. */
export function parseListing(folder: string, out: string): ChatFolder {
  const entries: ChatFileEntry[] = [];
  let truncated = false;
  for (const line of out.split('\n')) {
    if (line === '#truncated') {
      truncated = true;
      continue;
    }
    const m = LS_LINE.exec(line);
    if (!m) continue;
    const letter = m[1]!;
    const name = m[4]!;
    if (name === '.' || name === '..' || name.includes('/')) continue;
    const type = TYPES[letter] ?? 'other';
    const ms = Number(m[3]) * 1000;
    entries.push({
      name,
      path: folder === '/' ? `/${name}` : `${folder}/${name}`,
      type,
      size: type === 'file' ? Number(m[2]) : null,
      modifiedAt: Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null,
    });
  }
  entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || byName.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path: folder, entries, truncated };
}

/** A folder's entries (cp-session `ls`). 400 when the policy refuses the path. */
export async function listFolder(workspaces: Workspaces, workspaceId: string, path: string, opts: FilesOptions = {}): Promise<ChatFolder> {
  const folder = workspacePath(path);
  const { exec, installError } = await start(workspaces, workspaceId, ['ls', folder], opts);
  const { code, out, cut } = await collect(exec, LS_MAX_OUTPUT, opts.timeoutMs ?? LS_TIMEOUT_MS);
  if (!cut) check(code, 'ls', installError);
  const listing = parseListing(folder, out.toString('utf8'));
  return cut ? { ...listing, truncated: true } : listing;
}

/* ---------- Downloads ---------- */

export interface ChatDownload {
  /** The file's own name, for the attachment header. */
  name: string;
  body: ReadableStream<Uint8Array>;
}

/**
 * A file's bytes as a stream (cp-session `cat`). It settles on the first byte or the exit, whichever
 * comes first, so a refused path (400), a file over the limit (413) or an unreadable one still gets a
 * proper error. Once bytes flow, a failure (or growing past `maxBytes`) errors the stream, which
 * aborts the response rather than ending a partial file as if it were whole.
 */
export async function openDownload(
  workspaces: Workspaces,
  workspaceId: string,
  path: string,
  opts: FilesOptions & { maxBytes?: number } = {},
): Promise<ChatDownload> {
  const file = workspacePath(path);
  const name = posix.basename(file);
  const limit = opts.maxBytes ?? CHAT_MAX_DOWNLOAD_BYTES;
  const { exec, installError } = await start(workspaces, workspaceId, ['cat', file], opts);
  return await new Promise<ChatDownload>((resolve, reject) => {
    let state: 'waiting' | 'streaming' | 'done' = 'waiting';
    let total = 0;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (ctrl = c),
      // The browser went away: stop reading.
      cancel: () => {
        state = 'done';
        exec.close();
      },
    });
    const timer = setTimeout(() => {
      if (state !== 'waiting') return;
      state = 'done';
      exec.close();
      reject(tooSlow());
    }, opts.timeoutMs ?? DOWNLOAD_START_MS);
    const fail = (e: AppError) => {
      const waiting = state === 'waiting';
      state = 'done';
      clearTimeout(timer);
      if (waiting) reject(e);
      else ctrl.error(e);
    };

    exec.onData((b) => {
      if (state === 'done') return;
      total += b.length;
      if (total > limit) {
        exec.close(); // it grew past the limit while being read
        return fail(tooLarge(limit));
      }
      ctrl.enqueue(b);
      if (state === 'waiting') {
        state = 'streaming';
        clearTimeout(timer);
        resolve({ name, body });
      }
    });
    exec.onExit((code) =>
      setImmediate(() => {
        if (state === 'done') return;
        if (code !== 0) {
          try {
            check(code, 'cat', installError, limit);
          } catch (e) {
            return fail(e as AppError);
          }
        }
        const waiting = state === 'waiting';
        state = 'done';
        clearTimeout(timer);
        ctrl.close();
        if (waiting) resolve({ name, body }); // an empty file: no bytes at all
      }),
    );
  });
}

/* ---------- Diff ---------- */

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git prints it: C-quoted (`"a\tb"`, octal bytes) when it holds special characters. */
export function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const parts: Buffer[] = [];
  let last = 0;
  for (const m of body.matchAll(/\\([0-7]{3}|[abtnvfr"\\])/g)) {
    parts.push(Buffer.from(body.slice(last, m.index), 'utf8'));
    const e = m[1]!;
    parts.push(Buffer.from([e.length === 3 ? parseInt(e, 8) & 0xff : ESCAPES[e]!]));
    last = m.index + m[0].length;
  }
  parts.push(Buffer.from(body.slice(last), 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

/** Splits a leading path off `s`: a C-quoted string, or plain text up to `sep`. Returns it and the rest. */
function splitPath(s: string, sep: string): [string, string] {
  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    return [unquote(s.slice(0, i + 1)), s.slice(i + 1)];
  }
  const at = s.indexOf(sep);
  return at < 0 ? [s, ''] : [s.slice(0, at), s.slice(at)];
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** git's two-letter porcelain status as one: `??`, `U` (unmerged), `D`, `A`, `R`, `C`, `T` or `M`. */
function statusLetter(xy: string): string {
  if (xy === '??' || xy === '!!') return xy;
  if (UNMERGED.has(xy)) return 'U';
  const x = xy[0];
  const y = xy[1];
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'A' || x === 'R' || x === 'C') return x;
  if (y === 'A') return 'A'; // intent to add
  if (x === 'T' || y === 'T') return 'T';
  return 'M';
}

/** `status --porcelain=v1` lines: `XY path`, or `XY from -> to` for a rename or copy. */
function parseStatus(text: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  for (const line of text.split('\n')) {
    if (line.length < 4 || line[2] !== ' ') continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    if (/[RC]/.test(xy)) {
      const [, after] = splitPath(rest, ' -> ');
      if (after.startsWith(' -> ')) rest = after.slice(4);
    }
    out.push({ path: unquote(rest), status: statusLetter(xy) });
  }
  return out;
}

/** The path a numstat line counts for; a rename (`a => b`, `dir/{a => b}/f`, `"a" => "b"`) counts for its new path. */
function numstatPath(s: string): string {
  if (s.startsWith('"')) {
    const [first, after] = splitPath(s, ' => ');
    return after.startsWith(' => ') ? unquote(after.slice(4)) : first;
  }
  const arrow = s.indexOf(' => ');
  if (arrow < 0) return s;
  const open = s.lastIndexOf('{', arrow);
  const close = s.indexOf('}', arrow + 4);
  if (open >= 0 && close >= 0) return (s.slice(0, open) + s.slice(arrow + 4, close) + s.slice(close + 1)).replace(/\/{2,}/g, '/');
  return unquote(s.slice(arrow + 4));
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/**
 * Reads `diff` output: `#norepo`, or the `#status`, `#numstat` and `#patch` sections. Files come from
 * status (so untracked ones are listed too), with numstat's counts (`-` for binary reads null). A patch
 * cut short (`#truncated`, or `cut` by the reader) loses its partial last line.
 */
export function parseDiff(folder: string, out: string, cut = false): ChatDiff {
  if (out.trim() === '#norepo') return { repo: null, files: [], patch: '', truncated: false };
  if (!out.startsWith('#status\n')) throw new AppError('SERVICE_UNAVAILABLE', 'The workspace gave an unexpected answer about changes.', { expose: true });
  // Each marker follows the newline that ends the section before it (or the marker line above it).
  const n = out.indexOf('\n#numstat\n');
  const p = n < 0 ? -1 : out.indexOf('\n#patch\n', n + 1);
  const statusText = out.slice('#status\n'.length, n < 0 ? out.length : n + 1);
  const numstatText = n < 0 ? '' : out.slice(n + '\n#numstat\n'.length, p < 0 ? out.length : p + 1);
  let patch = p < 0 ? '' : out.slice(p + '\n#patch\n'.length);
  let truncated = cut;
  if (patch.endsWith(TRUNCATED)) {
    truncated = true;
    patch = patch.slice(0, -TRUNCATED.length);
  }
  if (truncated) patch = patch.slice(0, patch.lastIndexOf('\n') + 1);

  const counts = new Map<string, Pick<ChatDiffFile, 'additions' | 'deletions'>>();
  for (const line of numstatText.split('\n')) {
    const m = NUMSTAT_LINE.exec(line);
    if (!m) continue;
    counts.set(numstatPath(m[3]!), { additions: m[1] === '-' ? null : Number(m[1]), deletions: m[2] === '-' ? null : Number(m[2]) });
  }
  const files: ChatDiffFile[] = [];
  for (const { path, status } of parseStatus(statusText)) {
    if (files.length >= DIFF_MAX_FILES) {
      truncated = true;
      break;
    }
    const c = counts.get(path);
    files.push({ path, status, additions: c?.additions ?? null, deletions: c?.deletions ?? null });
  }
  return { repo: folder, files, patch, truncated };
}

/** What changed in a folder's git work tree (cp-session `diff`): staged and unstaged, against HEAD. */
export async function readDiff(workspaces: Workspaces, workspaceId: string, path: string, opts: FilesOptions = {}): Promise<ChatDiff> {
  const folder = workspacePath(path);
  const { exec, installError } = await start(workspaces, workspaceId, ['diff', folder], opts);
  const { code, out, cut } = await collect(exec, DIFF_MAX_OUTPUT, opts.timeoutMs ?? DIFF_TIMEOUT_MS);
  if (!cut) check(code, 'diff', installError);
  return parseDiff(folder, out.toString('utf8'), cut);
}
