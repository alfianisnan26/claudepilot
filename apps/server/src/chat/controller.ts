// Chat sessions: the controller (chat-sessions PRD milestones C1–C3). Owns the lifecycle of each
// session — launch the host process, follow its stdout, store the transcript, send input (with images),
// answer requests, change model/effort/ultracode/mode, track sub-agents — and dispatches live updates to
// whatever subscribes (the socket). All host access goes through short `workspaces.exec` calls into
// `cp-session`; the agent process itself stays detached in the workspace.

import { randomUUID } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  CHAT_SESSION_TITLE_MAX,
  type ChatControl,
  type ChatImage,
  type ChatInputState,
  type ChatModelOption,
  type ChatServerMessage,
  type ChatSession,
  type ChatTask,
  type CreateChatSessionRequest,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { HOME, type ExecSession } from '../workspaces/runtime.js';
import { decodeAttachments, decodeToolImage, readBlob, saveBlob } from './blobs.js';
import { CP_SESSION_PATH, parseStartOutput } from './host.js';
import {
  allowResponse,
  controlRequest,
  denyResponse,
  errorResponse,
  flagSettings,
  parseLine,
  pickApplied,
  pickModels,
  userLine,
  type AppliedSettings,
  type ControlResponse,
  type RawImage,
  type StoredEvent,
} from './protocol.js';
import { ChatStore, type InputState } from './store.js';

/** The claude flags cp-session runs after `--`; `--resume` or `--session-id` plus the id are spliced in. */
const BASE_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'] as const;
const BUDGET_FLAGS = ['--max-budget-usd', '10'] as const;

/** How long a dropped `tail` waits before re-following, and how many immediate failures end the reader. */
const RETAIL_MS = 1_000;
const MAX_IMMEDIATE_RETRIES = 5;
/** A `tail` that ran at least this long counts as healthy (it hit its 600 s limit), so retries reset. */
const HEALTHY_TAIL_MS = 5_000;

/** How long a control request waits for Claude Code's `control_response`. */
const CONTROL_TIMEOUT_MS = 15_000;

