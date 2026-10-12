// Chat content: artifacts, the files the agent produces (chat-sessions PRD FR32, FR33, I9). When a tool that writes
// a file reports success, or a turn that ran commands ends, the files it made are copied out of the workspace
// into the portal's blob store and shown in the transcript as cards where they happened. The copy is what the
// person previews and downloads: it survives the workspace stopping, and a text copy has its secrets hidden.
//
// What counts, so the transcript doesn't fill with source files (those are the Changes view):
//   - a file the agent CREATED with Write, of any type (at most a few source files per turn);
//   - a file it wrote or edited that is a document, a picture, audio, video, a table, a web page or an archive;
//   - a file a command made (Bash and the like), found by a sweep when the turn ends, of those same kinds;
//   - a file it hands over on purpose (the artifact_publish tool, publish.ts).
// Every copy-out goes through the host's path policy (FR33): only real paths under the workspace's home, never
// the portal's or Claude Code's own folders, checked on the opened file.

import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { AppError, isAppError } from '@isnanme/core';
import { CHAT_MAX_UPLOAD_BYTES, type ChatArtifactSource, type ChatFile } from '@portal/contracts';
import type { Store } from '../../store/store.js';
import type { Workspaces } from '../../workspaces/manager.js';
import { adoptBlob } from '../blobs.js';
import { collectHostOutput, openDownload, sessionFolder, startHostCommand } from '../files.js';
import type { StoredEvent } from '../protocol.js';
import { intakeStream, type Intake } from './intake.js';
import { displayName, extensionOf } from './names.js';
import { roomFor } from './quota.js';
import { recordFile, setFileEvent, shownPath } from './records.js';
import { sniff } from './sniff.js';

/** The most a copy-out takes of one file: the same as an upload. */
const MAX_BYTES = CHAT_MAX_UPLOAD_BYTES;
/** The most cards one turn makes: documents, pictures and media; and of those, source and config files. */
const MAX_CARDS = 20;
const MAX_CODE_CARDS = 4;
/** What a sweep reads back from the host, and how many of those it keeps. */
const SWEEP_LIST = 400;
const SWEEP_MAX_FILES = 12;
/** A sweep starts this long before the turn began (the workspace's clock may differ a little from the portal's). */
const SLACK_MS = 10_000;

/** Pictures, audio and video. */
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi']);
/** Documents, tables, web pages and archives: what a person takes away. */
const DOCUMENTS = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'tsv', 'ppt', 'pptx', 'odp', 'epub', 'html', 'htm', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
/** Plain writing: shown when the agent writes or edits it, not when a command happens to touch it. */
const NOTES = new Set(['md', 'markdown', 'txt']);

/** Whether a file of this name is the kind a person takes away (picture, audio, video, document, table, page, archive). */
export const isDeliverable = (name: string): boolean => {
  const ext = extensionOf(name);
  return MEDIA.has(ext) || DOCUMENTS.has(ext);
};

/** The tools that write a file and say which in their one-line summary. */
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** What Claude Code's Write says when it made a file that wasn't there (observed with 2.1.296). */
const CREATED = /^File created successfully at:/;

interface Turn {
  startedAt: number;
  usedCommand: boolean;
  cards: number;
  codeCards: number;
}

export interface CaptureDeps {
  store: Store;
  workspaces: Workspaces;
  /** Brings cp-session up to date in a workspace (the controller's installer). */
  install: (workspaceId: string) => Promise<void>;
  /** The workspace a session runs in, or null when there is no such session. */
  workspaceOf: (sessionId: string) => string | null;
  /** Adds an `artifact` event to the transcript and returns its sequence number. */
  append: (sessionId: string, ev: StoredEvent) => number | undefined;
  /** Hides secrets in a text copy: the workspace's secret values first, then credential shapes (the controller's `scrub`). */
  redact: (workspaceId: string, text: string) => string;
  now?: () => number;
}

/** Why a file wasn't copied out. */
export type CopyRefusal = 'refused' | 'too_large' | 'empty' | 'no_room' | 'shown' | 'unavailable';

