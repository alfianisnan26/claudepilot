// Chat sessions: the controller (chat-sessions PRD milestone C1). Owns the lifecycle of each session —
// launch the host process, follow its stdout, store the transcript, send input, answer requests — and
// dispatches live updates to whatever subscribes (the socket). All host access goes through short
// `workspaces.exec` calls into `cp-session`; the agent process itself stays detached in the workspace.

import { randomUUID } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { CHAT_SESSION_TITLE_MAX, type ChatServerMessage, type ChatSession, type CreateChatSessionRequest } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { HOME, type ExecSession } from '../workspaces/runtime.js';
import { CP_SESSION_PATH, parseStartOutput } from './host.js';
import { allowResponse, denyResponse, errorResponse, interruptRequest, parseLine, userLine } from './protocol.js';
import { ChatStore } from './store.js';

/** The claude flags cp-session runs after `--`; `--resume` or `--session-id` plus the id are spliced in. */
const BASE_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'] as const;
const BUDGET_FLAGS = ['--max-budget-usd', '10'] as const;

/** How long a dropped `tail` waits before re-following, and how many immediate failures end the reader. */
const RETAIL_MS = 1_000;
const MAX_IMMEDIATE_RETRIES = 5;
/** A `tail` that ran at least this long counts as healthy (it hit its 600 s limit), so retries reset. */
const HEALTHY_TAIL_MS = 5_000;

/** One follower per session: the live `tail` exec, its byte cursor, and re-follow bookkeeping. */
interface Reader {
  sessionId: string;
  exec?: ExecSession;
  /** Bytes read but not yet split into a complete line. */
  buffer: Buffer;
  /** The byte offset within the current segment, persisted as whole lines are consumed. */
  offset: number;
  /** Whether the one-time `system` "Ready" event has been stored. */
  ready: boolean;
  /** True once the reader is deliberately stopped (end / integrity); no re-follow after that. */
  stopped: boolean;
  /** Consecutive immediate `tail` exits; reset when a follow makes progress or runs its full term. */
  retries: number;
  tailStart: number;
  timer?: NodeJS.Timeout;
}

type Dispatch = (sessionId: string, msg: ChatServerMessage) => void;

/**
 * The chat controller. Construct once, share it between the HTTP routes and the socket. Readers are
 * started only on create and first send (resume-on-restart is a later milestone), and are kept alive
 * even with no subscribers so the transcript is never missed.
 */
export class ChatController {
  readonly #chat: ChatStore;
  readonly #workspaces: Workspaces;
  readonly #readers = new Map<string, Reader>();
  readonly #dispatchers = new Set<Dispatch>();

  /** Installed by the owner: writes `cp-session` into the workspace before each `start`. */
  installHost?: (workspaceId: string) => Promise<void>;

  constructor(store: Store, workspaces: Workspaces) {
    this.#chat = new ChatStore(store);
    this.#workspaces = workspaces;
  }

  /* ---------- Reads (delegated to the store) ---------- */

  list(): ChatSession[] {
    return this.#chat.list();
  }

  get(id: string): ChatSession | null {
    return this.#chat.get(id);
  }

  history(id: string, after = 0) {
    return this.#chat.history(id, after);
  }

  /** Registers a dispatcher for live `events`, `delta` and `session` messages. Returns an unsubscribe. */
  onEvent(cb: Dispatch): () => void {
    this.#dispatchers.add(cb);
    return () => this.#dispatchers.delete(cb);
  }

  /* ---------- Lifecycle ---------- */