/** Modes a chat session may switch to; Bypass is never one of them. */
const MODES = new Set<string>(['default', 'acceptEdits', 'plan', 'dontAsk']);
/** The UI's names for the modes, used in the transcript's system rows. */
const MODE_LABELS: Record<string, string> = { default: 'Ask', acceptEdits: 'Auto-accept edits', plan: 'Plan', dontAsk: "Don't ask" };
/** A model value (`default`, `sonnet`, a full id): printable ASCII, no spaces. */
const MODEL_VALUE = /^[\x21-\x7e]{1,200}$/;
/** An effort level, `low` … `max`. */
const EFFORT_LEVEL = /^[a-z]{1,16}$/;
/** A client-chosen message id (a UUID in practice); it's echoed into the stream and the inputs table. */
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** One follower per session: the live `tail` exec, its byte cursor, and re-follow bookkeeping. */
interface Reader {
  sessionId: string;
  exec?: ExecSession;
  /** Chunks of a line not yet complete; joined once, when its newline arrives (image lines run to MBs). */
  partial: Buffer[];
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

/** A control request waiting for its `control_response`. */
interface PendingControl {
  sessionId: string;
  resolve: (response: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type Dispatch = (sessionId: string, msg: ChatServerMessage) => void;

/** A refusal Claude Code sent, made safe to show: one line, no control characters, bounded. */
function cliMessage(error: string): string {
  // eslint-disable-next-line no-control-regex
  const text = error.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  if (!text) return 'Claude Code refused the request.';
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * The chat controller. Construct once, share it between the HTTP routes and the socket. Readers are
 * started only on create and first send or control (resume-on-restart is a later milestone), and are
 * kept alive even with no subscribers so the transcript is never missed.
 */
export class ChatController {
  readonly #store: Store;
  readonly #chat: ChatStore;
  readonly #workspaces: Workspaces;
  readonly #readers = new Map<string, Reader>();
  readonly #dispatchers = new Set<Dispatch>();
  /** Control requests in flight, by request_id. */
  readonly #pending = new Map<string, PendingControl>();
  /** Launches in flight, so a send and a control never start the same session twice. */
  readonly #starting = new Map<string, Promise<void>>();
  /** Sessions whose current process has had its applied settings read (after its first `system/init`). */
  readonly #appliedRead = new Set<string>();
  /** Per session: a `Task` tool_use id → its sub-agent's description, to label that agent's lines. */
  readonly #agentNames = new Map<string, Map<string, string>>();
  /** Per session: tool calls still waiting for their result, tool_use id → tool name. */
  readonly #toolCalls = new Map<string, Map<string, string>>();

  /** Installed by the owner: writes `cp-session` into the workspace before each `start`. */
  installHost?: (workspaceId: string) => Promise<void>;
  /** How long a control request waits for Claude Code's answer. */
  controlTimeoutMs = CONTROL_TIMEOUT_MS;

  constructor(store: Store, workspaces: Workspaces) {
    this.#store = store;
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

  /** The session's sub-agents and background tasks. */
  tasks(id: string): ChatTask[] {
    this.#require(id);
    return this.#chat.tasks(id);
  }

  /** Sent messages a reconnecting tab can't tell from the transcript: queued, withdrawn or failed. */
  inputStates(id: string): { uuid: string; state: ChatInputState }[] {
    return this.#chat.inputStates(id);
  }

  /** An image's bytes and type — only when this session links it. */
  blob(id: string, blobId: string): { bytes: Buffer<ArrayBuffer>; mediaType: string } | null {
    return readBlob(this.#store, id, blobId);
  }

  /** The models this session can switch to (Claude Code's `list_models`); resumes the process if needed. */
  async models(id: string): Promise<ChatModelOption[]> {
    this.#require(id);
    await this.#live(id);
    return pickModels(await this.#request(id, 'list_models'));
  }

  /** Registers a dispatcher for live `events`, `delta`, `session`, `input` and `tasks` messages. Returns an unsubscribe. */
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
    void this.#startProcess(id).catch(() => undefined);
    return session;
  }

  /**
   * Sends a message. While Claude works, `priority` `next` steers the running turn and `later` waits
   * for it to end; `command_lifecycle` then reports where it is (`input` messages). Attached images are
   * checked, kept in the blob store, and sent inline; the transcript keeps only their references.
   */
  async send(sessionId: string, uuid: string, text: string, opts: { priority?: 'next' | 'later'; actor?: string; attachments?: unknown } = {}): Promise<void> {
    const session = this.#require(sessionId);
    if (session.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    if (typeof uuid !== 'string' || !CLIENT_ID.test(uuid)) throw new AppError('VALIDATION_FAILED', 'That message has no valid id.');
    if (typeof text !== 'string') throw new AppError('VALIDATION_FAILED', 'Type a message.');
    const priority = opts.priority;
    if (priority !== undefined && priority !== 'next' && priority !== 'later') throw new AppError('VALIDATION_FAILED', 'Unknown message priority.');
    const images = decodeAttachments(opts.attachments);
    if (!text.trim() && !images.length) throw new AppError('VALIDATION_FAILED', 'Type a message.');
    if (this.#chat.hasInput(sessionId, uuid)) throw new AppError('CONFLICT', 'That message was already sent.'); // integrity: a UUID is used once

    await this.#live(sessionId);
    if (this.#chat.hasInput(sessionId, uuid)) throw new AppError('CONFLICT', 'That message was already sent.'); // a retry raced it

    const refs = images.map((i) => saveBlob(this.#store, sessionId, 'upload', i.name, i.mediaType, i.bytes));
    this.#chat.addInput(sessionId, uuid, opts.actor ?? null, 'message', priority ?? null);
    // Store the user event first so the UI shows it in order, then send. Sent while Claude works, it
    // steers or queues; sent while a request waits, the session keeps waiting.
    const ev: StoredEvent = { kind: 'user', text, uuid };
    if (refs.length) ev.images = refs;
    this.#append(sessionId, ev);
    const before = this.#chat.get(sessionId)?.state;
    const woke = before !== undefined && before !== 'working' && before !== 'waiting';
    if (woke) {
      this.#chat.patchSession(sessionId, { state: 'working' });
      this.#emitSession(sessionId);
    }
    try {
      await this.#writeLine(sessionId, userLine(text, { uuid, priority, images: images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 })) }));
    } catch (e) {
      this.#setInput(sessionId, uuid, 'failed');
      // Nothing reached Claude Code: undo the optimistic Working, unless something else moved it since.
      if (woke && before && this.#chat.get(sessionId)?.state === 'working') {
        this.#chat.patchSession(sessionId, { state: before });
        this.#emitSession(sessionId);
      }
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

  /**
   * One session control. `stop` and `end` as before; `model`, `effort`, `ultracode` and `mode` change
   * what applies from Claude Code's next request (the session then shows the applied values);
   * `cancel_queued` withdraws a queued message.
   */
  async control(sessionId: string, op: ChatControl['op'], args?: ChatControl['args']): Promise<void> {
    const a: NonNullable<ChatControl['args']> = args && typeof args === 'object' ? args : {};
    switch (op) {
      case 'stop':
        return this.stop(sessionId);
      case 'end':
        return this.end(sessionId);
      case 'model':
        return this.#setModel(sessionId, a.model);
      case 'effort':
        return this.#setEffort(sessionId, a.effort);
      case 'ultracode':
        return this.#setUltracode(sessionId, a.ultracode);
      case 'mode':
        return this.#setMode(sessionId, a.mode);
      case 'cancel_queued':
        return this.#cancelQueued(sessionId, a.inputUuid);
      default:
        throw new AppError('VALIDATION_FAILED', 'Unknown control.');
    }
  }

  /** Interrupt the running turn: a plain `interrupt` control request (Stop never sends a signal). */
  async stop(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    if (session.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    await this.#starting.get(sessionId);
    if (this.#chat.row(sessionId)?.process === 'gone') return; // nothing is running
    await this.#request(sessionId, 'interrupt');
  }

  /** End the session: SIGTERM the process group, stop the reader, mark it ended. */
  async end(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    this.#stopReader(sessionId);
    this.#forget(sessionId, 'The session ended.');
    await this.#runOnce(session.workspaceId, ['stop', sessionId]).catch(() => undefined);
    this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: 'closed by operator' });
    this.#emitSession(sessionId);
  }

  /* ---------- Controls ---------- */

  async #setModel(sessionId: string, model: unknown): Promise<void> {
    const value = typeof model === 'string' ? model.trim() : '';
    if (!MODEL_VALUE.test(value)) throw new AppError('VALIDATION_FAILED', 'Pick a model.');
    this.#require(sessionId);
    await this.#live(sessionId);
    await this.#request(sessionId, 'set_model', { model: value }); // Claude Code validates it with a tiny API call
    const applied = await this.#refreshApplied(sessionId).catch(() => null);
    this.#note(sessionId, `Model: ${applied?.model ?? value}`);
  }

  async #setEffort(sessionId: string, effort: unknown): Promise<void> {
    const level = typeof effort === 'string' ? effort.trim() : '';
    if (!EFFORT_LEVEL.test(level)) throw new AppError('VALIDATION_FAILED', 'Pick an effort level.');
    this.#require(sessionId);
    await this.#live(sessionId);
    await this.#request(sessionId, 'apply_flag_settings', { settings: flagSettings({ effort: level }) });
    const applied = await this.#refreshApplied(sessionId).catch(() => null);
    // Clamps are silent in Claude Code, so say what actually applies.
    if (applied?.effort === null) this.#note(sessionId, `Effort: ${level} (this model doesn’t use effort)`);
    else if (applied?.effort && applied.effort !== level) this.#note(sessionId, `Effort: ${applied.effort} (asked for ${level})`);
    else this.#note(sessionId, `Effort: ${level}`);
  }

  async #setUltracode(sessionId: string, on: unknown): Promise<void> {
    if (typeof on !== 'boolean') throw new AppError('VALIDATION_FAILED', 'Turn ultracode on or off.');
    this.#require(sessionId);
    await this.#live(sessionId);
    await this.#request(sessionId, 'apply_flag_settings', { settings: flagSettings({ ultracode: on }) });
    await this.#refreshApplied(sessionId).catch(() => null);
    this.#note(sessionId, on ? 'Ultracode on' : 'Ultracode off');
  }

  async #setMode(sessionId: string, mode: unknown): Promise<void> {
    if (mode === 'bypassPermissions') throw new AppError('FORBIDDEN', 'Bypass is off for chat sessions.');
    if (typeof mode !== 'string' || !MODES.has(mode)) throw new AppError('VALIDATION_FAILED', 'Pick a permission mode.');
    this.#require(sessionId);
    await this.#live(sessionId);
    const reply = await this.#request(sessionId, 'set_permission_mode', { mode });
    const applied = typeof reply.mode === 'string' && reply.mode ? reply.mode : mode;
    if (applied === 'bypassPermissions') {
      this.#endIntegrity(sessionId, 'Claude Code switched to Bypass permissions, which chat sessions never allow');
      throw new AppError('CONFLICT', 'The session ended: Claude Code switched to Bypass permissions.');
    }
    this.#chat.patchSession(sessionId, { mode: applied });
    this.#emitSession(sessionId);
    this.#note(sessionId, `Mode: ${MODE_LABELS[applied] ?? applied}`);
  }

  /** Withdraws a queued message (`cancel_async_message`); it then reads `cancelled`. */
  async #cancelQueued(sessionId: string, inputUuid: unknown): Promise<void> {
    this.#require(sessionId);
    const uuid = typeof inputUuid === 'string' ? inputUuid : '';
    const state = uuid ? this.#chat.inputState(sessionId, uuid) : null;
    if (!state) throw new AppError('NOT_FOUND', 'No such message.');
    if (state === 'cancelled') return; // already withdrawn (a retry)
    if (state === 'started' || state === 'completed') throw new AppError('CONFLICT', 'Claude already read that message.');
    if (state !== 'sending' && state !== 'queued') throw new AppError('CONFLICT', 'That message isn’t queued.');
    await this.#starting.get(sessionId);
    const row = this.#chat.row(sessionId);
    if (!row || row.state === 'ended' || row.process === 'gone') {
      this.#setInput(sessionId, uuid, 'cancelled'); // its process, and the queue with it, is gone: it will never run
      return;
    }
    const reply = await this.#request(sessionId, 'cancel_async_message', { message_uuid: uuid });
    if (reply.cancelled !== true) throw new AppError('CONFLICT', 'Claude already read that message.');
    this.#setInput(sessionId, uuid, 'cancelled');
  }

  /* ---------- Host process ---------- */

  /** Launches (or resumes) the session's process; a launch already in flight is shared, never doubled. */
  #startProcess(sessionId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const inFlight = this.#starting.get(sessionId);
    if (inFlight) return inFlight;
    const launch = this.#launch(sessionId, opts).finally(() => this.#starting.delete(sessionId));
    this.#starting.set(sessionId, launch);
    return launch;
  }

  async #launch(sessionId: string, opts: { resume?: boolean }): Promise<void> {
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
    this.#appliedRead.delete(sessionId); // a new process: read its applied settings after its first init
    this.#emitSession(sessionId);
    this.#ensureReader(sessionId);
  }

  /** Makes sure there is a live process to talk to: waits out a launch in flight, resumes a gone one. */
  async #live(sessionId: string): Promise<void> {
    await this.#starting.get(sessionId);
    let row = this.#chat.row(sessionId);
    if (row && row.state !== 'ended' && row.process === 'gone') {
      await this.#startProcess(sessionId, { resume: true });
      row = this.#chat.row(sessionId);
    }
    if (!row || row.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    if (row.process === 'gone')
      throw new AppError('SERVICE_UNAVAILABLE', row.ended_reason ? `Couldn’t resume the session: ${row.ended_reason}` : 'Couldn’t resume the session.', { expose: true });
  }

  #ensureReader(sessionId: string): void {
    let reader = this.#readers.get(sessionId);
    if (reader) {
      if (reader.exec || reader.timer || reader.stopped) return; // already following, scheduled, or stopped
    } else {
      reader = { sessionId, partial: [], offset: 0, ready: this.#chat.hasReady(sessionId), stopped: false, retries: 0, tailStart: 0 };
      this.#readers.set(sessionId, reader);
    }
    void this.#tail(reader);
  }

  async #tail(reader: Reader): Promise<void> {
    if (reader.stopped) return;
    const row = this.#chat.row(reader.sessionId);
    if (!row || row.state === 'ended') return;
    reader.offset = row.byte_offset;
    reader.partial = [];
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
    let advanced = false;
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, start)) >= 0) {
      const tail = chunk.subarray(start, nl + 1);
      const lineBuf = reader.partial.length ? Buffer.concat([...reader.partial, tail]) : tail;
      reader.partial = [];
      start = nl + 1;
      reader.offset += lineBuf.length;
      reader.retries = 0; // progress: the follow is healthy
      advanced = true;
      this.#handleLine(reader, lineBuf.toString('utf8'));
      if (reader.stopped) return;
    }
    if (start < chunk.length) reader.partial.push(chunk.subarray(start));
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
      this.#forget(reader.sessionId, 'Claude Code stopped before it answered.');
      this.#chat.patchSession(reader.sessionId, { process: 'gone', state: 'interrupted' });
      this.#emitSession(reader.sessionId);
      return; // keep the reader registered but idle
    }
    this.#scheduleRetail(reader);
  }