/** What to tell the agent that tried to hand a file over (it can act on it). */
const REFUSALS: Record<CopyRefusal, string> = {
  refused: 'That path can’t be shared: only regular files under the workspace’s home folder, outside the portal’s and Claude Code’s own folders.',
  too_large: `That file is over ${CHAT_MAX_UPLOAD_BYTES / 1_000_000} MB.`,
  empty: 'That file is empty.',
  no_room: 'This chat’s file storage is full.',
  shown: 'That file is already shown.',
  unavailable: 'The workspace couldn’t be reached, or there is no such file.',
};

export interface CopyOptions {
  since?: string;
  byPath?: boolean;
  /** The name to show (default: the file's own). */
  name?: string;
}

/** A file copied out of a workspace and recorded, waiting for its transcript event. */
export interface CopiedFile {
  file: ChatFile;
  row: number;
}

/** Copies and records the files an agent produces; see the file's header. */
export class ArtifactCapture {
  readonly #deps: CaptureDeps;
  /** Per session: the calls of tools that write files, by tool_use id, until their results arrive. */
  readonly #calls = new Map<string, Map<string, { tool: string; path: string }>>();
  readonly #turns = new Map<string, Turn>();
  /** Per session: the work in flight (one at a time, in the order the events came). */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(deps: CaptureDeps) {
    this.#deps = deps;
  }

  /** Shows the capture an event just stored; it never throws and never waits for the copy-out. */
  observe(sessionId: string, ev: StoredEvent): void {
    try {
      this.#observe(sessionId, ev);
    } catch {
      // an artifact is a nicety: nothing here may disturb the transcript
    }
  }

  #observe(sessionId: string, ev: StoredEvent): void {
    const now = (this.#deps.now ?? Date.now)();
    if (ev.kind === 'tool_use' && ev.toolUseId && ev.toolName) {
      const turn = this.#turn(sessionId, now);
      if (ev.toolName === 'Bash') turn.usedCommand = true;
      const path = WRITERS.has(ev.toolName) ? shownPath(ev.text) : undefined;
      // A path cut for the summary ends in an ellipsis: it names no file.
      if (path && !path.endsWith('…')) {
        const calls = this.#calls.get(sessionId) ?? new Map();
        if (calls.size >= 200) calls.delete(calls.keys().next().value as string);
        calls.set(ev.toolUseId, { tool: ev.toolName, path });
        this.#calls.set(sessionId, calls);
      }
    } else if (ev.kind === 'tool_result' && ev.toolUseId) {
      const call = this.#calls.get(sessionId)?.get(ev.toolUseId);
      if (!call) return;
      this.#calls.get(sessionId)!.delete(ev.toolUseId);
      if (ev.isError) return;
      const created = call.tool === 'Write' && CREATED.test(ev.text ?? '');
      const turn = this.#turn(sessionId, now);
      this.#enqueue(sessionId, () => this.#written(sessionId, turn, call.path, call.tool === 'Write' ? (created ? 'created' : 'written') : 'edited'));
    } else if (ev.kind === 'result') {
      const turn = this.#turns.get(sessionId);
      this.#turns.delete(sessionId);
      this.#calls.delete(sessionId);
      if (turn?.usedCommand) this.#enqueue(sessionId, () => this.#sweep(sessionId, turn));
    }
  }

