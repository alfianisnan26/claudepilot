// Chat content: staging an attachment in the workspace so Claude can read it (chat-sessions PRD FR31).
// Claude Code runs inside the workspace and can only open files there, so each attachment is written to
// `~/.claudepilot/uploads/<session id>/<name>` by cp-session's `put` (base64 on stdin: the same exec works on
// every target) and the message Claude reads names that path. The person never sees any of this: the chat
// shows the attachment, and the staged copy is only transport. Nothing is ever written into a project folder.

import { createReadStream, statSync } from 'node:fs';
import { posix } from 'node:path';
import { AppError } from '@isnanme/core';
import { CHAT_MAX_UPLOAD_BYTES, type ChatReach } from '@portal/contracts';
import type { Workspaces } from '../../workspaces/manager.js';
import { collectHostOutput, startHostCommand, withinTime } from '../files.js';
import { HOST_REFUSED, HOST_TOO_LARGE } from '../host.js';
import { STAGED_NAME } from './names.js';

export interface StageOptions {
  /** Brings cp-session up to date in the workspace first (an old host doesn't know `put`). */
  install?: (workspaceId: string) => Promise<void>;
  /** The longest the whole transfer of one file may take. */
  timeoutMs?: number;
}

/** What one staged file needs: where its bytes are (the blob store) and what to call it in the workspace. */
export interface StageSource {
  /** The file in the blob store (its size is read from there: the host is told exactly how many bytes to expect). */
  blobPath: string;
  /** The ASCII name from {@link stagedName}. */
  staged: string;
}

const START_MS = 20_000;
/** A file of the largest size, over a slow link: generous, since the person is waiting on a send. */
const STAGE_MS = 180_000;

/** The base64 of a file in pieces whose lengths are multiples of three bytes, so they join without padding in the middle. */
async function* base64Pieces(path: string): AsyncGenerator<string> {
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 3 * 64 * 1024 })) {
    const buf: Buffer = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    const whole = buf.length - (buf.length % 3);
    if (whole) yield buf.subarray(0, whole).toString('base64');
    carry = buf.subarray(whole);
  }
  if (carry.length) yield carry.toString('base64');
}

/**
 * Writes one file into the session's uploads folder in the workspace and returns the absolute path the host
 * reports (the workspace's own: `/home/node/...` in a workspace image, the real home on this machine).
 */
export async function stageFile(workspaces: Workspaces, workspaceId: string, sessionId: string, file: StageSource, opts: StageOptions = {}): Promise<string> {
  try {
    return await stageOnce(workspaces, workspaceId, sessionId, file, opts);
  } catch (e) {
    // Fewer bytes than sent arrived once (a transfer cut on its way): one more try before the person hears of it.
    if (!(e instanceof AppError) || !e.message.includes('arrived')) throw e;
    console.warn(`[chat] staging ${file.staged} in ${workspaceId}: ${e.message} Trying once more.`);
    return stageOnce(workspaces, workspaceId, sessionId, file, opts);
  }
}

/** `#short <got> <expected>`: what the host said arrived when it refused a size that doesn't match. */
const SHORT = /^#short (\d+) (\d+)$/m;