  #scheduleRetail(reader: Reader): void {
    if (reader.stopped || reader.timer) return;
    if (reader.retries >= MAX_IMMEDIATE_RETRIES) {
      this.#forget(reader.sessionId, 'Lost touch with Claude Code before it answered.');
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

    // Integrity: the agent must stay the session we launched, and never run with Bypass.
    if (parsed.sessionIdSeen && parsed.sessionIdSeen !== sessionId) return void this.#endIntegrity(sessionId, `the agent reported a different session id (${parsed.sessionIdSeen})`);
    if (parsed.sessionPatch?.mode === 'bypassPermissions') return void this.#endIntegrity(sessionId, 'the agent reported Bypass permissions, which chat sessions never allow');

    if (parsed.controlError) void this.#writeLine(sessionId, errorResponse(parsed.controlError, 'unsupported')).catch(() => undefined);
    if (parsed.controlResponse) this.#settleControl(sessionId, parsed.controlResponse);

    // Sub-agent names first, so this line's own events can already use them.
    for (const a of parsed.agents ?? []) this.#names(sessionId).set(a.toolUseId, a.description);
    if (parsed.tasks?.length) {
      for (const t of parsed.tasks) {
        this.#chat.upsertTask(sessionId, t);
        if (t.toolUseId && t.description) this.#names(sessionId).set(t.toolUseId, t.description);
      }
      this.#emitTasks(sessionId);
    }

    for (const ev of parsed.stored) {
      if (parsed.init && ev.kind === 'system') {
        if (reader.ready) continue; // the "Ready" note is stored once
        reader.ready = true;
      }
      if (ev.parentToolUseId) ev.agentLabel = this.#label(sessionId, ev.parentToolUseId);
      // Name each result from its own call (parallel calls finish in any order).
      if (ev.kind === 'tool_use' && ev.toolUseId && ev.toolName) this.#calls(sessionId).set(ev.toolUseId, ev.toolName);
      if (ev.kind === 'tool_result' && ev.toolUseId && ev.toolName === undefined) ev.toolName = this.#toolFor(sessionId, ev.toolUseId);
      if (ev.rawImages) {
        const images = this.#saveToolImages(sessionId, ev.rawImages);
        delete ev.rawImages; // the base64 never reaches the store
        if (images.length) ev.images = images;
      }
      this.#append(sessionId, ev);
    }

    if (parsed.request) {
      const parent = parsed.request.agentLabel;
      let canonical;
      try {
        canonical = this.#chat.addRequest(sessionId, { ...parsed.request, agentLabel: parent ? this.#label(sessionId, parent) : null });
      } catch {
        return void this.#endIntegrity(sessionId, `a tool request id arrived twice (${parsed.request.requestId})`);
      }
      this.#append(sessionId, { kind: 'request', requestId: canonical.requestId, request: canonical, agentLabel: canonical.agentLabel, parentToolUseId: parent });
    }

    if (parsed.sessionPatch) {
      this.#chat.patchSession(sessionId, parsed.sessionPatch);
      this.#emitSession(sessionId);
    }

    for (const { uuid, state } of parsed.inputs ?? []) this.#setInput(sessionId, uuid, state);

    if (parsed.delta) {
      const agentLabel = parsed.delta.agentLabel ? this.#label(sessionId, parsed.delta.agentLabel) : null;
      this.#emit(sessionId, { type: 'delta', session: sessionId, agentLabel, text: parsed.delta.text });
    }

    // After a process's first `system/init`, read what actually applies (model, effort, ultracode).
    if (parsed.init && !this.#appliedRead.has(sessionId)) {
      this.#appliedRead.add(sessionId);
      void this.#refreshApplied(sessionId).catch(() => undefined);
    }
  }

