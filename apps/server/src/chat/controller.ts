// Chat sessions: the controller (chat-sessions PRD milestones C1–C4). Owns the lifecycle of each
// session — launch the host process, follow its stdout, store the transcript, send input (with images),
// answer requests, change model/effort/ultracode/mode, track sub-agents — and dispatches live updates to
// whatever subscribes (the socket). All host access goes through short `workspaces.exec` calls into
// `cp-session`; the agent process itself stays detached in the workspace.
//
// Durability (PRD §8): `start()` reattaches to running processes after a portal restart and checks
// liveness every minute. A vanished process leaves the session Interrupted; Resume or the next message
// relaunches it with `--resume` on a fresh log segment and restores its settings. Idle sessions sleep and
// wake the same way. Integrity (§10.4): anything in the stream this portal didn't originate ends the
// session. Redaction (§13): stored text and live deltas pass through redact.ts. Folder trust (FR43): no
// process starts in a folder whose project settings would load something the person hasn't trusted.
//
// Credentials (§6): a session runs on one of two. On a workspace with an Account Pool, on the pool's keys
// (its managed `apiKeyHelper`): every create, launch, resume and wake needs an active, Synced assignment
// (the `eligibility` hook) and a passing `cp-session authcheck`; every turn's `system/init` must report
// the helper, and after every `result` a `get_usage` must show no plan limits, or the session ends.
// Without a pool, on its Claude's own sign-in: that Claude must be signed in (the `signedIn` hook, from
// `claude auth status`) before each start, and the pool checks don't apply. The portal never reads the
// login itself. Assigning, moving or unassigning a pool stops the workspace's sessions before it goes out
// (`endWorkspaceSessions`), so a session never changes credential mid-run.

import { randomUUID } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  CHAT_ENDED_CREDENTIAL,
  CHAT_ENDED_INTEGRITY,
  CHAT_SESSION_TITLE_MAX,
  type ChatControl,
  type ChatFolderScan,
  type ChatImage,
  type ChatInputState,
  type ChatModelOption,
  type ChatServerMessage,
  type ChatSession,
  type ChatTask,
  type ChatUsageReport,
  type CreateChatSessionRequest,
  type WorkspaceClaude,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { HOME, type ExecSession } from '../workspaces/runtime.js';
import { decodeAttachments, decodeToolImage, readBlob, saveBlob } from './blobs.js';
import { ineligibleError, NOT_SET_UP, NOT_SIGNED_IN, UNKNOWN, type Eligibility } from './eligibility.js';
import { workspacePath } from './files.js';
import { CP_SESSION_PATH, parseStartOutput } from './host.js';
import {
  allowResponse,
  controlRequest,
  CREDENTIAL,
  denyResponse,
  errorResponse,
  flagSettings,
  parseLine,
  pickApplied,
  pickModels,
  POOL_KEY_SOURCE,
  usageVerdict,
  userLine,
  type AppliedSettings,
  type ControlResponse,
  type ModelTotals,
  type ParsedLine,
  type RawImage,
  type StoredEvent,
} from './protocol.js';
import { redact, StreamRedactor } from './redact.js';
import { ChatStore, sessionCwd, type ChatSessionPatch, type ChatSessionRow, type InputState } from './store.js';
import { FOLDER_CHANGED, scanFolder, untrustedError } from './trust.js';
import { usageReport } from './usage.js';

/** The permission mode every process starts in (`--permission-mode`); others are applied after. */
const START_MODE = 'default';
/** The claude flags cp-session runs after `--`; `--resume` or `--session-id` plus the id are spliced in. */
const BASE_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', START_MODE];
const BUDGET_FLAGS = ['--max-budget-usd', '10'] as const;

/** How long a dropped `tail` waits before re-following, and how many immediate failures end the reader. */
const RETAIL_MS = 1_000;
const MAX_IMMEDIATE_RETRIES = 5;
/** A `tail` that ran at least this long counts as healthy (it hit its 600 s limit), so retries reset. */
const HEALTHY_TAIL_MS = 5_000;

/** How long a control request waits for Claude Code's `control_response`. */
const CONTROL_TIMEOUT_MS = 15_000;
/** How long one short `cp-session` command (start, send, status, stop) may take. */
const EXEC_TIMEOUT_MS = 30_000;
/** Idle this long, with nothing open or running, and a session's process sleeps (PRD FR38). */
const IDLE_SLEEP_MS = 30 * 60_000;
/** How often live sessions' processes are checked. */
const LIVENESS_MS = 60_000;

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
/** A sub-agent's task id as Claude Code reports it (e.g. `aae5b105d0089cda7`). */
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Keys of the portal's own control lines in `chat_inputs`: a request it asks, an answer it gives. */
const ASKED = (requestId: string) => `req/${requestId}`;
const ANSWERED = (requestId: string) => `ans/${requestId}`;

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
  /** True once the reader is deliberately stopped (end, integrity, sleep, a new process); never reused. */
  stopped: boolean;
  /** Consecutive immediate `tail` exits; reset when a follow makes progress or runs its full term. */
  retries: number;
  tailStart: number;
  timer?: NodeJS.Timeout;
  /** A `tail` exec is being opened (so a second one never is). */
  connecting?: boolean;
}

