// Chat sessions: talking to Claude Code agents in workspaces (chat-sessions PRD, milestone C1).
// Transcript, send, steer, Stop, approvals and questions. One dedicated WebSocket per tab.

/** `starting` launching; `idle` waiting for you; `working` a turn is running; `waiting` needs an answer; `interrupted` the process is gone but resumable; `ended` closed. */
export type ChatSessionState = 'starting' | 'idle' | 'working' | 'waiting' | 'interrupted' | 'ended';

/** Who started it. `ui` a person in the portal; `mcp` a Portal MCP client; `persona_test` a one-shot test. */
export type ChatOrigin = 'ui' | 'mcp' | 'persona_test';

/** Claude Code permission modes. `default` asks for everything (Manual). Bypass is blocked in C1. */
export type ChatPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

export interface ChatSession {
  id: string;
  workspaceId: string;
  /** The folder the session runs in. */
  cwd: string;
  title: string;
  state: ChatSessionState;
  origin: ChatOrigin;
  /** The model in effect (Claude Code's `applied.model`), or null before the first report. */
  model: string | null;
  mode: ChatPermissionMode;
  /** Effort in effect (`low` … `max`), or null when the model has none. */
  effort: string | null;
  ultracode: boolean;
  /** Whether this model/host offers ultracode at all. */
  ultracodeAvailable: boolean;
  /** `live` running; `asleep` stopped after idling (wakes on the next message); `gone` exited or lost (Interrupted). */
  process: 'live' | 'asleep' | 'gone';
  /** How full the context window was after the last turn, from Claude Code's own usage report. */
  context: { usedTokens: number; windowTokens: number | null } | null;
  costUsd: number;
  turns: number;
  /** The last stored event's sequence number; a reconnecting tab resumes after it. */
  lastSeq: number;
  /** Open requests waiting for an answer. */
  waiting: number;
  createdAt: string;
  lastActivityAt: string;
  endedReason: string | null;
}

/** A request from the agent that needs an answer: a tool to allow, a question, a plan to review. */
export type ChatRequestKind = 'tool' | 'question' | 'plan' | 'workflow' | 'elicitation' | 'handoff';

export interface ChatRequest {
  requestId: string;
  kind: ChatRequestKind;
  /** The tool it wants to run (`tool` kind), e.g. `Bash`, `Edit`. */
  toolName: string | null;
  /** Which agent asked, when it's a sub-agent. */
  agentLabel: string | null;
  /** A short human summary the controller builds, e.g. "Run a command". */
  title: string;
  /** More detail, redacted: the command, the file, the question text. */
  detail: string | null;
  createdAt: string;
}

/** A stored transcript event, normalized by the controller so the UI can switch on `kind`. */
export type ChatEventKind =
  | 'user' // something you sent
  | 'assistant' // a finished assistant text block
  | 'system' // a system note (model, mode, a notice)
  | 'result' // a turn finished (with cost/usage)
  | 'tool_use' // the agent used a tool
  | 'tool_result' // a tool returned
  | 'retry' // an API retry (rate limit, overloaded)
  | 'request' // something needs an answer (carries `request`)
  | 'resolved' // a request was answered or withdrawn (carries `requestId`, `outcome`)
  | 'error'; // a turn or the session failed

export interface ChatEvent {
  seq: number;
  at: string;
  kind: ChatEventKind;
  text?: string;
  /** Set when the line came from a sub-agent (its `parent_tool_use_id`). */
  agentLabel?: string | null;
  toolName?: string;
  requestId?: string;
  request?: ChatRequest;
  /** For `resolved`: `allowed_once`, `allowed_session`, `denied`, `withdrawn`, `expired`. */
  outcome?: string;
  /** For `result`: the turn's cost and model. */
  costUsd?: number;
  /** Images on this event (sent by you, or returned by a tool), served from `CHAT_API.blob`. */
  images?: ChatImage[];
  /** For `user`: the client UUID it was sent with, to match lifecycle updates (`input` messages). */
  uuid?: string;
}

export interface ChatImage {
  /** sha256 of the bytes; fetch from `CHAT_API.blob(sessionId, blobId)`. */
  blobId: string;
  mediaType: string;
  name?: string;
}

/** An image you attach to a message. */
export interface ChatAttachment {
  name: string;
  mediaType: ChatImageType;
  /** Base64, without a `data:` prefix. */
  dataBase64: string;
}
export type ChatImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const CHAT_IMAGE_TYPES: readonly ChatImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Per message: at most this many images, each at most this many bytes (before base64). */
export const CHAT_MAX_IMAGES = 4;
export const CHAT_MAX_IMAGE_BYTES = 3_750_000;

/** Where a sent message is (Claude Code's `command_lifecycle`). */
export type ChatInputState = 'sending' | 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded' | 'failed';