  /** Integrity failure (§10.4): end the session at once and SIGTERM the process. */
  #endIntegrity(sessionId: string, why: string): void {
    this.#stopReader(sessionId);
    this.#forget(sessionId, 'The session ended for integrity.');
    if (this.#chat.row(sessionId)?.state === 'ended') return; // already ended (by the operator, or an earlier check)
    this.#append(sessionId, { kind: 'error', text: `Session ended for integrity: ${why}.` });
    this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: `integrity: ${why}` });
    this.#emitSession(sessionId);
    const row = this.#chat.row(sessionId);
    if (row) void this.#runOnce(row.workspace_id, ['stop', sessionId]).catch(() => undefined);
  }

  /* ---------- Control requests ---------- */

  /**
   * Sends one control request and resolves with the body of Claude Code's success reply. Rejects with
   * its error message, when the line can't be written, or after {@link controlTimeoutMs} without an
   * answer. Replies are only ever reduced by the caller, never stored or logged whole.
   */
  #request(sessionId: string, subtype: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new AppError('SERVICE_UNAVAILABLE', 'Claude Code didn’t answer in time. Try again.', { expose: true }));
      }, this.controlTimeoutMs);
      this.#pending.set(requestId, { sessionId, resolve, reject, timer });
      this.#ensureReader(sessionId); // the reply arrives on stdout
      this.#writeLine(sessionId, controlRequest(requestId, subtype, fields)).catch((e: unknown) => {
        if (!this.#pending.delete(requestId)) return;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** Routes a `control_response` to the request it answers; replies we didn't ask for are ignored. */
  #settleControl(sessionId: string, reply: ControlResponse): void {
    const pending = this.#pending.get(reply.requestId);
    if (!pending || pending.sessionId !== sessionId) return; // not ours (e.g. issued before a restart)
    this.#pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.response);
    else pending.reject(new AppError('VALIDATION_FAILED', cliMessage(reply.error)));
  }

  /** Reads what applies now — `get_settings.applied` only, never `effective` or `sources` — onto the session. */
  async #refreshApplied(sessionId: string): Promise<AppliedSettings | null> {
    const applied = pickApplied(await this.#request(sessionId, 'get_settings'));
    if (!applied) return null;
    this.#chat.patchSession(sessionId, applied);
    this.#emitSession(sessionId);
    return applied;
  }

  /** Fails the session's control requests in flight and drops its per-process caches. */
  #forget(sessionId: string, why: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new AppError('CONFLICT', why));
    }
    this.#appliedRead.delete(sessionId);
    this.#agentNames.delete(sessionId);
    this.#toolCalls.delete(sessionId);
  }

  /* ---------- Exec helpers ---------- */

  /** Stages one line into the FIFO via `cp-session send` (a fresh staging uuid, exact byte count). */
  async #writeLine(sessionId: string, line: string): Promise<void> {
    const row = this.#chat.row(sessionId);
    if (!row) throw new AppError('NOT_FOUND', 'No such session.');
    const { code } = await this.#runOnce(row.workspace_id, ['send', sessionId, randomUUID(), String(Buffer.byteLength(line))], line);
    if (code !== 0) throw new AppError('SERVICE_UNAVAILABLE', `The session host rejected the line (exit ${code ?? 'unknown'}).`, { expose: true });
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

  #append(sessionId: string, ev: StoredEvent): void {
    const full = this.#chat.appendEvent(sessionId, ev);
    this.#emit(sessionId, { type: 'events', session: sessionId, items: [full] });
  }

  /** A system row in the transcript (a control change). */
  #note(sessionId: string, text: string): void {
    this.#append(sessionId, { kind: 'system', text });
  }

  /** Moves a sent line's state and tells the tabs — once per real change. */
  #setInput(sessionId: string, uuid: string, state: InputState): void {
    if (!this.#chat.setInputState(sessionId, uuid, state) || state === 'refused') return;
    this.#emit(sessionId, { type: 'input', session: sessionId, uuid, state });
  }

  #emitTasks(sessionId: string): void {
    this.#emit(sessionId, { type: 'tasks', session: sessionId, tasks: this.#chat.tasks(sessionId) });
  }

  #names(sessionId: string): Map<string, string> {
    let names = this.#agentNames.get(sessionId);
    if (!names) this.#agentNames.set(sessionId, (names = new Map()));
    return names;
  }

  #calls(sessionId: string): Map<string, string> {
    let calls = this.#toolCalls.get(sessionId);
    if (!calls) this.#toolCalls.set(sessionId, (calls = new Map()));
    return calls;
  }

  /** The tool a result answers: from the call still in flight (then forgotten), else from the stored call. */
  #toolFor(sessionId: string, toolUseId: string): string | undefined {
    const calls = this.#toolCalls.get(sessionId);
    const name = calls?.get(toolUseId);
    if (name !== undefined) {
      calls!.delete(toolUseId); // one result per call
      return name;
    }
    return this.#chat.toolName(sessionId, toolUseId) ?? undefined;
  }

  /** A sub-agent's label: its task's description when known, else the raw `parent_tool_use_id`. */
  #label(sessionId: string, toolUseId: string): string {
    const names = this.#names(sessionId);
    let label = names.get(toolUseId);
    if (label === undefined) {
      label = this.#chat.taskLabel(sessionId, toolUseId) ?? undefined;
      if (label) names.set(toolUseId, label);
    }
    return label ?? toolUseId;
  }

  /** Saves a tool's images as blobs; ones that don't check out (type, size, bytes) are left out. */
  #saveToolImages(sessionId: string, raw: RawImage[]): ChatImage[] {
    const out: ChatImage[] = [];
    for (const r of raw) {
      const image = decodeToolImage(r.mediaType, r.dataBase64);
      if (!image) continue;
      try {
        out.push(saveBlob(this.#store, sessionId, 'tool_image', null, image.mediaType, image.bytes));
      } catch {
        // the blob store is unavailable: the row still reads, without the image
      }
    }
    return out;
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