  create(req: Partial<CreateChatSessionRequest>): ChatSession {
    const workspaceId = typeof req.workspaceId === 'string' ? req.workspaceId.trim() : '';
    if (!workspaceId) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    const [target] = this.#split(workspaceId);
    if (!this.#workspaces.runtimeFor(target)) throw new AppError('VALIDATION_FAILED', `No target “${target}”.`, { details: { workspaceId: 'Unknown target.' } });
    const id = randomUUID();
    const cwd = typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd.trim() : HOME;
    const title = (typeof req.title === 'string' && req.title.trim() ? req.title.trim() : 'New session').slice(0, CHAT_SESSION_TITLE_MAX);
    const session = this.#chat.create({ id, workspaceId, cwd, title, origin: 'ui' });
    void this.#startProcess(id);
    return session;
  }

  async send(sessionId: string, uuid: string, text: string, opts: { priority?: 'next' | 'later'; actor?: string } = {}): Promise<void> {
    const session = this.#require(sessionId);
    if (session.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    if (this.#chat.hasInput(sessionId, uuid)) throw new AppError('CONFLICT', 'That message was already sent.'); // integrity: a UUID is used once

    if (this.#chat.row(sessionId)?.process === 'gone') await this.#startProcess(sessionId, { resume: true });

    this.#chat.addInput(sessionId, uuid, opts.actor ?? null, 'message', opts.priority ?? null);
    // Store the user event first so the UI shows it in order, then send and go working.
    this.#append(sessionId, { kind: 'user', text, uuid });
    this.#chat.patchSession(sessionId, { state: 'working' });
    this.#emitSession(sessionId);
    try {
      await this.#writeLine(sessionId, userLine(text));
      this.#chat.setInputState(sessionId, uuid, 'started');
    } catch (e) {
      this.#chat.setInputState(sessionId, uuid, 'failed');
      throw e;
    }
    this.#ensureReader(sessionId);
  }

  async respond(sessionId: string, requestId: string, decision: 'allow' | 'allow_session' | 'deny', opts: { note?: string; actor?: string } = {}): Promise<void> {
    this.#require(sessionId);
    const open = this.#chat.openRequests(sessionId).find((r) => r.requestId === requestId);
    if (!open) throw new AppError('CONFLICT', 'That request is no longer open.');
    let line: string;
    let outcome: string;
    switch (decision) {
      case 'allow':
        line = allowResponse(requestId);
        outcome = 'allowed_once';
        break;
      case 'allow_session':
        // TODO(C2): build session permission rules (addRules, destination "session") checked against
        // Settings. For v1 "allow for session" sends a plain allow but records the intended outcome.
        line = allowResponse(requestId);
        outcome = 'allowed_session';
        break;
      case 'deny':
        line = denyResponse(requestId, opts.note?.trim() || 'Denied by the operator.');
        outcome = 'denied';
        break;
      default:
        throw new AppError('VALIDATION_FAILED', 'Unknown decision.');
    }
    // Record the decision first, so the transcript reads request → answer → what the tool did
    // (Claude Code acts on the answer before the send exec even returns).
    this.#chat.answerRequest(sessionId, requestId, outcome, opts.actor ?? null);
    this.#append(sessionId, { kind: 'resolved', requestId, outcome });
    this.#chat.patchSession(sessionId, { state: 'working' });
    this.#emitSession(sessionId);
    try {
      await this.#writeLine(sessionId, line);
    } catch (e) {
      // It never arrived: Claude Code is still waiting, so the request is open again.
      this.#chat.reopenRequest(sessionId, requestId);
      this.#append(sessionId, { kind: 'error', text: `Your answer didn't reach Claude Code: ${(e as Error).message}` });
      this.#append(sessionId, { kind: 'request', requestId, request: open });
      this.#chat.patchSession(sessionId, { state: 'waiting' });
      this.#emitSession(sessionId);
      throw e;
    }
  }

  /** Interrupt the running turn. */
  async stop(sessionId: string): Promise<void> {
    this.#require(sessionId);
    await this.#writeLine(sessionId, interruptRequest(randomUUID()));
  }

  /** End the session: SIGTERM the process group, stop the reader, mark it ended. */
  async end(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    this.#stopReader(sessionId);
    await this.#runOnce(session.workspaceId, ['stop', sessionId]).catch(() => undefined);
    this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: 'closed by operator' });
    this.#emitSession(sessionId);
  }

  /* ---------- Host process ---------- */

  async #startProcess(sessionId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const row = this.#chat.row(sessionId);
    if (!row || row.state === 'ended') return;
    const resume = opts.resume ?? false;

    if (this.installHost) {
      try {
        await this.installHost(row.workspace_id);
      } catch (e) {
        this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: this.#message(e) });
        this.#emitSession(sessionId);
        return;
      }
    }

    const seg = resume ? row.segment + 1 : row.segment;
    const cwd = row.cwd || HOME;
    const flags = [...BASE_FLAGS, resume ? '--resume' : '--session-id', sessionId, ...BUDGET_FLAGS];
    let code: number | null;
    let out: string;
    try {
      ({ code, out } = await this.#runOnce(row.workspace_id, ['start', sessionId, String(seg), cwd, '--', ...flags]));
    } catch (e) {
      // The workspace is unreachable or stopped: nothing started, but a later send can resume it.
      this.#chat.patchSession(sessionId, { state: 'interrupted', process: 'gone', endedReason: this.#message(e) });
      this.#emitSession(sessionId);
      return;
    }

    if (code === 0) {
      const started = parseStartOutput(out);
      this.#chat.patchSession(sessionId, { parentPid: started?.pid ?? null, processStartedAt: started?.startedAt ?? null, process: 'live', state: 'idle', segment: seg, byteOffset: 0 });
    } else if (code === 3) {
      // Already running (run.lock held): attach to the existing process on its current segment.
      this.#chat.patchSession(sessionId, { process: 'live', state: 'idle' });
    } else {
      this.#chat.patchSession(sessionId, { state: 'interrupted', process: 'gone', endedReason: `the session host could not start (exit ${code ?? 'unknown'})` });
      this.#emitSession(sessionId);
      return;
    }
    this.#emitSession(sessionId);
    this.#ensureReader(sessionId);
  }

  #ensureReader(sessionId: string): void {
    let reader = this.#readers.get(sessionId);
    if (reader) {
      if (reader.exec || reader.timer || reader.stopped) return; // already following, scheduled, or stopped
    } else {
      reader = { sessionId, buffer: Buffer.alloc(0), offset: 0, ready: this.#chat.hasEventKind(sessionId, 'system'), stopped: false, retries: 0, tailStart: 0 };
      this.#readers.set(sessionId, reader);
    }
    void this.#tail(reader);
  }

  async #tail(reader: Reader): Promise<void> {
    if (reader.stopped) return;
    const row = this.#chat.row(reader.sessionId);
    if (!row || row.state === 'ended') return;
    reader.offset = row.byte_offset;
    reader.buffer = Buffer.alloc(0);
    reader.tailStart = Date.now();
    let exec: ExecSession;
    try {
      const [target, name] = this.#split(row.workspace_id);
      exec = await this.#workspaces.exec(target, name, ['sh', CP_SESSION_PATH, 'tail', reader.sessionId, String(row.segment), String(reader.offset)]);
    } catch {
      this.#scheduleRetail(reader); // workspace briefly unreachable; try again shortly
      return;
    }
    if (reader.stopped) return void exec.close();
    reader.exec = exec;
    exec.onData((b) => this.#onBytes(reader, b));
    exec.onExit(() => this.#onTailExit(reader));
  }

  #onBytes(reader: Reader, chunk: Buffer): void {
    reader.buffer = Buffer.concat([reader.buffer, chunk]);
    let advanced = false;
    let nl: number;
    while ((nl = reader.buffer.indexOf(0x0a)) >= 0) {
      const lineBuf = reader.buffer.subarray(0, nl + 1);
      reader.buffer = reader.buffer.subarray(nl + 1);
      reader.offset += lineBuf.length;
      reader.retries = 0; // progress: the follow is healthy
      advanced = true;
      this.#handleLine(reader, lineBuf.toString('utf8'));
      if (reader.stopped) return;
    }
    // Persist the cursor so a re-follow (or a restart) resumes after whole lines only.
    if (advanced) this.#chat.patchSession(reader.sessionId, { byteOffset: reader.offset });
  }

  #onTailExit(reader: Reader): void {
    reader.exec = undefined;
    if (reader.stopped) return;
    if (Date.now() - reader.tailStart >= HEALTHY_TAIL_MS) reader.retries = 0; // hit its 600 s limit: normal renewal
    void this.#checkAndRetail(reader);
  }

  /** On a dropped `tail`: if the process is gone, mark the session interrupted; otherwise re-follow. */
  async #checkAndRetail(reader: Reader): Promise<void> {
    const row = this.#chat.row(reader.sessionId);
    if (!row || row.state === 'ended' || reader.stopped) return;
    let alive = false;
    try {
      const { out } = await this.#runOnce(row.workspace_id, ['status', reader.sessionId]);
      alive = out.trim().startsWith('live');
    } catch {
      alive = false; // treat unreachable as gone; a later send resumes
    }
    if (!alive) {
      this.#chat.patchSession(reader.sessionId, { process: 'gone', state: 'interrupted' });
      this.#emitSession(reader.sessionId);
      return; // keep the reader registered but idle
    }
    this.#scheduleRetail(reader);
  }

