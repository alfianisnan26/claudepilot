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
  title: string;
  state: ChatSessionState;
  origin: ChatOrigin;
  /** The model in effect, or null for the workspace default. */
  model: string | null;
  mode: ChatPermissionMode;
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
} as const;

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
  op: 'stop' | 'end';
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
  | { type: 'ack'; uuid: string; ok: boolean; error?: string }
  | { type: 'error'; session?: string; message: string };
