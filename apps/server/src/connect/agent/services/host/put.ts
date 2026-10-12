// `host` op `put` (docs/prd/targets-connect.md §11.6): the portal streams a tar archive as DATA records and ends it with EOF; the agent
// extracts each file and directory with the entry's mode (and its owner, when the agent is root), under the path mapping, and says
// in RESULT what it did not do. Nothing is buffered whole: a file goes to disk as its bytes arrive, so a 100 MB archive costs a few
// buffers. What it refuses: names with `..` (they would leave the mapped root), symlinks and hard links (skipped, never created or
// followed), device and fifo entries, and a path whose real location is outside the folder it was mapped into.
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { extract, type ExtractEvents, type Header } from 'tar-stream';
import type { ConnectHostResult } from '@portal/contracts';
import { HostChannel, REC } from './channel.js';
import { errorResult, type HostContext } from './exec.js';

type Skipped = NonNullable<ConnectHostResult['skipped']>;
/** tar-stream's entry body (a streamx readable, not a Node one). */
type Source = ExtractEvents['entry'][1];
const MAX_REPORTED = 50;

/** `a/./b//c` → `/a/b/c`; null when the name can't be used (`..`, NUL, empty). */
export function entryPath(name: string): string | null {
  if (name.includes('\0')) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return `/${parts.join('/')}`;
}

/** The real path of the deepest ancestor that exists, plus what doesn't exist yet. */
async function resolveDeepest(path: string): Promise<string> {
  let existing = path;
  let rest = '';
  for (;;) {
    try {
      return (await realpath(existing)) + rest;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e;
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest = `/${existing.slice(parent.length === 1 ? 1 : parent.length + 1)}${rest}`;
      existing = parent;
    }
  }
}

/** Whether `target` really lies inside `root` (symlinks resolved on both). */
export async function insideRoot(target: string, root: string): Promise<boolean> {
  const [t, r] = await Promise.all([resolveDeepest(target), resolveDeepest(root)]);
  return t === r || t.startsWith(r.endsWith('/') ? r : `${r}/`);
}

const isRoot = () => process.getuid?.() === 0;

async function writeAll(fh: FileHandle, chunk: Buffer): Promise<void> {
  let at = 0;
  while (at < chunk.length) at += (await fh.write(chunk, at, chunk.length - at)).bytesWritten;
}

/** Reads an entry to its end and throws the bytes away (an entry we won't write still has to be consumed for the archive to go on). */
const drainOf = (body: Source) =>
  new Promise<void>((resolve) => {
    if (body.destroyed) return resolve();
    body.once('end', () => resolve());
    body.once('close', () => resolve());
    body.once('error', () => resolve());
    body.resume();
  });

export async function runPut(ch: HostChannel, ctx: HostContext): Promise<void> {
  const skipped: Skipped = [];
  let failures = 0;
  let firstError: ConnectHostResult['error'];
  let partial: string | null = null;
  const note = (path: string, reason: string, failure = false) => {
    if (skipped.length < MAX_REPORTED) skipped.push({ path: path.slice(0, 300), reason });
    if (failure) failures++;
  };

  const ex = extract();
  let ended = false;
  let finished = false;

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  const finish = (error?: ConnectHostResult['error']) => {
    if (finished) return;
    finished = true;
    resolveDone();
    const result: ConnectHostResult = {
      code: error || failures ? 1 : 0,
      ...(error || firstError ? { error: error ?? firstError } : {}),
      ...(skipped.length ? { skipped } : {}),
    };
    ch.finish(result);
  };

  const write = async (header: Header, body: Source, target: string) => {
    const mode = (header.mode ?? 0o644) & 0o7777;
    // O_NOFOLLOW: a symlink in the last place is never written through.
    const fh = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode & 0o777);
    partial = target;
    try {
      // The mode and owner go on before the first byte (open applied the umask), so a secret never sits in a file others can read.
      await fh.chmod(mode);
      if (isRoot() && Number.isInteger(header.uid) && Number.isInteger(header.gid)) await fh.chown(header.uid, header.gid);
      await new Promise<void>((resolve, reject) => {
        let writing: Promise<void> = Promise.resolve();
        body.on('error', reject);
        body.on('data', (chunk: unknown) => {
          // One write at a time: the entry is paused while the disk takes the bytes (that is the backpressure).
          body.pause();
          writing = writing.then(() => writeAll(fh, chunk as Buffer)).then(() => void body.resume(), reject);
        });
        body.on('end', () => void writing.then(resolve, reject));
      });
      partial = null;
    } catch (e) {
      await fh.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      partial = null;
      throw e;
    }
    await fh.close();
  };

  const handle = async (header: Header, body: Source): Promise<void> => {
    const workspacePath = entryPath(header.name);
    const drain = () => drainOf(body);
    if (!workspacePath) {
      note(header.name, 'path');
      return drain();
    }
    if (header.type === 'symlink' || header.type === 'link') {
      note(workspacePath, 'link');
      return drain();
    }
    if (header.type !== 'file' && header.type !== 'directory') {
      note(workspacePath, 'type');
      return drain();
    }
    const target = ctx.paths.map(workspacePath);
    const root = ctx.paths.confine(workspacePath);
    if (root && !(await insideRoot(target, root).catch(() => false))) {
      note(workspacePath, 'escape');
      return drain();
    }
    try {
      if (header.type === 'directory') {
        const existing = await lstat(target).catch(() => null);
        if (existing && !existing.isDirectory()) throw Object.assign(new Error('exists and is not a directory'), { code: 'EINVAL' });
        await mkdir(target, { recursive: true });
        await chmod(target, (header.mode ?? 0o755) & 0o7777);
        if (isRoot() && Number.isInteger(header.uid) && Number.isInteger(header.gid)) await chown(target, header.uid, header.gid);
        return drain();
      }
      await mkdir(dirname(target), { recursive: true });
      await write(header, body, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'FAILED';
      note(workspacePath, code === 'ELOOP' ? 'link' : code, code !== 'ELOOP');
      firstError ??= errorResult(code === 'EACCES' || code === 'EPERM' ? 'EACCES' : 'FAILED', 'some entries could not be written').error;
      await drain();
    }
  };

  ex.on('entry', (header, body, next) => {
    handle(header, body).then(
      () => next(),
      () => next(),
    );
  });
  ex.on('finish', () => finish());
  ex.on('error', () => finish(errorResult('EINVAL', 'the archive is damaged').error));

  const endInput = () => {
    if (ended) return;
    ended = true;
    ex.end(undefined);
  };

  ch.onRecord(({ kind, payload }) => {
    if (kind === REC.data) {
      if (ended) return;
      if (!ex.write(payload)) {
        ch.pause();
        ex.once('drain', () => ch.resume());
      }
    } else if (kind === REC.eof) endInput();
  });
  ch.onEnd(endInput);
  ch.onClose(() => {
    // Reset before the end: stop, and don't leave half a file behind.
    if (!finished) {
      finished = true;
      ex.destroy();
      if (partial) void rm(partial, { force: true }).catch(() => undefined);
    }
    resolveDone();
  });

  return done;
}