async function stageOnce(workspaces: Workspaces, workspaceId: string, sessionId: string, file: StageSource, opts: StageOptions): Promise<string> {
  let size: number;
  try {
    size = statSync(file.blobPath).size;
  } catch (e) {
    throw new AppError('SERVICE_UNAVAILABLE', 'The file to save in the workspace is gone.', { expose: true, cause: e });
  }
  if (!STAGED_NAME.test(file.staged) || size > CHAT_MAX_UPLOAD_BYTES) throw new AppError('VALIDATION_FAILED', 'That file can’t be saved in the workspace.');
  const nchars = 4 * Math.ceil(size / 3);
  const { exec, installError } = await startHostCommand(workspaces, workspaceId, ['put', sessionId, file.staged, String(nchars), String(size)], { install: opts.install, timeoutMs: START_MS });
  // A host that couldn't be brought up to date may not know `put`: it would exit at once, and bytes written to
  // a pipe nobody reads are an error on some targets. Don't start the transfer.
  if (installError) {
    exec.close();
    throw new AppError('SERVICE_UNAVAILABLE', 'Couldn’t bring the workspace’s chat host up to date to save the file.', { expose: true, cause: installError });
  }
  const timeoutMs = opts.timeoutMs ?? STAGE_MS;
  // Listen first: the host may answer (or refuse) before the last piece is written.
  const finished = collectHostOutput(exec, 4096, timeoutMs);
  finished.catch(() => undefined); // judged below; a failure while writing must not become an unhandled rejection
  let ended = false;
  void finished.then(() => (ended = true), () => (ended = true));
  try {
    for await (const piece of base64Pieces(file.blobPath)) {
      if (ended) break; // the host answered (or refused) already: whatever it said is judged below
      exec.write(piece);
      await new Promise<void>((resolve) => setImmediate(resolve)); // let the event loop breathe between pieces
    }
  } catch (e) {
    exec.close();
    throw new AppError('SERVICE_UNAVAILABLE', 'Couldn’t read the file to save it in the workspace.', { expose: true, cause: e });
  }
  const { code, out } = await withinTime(finished, timeoutMs);
  exec.close();
  if (code === 0) {
    const path = out.toString('utf8').trim().split('\n').pop() ?? '';
    // The host's own answer, checked: absolute, in a uploads folder of this session, and the name asked for.
    if (path.startsWith('/') && posix.basename(path) === file.staged && posix.basename(posix.dirname(path)) === sessionId) return path;
    throw new AppError('SERVICE_UNAVAILABLE', 'The workspace didn’t say where it saved the file.', { expose: true });
  }
  if (code === HOST_TOO_LARGE) throw new AppError('PAYLOAD_TOO_LARGE', 'That file is too large to save in the workspace.');
  if (code === HOST_REFUSED) throw new AppError('BAD_REQUEST', 'The workspace refused to save that file.');
  const short = SHORT.exec(out.toString('utf8'));
  if (short) throw new AppError('SERVICE_UNAVAILABLE', `Couldn’t save the file in the workspace: ${short[1]} of ${short[2]} bytes arrived.`, { expose: true });
  throw new AppError('SERVICE_UNAVAILABLE', `Couldn’t save the file in the workspace (exit ${code ?? 'unknown'}).`, { expose: true });
}

/** Removes a session's staged files (a deleted chat's). Failures are the caller's to ignore: it is housekeeping. */
export async function unstageSession(workspaces: Workspaces, workspaceId: string, sessionId: string, opts: StageOptions = {}): Promise<boolean> {
  const { exec } = await startHostCommand(workspaces, workspaceId, ['unstage', sessionId], { install: opts.install, timeoutMs: START_MS });
  const { code } = await collectHostOutput(exec, 1024, 30_000);
  exec.close();
  return code === 0;
}

/* ---------- What Claude reads ---------- */

/** One attachment as the note to Claude describes it. */
export interface NoteItem {
  /** Absolute path in the workspace. */
  path: string;
  reach: ChatReach;
  /** "image", "PDF", "video", "audio", "archive" … */
  label: string;
  size: number;
  /** An image Claude is shown directly in this message. */
  shown?: boolean;
  /** What Claude can't do with it, when that is worth saying ("you can't watch or hear it"). */
  limit?: string;
}

const sizeText = (bytes: number) => (bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

/**
 * The lines added to what Claude reads of a message that has attachments. A file Claude can open
 * (text, code, CSV, PDF) is an `@path` mention: when Claude Code runs the message it reads the file
 * itself (observed with 2.1.296: text and CSV come in as a Read, a large one with a pointer to read it in
 * parts) and a message that was queued behind a running turn leaves the mention for Claude to follow.
 * An image Claude is shown directly is named without `@`, so it isn't read twice, and anything it can't
 * read at all (audio, video, archives, other binaries) is named with what it is, so Claude can run tools
 * on it instead of guessing.
 */
export function attachmentNote(items: NoteItem[]): string {
  if (!items.length) return '';
  const lines = items.map((i) => {
    if (i.reach === 'reads') return `@${i.path}`;
    const what = i.shown ? `${i.label}, shown in this message` : `${i.label}, ${sizeText(i.size)}${i.limit ? `; ${i.limit}` : ''}`;
    return `${i.path} (${what})`;
  });
  return `[Attached by the user, saved in the workspace:\n${lines.join('\n')}]`;
}