/** A sub-agent or background task inside a session (multi-agent view). */
export interface ChatTask {
  taskId: string;
  /** The `Task` tool_use that started it; sub-agent lines carry it as their agent label. */
  toolUseId: string | null;
  description: string;
  subagentType: string | null;
  status: 'running' | 'completed' | 'failed' | 'killed';
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** A model the session can switch to (Claude Code's `list_models`). */
export interface ChatModelOption {
  /** Pass to the `model` control op, e.g. `default`, `sonnet`, a full model id. */
  value: string;
  displayName: string;
  description: string | null;
  /** The model it resolves to now. */
  resolvedModel: string | null;
  effortLevels: string[];
}

export interface CreateChatSessionRequest {
  workspaceId: string;
  title?: string;
  /** A folder in the workspace to run in; defaults to the home folder. */
  cwd?: string;
}

export const CHAT_SESSION_TITLE_MAX = 80;

export const CHAT_API = {
  /** GET: sessions, newest activity first. POST: create one. */
  list: '/api/chat/sessions',
  create: '/api/chat/sessions',
  /** GET: one session. DELETE: end it. */
  one: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}`,
  /** GET `?after=<seq>`: stored transcript events after a sequence number (history and resume). */
  events: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/events`,
  /** GET: models this session can switch to. */
  models: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/models`,
  /** GET: sub-agents and background tasks. */
  tasks: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/tasks`,
  /** GET: an image's bytes (attachments and tool images). */
  blob: (id: string, blobId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/blobs/${blobId}`,
  /** GET `?path=`: a folder's entries in the session's workspace (default: the session's folder). */
  files: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/files`,
  /** GET `?path=`: a file's bytes, as a download. */
  download: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/files/download`,
  /** GET: what changed in the session's folder (git), as a summary and a unified diff. */
  diff: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/diff`,
  /** GET `?workspaceId=&folder=`: what a folder would load (FR43). */
  scan: '/api/chat/trust/scan',
  /** POST `ChatTrustRequest`: trust a folder as scanned. */
  trust: '/api/chat/trust',
} as const;

export interface ChatFileEntry {
  name: string;
  /** Absolute path in the workspace. */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
  modifiedAt: string | null;
}

export interface ChatFolder {
  path: string;
  entries: ChatFileEntry[];
  /** True when the listing was cut short. */
  truncated: boolean;
}

export interface ChatDiffFile {
  path: string;
  /** git's short status, e.g. `M`, `A`, `D`, `R`, `??`. */
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface ChatDiff {
  /** Null when the session's folder isn't a git repository. */
  repo: string | null;
  files: ChatDiffFile[];
  /** Unified diff of tracked changes (untracked files listed only). */
  patch: string;
  truncated: boolean;
}

/** Downloads larger than this are refused. */
export const CHAT_MAX_DOWNLOAD_BYTES = 50_000_000;

/**
 * What a folder's own Claude Code project settings would load when a session starts there (FR43),
 * by name only. Print mode doesn't ask before loading them, so the portal asks instead.
 */
export interface ChatFolderScan {
  workspaceId: string;
  folder: string;
  /** Hash of the scanned files; trust is tied to it, so any change asks again. */
  hash: string;
  /** Nothing to load: such a folder needs no confirmation. */
  empty: boolean;
  mcpServers: string[];
  /** Hook events with commands configured, e.g. `SessionStart`. */
  hooks: string[];
  plugins: string[];
  allowRules: number;
  envNames: string[];
  /** Settings files found (relative to the folder). */
  files?: string[];
  /** Files present but not valid JSON (they still count toward the hash). */
  invalid?: string[];
  /** Whether this exact scan (same hash) was already trusted. */
  trusted: boolean;
}

/** `POST CHAT_API.trust`: trust a folder as scanned. */
export interface ChatTrustRequest {
  workspaceId: string;
  folder: string;
  hash: string;
}

/** The error code a session start returns when its folder needs confirming first; `details` is the `ChatFolderScan`. */
export const CHAT_FOLDER_UNTRUSTED = 'FOLDER_UNTRUSTED';

/** The chat WebSocket, one per tab. Authorized like the shell socket (Origin + session cookie). */
export const CHAT_SOCKET_PATH = '/api/chat/live';

/* ---------- Socket: browser → portal ---------- */

export interface ChatSubscribe {
  type: 'subscribe';
  session: string;
  /** Resume: send stored events after this sequence number. Omit for all. */
  afterSeq?: number;
}
export interface ChatUnsubscribe {
  type: 'unsubscribe';
  session: string;
}
export interface ChatSend {
  type: 'send';
  session: string;
  /** Client-chosen UUID, so a retry never sends twice. */
  uuid: string;
  text: string;
  /** `next` steers the running turn; `later` queues after it. Omit for a fresh turn. */
  priority?: 'next' | 'later';
  attachments?: ChatAttachment[];
}
export interface ChatRespond {
  type: 'respond';
  session: string;
  requestId: string;
  decision: 'allow' | 'allow_session' | 'deny';
  note?: string;
}
export interface ChatControl {
  type: 'control';
  session: string;
  /**
   * `stop` interrupts the turn; `end` closes the session; `model`, `effort`, `ultracode`, `mode`
   * change what applies from the next request; `cancel_queued` withdraws a queued message.
   */
  op: 'stop' | 'end' | 'model' | 'effort' | 'ultracode' | 'mode' | 'cancel_queued' | 'resume' | 'stop_task';
  /** Used to key the `ack`; any client-chosen string. */
  uuid?: string;
  args?: { model?: string; effort?: string; ultracode?: boolean; mode?: ChatPermissionMode; inputUuid?: string; taskId?: string };
}
export type ChatClientMessage = ChatSubscribe | ChatUnsubscribe | ChatSend | ChatRespond | ChatControl;

/* ---------- Socket: portal → browser ---------- */

export type ChatServerMessage =
  /** Stored events, in order, for a subscribed session (also the backlog on subscribe). */
  | { type: 'events'; session: string; items: ChatEvent[] }
  /** Live assistant tokens for the open block; never stored, not replayed on resume. */
  | { type: 'delta'; session: string; agentLabel: string | null; text: string }
  /** The session's state/counters changed. */
  | { type: 'session'; session: ChatSession }
  /** Result of a send/respond/control the tab sent. */
  | { type: 'ack'; uuid: string; ok: boolean; error?: string; code?: string }
  /** A sent message moved through Claude Code's queue (queued → started → completed, or cancelled). */
  | { type: 'input'; session: string; uuid: string; state: ChatInputState }
  /** The session's sub-agents and background tasks changed (the full current list). */
  | { type: 'tasks'; session: string; tasks: ChatTask[] }
  | { type: 'error'; session?: string; message: string };