  #turn(sessionId: string, now: number): Turn {
    let turn = this.#turns.get(sessionId);
    if (!turn) {
      turn = { startedAt: now, usedCommand: false, cards: 0, codeCards: 0 };
      this.#turns.set(sessionId, turn);
    }
    return turn;
  }

  #enqueue(sessionId: string, work: () => Promise<void>): void {
    const next = (this.#queues.get(sessionId) ?? Promise.resolve()).then(work).catch(() => undefined);
    this.#queues.set(sessionId, next);
    void next.then(() => {
      if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId);
    });
  }

  /** Resolves when everything queued so far has finished (tests, and shutdown). */
  async idle(): Promise<void> {
    while (this.#queues.size) await Promise.all([...this.#queues.values()]);
  }

  /** Forgets a session (it was deleted). */
  forget(sessionId: string): void {
    this.#calls.delete(sessionId);
    this.#turns.delete(sessionId);
  }

  /** A file the agent wrote with Write or Edit: copied out when it is one to show, and put in the transcript. */
  async #written(sessionId: string, turn: Turn, path: string, how: 'created' | 'written' | 'edited'): Promise<void> {
    const name = posix.basename(path);
    const ext = extensionOf(name);
    // Created: any kind of file. Written over or edited: only the kinds a person takes away, and plain notes.
    if (how !== 'created' && !isDeliverable(name) && !NOTES.has(ext)) return;
    const deliverable = isDeliverable(name) || NOTES.has(ext);
    if (turn.cards >= MAX_CARDS || (!deliverable && turn.codeCards >= MAX_CODE_CARDS)) return;
    // The same bytes shown earlier this turn are not shown again; a new version of the same path is (the transcript keeps the newest).
    const copied = await this.copyOut(sessionId, path, how === 'edited' ? 'edit' : 'write', { since: new Date(turn.startedAt - SLACK_MS).toISOString(), byPath: false });
    if (!copied) return;
    turn.cards++;
    if (!deliverable) turn.codeCards++;
    this.show(sessionId, [copied]);
  }

  /** The files commands made during a turn, found when it ends: one event with all of them. */
  async #sweep(sessionId: string, turn: Turn): Promise<void> {
    const workspaceId = this.#deps.workspaceOf(sessionId);
    const folder = sessionFolder(this.#deps.store, sessionId);
    if (!workspaceId || !folder) return;
    const since = Math.max(0, Math.floor((turn.startedAt - SLACK_MS) / 1000));
    const { exec, installError } = await startHostCommand(this.#deps.workspaces, workspaceId, ['produced', folder, String(since), String(SWEEP_LIST)], { install: this.#deps.install, timeoutMs: 20_000 }).catch(() => ({ exec: null, installError: null }));
    if (!exec) return;
    const { code, out } = await collectHostOutput(exec, 2_000_000, 30_000).catch(() => ({ code: null, out: Buffer.alloc(0) }));
    exec.close();
    if (code !== 0 || installError) return;
    const found = parseProduced(out.toString('utf8'));
    if (!found) return;
    const candidates = found.files
      .filter((f) => f.size > 0 && f.size <= MAX_BYTES && isDeliverable(f.rel) && !f.rel.split('/').includes('..'))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, SWEEP_MAX_FILES);
    const copied: CopiedFile[] = [];
    for (const c of candidates) {
      if (turn.cards >= MAX_CARDS) break;
      const path = posix.join(found.dir, c.rel);
      const one = await this.copyOut(sessionId, path, 'command', { since: new Date(turn.startedAt - SLACK_MS).toISOString(), byPath: true });
      if (one) {
        turn.cards++;
        copied.push(one);
      }
    }
    if (copied.length) this.show(sessionId, copied);
  }

  /**
   * Copies one file out of the workspace into the blob store and records it as an artifact of the session
   * (nothing in the transcript yet: see {@link show}). Null when it can't or shouldn't be kept: see
   * {@link copyOutWhy}.
   */
  async copyOut(sessionId: string, path: string, source: ChatArtifactSource, opts: CopyOptions = {}): Promise<CopiedFile | null> {
    const r = await this.copyOutWhy(sessionId, path, source, opts);
    return r.ok ? r.copied : null;
  }

  /**
   * {@link copyOut} that says why not: refused by the path policy (or not a regular file), gone, too large,
   * empty, no room in the chat, or already shown. With `since`, the same bytes recorded since then (this
   * turn) are the same artifact, and with `byPath` so is any file recorded at that path since.
   */
  async copyOutWhy(sessionId: string, path: string, source: ChatArtifactSource, opts: CopyOptions = {}): Promise<{ ok: true; copied: CopiedFile } | { ok: false; why: CopyRefusal }> {
    const { store, workspaces } = this.#deps;
    const workspaceId = this.#deps.workspaceOf(sessionId);
    const db = store.db;
    if (!workspaceId || !db || !store.writable) return { ok: false, why: 'unavailable' };
    if (!path.startsWith('/') || path.includes('\0') || path.length > 1024) return { ok: false, why: 'refused' };
    if (opts.since && opts.byPath && db.prepare("SELECT 1 FROM chat_files WHERE session_id = ? AND kind = 'download' AND workspace_path = ? AND at >= ? LIMIT 1").get(sessionId, path, opts.since)) return { ok: false, why: 'shown' };
    if (!roomFor(store, sessionId, 1).ok) return { ok: false, why: 'no_room' };
    let intake: Intake;
    try {
      const download = await openDownload(workspaces, workspaceId, path, { install: this.#deps.install, maxBytes: MAX_BYTES });
      const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', 'Too large.');
      intake = await intakeStream(store, download.body, MAX_BYTES, { tooLarge });
    } catch (e) {
      // 413: over the limit. 400: the path policy (or not a regular file). Anything else: the workspace couldn't say.
      return { ok: false, why: isAppError(e) ? (e.code === 'PAYLOAD_TOO_LARGE' ? 'too_large' : e.code === 'BAD_REQUEST' ? 'refused' : 'unavailable') : 'unavailable' };
    }
    const { tmp, head } = intake;
    let { sha256, size } = intake;
    if (size === 0) {
      rmSync(tmp, { force: true });
      return { ok: false, why: 'empty' };
    }
    if (!roomFor(store, sessionId, size).ok) {
      rmSync(tmp, { force: true });
      return { ok: false, why: 'no_room' };
    }
    const name = displayName(opts.name ?? posix.basename(path), 'file');
    const sniffed = sniff(head, name, size, size > head.length);
    let redacted = false;
    if (sniffed.textual) {
      // A text copy is what the person sees and downloads: whatever a secret-shaped part of it is, it isn't kept.
      const raw = readFileSync(tmp);
      const text = this.#deps.redact(workspaceId, raw.toString('utf8'));
      if (text !== raw.toString('utf8')) {
        const bytes = Buffer.from(text, 'utf8');
        writeFileSync(tmp, bytes);
        sha256 = createHash('sha256').update(bytes).digest('hex');
        size = bytes.length;
        redacted = true;
      }
    }
    if (opts.since && db.prepare("SELECT 1 FROM chat_files WHERE session_id = ? AND blob_sha256 = ? AND at >= ? LIMIT 1").get(sessionId, sha256, opts.since)) {
      rmSync(tmp, { force: true });
      return { ok: false, why: 'shown' }; // the same bytes were already shown this turn (a tool's screenshot, a file written with Write)
    }
    adoptBlob(store, tmp, sha256);
    const file: ChatFile = { blobId: sha256, name, mediaType: sniffed.mediaType, size, preview: sniffed.preview, path, source };
    if (sniffed.width && sniffed.height) {
      file.width = sniffed.width;
      file.height = sniffed.height;
    }
    if (redacted) file.redacted = true;
    return { ok: true, copied: { file, row: recordFile(store, sessionId, 'download', file) } };
  }

  /** A file the agent hands over on purpose (the `artifact_publish` tool): always shown, whatever it is, with the reason when it can't be. */
  async publish(sessionId: string, path: string, name?: string): Promise<ChatFile> {
    const r = await this.copyOutWhy(sessionId, path, 'publish', { name });
    if (!r.ok) throw new AppError(r.why === 'too_large' ? 'PAYLOAD_TOO_LARGE' : r.why === 'no_room' ? 'LIMIT_REACHED' : r.why === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'VALIDATION_FAILED', REFUSALS[r.why], { expose: true });
    this.show(sessionId, [r.copied]);
    return r.copied.file;
  }

  /** Puts copied files in the transcript as one `artifact` event, and points their rows at it. */
  show(sessionId: string, copied: CopiedFile[]): number | undefined {
    if (copied.length === 0 || !this.#deps.workspaceOf(sessionId)) return undefined;
    const seq = this.#deps.append(sessionId, { kind: 'artifact', files: copied.map((c) => c.file) });
    if (seq !== undefined) setFileEvent(this.#deps.store, copied.map((c) => c.row), seq);
    return seq;
  }
}

/** The `produced` command's answer: the folder's real path, and the files with their size and modification time. */
export function parseProduced(out: string): { dir: string; files: { size: number; mtime: number; rel: string }[] } | null {
  const lines = out.split('\n');
  const first = /^#dir\t(\/.+)$/.exec(lines[0] ?? '');
  if (!first) return null;
  const files: { size: number; mtime: number; rel: string }[] = [];
  for (const line of lines.slice(1)) {
    const m = /^(\d+)\t(\d+(?:\.\d+)?)\t\.\/(.+)$/.exec(line);
    if (!m) continue;
    files.push({ size: Number(m[1]), mtime: Number(m[2]), rel: m[3]! });
  }
  return { dir: first[1]!, files };
}