  #scheduleRetail(reader: Reader): void {
    if (reader.stopped || reader.timer) return;
    if (reader.retries >= MAX_IMMEDIATE_RETRIES) {
      this.#chat.patchSession(reader.sessionId, { process: 'gone', state: 'interrupted' });
      this.#emitSession(reader.sessionId);
      return;
    }
    reader.retries++;
    reader.timer = setTimeout(() => {
      reader.timer = undefined;
      void this.#tail(reader);
    }, RETAIL_MS);
    reader.timer.unref?.();
  }

  #stopReader(sessionId: string): void {
    const reader = this.#readers.get(sessionId);
    if (!reader) return;
    reader.stopped = true;
    if (reader.timer) clearTimeout(reader.timer);
    reader.exec?.close();
    this.#readers.delete(sessionId);
  }

  /* ---------- Reading one line ---------- */

  #handleLine(reader: Reader, raw: string): void {
    if (!raw.trim()) return;
    const sessionId = reader.sessionId;
    const parsed = parseLine(raw);

    // Integrity: the agent must stay the session we launched.
    if (parsed.sessionIdSeen && parsed.sessionIdSeen !== sessionId) return void this.#endIntegrity(reader, `the agent reported a different session id (${parsed.sessionIdSeen})`);

    if (parsed.controlError) void this.#writeLine(sessionId, errorResponse(parsed.controlError, 'unsupported')).catch(() => undefined);

    for (const ev of parsed.stored) {
      if (ev.kind === 'system') {
        if (reader.ready) continue; // the "Ready" note is stored once
        reader.ready = true;
      }
      this.#append(sessionId, ev);
    }

    if (parsed.request) {
      let canonical;
      try {
        canonical = this.#chat.addRequest(sessionId, parsed.request);
      } catch {
        return void this.#endIntegrity(reader, `a tool request id arrived twice (${parsed.request.requestId})`);
      }
      this.#append(sessionId, { kind: 'request', requestId: canonical.requestId, request: canonical, parentToolUseId: canonical.agentLabel });
    }

    if (parsed.sessionPatch) {
      this.#chat.patchSession(sessionId, parsed.sessionPatch);
      this.#emitSession(sessionId);
    }

    if (parsed.delta) this.#emit(sessionId, { type: 'delta', session: sessionId, agentLabel: parsed.delta.agentLabel, text: parsed.delta.text });
  }

  /** Integrity failure (§10.4): end the session at once and SIGTERM the process. */
  #endIntegrity(reader: Reader, why: string): void {
    const sessionId = reader.sessionId;
    this.#stopReader(sessionId);
    this.#append(sessionId, { kind: 'error', text: `Session ended for integrity: ${why}.` });
    this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: `integrity: ${why}` });
    this.#emitSession(sessionId);
    const row = this.#chat.row(sessionId);
    if (row) void this.#runOnce(row.workspace_id, ['stop', sessionId]).catch(() => undefined);
  }

  /* ---------- Exec helpers ---------- */

  /** Stages one line into the FIFO via `cp-session send` (a fresh staging uuid, exact byte count). */
  async #writeLine(sessionId: string, line: string): Promise<void> {
    const row = this.#chat.row(sessionId);
    if (!row) throw new AppError('NOT_FOUND', 'No such session.');
    const { code } = await this.#runOnce(row.workspace_id, ['send', sessionId, randomUUID(), String(Buffer.byteLength(line))], line);
    if (code !== 0) throw new AppError('SERVICE_UNAVAILABLE', `The session host rejected the line (exit ${code ?? 'unknown'}).`);
  }

  /** Runs one short `cp-session` command to completion; writes `stdin` (then closes it) when given. */
  async #runOnce(workspaceId: string, args: string[], stdin?: string): Promise<{ code: number | null; out: string }> {
    const [target, name] = this.#split(workspaceId);
    const exec = await this.#workspaces.exec(target, name, ['sh', CP_SESSION_PATH, ...args]);
    const chunks: Buffer[] = [];
    return await new Promise((resolve) => {
      let done = false;
      exec.onData((b) => chunks.push(b));
      exec.onExit((code) => {
        if (done) return;
        done = true;
        resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
      });
      if (stdin !== undefined) {
        exec.write(stdin);
        exec.close();
      }
    });
  }

  /* ---------- Dispatch and small helpers ---------- */

  #append(sessionId: string, ev: Parameters<ChatStore['appendEvent']>[1]): void {
    const full = this.#chat.appendEvent(sessionId, ev);
    this.#emit(sessionId, { type: 'events', session: sessionId, items: [full] });
  }

  #emit(sessionId: string, msg: ChatServerMessage): void {
    for (const cb of this.#dispatchers) cb(sessionId, msg);
  }

  #emitSession(sessionId: string): void {
    const session = this.#chat.get(sessionId);
    if (session) this.#emit(sessionId, { type: 'session', session });
  }

  #require(sessionId: string): ChatSession {
    const session = this.#chat.get(sessionId);
    if (!session) throw new AppError('NOT_FOUND', 'No such session.');
    return session;
  }

  #split(workspaceId: string): [string, string] {
    const i = workspaceId.indexOf('/');
    if (i <= 0 || i === workspaceId.length - 1) throw new AppError('VALIDATION_FAILED', `Bad workspace id “${workspaceId}”.`);
    return [workspaceId.slice(0, i), workspaceId.slice(i + 1)];
  }

  #message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