/** A control request waiting for its `control_response` (Claude Code's success or error reply). */
interface PendingControl {
  sessionId: string;
  resolve: (reply: ControlResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A control request Claude Code didn't answer in time (as opposed to one it refused, or one never sent). */
class ControlTimeout extends AppError {
  constructor() {
    super('SERVICE_UNAVAILABLE', 'Claude Code didn’t answer in time. Try again.', { expose: true });
  }
}

/** The permission mode the portal set or confirmed, and the changes Claude Code may make by itself. */
interface ModeTrack {
  expected: string;
  /** The mode before plan mode, which approving ExitPlanMode returns to. */
  prePlan: string | null;
  /** The agent called EnterPlanMode, which needs no approval: `plan` may follow. */
  enterPlan: boolean;
  /** The portal approved ExitPlanMode: leaving plan mode may follow. */
  exitPlan: boolean;
}

/** Values a resumed process gets back (it starts on defaults). */
interface Restore {
  model: string | null;
  effort: string | null;
  ultracode: boolean;
  mode: string;
}

interface LaunchOptions {
  /** Relaunch with `--resume` (Interrupted, or asleep). */
  resume?: boolean;
  /** The host was just brought up to date and passed its auth check, and the folder its trust check (a create). */
  checked?: boolean;
}

type Dispatch = (sessionId: string, msg: ChatServerMessage) => void;

export interface ChatControllerOptions {
  /** How long a live session sits idle, with nothing open or running, before its process sleeps. */
  idleSleepMs?: number;
  /** How often `start()`ed durability work checks live sessions' processes. */
  livenessMs?: number;
  /** How long one short `cp-session` command may run before it counts as failed. */
  execTimeoutMs?: number;
}

/** A refusal Claude Code sent, made safe to show: one line, no control characters, bounded, redacted. */
function cliMessage(error: string): string {
  // eslint-disable-next-line no-control-regex
  const text = redact(error.replace(/[\x00-\x1f\x7f]+/g, ' ').trim());
  if (!text) return 'Claude Code refused the request.';
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** An id read from the stream, made safe for a reason line: printable, short, redacted. */
function shortId(v: string): string {
  const s = redact(v.replace(/[^\x20-\x7e]+/g, '?'));
  return s.length > 64 ? `${s.slice(0, 63)}…` : s;
}

/**
 * The chat controller. Construct once, share it between the HTTP routes and the socket, and call
 * {@link start} once. Readers are kept alive even with no subscribers so the transcript is never missed.
 */
export class ChatController {
  readonly #store: Store;
  readonly #chat: ChatStore;
  readonly #workspaces: Workspaces;
  readonly #readers = new Map<string, Reader>();
  /** Per session, the latest main-thread API call's usage (for the context figure). */
  readonly #lastCall = new Map<string, { messageId: string | null; input: number; output: number }>();
  readonly #dispatchers = new Set<Dispatch>();
  /** Control requests in flight, by request_id. */
  readonly #pending = new Map<string, PendingControl>();
  /** Lifecycle work in flight (a launch, a sleep): sends and controls wait for it, and it's never doubled. Never rejects. */
  readonly #busy = new Map<string, Promise<void>>();
  /** Launches in flight: whoever asks for one meanwhile shares its outcome, a trust refusal included. */
  readonly #launching = new Map<string, Promise<void>>();
  /** Sessions whose current process has had its applied settings read (after its first `system/init`). */
  readonly #appliedRead = new Set<string>();
  /** Per session: a `Task` tool_use id → its sub-agent's description, to label that agent's lines. */
  readonly #agentNames = new Map<string, Map<string, string>>();
  /** Per session: tool calls still waiting for their result, tool_use id → tool name. */
  readonly #toolCalls = new Map<string, Map<string, string>>();
  /** Per session, per agent (`''` for the main thread): the open text block's redactor. */
  readonly #streams = new Map<string, Map<string, StreamRedactor>>();
  /** Per session, per agent ('' for the main one): when its open thinking block started (epoch ms). */
  readonly #thinkingSince = new Map<string, Map<string, number>>();
  /** Per session: the permission mode the stream must report. */
  readonly #modes = new Map<string, ModeTrack>();
  readonly #idleTimers = new Map<string, NodeJS.Timeout>();
  /** Per session: the running cost its process last reported, so each `result` can say what its turn cost. */
  readonly #costBase = new Map<string, number>();
  /** Per session: each model's running totals its process last reported, for each turn's usage metrics. */
  readonly #modelBase = new Map<string, Map<string, ModelTotals>>();
  /**
   * Per workspace: how many times its credentials began to change ({@link endWorkspaceSessions}). A
   * launch that began before the latest change gives up, and stops a process it already started.
   */
  readonly #epochs = new Map<string, number>();
  readonly #idleMs: number;
  readonly #livenessMs: number;
  #liveness?: NodeJS.Timeout;
  #started = false;
  #closed = false;
  #ticking = false;

  /** Installed by the owner: writes `cp-session` into the workspace before each `start`. */
  installHost?: (workspaceId: string) => Promise<void>;
  /**
   * Installed by the owner: whether a workspace may host sessions now (chat-sessions PRD §6 rule 1), from
   * portal state alone — an `active` Account Pool assignment whose delivery is `synced`
   * (`poolEligibility` in eligibility.ts). Asked before every create, launch, resume and wake; a refusal
   * is a 409 `CHAT_INELIGIBLE` carrying the reason, and nothing starts. Unset, every workspace is
   * eligible (tests); production always sets it.
   */
  eligibility?: (workspaceId: string) => Eligibility;
  /**
   * Installed by the owner: whether the workspace has an Account Pool assignment (in any state). With
   * one, its sessions run on the pool's keys and the pool checks apply; without, each runs on its
   * Claude's own sign-in. Unset, every workspace counts as pooled (tests).
   */
  pooled?: (workspaceId: string) => boolean;
  /**
   * Installed by the owner: whether a Claude's directory (`''` for Default) is signed in to Claude Code,
   * from `claude auth status` (status only). Asked before every start of a session on its Claude's own
   * sign-in. Unset, every Claude counts as signed in.
   */
  signedIn?: (workspaceId: string, directory: string) => Promise<boolean>;
  /** How long a control request waits for Claude Code's answer. */
  controlTimeoutMs = CONTROL_TIMEOUT_MS;
  /** How long one short `cp-session` command may run. */
  execTimeoutMs: number;

  constructor(store: Store, workspaces: Workspaces, opts: ChatControllerOptions = {}) {
    this.#store = store;
    this.#chat = new ChatStore(store);
    this.#workspaces = workspaces;
    this.#idleMs = opts.idleSleepMs ?? IDLE_SLEEP_MS;
    this.#livenessMs = opts.livenessMs ?? LIVENESS_MS;
    this.execTimeoutMs = opts.execTimeoutMs ?? EXEC_TIMEOUT_MS;
  }

  /* ---------- Durability ---------- */

  /**
   * Starts the background work; call once, after construction. Sessions whose process is still running
   * get their reader back (resuming from the stored byte offset), vanished ones become Interrupted, and
   * the same check repeats every minute. Idle sessions sleep from now on.
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#liveness = setInterval(() => void this.#tick(), this.#livenessMs);
    this.#liveness.unref?.();
    void this.#tick();
  }

  /** Stops the background work and the readers. The processes keep running; the next `start` reattaches. */
  stop(): void {
    this.#closed = true;
    if (this.#liveness) clearInterval(this.#liveness);
    this.#liveness = undefined;
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    for (const id of [...this.#readers.keys()]) this.#stopReader(id);
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new AppError('SERVICE_UNAVAILABLE', 'The portal is shutting down.', { expose: true }));
    }
  }

  /** A tab opened the session: a running process gets its reader if it lost it. */
  attach(sessionId: string): void {
    const row = this.#chat.row(sessionId);
    if (row && row.state !== 'ended' && row.process === 'live' && !this.#busy.has(sessionId)) this.#ensureReader(sessionId);
  }

  /** One liveness round over every session whose process should be running. */
  async #tick(): Promise<void> {
    if (this.#ticking || this.#closed) return;
    this.#ticking = true;
    try {
      await Promise.allSettled(this.#chat.liveRows().map((row) => this.#check(row)));
    } catch {
      // the store is unavailable: try again next round
    } finally {
      this.#ticking = false;
    }
  }

  /** A running process keeps (or gets back) its reader; a vanished one leaves the session Interrupted. */
  async #check(row: ChatSessionRow): Promise<void> {
    const id = row.id;
    if (this.#busy.has(id)) return; // a launch or sleep is deciding
    const status = await this.#status(row.workspace_id, id);
    if (status === 'unknown') return; // unreachable right now: ask again next round
    const now = this.#chat.row(id);
    // Act only on the process this check was about.
    if (!now || now.state === 'ended' || now.process !== 'live' || this.#busy.has(id) || now.segment !== row.segment || now.parent_pid !== row.parent_pid) return;
    if (status === 'gone') return this.#markGone(id);
    this.#ensureReader(id);
    this.#armIdle(id);
  }

  /** `cp-session status`: `live <pid>` or `gone`; anything else (unreachable, no host) is `unknown`. */
  async #status(workspaceId: string, sessionId: string): Promise<'live' | 'gone' | 'unknown'> {
    try {
      const { code, out } = await this.#runOnce(workspaceId, ['status', sessionId]);
      const word = out.trim().split(/\s+/)[0];
      if (word === 'live') return 'live';
      return word === 'gone' && code === 0 ? 'gone' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** The process vanished: the session is Interrupted (resumable) and what it was doing is over. */
  #markGone(sessionId: string, why = 'Claude Code stopped before it answered.'): void {
    this.#stopReader(sessionId);
    this.#forget(sessionId, why);
    this.#closeOut(sessionId);
    this.#chat.patchSession(sessionId, { process: 'gone', state: 'interrupted' });
    this.#emitSession(sessionId);
  }

  /** A process is over: its unfinished messages are discarded, its open requests expire, its tasks are killed. */
  #closeOut(sessionId: string): void {
    for (const uuid of this.#chat.discardOpenInputs(sessionId)) this.#emit(sessionId, { type: 'input', session: sessionId, uuid, state: 'discarded' });
    for (const requestId of this.#chat.expireOpenRequests(sessionId)) this.#append(sessionId, { kind: 'resolved', requestId, outcome: 'expired' });
    if (this.#chat.endRunningTasks(sessionId)) this.#emitTasks(sessionId);
  }

  /** (Re)schedules the idle check of a live, idle session; any other state cancels it. */
  #armIdle(sessionId: string): void {
    const old = this.#idleTimers.get(sessionId);
    if (old) clearTimeout(old);
    this.#idleTimers.delete(sessionId);
    if (!this.#started || this.#closed) return;
    const row = this.#chat.row(sessionId);
    if (!row || row.state !== 'idle' || row.process !== 'live') return;
    const wait = Math.max(0, this.#idleSince(row) + this.#idleMs - Date.now());
    const timer = setTimeout(() => {
      this.#idleTimers.delete(sessionId);
      try {
        this.#maybeSleep(sessionId);
      } catch {
        // the store went away (shutdown)
      }
    }, wait + 5);
    timer.unref?.();
    this.#idleTimers.set(sessionId, timer);
  }

  #idleSince(row: ChatSessionRow): number {
    const t = Math.max(Date.parse(row.state_since), Date.parse(row.last_activity_at));
    return Number.isFinite(t) ? t : Date.now();
  }

  #maybeSleep(sessionId: string): void {
    if (this.#closed || this.#busy.has(sessionId)) return;
    const row = this.#chat.row(sessionId);
    if (!row || row.state !== 'idle' || row.process !== 'live') return;
    if (Date.now() < this.#idleSince(row) + this.#idleMs) return this.#armIdle(sessionId); // active since: wait out the rest
    if (!this.#canSleep(sessionId)) return; // still busy; the next change or liveness round re-arms
    const op = this.#sleep(sessionId, row).finally(() => this.#busy.delete(sessionId));
    this.#busy.set(sessionId, op);
  }

  /** Nothing sleeping would lose: no open request, running task, unfinished message or control in flight. */
  #canSleep(sessionId: string): boolean {
    if (this.#chat.openRequests(sessionId).length || this.#chat.hasRunningTasks(sessionId) || this.#chat.hasOpenInputs(sessionId)) return false;
    for (const pending of this.#pending.values()) if (pending.sessionId === sessionId) return false;
    return true;
  }

  /** Stops an idle process; the session reads Idle (asleep) and the next message or Resume wakes it. */
  async #sleep(sessionId: string, row: ChatSessionRow): Promise<void> {
    let code: number | null;
    try {
      ({ code } = await this.#runOnce(row.workspace_id, ['stop', sessionId]));
    } catch {
      return; // unreachable: the liveness round decides
    }
    const now = this.#chat.row(sessionId);
    if (code !== 0 || !now || now.state === 'ended' || now.process !== 'live') return;
    this.#stopReader(sessionId);
    this.#forget(sessionId, 'The session went to sleep.');
    this.#chat.patchSession(sessionId, { process: 'asleep' });
    this.#emitSession(sessionId);
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

  /**
   * Creates a session and starts its process in the background. The workspace must be eligible (§6
   * rule 1: a 409 `CHAT_INELIGIBLE` with the reason otherwise, before anything runs there), its credential
   * must check out (the same 409: on a pool, `authcheck` names its helper; without one, the Claude is
   * signed in), and the
   * folder is checked (FR43): when its project settings would load something the person hasn't trusted
   * at this exact hash, this throws a 409 `FOLDER_UNTRUSTED` carrying the scan. Refused, nothing is created.
   */
  async create(req: Partial<CreateChatSessionRequest>): Promise<ChatSession> {
    const workspaceId = typeof req.workspaceId === 'string' ? req.workspaceId.trim() : '';
    if (!workspaceId) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    const [target] = this.#split(workspaceId);
    if (!this.#workspaces.runtimeFor(target)) throw new AppError('VALIDATION_FAILED', `No target “${target}”.`, { details: { workspaceId: 'Unknown target.' } });
    const cwd = this.#folder(req.cwd);
    const title = (typeof req.title === 'string' && req.title.trim() ? req.title.trim() : 'New session').slice(0, CHAT_SESSION_TITLE_MAX);
    this.#requireEligible(workspaceId);
    const claude = typeof req.claudeId === 'string' && req.claudeId.trim() ? this.#chat.claude(req.claudeId.trim()) : this.#chat.ensureDefault(workspaceId);
    if (!claude || claude.workspaceId !== workspaceId || claude.removedAt) {
      throw new AppError('VALIDATION_FAILED', 'Pick a Claude on this workspace.', { details: { claudeId: 'Unknown Claude.' } });
    }
    // The checks need the current host. If it can't be installed, the session is created anyway and its
    // launch tries again: failing, it ends with the reason, and nothing starts unchecked either way.
    let installed = true;
    if (this.installHost) await this.installHost(workspaceId).catch(() => void (installed = false));
    if (installed) {
      const refused = await this.#credentialCheck(workspaceId, claude.id);
      if (refused) throw ineligibleError(refused);
      const scan = await this.#scan(workspaceId, cwd);
      if (!scan.empty && !scan.trusted) throw untrustedError(scan, this.#chat.folderTrust(workspaceId, scan.folder) !== null);
    }
    // Asked again: the pool may have changed while the host was checked. The launch asks once more.
    this.#requireEligible(workspaceId);
    const id = randomUUID();
    const session = this.#chat.create({ id, workspaceId, cwd, title, origin: 'ui', claudeId: claude.id });
    void this.#startProcess(id, { checked: installed }).catch(() => undefined);
    return session;
  }

  /** Claudes on a workspace. Default is created on first read and keeps the original home. */
  listClaudes(workspaceId: string): WorkspaceClaude[] {
    const id = workspaceId.trim();
    if (!id) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    this.#split(id);
    return this.#chat.listClaudes(id);
  }

  /**
   * Adds an empty Claude directory on the workspace volume. Does not sign in and does not copy a login.
   * The workspace must be running so the directory can be created.
   */
  async createClaude(workspaceId: string, rawName: string): Promise<WorkspaceClaude> {
    const id = workspaceId.trim();
    const name = rawName.trim();
    if (!id) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) {
      throw new AppError('VALIDATION_FAILED', 'Use a short name: letters, numbers, spaces, dots, _ or -.', { details: { name: 'Invalid name.' } });
    }
    this.#split(id);
    this.#chat.ensureDefault(id);
    let created: { id: string; directory: string };
    try {
      created = this.#chat.addClaude(id, name);
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('CONFLICT', 'A Claude with that name is already on this workspace.');
      throw e;
    }
    try {
      // Under the workspace user's own $HOME: /home/node in workspace images, the portal user's home on this machine.
      await this.#shell(id, ['sh', '-c', 'mkdir -p -- "$HOME/.claudepilot/$1"', 'sh', created.directory]);
    } catch (e) {
      this.#chat.removeClaudeRow(created.id);
      throw new AppError('SERVICE_UNAVAILABLE', 'Couldn’t create the Claude directory. Is the workspace running?', { expose: true, cause: e });
    }
    return this.#chat.claude(created.id)!;
  }

  /** Renames a Claude (FR3): the label only. */
  renameClaude(workspaceId: string, claudeId: string, rawName: string): WorkspaceClaude {
    const claude = this.#ownClaude(workspaceId, claudeId);
    const name = rawName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) {
      throw new AppError('VALIDATION_FAILED', 'Use a short name: letters, numbers, spaces, dots, _ or -.', { details: { name: 'Invalid name.' } });
    }
    try {
      this.#chat.renameClaude(claude.id, name);
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('CONFLICT', 'A Claude with that name is already on this workspace.');
      throw e;
    }
    return this.#chat.claude(claude.id)!;
  }

  /**
   * Removes a Claude (FR3): refused for Default and while a session on it hasn't ended. Its rows and
   * its directory stay: the portal doesn't delete a directory that may hold a login.
   */
  removeClaude(workspaceId: string, claudeId: string): void {
    const claude = this.#ownClaude(workspaceId, claudeId);
    if (!claude.directory) throw new AppError('CONFLICT', 'Default can’t be removed.');
    if (this.#chat.openSessionsOnClaude(claude.workspaceId, claude.id, false) > 0)
      throw new AppError('CONFLICT', `${claude.name} has a session that hasn’t ended. End it first.`);
    this.#chat.markClaudeRemoved(claude.id);
  }

  /** A Claude of this workspace that isn't removed. */
  #ownClaude(workspaceId: string, claudeId: string): WorkspaceClaude {
    const claude = this.listClaudes(workspaceId).find((c) => c.id === claudeId && !c.removedAt);
    if (!claude) throw new AppError('NOT_FOUND', 'That Claude isn’t on this workspace.');
    return claude;
  }

  /**
   * Confirmed context move (Workspace Claudes FR9–FR16). Stops the source, writes a context file from
   * portal events, and starts a new session in the destination Claude. Does not copy a login.
   */
  async transfer(sessionId: string, destClaudeId: string): Promise<ChatSession> {
    const source = this.#require(sessionId);
    if (source.state === 'ended' && source.endedReason !== 'transferred') throw new AppError('CONFLICT', 'This session has ended.');
    const dest = this.#chat.claude(destClaudeId.trim());
    if (!dest || dest.workspaceId !== source.workspaceId || dest.removedAt) {
      throw new AppError('VALIDATION_FAILED', 'Pick a Claude on this workspace.', { details: { claudeId: 'Unknown Claude.' } });
    }
    if (dest.id === source.claudeId) throw new AppError('VALIDATION_FAILED', 'That session is already on this Claude.');
    const row = this.#chat.row(sessionId);
    if (row?.process === 'live') await this.#runOnce(source.workspaceId, ['stop', sessionId]).catch(() => undefined);
    const summary = redact(this.#chat.contextSummary(sessionId));
    const handoffId = randomUUID();
    const path = `${HOME}/.claudepilot/transfer/${handoffId}.md`;
    const from = source.claudeName ?? 'Claude';
    const body = `# Transferred from ${from}\n\n${summary || '(no messages yet)'}\n`;
    await this.#shellWrite(source.workspaceId, `${HOME}/.claudepilot/transfer`, path, body);
    const sourceClaudeId = source.claudeId || this.#chat.ensureDefault(source.workspaceId).id;
    this.#chat.saveHandoff({ id: handoffId, workspaceId: source.workspaceId, sourceSessionId: source.id, sourceClaudeId, destClaudeId: dest.id, path });
    const successorId = randomUUID();
    const successor = this.#chat.create({
      id: successorId,
      workspaceId: source.workspaceId,
      cwd: source.cwd,
      title: source.title,
      origin: source.origin,
      claudeId: dest.id,
      predecessorId: source.id,
    });
    this.#chat.setHandoffSuccessor(handoffId, successor.id);
    this.#chat.patchSession(source.id, { state: 'ended', process: 'gone', endedReason: 'transferred', successorId: successor.id });
    const when = new Date().toISOString().slice(11, 16);
    this.#append(successor.id, { kind: 'system', text: `New session on ${dest.name} · transferred from ${from} · ${when}` });
    this.#emitSession(source.id);
    const opening = `Context transferred from ${from}. Continue from this summary. This is prior context, not a new request.\n\n${summary || '(no messages yet)'}`;
    void this.#startProcess(successor.id)
      .then(() => this.send(successor.id, randomUUID(), opening))
      .catch(() => undefined);
    return this.#chat.get(successor.id)!;
  }

  /** Runs a short command in the workspace. The arguments are passed as argv, never through a shell string. */
  async #shell(workspaceId: string, command: string[]): Promise<void> {
    const [target, name] = this.#split(workspaceId);
    const exec = await this.#workspaces.exec(target, name, command);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        exec.close();
        reject(new Error('The workspace took too long.'));
      }, this.execTimeoutMs);
      exec.onExit((code) => {
        clearTimeout(timer);
        exec.close();
        if (code === 0) resolve();
        else reject(new Error(`Command failed (${code ?? 'no exit'}).`));
      });
    });
  }

  /** Writes `body` to `path` under the transfer directory. `body` is stdin, not a shell argument. */
  async #shellWrite(workspaceId: string, dir: string, path: string, body: string): Promise<void> {
    if (!path.startsWith(`${dir}/`) || path.includes('..')) throw new AppError('VALIDATION_FAILED', 'That transfer path is not allowed.');
    const [target, name] = this.#split(workspaceId);
    const bytes = Buffer.byteLength(body);
    const exec = await this.#workspaces.exec(target, name, ['sh', '-c', 'mkdir -p -- "$1" && head -c "$3" > "$2"', 'sh', dir, path, String(bytes)]);
    if (bytes) exec.write(body);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        exec.close();
        reject(new Error('The workspace took too long.'));
      }, this.execTimeoutMs);
      exec.onExit((code) => {
        clearTimeout(timer);
        exec.close();
        if (code === 0) resolve();
        else reject(new Error(`Couldn’t write the context file (${code ?? 'no exit'}).`));
      });
    });
  }

  /**
   * Sends a message. While Claude works, `priority` `next` steers the running turn and `later` waits
   * for it to end; `command_lifecycle` then reports where it is (`input` messages). Attached images are
   * checked, kept in the blob store, and sent inline; the transcript keeps only their references. An
   * Interrupted or sleeping session is resumed first.
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
    // Claude Code echoes every answer it reads; the answer is on record first, so the echo matches it.
    this.#chat.addControl(sessionId, ANSWERED(requestId));
    // Approving ExitPlanMode lets Claude Code leave plan mode by itself.
    const exitPlan = decision !== 'deny' && open.toolName === 'ExitPlanMode';
    if (exitPlan) this.#mode(sessionId).exitPlan = true;
    try {
      await this.#writeLine(sessionId, line);
    } catch (e) {
      // It never arrived: Claude Code is still waiting, so the request is open again.
      this.#chat.setControlState(sessionId, ANSWERED(requestId), 'failed');
      if (exitPlan) this.#mode(sessionId).exitPlan = false;
      this.#chat.reopenRequest(sessionId, requestId);
      this.#append(sessionId, { kind: 'error', text: `Your answer didn't reach Claude Code: ${(e as Error).message}` });
      this.#append(sessionId, { kind: 'request', requestId, request: open });
      this.#chat.patchSession(sessionId, { state: 'waiting' });
      this.#emitSession(sessionId);
      throw e;
    }
  }

  /**
   * One session control. `stop` interrupts the turn and `end` closes the session; `model`, `effort`,
   * `ultracode` and `mode` change what applies from Claude Code's next request (the session then shows
   * the applied values); `cancel_queued` withdraws a queued message; `resume` relaunches an Interrupted
   * or sleeping session; `stop_task` stops one sub-agent or background task.
   */
  async control(sessionId: string, op: ChatControl['op'], args?: ChatControl['args']): Promise<void> {
    const a: NonNullable<ChatControl['args']> = args && typeof args === 'object' ? args : {};
    switch (op) {
      case 'stop':
        return this.interrupt(sessionId);
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
      case 'resume':
        return this.#resume(sessionId);
      case 'stop_task':
        return this.#stopTask(sessionId, a.taskId);
      default:
        throw new AppError('VALIDATION_FAILED', 'Unknown control.');
    }
  }

  /** Interrupt the running turn: a plain `interrupt` control request (Stop never sends a signal). */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    if (session.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    await this.#busy.get(sessionId);
    if (this.#chat.row(sessionId)?.process !== 'live') return; // nothing is running
    await this.#request(sessionId, 'interrupt');
  }

  /** End the session: SIGTERM the process group, stop the reader, mark it ended. An ended session stays as it is. */
  async end(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    if (session.state === 'ended') return; // already over, and its reason (an integrity end, say) stays
    this.#stopReader(sessionId);
    this.#forget(sessionId, 'The session ended.');
    await this.#runOnce(session.workspaceId, ['stop', sessionId]).catch(() => undefined);
    this.#closeOut(sessionId);
    this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: 'closed by operator' });
    this.#emitSession(sessionId);
  }

  /**
   * Archive (FR4): hides the session from the list. One that hasn't ended is ended first, the same as
   * End, so nothing archived keeps running. Its transcript stays; Unarchive brings it back, ended.
   */
  async archive(sessionId: string): Promise<ChatSession> {
    const session = this.#require(sessionId);
    if (session.state !== 'ended') await this.end(sessionId);
    if (!session.archivedAt) this.#chat.patchSession(sessionId, { archivedAt: new Date().toISOString() });
    this.#emitSession(sessionId);
    return this.#chat.get(sessionId)!;
  }

  /** Brings an archived session back to the list. */
  unarchive(sessionId: string): ChatSession {
    this.#require(sessionId);
    this.#chat.patchSession(sessionId, { archivedAt: null });
    this.#emitSession(sessionId);
    return this.#chat.get(sessionId)!;
  }

  /**
   * Stops a workspace's sessions before its credentials change (§6 rule 2): Account Pool calls this at
   * the start of an unassign or a move to another pool, before the change goes out, so no session ever
   * runs on whatever would come after the pool's helper. Every running process gets `cp-session stop`
   * and its session reads Interrupted with `reason` (its unfinished messages discarded, open requests
   * expired, sub-agents killed); a launch in flight gives up, stopping its process if it got that far.
   * Sleeping and interrupted sessions have nothing running. The sessions resume like any Interrupted
   * one, once the eligibility check passes again (the new assignment active and Synced).
   *
   * Everything on the portal's side happens before this returns, the stop commands included (they're on
   * their way to the workspace); the promise settles once each has finished or failed.
   */
  endWorkspaceSessions(workspaceId: string, reason: string): Promise<void> {
    this.#epochs.set(workspaceId, this.#epoch(workspaceId) + 1);
    const stops: Promise<unknown>[] = [];
    for (const row of this.#chat.workspaceRows(workspaceId)) {
      if (row.process !== 'live' && !this.#launching.has(row.id)) continue;
      this.#stopReader(row.id);
      this.#forget(row.id, reason);
      this.#closeOut(row.id);
      this.#chat.patchSession(row.id, { state: 'interrupted', process: 'gone', endedReason: reason });
      this.#note(row.id, `Session stopped: ${reason}`);
      this.#emitSession(row.id);
      stops.push(this.#runOnce(workspaceId, ['stop', row.id]).catch(() => undefined));
    }
    return Promise.all(stops).then(() => undefined);
  }

  /** Resume: an Interrupted or sleeping session relaunches with `--resume`; a running one is left as it is. */
  async #resume(sessionId: string): Promise<void> {
    this.#require(sessionId);
    await this.#live(sessionId);
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
    // The reply confirms the mode as it's read (see #acceptControlResponse), before any status line.
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
    await this.#busy.get(sessionId);
    const row = this.#chat.row(sessionId);
    if (!row || row.state === 'ended' || row.process !== 'live') {
      this.#setInput(sessionId, uuid, 'cancelled'); // its process, and the queue with it, is gone: it will never run
      return;
    }
    const reply = await this.#request(sessionId, 'cancel_async_message', { message_uuid: uuid });
    if (reply.cancelled !== true) throw new AppError('CONFLICT', 'Claude already read that message.');
    this.#setInput(sessionId, uuid, 'cancelled');
  }

  /**
   * Stops one running sub-agent or background task (`stop_task`) and waits for Claude Code's reply; a
   * refusal comes back as its message. Claude Code reports the task stopped on the stream, which the task
   * list follows. One that already ended, or whose process is gone, needs nothing (it's never resumed for this).
   */
  async #stopTask(sessionId: string, taskId: unknown): Promise<void> {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!TASK_ID.test(id)) throw new AppError('VALIDATION_FAILED', 'Say which sub-agent to stop.');
    this.#require(sessionId);
    const task = this.#chat.tasks(sessionId).find((t) => t.taskId === id);
    if (!task) throw new AppError('NOT_FOUND', 'No such sub-agent.');
    if (task.status !== 'running') return;
    await this.#busy.get(sessionId);
    const row = this.#chat.row(sessionId);
    if (!row || row.state === 'ended' || row.process !== 'live') return;
    await this.#request(sessionId, 'stop_task', { task_id: id });
  }

  /* ---------- Host process ---------- */

  /**
   * Launches (or resumes) the session's process; lifecycle work already in flight is shared, never
   * doubled. Rejects when a check refuses the launch: the folder's trust (409 `FOLDER_UNTRUSTED`), or the
   * workspace's eligibility or host auth check (409 `CHAT_INELIGIBLE`).
   */
  #startProcess(sessionId: string, opts: LaunchOptions = {}): Promise<void> {
    const launching = this.#launching.get(sessionId);
    if (launching) return launching;
    const inFlight = this.#busy.get(sessionId);
    if (inFlight) return inFlight;
    const launch = this.#launch(sessionId, opts).finally(() => {
      this.#busy.delete(sessionId);
      this.#launching.delete(sessionId);
    });
    this.#launching.set(sessionId, launch);
    // Whoever only waits for lifecycle work (Stop, a liveness round) needs it settled, not its refusal.
    this.#busy.set(sessionId, launch.catch(() => undefined));
    return launch;
  }

  async #launch(sessionId: string, opts: LaunchOptions): Promise<void> {
    const row = this.#chat.row(sessionId);
    if (!row || row.state === 'ended') return;
    const workspaceId = row.workspace_id;
    // Ended meanwhile, or the workspace's credentials began to change (which settled the session): stop here.
    const epoch = this.#epoch(workspaceId);
    const cancelled = () => this.#epoch(workspaceId) !== epoch || this.#chat.row(sessionId)?.state === 'ended';
    // A relaunch starts on defaults: these go back once it runs.
    const restore: Restore | null = opts.resume ? { model: row.model, effort: row.effort, ultracode: row.ultracode === 1, mode: row.mode } : null;
    // The folder it's scanned in is the folder it runs in (and the one the session reports).
    const cwd = sessionCwd(row.cwd);

    // §6 rule 1: the workspace may host sessions now, before anything runs in it.
    this.#requireEligible(workspaceId, sessionId);

    if (this.installHost && !opts.checked) {
      try {
        await this.installHost(workspaceId);
      } catch (e) {
        if (cancelled()) return;
        this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason: this.#message(e) });
        this.#emitSession(sessionId);
        return;
      }
      if (cancelled()) return;
    }

    if (!opts.checked) {
      let refused: string | null;
      let scan: ChatFolderScan | undefined;
      try {
        // The credential first: a workspace not set up for it never gets the trust sheet.
        refused = await this.#credentialCheck(workspaceId, row.claude_id ?? null);
        if (!refused && !cancelled()) scan = await this.#scan(workspaceId, cwd);
      } catch (e) {
        // The workspace couldn't be checked (unreachable, the folder gone): nothing starts, and like a
        // start that failed, the session reads Interrupted and a later send can resume it.
        if (cancelled()) return;
        this.#chat.patchSession(sessionId, { state: 'interrupted', process: 'gone', endedReason: this.#message(e) });
        this.#emitSession(sessionId);
        return;
      }
      if (cancelled()) return;
      if (refused) this.#refuse(sessionId, ineligibleError(refused));
      if (scan && !scan.empty && !scan.trusted) this.#refuseLaunch(sessionId, row, scan);
    }

    // Asked again at the last moment: the assignment or its delivery may have changed meanwhile.
    this.#requireEligible(workspaceId, sessionId);

    // One log segment per process: a relaunch never appends to (or re-reads) the previous one's log.
    const seg = opts.resume || row.process_started_at !== null ? row.segment + 1 : row.segment;
    // `--resume` needs Claude Code's transcript, which exists once a turn has started (the first
    // `system/init`, stored as "Ready"); until then the id is unused and the session starts afresh.
    const resume = opts.resume === true && this.#chat.hasReady(sessionId);
    // The spending cap is for the pool's keys; a Claude's own sign-in has its plan's limits instead.
    const flags = [...BASE_FLAGS, resume ? '--resume' : '--session-id', sessionId, ...(this.#viaPool(workspaceId) ? BUDGET_FLAGS : [])];
    let code: number | null;
    let out: string;
    try {
      ({ code, out } = await this.#runOnce(workspaceId, ['start', sessionId, String(seg), cwd, '--', ...flags], undefined, this.#chat.configDir(row.claude_id ?? '')));
    } catch (e) {
      if (cancelled()) return;
      // The workspace is unreachable or stopped: nothing started, but a later send can resume it.
      this.#chat.patchSession(sessionId, { state: 'interrupted', process: 'gone', endedReason: this.#message(e) });
      this.#emitSession(sessionId);
      return;
    }

    if (cancelled()) {
      // Ended, or the credentials began to change, while it launched: leave no process behind.
      if (code === 0) await this.#runOnce(workspaceId, ['stop', sessionId]).catch(() => undefined);
      return;
    }
    if (code === 0) {
      const started = parseStartOutput(out);
      // A new process: nothing of the previous one carries over, and its reader must not read this log.
      this.#stopReader(sessionId);
      this.#forget(sessionId, 'Claude Code restarted.');
      this.#chat.patchSession(sessionId, {
        parentPid: started?.pid ?? null,
        processStartedAt: started?.startedAt ?? null,
        process: 'live',
        state: 'idle',
        segment: seg,
        byteOffset: 0,
        endedReason: null,
      });
      this.#modes.set(sessionId, { expected: START_MODE, prePlan: null, enterPlan: false, exitPlan: false });
      this.#costBase.set(sessionId, 0); // a new process counts its cost from zero
      this.#modelBase.set(sessionId, new Map());
    } else if (code === 3) {
      // Already running (run.lock held): attach to the existing process on its current segment.
      this.#chat.patchSession(sessionId, { process: 'live', state: 'idle', endedReason: null });
    } else {
      this.#chat.patchSession(sessionId, { state: 'interrupted', process: 'gone', endedReason: `the session host could not start (exit ${code ?? 'unknown'})` });
      this.#emitSession(sessionId);
      return;
    }
    this.#emitSession(sessionId);
    this.#ensureReader(sessionId);
    if (restore && code === 0) await this.#restore(sessionId, restore);
  }

  /**
   * A launch the folder's trust check refused (FR43): nothing starts, and the caller gets the 409 with
   * the scan. When the files changed since the folder was trusted, the transcript says so (once).
   */
  #refuseLaunch(sessionId: string, row: ChatSessionRow, scan: ChatFolderScan): never {
    const changed = this.#chat.folderTrust(row.workspace_id, scan.folder) !== null;
    if (changed) this.#appendOnce(sessionId, { kind: 'error', text: FOLDER_CHANGED });
    this.#refuse(sessionId, untrustedError(scan, changed));
  }

  /**
   * A launch refused before anything started (trust, eligibility, the host's auth check): the caller gets
   * `error`. A first launch, which never ran, reads Interrupted with its reason; a resume or wake leaves
   * the session as it was.
   */
  #refuse(sessionId: string, error: AppError): never {
    if (this.#chat.row(sessionId)?.process === 'live') {
      this.#chat.patchSession(sessionId, { state: 'interrupted', process: 'gone', endedReason: error.message });
      this.#emitSession(sessionId);
    }
    throw error;
  }

  /**
   * §6 rule 1, from portal state: throws the 409 `CHAT_INELIGIBLE` with the hook's reason unless the
   * workspace may host sessions now. With a session (a launch), that launch is refused like any other.
   */
  #requireEligible(workspaceId: string, sessionId?: string): void {
    let verdict: Eligibility = { ok: true };
    try {
      if (this.eligibility) verdict = this.eligibility(workspaceId);
    } catch {
      verdict = { ok: false, reason: UNKNOWN }; // can't tell: nothing starts
    }
    if (verdict.ok) return;
    const error = ineligibleError(verdict.reason);
    if (sessionId) this.#refuse(sessionId, error);
    throw error;
  }

  #epoch(workspaceId: string): number {
    return this.#epochs.get(workspaceId) ?? 0;
  }

  /**
   * After a resume or wake: put back the session's model, effort, ultracode and mode (never Bypass),
   * skipping values that are unset, default, or already apply, then read what applies. A failure leaves a
   * note and never fails the launch.
   */
  async #restore(sessionId: string, r: Restore): Promise<void> {
    const mode = r.mode !== START_MODE && MODES.has(r.mode);
    if (!r.model && !r.effort && !r.ultracode && !mode) {
      await this.#refreshApplied(sessionId).catch(() => undefined); // nothing to put back: just show what applies
      return;
    }
    const now = await this.#request(sessionId, 'get_settings').then(pickApplied, () => null);
    const failed: string[] = [];
    if (r.model && now?.model !== r.model) await this.#request(sessionId, 'set_model', { model: r.model }).catch(() => failed.push('model'));
    const settings: { effort?: string; ultracode?: boolean } = {};
    if (r.effort && now?.effort !== r.effort) settings.effort = r.effort;
    if (r.ultracode && now?.ultracode !== true) settings.ultracode = true;
    if (settings.effort !== undefined || settings.ultracode !== undefined)
      await this.#request(sessionId, 'apply_flag_settings', { settings: flagSettings(settings) }).catch(() => failed.push(settings.ultracode ? 'effort and ultracode' : 'effort'));
    if (mode) {
      try {
        const reply = await this.#request(sessionId, 'set_permission_mode', { mode: r.mode });
        const applied = typeof reply.mode === 'string' && reply.mode ? reply.mode : r.mode;
        if (applied !== 'bypassPermissions') this.#chat.patchSession(sessionId, { mode: applied });
      } catch {
        failed.push('mode');
      }
    }
    await this.#refreshApplied(sessionId).catch(() => undefined);
    // A process stopped meanwhile (ended, a pool change) failed them all: nothing worth a note.
    if (failed.length && this.#isLive(sessionId)) this.#note(sessionId, `Couldn’t restore the ${failed.join(', ')} after resuming.`);
  }

  /** Makes sure there is a running process to talk to: waits out work in flight, resumes or wakes one that isn't running. */
  async #live(sessionId: string): Promise<void> {
    await this.#busy.get(sessionId);
    let row = this.#chat.row(sessionId);
    if (row && row.state !== 'ended' && row.process !== 'live') {
      await this.#startProcess(sessionId, { resume: true });
      row = this.#chat.row(sessionId);
    }
    if (!row || row.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    if (row.process !== 'live')
      throw new AppError('SERVICE_UNAVAILABLE', row.ended_reason ? `Couldn’t resume the session: ${row.ended_reason}` : 'Couldn’t resume the session.', { expose: true });
  }

  #ensureReader(sessionId: string): void {
    let reader = this.#readers.get(sessionId);
    if (reader) {
      if (reader.exec || reader.connecting || reader.timer || reader.stopped) return; // already following, opening, scheduled, or stopped
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
    reader.connecting = true;
    try {
      const [target, name] = this.#split(row.workspace_id);
      exec = await this.#workspaces.exec(target, name, ['sh', CP_SESSION_PATH, 'tail', reader.sessionId, String(row.segment), String(reader.offset)]);
    } catch {
      reader.connecting = false;
      this.#scheduleRetail(reader); // workspace briefly unreachable; try again shortly
      return;
    }
    reader.connecting = false;
    if (reader.stopped) return void exec.close();
    reader.exec = exec;
    exec.onData((b) => this.#onBytes(reader, b));
    exec.onExit(() => this.#onTailExit(reader));
  }

  #onBytes(reader: Reader, chunk: Buffer): void {
    let start = 0;
    let nl: number;
    let unsaved = false;
    // A stopped reader takes no further line, not even the rest of this chunk.
    while (!reader.stopped && (nl = chunk.indexOf(0x0a, start)) >= 0) {
      const tail = chunk.subarray(start, nl + 1);
      const lineBuf = reader.partial.length ? Buffer.concat([...reader.partial, tail]) : tail;
      reader.partial = [];
      start = nl + 1;
      reader.offset += lineBuf.length;
      reader.retries = 0; // progress: the follow is healthy
      const offset = reader.offset;
      unsaved = true;
      try {
        // The line's effects and its byte offset commit together, so a restart never applies it twice.
        this.#chat.transaction(
          () => this.#handleLine(reader, lineBuf.toString('utf8')),
          () => {
            this.#chat.patchSession(reader.sessionId, { byteOffset: offset });
            unsaved = false;
          },
        );
      } catch (e) {
        // One line the store couldn't take: skip it rather than stall the session.
        console.error(`[chat] skipped a line of session ${reader.sessionId}: ${this.#message(e)}`);
      }
    }
    if (reader.stopped) return;
    if (start < chunk.length) reader.partial.push(chunk.subarray(start));
    // Lines that changed nothing (live deltas) move the cursor once per chunk.
    if (unsaved) this.#chat.patchSession(reader.sessionId, { byteOffset: reader.offset });
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
    const status = await this.#status(row.workspace_id, reader.sessionId);
    if (reader.stopped || this.#readers.get(reader.sessionId) !== reader) return; // replaced meanwhile
    if (status === 'gone') return this.#markGone(reader.sessionId);
    this.#scheduleRetail(reader); // live, or unreachable (which runs out of retries if it stays so)
  }

  #scheduleRetail(reader: Reader): void {
    if (reader.stopped || reader.timer) return;
    if (reader.retries >= MAX_IMMEDIATE_RETRIES) return this.#markGone(reader.sessionId, 'Lost touch with Claude Code before it answered.');
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

    // Integrity (PRD §10.4): the stream may show only what this portal started.
    if (parsed.sessionIdSeen && parsed.sessionIdSeen !== sessionId) return void this.#endIntegrity(sessionId, `the agent reported a different session id (${shortId(parsed.sessionIdSeen)})`);
    // Credentials (§6 rules 1 and 3), on a pool: every turn on its helper, and never plan limits. The source
    // Claude Code reported is only compared, never kept. On a Claude's own sign-in both are its own.
    if ((parsed.apiKeySource !== undefined || parsed.rateLimitEvent) && this.#viaPool(this.#chat.row(sessionId)?.workspace_id ?? '')) {
      if (parsed.apiKeySource !== undefined && parsed.apiKeySource !== POOL_KEY_SOURCE) return void this.#endCredential(sessionId, CREDENTIAL.keySource);
      if (parsed.rateLimitEvent) return void this.#endCredential(sessionId, CREDENTIAL.planLimits);
    }
    if (parsed.controlResponse && !this.#acceptControlResponse(sessionId, parsed.controlResponse)) return;
    if (parsed.replay && !this.#acceptReplay(sessionId, parsed.replay)) return;
    if (parsed.commandUuid && !this.#chat.isMessage(sessionId, parsed.commandUuid))
      return void this.#endIntegrity(sessionId, `Claude Code queued a message this portal didn't send (${shortId(parsed.commandUuid)})`);
    if (parsed.enterPlan) this.#mode(sessionId).enterPlan = true;
    if (parsed.modeSeen !== undefined && !this.#acceptMode(sessionId, parsed.modeSeen)) return;

    if (parsed.controlError) this.#refuseControl(sessionId, parsed.controlError);

    // Sub-agent names first, so this line's own events can already use them.
    for (const a of parsed.agents ?? []) this.#names(sessionId).set(a.toolUseId, a.description);
    if (parsed.tasks?.length) {
      for (const t of parsed.tasks) {
        this.#chat.upsertTask(sessionId, t);
        if (t.toolUseId && t.description) this.#names(sessionId).set(t.toolUseId, t.description);
      }
      this.#emitTasks(sessionId);
      this.#armIdle(sessionId); // a task that ended may be what kept it awake
    }

    // A finished block replaces its live text: what was held back goes out (redacted) just before it.
    this.#flushFor(sessionId, parsed);

    for (const ev of parsed.stored) {
      if (parsed.init && ev.kind === 'system') {
        if (reader.ready) continue; // the "Ready" note is stored once
        reader.ready = true;
      }
      if (ev.parentToolUseId) ev.agentLabel = this.#label(sessionId, ev.parentToolUseId);
      // "Thought for 12 s": timed from the block's start in the stream, when the portal saw it.
      if (ev.kind === 'thinking') {
        const since = this.#thinkingSince.get(sessionId);
        const started = since?.get(ev.parentToolUseId ?? '');
        if (started !== undefined) {
          ev.durationMs = Math.max(0, Date.now() - started);
          since!.delete(ev.parentToolUseId ?? '');
        }
      }
      // What this turn cost: the change in the process's running total (a reattached reader, after a
      // portal restart, takes the last stored total; a total lower than that is a new process's).
      if (ev.kind === 'result' && ev.costUsd !== undefined) {
        const base = this.#costBase.get(sessionId) ?? this.#chat.lastResultCost(sessionId) ?? 0;
        ev.turnCostUsd = ev.costUsd >= base ? ev.costUsd - base : ev.costUsd;
        this.#costBase.set(sessionId, ev.costUsd);
      }
      if (ev.kind === 'result') this.#recordTurn(sessionId, ev);
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
        return void this.#endIntegrity(sessionId, `a tool request id arrived twice (${shortId(parsed.request.requestId)})`);
      }
      this.#append(sessionId, { kind: 'request', requestId: canonical.requestId, request: canonical, agentLabel: canonical.agentLabel, parentToolUseId: parent });
    }

    if (parsed.mainUsage) {
      // The latest main-thread API call: its input (with cache) and final output tokens.
      const u = parsed.mainUsage;
      const last = this.#lastCall.get(sessionId);
      const same = last && last.messageId === u.messageId;
      this.#lastCall.set(sessionId, {
        messageId: u.messageId,
        input: Math.max(same ? last.input : 0, u.input ?? 0),
        output: Math.max(same ? last.output : 0, u.output ?? 0),
      });
    }
    if (parsed.sessionPatch || parsed.context) {
      const patch: ChatSessionPatch = { ...parsed.sessionPatch };
      if (parsed.context) {
        // How full the window is now: the last call's tokens, not the turn's sum over every call.
        const last = this.#lastCall.get(sessionId);
        patch.contextUsed = last && last.input > 0 ? last.input + last.output : parsed.context.usedTokens;
        this.#lastCall.delete(sessionId); // each turn reports its own
        patch.contextWindow = this.#contextWindow(sessionId, parsed.context.windows);
      }
      this.#chat.patchSession(sessionId, patch);
      this.#emitSession(sessionId);
    }

    for (const { uuid, state } of parsed.inputs ?? []) this.#setInput(sessionId, uuid, state);

    if (parsed.thinkingStarted) this.#thinkingStarted(sessionId, parsed.thinkingStarted.agentLabel);
    if (parsed.delta) this.#pushDelta(sessionId, parsed.delta.agentLabel, parsed.delta.text);
    if (parsed.blockEdge) this.#flushDelta(sessionId, parsed.blockEdge.agentLabel);

    // After a process's first `system/init`, read what actually applies (model, effort, ultracode).
    if (parsed.init && !this.#appliedRead.has(sessionId)) {
      this.#appliedRead.add(sessionId);
      void this.#refreshApplied(sessionId).catch(() => undefined);
    }

    // After every turn, the subscription check (§6 rule 3) — asked once this line has committed, so the
    // request it records can't be rolled back with it.
    if (parsed.result) {
      this.#thinkingSince.delete(sessionId); // a block cut short (stopped mid-thought) is never stored
      setImmediate(() => void this.#checkUsage(sessionId).catch(() => undefined));
    }
  }

  /**
   * A `control_response` on stdout is either Claude Code's reply to a request this portal asked, or the
   * echo of an answer this portal gave (it echoes every answer it reads). Anything else — a reply or echo
   * nobody asked for, or a second one — ends the session. Returns whether the line may be processed.
   */
  #acceptControlResponse(sessionId: string, reply: ControlResponse): boolean {
    const id = reply.requestId;
    const asked = this.#chat.controlState(sessionId, ASKED(id));
    if (asked !== null) {
      if (asked === 'completed') {
        this.#endIntegrity(sessionId, `a second control response for request ${shortId(id)}`);
        return false;
      }
      this.#chat.setControlState(sessionId, ASKED(id), 'completed');
      this.#settleControl(sessionId, reply);
      // `set_permission_mode`'s reply confirms the mode, before the status line that reports it.
      const mode = reply.ok ? reply.response.mode : undefined;
      if (typeof mode === 'string' && mode) {
        if (mode === 'bypassPermissions') {
          this.#endIntegrity(sessionId, 'Claude Code switched to Bypass permissions, which chat sessions never allow');
          return false;
        }
        this.#confirmMode(sessionId, mode);
      }
      return true;
    }
    const answered = this.#chat.controlState(sessionId, ANSWERED(id));
    if (answered === 'sending' || answered === 'failed') {
      this.#chat.setControlState(sessionId, ANSWERED(id), 'completed');
      return true;
    }
    this.#endIntegrity(
      sessionId,
      answered === 'completed' ? `a second control response for request ${shortId(id)}` : `a control response for request ${shortId(id)} that this portal never asked for or answered`,
    );
    return false;
  }

  /** A replayed user line must be a message this portal sent; local command output is Claude Code's own. */
  #acceptReplay(sessionId: string, replay: NonNullable<ParsedLine['replay']>): boolean {
    if (replay.uuid && this.#chat.isMessage(sessionId, replay.uuid)) return true;
    // `/compact` and other local commands echo their output as a replayed line under an id of its own.
    if (replay.localCommand && this.#chat.slashCommandRunning(sessionId)) return true;
    this.#endIntegrity(sessionId, `a message this portal didn't send reached Claude Code (${shortId(replay.uuid ?? 'no id')})`);
    return false;
  }

  /**
   * The mode a main-thread `system/init` or `system/status` reports must be the one the portal set or
   * confirmed. Claude Code changes it by itself only into plan mode after EnterPlanMode, and out of it
   * after the portal approved ExitPlanMode. Bypass always ends the session.
   */
  #acceptMode(sessionId: string, mode: string): boolean {
    if (mode === 'bypassPermissions') {
      this.#endIntegrity(sessionId, 'the agent reported Bypass permissions, which chat sessions never allow');
      return false;
    }
    const m = this.#mode(sessionId);
    if (mode === m.expected) return true;
    if (mode === 'plan' && m.enterPlan) {
      m.prePlan = m.expected;
      m.expected = 'plan';
      m.enterPlan = false;
      return true;
    }
    if (m.exitPlan && m.expected === 'plan' && (mode === m.prePlan || mode === START_MODE)) {
      m.expected = mode;
      m.exitPlan = false;
      m.prePlan = null;
      return true;
    }
    this.#endIntegrity(sessionId, `the permission mode changed to ${shortId(mode)} without this portal (expected ${m.expected})`);
    return false;
  }

  #mode(sessionId: string): ModeTrack {
    let m = this.#modes.get(sessionId);
    if (!m) {
      // After a portal restart: the last mode stored is the last one set or confirmed.
      m = { expected: this.#chat.row(sessionId)?.mode ?? START_MODE, prePlan: null, enterPlan: false, exitPlan: false };
      this.#modes.set(sessionId, m);
    }
    return m;
  }

  #confirmMode(sessionId: string, mode: string): void {
    const m = this.#mode(sessionId);
    m.prePlan = mode === 'plan' ? (m.expected === 'plan' ? m.prePlan : m.expected) : null;
    m.expected = mode;
    m.enterPlan = false;
    m.exitPlan = false;
  }

  /** A control request the portal doesn't handle gets an error response, on record first like every answer. */
  #refuseControl(sessionId: string, requestId: string): void {
    this.#chat.addControl(sessionId, ANSWERED(requestId));
    void this.#writeLine(sessionId, errorResponse(requestId, 'unsupported')).catch(() => {
      try {
        this.#chat.setControlState(sessionId, ANSWERED(requestId), 'failed');
      } catch {
        // the store went away
      }
    });
  }

  /** Integrity failure (§10.4): end the session at once and SIGTERM the process. */
  #endIntegrity(sessionId: string, why: string): void {
    this.#endForSafety(sessionId, 'The session ended for integrity.', `Integrity check failed: ${why}`, `${CHAT_ENDED_INTEGRITY}${why}`);
  }

  /**
   * Credential failure (§6 rules 1 and 3): Claude Code stopped using the pool's helper, or plan limits
   * showed. The session ends at once like an integrity failure; `why` is fixed text that never names the
   * credential, account or plan.
   */
  #endCredential(sessionId: string, why: string): void {
    this.#endForSafety(sessionId, 'The session ended for safety.', `Ended for safety: ${why}.`, `${CHAT_ENDED_CREDENTIAL}${why}`);
  }

  /** Ends the session at once, with an error event and its reason, and SIGTERMs the process. */
  #endForSafety(sessionId: string, forget: string, text: string, endedReason: string): void {
    this.#stopReader(sessionId);
    this.#forget(sessionId, forget);
    const row = this.#chat.row(sessionId);
    if (!row || row.state === 'ended') return; // already ended (by the operator, or an earlier check)
    this.#append(sessionId, { kind: 'error', text });
    this.#closeOut(sessionId);
    this.#chat.patchSession(sessionId, { state: 'ended', process: 'gone', endedReason });
    this.#emitSession(sessionId);
    void this.#runOnce(row.workspace_id, ['stop', sessionId]).catch(() => undefined);
  }

  /* ---------- Live deltas, redacted ---------- */

  #stream(sessionId: string, agent: string | null): StreamRedactor {
    let streams = this.#streams.get(sessionId);
    if (!streams) this.#streams.set(sessionId, (streams = new Map()));
    let redactor = streams.get(agent ?? '');
    if (!redactor) streams.set(agent ?? '', (redactor = new StreamRedactor()));
    return redactor;
  }

  /** A delta goes out minus a short tail that could still become a credential (held for the next one). */
  #pushDelta(sessionId: string, agent: string | null, text: string): void {
    this.#emitDelta(sessionId, agent, this.#stream(sessionId, agent).push(text));
  }

  /** The block ended: what it held back goes out, redacted. */
  #flushDelta(sessionId: string, agent: string | null): void {
    const streams = this.#streams.get(sessionId);
    const redactor = streams?.get(agent ?? '');
    if (!streams || !redactor) return;
    streams.delete(agent ?? '');
    this.#emitDelta(sessionId, agent, redactor.flush());
  }

  /** Before a finished block (`assistant`) or turn (`result`) is stored, flush the live text it replaces. */
  #flushFor(sessionId: string, parsed: ParsedLine): void {
    if (!parsed.stored.length || !this.#streams.has(sessionId)) return;
    if (parsed.stored.some((e) => e.kind === 'result')) {
      for (const agent of [...(this.#streams.get(sessionId)?.keys() ?? [])]) this.#flushDelta(sessionId, agent || null);
      return;
    }
    for (const ev of parsed.stored) if (ev.kind === 'assistant') this.#flushDelta(sessionId, ev.parentToolUseId ?? null);
  }

  /** Thinking blocks open right now, for a tab that subscribes mid-block (each with how long it has run). */
  openThinking(sessionId: string): { agentLabel: string | null; elapsedMs: number }[] {
    const now = Date.now();
    return [...(this.#thinkingSince.get(sessionId) ?? [])].map(([agent, since]) => ({
      agentLabel: agent ? this.#label(sessionId, agent) : null,
      elapsedMs: Math.max(0, now - since),
    }));
  }

  /** A thinking block opened: note when, and tell open tabs (its text is never streamed). */
  #thinkingStarted(sessionId: string, agent: string | null): void {
    let since = this.#thinkingSince.get(sessionId);
    if (!since) this.#thinkingSince.set(sessionId, (since = new Map()));
    since.set(agent ?? '', Date.now());
    this.#emit(sessionId, { type: 'delta', session: sessionId, agentLabel: agent ? this.#label(sessionId, agent) : null, text: '', thinking: true });
  }

  #emitDelta(sessionId: string, agent: string | null, text: string): void {
    if (!text) return;
    this.#emit(sessionId, { type: 'delta', session: sessionId, agentLabel: agent ? this.#label(sessionId, agent) : null, text });
  }

  /* ---------- Control requests ---------- */

  /**
   * Sends one control request and resolves with the body of Claude Code's success reply. Rejects with
   * its error message, when the line can't be written, or after {@link controlTimeoutMs} without an
   * answer. The request is on record first (its reply is checked against it). Replies are only ever
   * reduced by the caller, never stored or logged whole.
   */
  async #request(sessionId: string, subtype: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const reply = await this.#control(sessionId, subtype, fields);
    if (!reply.ok) throw new AppError('VALIDATION_FAILED', cliMessage(reply.error));
    return reply.response;
  }

  /**
   * Sends one control request and resolves with Claude Code's reply, success or error. Rejects only when
   * no reply came: the line couldn't be written, the process's requests were dropped (it ended, slept or
   * restarted), or a {@link ControlTimeout} after {@link controlTimeoutMs}.
   */
  #control(sessionId: string, subtype: string, fields: Record<string, unknown> = {}): Promise<ControlResponse> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      try {
        this.#chat.addControl(sessionId, ASKED(requestId));
      } catch (e) {
        return reject(e instanceof Error ? e : new Error(String(e)));
      }
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new ControlTimeout());
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

  /** Hands a reply to the request waiting for it (one that already timed out has nobody waiting). */
  #settleControl(sessionId: string, reply: ControlResponse): void {
    const pending = this.#pending.get(reply.requestId);
    if (!pending || pending.sessionId !== sessionId) return;
    this.#pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  /**
   * §6 rule 3, after each `result`: `get_usage {skip_behaviors: true}` (without the flag Claude Code reads
   * every transcript of the last seven days). Plan limits or a subscription type in the reply, a reply
   * without `rate_limits_available: false`, or Claude Code refusing the request ends the session; so does
   * no reply in time from a process that's still running. No gate on this CLI version: 2.1.296 answered
   * every API-key session (helper, environment key, none) with success and `rate_limits_available: false`,
   * so an error is never expected and fails closed. Only the verdict is used: the reply is never stored,
   * logged or shown.
   */
  async #checkUsage(sessionId: string): Promise<void> {
    if (this.#closed || !this.#isLive(sessionId)) return;
    // Only a pool's keys are confirmed: on a Claude's own sign-in, plan limits are expected.
    if (!this.#viaPool(this.#chat.row(sessionId)!.workspace_id)) return this.#armIdle(sessionId);
    let reply: ControlResponse;
    try {
      reply = await this.#control(sessionId, 'get_usage', { skip_behaviors: true });
    } catch (e) {
      // Never asked (the line didn't go) or dropped (the session ended, slept or restarted): no verdict.
      if (!(e instanceof ControlTimeout) || !this.#isLive(sessionId)) return;
      // No answer: a process that died after its turn says nothing about credentials; a running one that
      // won't answer fails closed. Unreachable, the liveness check and the next turn's check decide.
      const workspaceId = this.#chat.row(sessionId)!.workspace_id;
      const status = await this.#status(workspaceId, sessionId);
      if (!this.#isLive(sessionId)) return;
      if (status === 'gone') this.#markGone(sessionId);
      else if (status === 'live') this.#endCredential(sessionId, CREDENTIAL.unanswered);
      return;
    }
    if (!this.#isLive(sessionId)) return;
    const why = reply.ok ? usageVerdict(reply.response) : CREDENTIAL.refused;
    if (why) return this.#endCredential(sessionId, why);
    this.#armIdle(sessionId); // a sleep this check held off may go ahead now
  }

  /**
   * A finished turn as usage metrics (Usage charts): one row per model, from the change in each model's
   * running totals since the last turn, so sub-agents count with the request that started them. The
   * result's tokens become that sum too (Claude Code's own `usage` counts the main agent only). Runs
   * before the result is stored, so "since the last result" means this turn.
   */
  #recordTurn(sessionId: string, ev: StoredEvent): void {
    try {
      const row = this.#chat.row(sessionId);
      if (!row) return;
      const base = this.#modelBase.get(sessionId) ?? new Map((this.#chat.lastResultModelTotals(sessionId) ?? []).map((m) => [m.model, m]));
      const turn: ModelTotals[] = [];
      for (const cur of ev.modelTotals ?? []) {
        const was = base.get(cur.model);
        // A total lower than before means a new process, counting from zero.
        const fresh = !was || cur.input < was.input || cur.output < was.output || cur.cacheRead < was.cacheRead || cur.cacheWrite < was.cacheWrite || cur.costUsd < was.costUsd - 1e-9;
        const d = fresh
          ? cur
          : { model: cur.model, input: cur.input - was.input, output: cur.output - was.output, cacheRead: cur.cacheRead - was.cacheRead, cacheWrite: cur.cacheWrite - was.cacheWrite, costUsd: cur.costUsd - was.costUsd };
        if (d.input || d.output || d.cacheRead || d.cacheWrite || d.costUsd > 0) turn.push(d);
      }
      if (ev.modelTotals?.length) this.#modelBase.set(sessionId, new Map(ev.modelTotals.map((m) => [m.model, m])));
      if (turn.length) {
        ev.tokens = turn.reduce(
          (t, m) => ({ input: t.input + m.input, output: t.output + m.output, cacheRead: t.cacheRead + m.cacheRead, cacheWrite: t.cacheWrite + m.cacheWrite }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        );
      }
      const shares: ModelTotals[] = turn.length
        ? turn
        : [{ model: row.model ?? 'unknown', input: ev.tokens?.input ?? 0, output: ev.tokens?.output ?? 0, cacheRead: ev.tokens?.cacheRead ?? 0, cacheWrite: ev.tokens?.cacheWrite ?? 0, costUsd: ev.turnCostUsd ?? 0 }];
      const agents = this.#chat.agentsSinceLastResult(sessionId);
      this.#chat.recordUsage(
        { atMs: Date.now(), sessionId, workspaceId: row.workspace_id, claudeId: row.claude_id ?? null },
        shares.map((m, i) => ({ ...m, requests: i === 0 ? 1 : 0, agents: i === 0 ? agents : 0, durationMs: i === 0 ? (ev.durationMs ?? 0) : 0 })),
      );
    } catch {
      // Metrics never get in the way of the transcript.
    }
  }

  /** Usage over a window, for the Usage charts. */
  usage(range: unknown, opts: { claudeId?: string; tzOffsetMin?: number } = {}): ChatUsageReport {
    return usageReport(this.#chat, range, opts);
  }

  /** Whether the workspace's sessions run on its Account Pool's keys (else on their Claude's own sign-in). */
  #viaPool(workspaceId: string): boolean {
    try {
      return this.pooled ? this.pooled(workspaceId) : true;
    } catch {
      return true; // can't tell: the pool's checks apply
    }
  }

  /**
   * Before each start, the credential the session will run on: on a pool, `authcheck` must pass (§6 rule
   * 1); without one, the session's Claude must be signed in. Returns the refusal's reason, or null. Throws
   * when the workspace can't be asked.
   */
  async #credentialCheck(workspaceId: string, claudeId: string | null): Promise<string | null> {
    if (this.#viaPool(workspaceId)) return (await this.#authcheck(workspaceId)) === 'pass' ? null : NOT_SET_UP;
    if (!this.signedIn) return null;
    const directory = (claudeId ? this.#chat.claude(claudeId)?.directory : '') ?? '';
    return (await this.signedIn(workspaceId, directory)) ? null : NOT_SIGNED_IN;
  }

  /**
   * §6 rule 1's host check, before each start: `cp-session authcheck` answers `pass` only when the
   * account drop-in names Account Pool's helper; anything else is `fail`. It reads nothing of the
   * workspace's own login. Throws when the workspace can't be asked (unreachable, or no answer in time).
   */
  async #authcheck(workspaceId: string): Promise<'pass' | 'fail'> {
    const { code, out } = await this.#runOnce(workspaceId, ['authcheck']);
    if (code === null) throw new AppError('SERVICE_UNAVAILABLE', 'The workspace took too long to check its account setup. Try again.', { expose: true });
    return code === 0 && out.trim() === 'pass' ? 'pass' : 'fail';
  }

  /** Reads what applies now — `get_settings.applied` only, never `effective` or `sources` — onto the session. */
  async #refreshApplied(sessionId: string): Promise<AppliedSettings | null> {
    const applied = pickApplied(await this.#request(sessionId, 'get_settings'));
    if (!applied) return null;
    this.#chat.patchSession(sessionId, applied);
    this.#emitSession(sessionId);
    return applied;
  }

  /** Fails the session's control requests in flight and drops everything kept for its current process. */
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
    this.#streams.delete(sessionId);
    this.#thinkingSince.delete(sessionId);
    this.#modes.delete(sessionId);
  }

  /* ---------- Exec helpers ---------- */

  /** What the folder's project settings would load, and whether the person trusted exactly that (FR43). */
  #scan(workspaceId: string, folder: string): Promise<ChatFolderScan> {
    return scanFolder(this.#workspaces, this.#store, workspaceId, folder, { timeoutMs: this.execTimeoutMs });
  }

  /** A new session's folder: an absolute path, tidied; the home folder when none is given. */
  #folder(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) return HOME;
    if (!raw.trim().startsWith('/'))
      throw new AppError('VALIDATION_FAILED', 'Pick a folder by its full path, like /home/node/project.', { details: { cwd: 'Expected an absolute path.' } });
    return workspacePath(raw.trim());
  }

  /**
   * Stages one line into the FIFO via `cp-session send` (a fresh staging uuid, exact byte count). Never
   * to a process the portal stopped or lost: a pool change may have stopped it since the caller looked.
   */
  async #writeLine(sessionId: string, line: string): Promise<void> {
    const row = this.#chat.row(sessionId);
    if (!row) throw new AppError('NOT_FOUND', 'No such session.');
    if (row.state === 'ended' || row.process !== 'live')
      throw new AppError('CONFLICT', row.state === 'ended' ? 'This session has ended.' : row.ended_reason ? `Claude Code isn’t running: ${row.ended_reason}` : 'Claude Code isn’t running.');
    const { code } = await this.#runOnce(row.workspace_id, ['send', sessionId, randomUUID(), String(Buffer.byteLength(line))], line);
    if (code === null) throw new AppError('SERVICE_UNAVAILABLE', 'The session host didn’t confirm the line in time.', { expose: true });
    if (code !== 0) throw new AppError('SERVICE_UNAVAILABLE', `The session host rejected the line (exit ${code}).`, { expose: true });
  }

  /**
   * Runs one short `cp-session` command to completion and closes the exec only after it exits: closing
   * earlier drops stdin bytes still in flight (the host reads exactly as many as it was told, then exits
   * by itself) and, on Kubernetes, the exit code. A command still running after {@link execTimeoutMs} is
   * closed and reads as failed (`code: null`).
   */
  async #runOnce(workspaceId: string, args: string[], stdin?: string, configDir?: string | null): Promise<{ code: number | null; out: string }> {
    const [target, name] = this.#split(workspaceId);
    // Only a start needs the directory. The long-lived claude inherits it; the portal never reads that directory.
    const command = configDir
      ? ['sh', '-c', 'export CLAUDE_CONFIG_DIR="$1"; shift; exec sh "$@"', 'sh', configDir, CP_SESSION_PATH, ...args]
      : ['sh', CP_SESSION_PATH, ...args];
    const exec = await this.#workspaces.exec(target, name, command);
    const chunks: Buffer[] = [];
    return await new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        exec.close();
        resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
      };
      const timer = setTimeout(() => finish(null), this.execTimeoutMs);
      exec.onData((b) => chunks.push(b));
      exec.onExit((code) => finish(code));
      if (stdin !== undefined) exec.write(stdin);
    });
  }

  /* ---------- Dispatch and small helpers ---------- */

  #append(sessionId: string, ev: StoredEvent): void {
    const full = this.#chat.appendEvent(sessionId, ev);
    this.#emit(sessionId, { type: 'events', session: sessionId, items: [full] });
  }

  /** Appends an event unless the newest one already says the same (a refusal repeated on every retry). */
  #appendOnce(sessionId: string, ev: StoredEvent): void {
    const last = this.#chat.lastEvent(sessionId);
    if (last?.kind === ev.kind && last.text === ev.text) return;
    this.#append(sessionId, ev);
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

  /** The context window of the model in use, from a result's `modelUsage`; the largest when that's unclear. */
  #contextWindow(sessionId: string, windows: { model: string; tokens: number }[]): number | null {
    if (!windows.length) return null;
    const model = this.#chat.row(sessionId)?.model;
    const own = model ? windows.find((w) => w.model === model) : undefined;
    return own ? own.tokens : Math.max(...windows.map((w) => w.tokens));
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

  /** Tells the tabs the session changed, and (re)schedules its idle check. */
  #emitSession(sessionId: string): void {
    const session = this.#chat.get(sessionId);
    if (session) this.#emit(sessionId, { type: 'session', session });
    this.#armIdle(sessionId);
  }

  #require(sessionId: string): ChatSession {
    const session = this.#chat.get(sessionId);
    if (!session) throw new AppError('NOT_FOUND', 'No such session.');
    return session;
  }

  /** The session hasn't ended and its process should be running. */
  #isLive(sessionId: string): boolean {
    const row = this.#chat.row(sessionId);
    return !!row && row.state !== 'ended' && row.process === 'live';
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
