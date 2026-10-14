// Chat sessions: talking to Claude Code agents in workspaces (chat-sessions PRD, milestone C1).
// Transcript, send, steer, Stop, approvals and questions. One dedicated WebSocket per tab.

import type { ChatFile, ChatUploadRef } from './artifacts.js';
import type { BtwClientMessage, BtwServerMessage, ChatPinnedBtw } from './chatBtw.js';
import type { ChatKeepGoing } from './keepgoing.js';

/** `starting` launching; `idle` waiting for you; `working` a turn is running; `waiting` needs an answer; `interrupted` the process is gone but resumable; `ended` closed. */
export type ChatSessionState = 'starting' | 'idle' | 'working' | 'waiting' | 'interrupted' | 'ended';

/** Who started it. `ui` a person in the portal; `mcp` a Portal MCP client; `persona_test` a one-shot test. */
export type ChatOrigin = 'ui' | 'mcp' | 'persona_test';

/**
 * Claude Code permission modes. `default` asks for everything (Manual); `acceptEdits` edits without asking (Edit); `auto` lets Claude
 * Code's classifier approve routine actions and block risky ones (Auto: only sessions a person started in the app, see
 * {@link autoModeAllowed}); `plan` changes nothing until approved; `dontAsk` (not offered, kept for stored rows) denies what isn't
 * pre-approved; Bypass only through its own confirmation (FR20).
 */
export type ChatPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

/**
 * Whether a session may use Auto (chat-sessions PRD, Auto mode): only one a person started in the app. A session a trigger, a ticket,
 * Portal MCP or another session started read text nobody vetted (a webhook body, a ticket, an agent's words), so its ceiling stays
 * where it was (Edit). The server checks this on every change to Auto; the app uses it to show Auto as unavailable.
 */
export function autoModeAllowed(s: { startedBy: string | null; origin: ChatOrigin; parentId: string | null }): boolean {
  if (s.parentId) return false;
  return s.startedBy === CHAT_ACTOR_UI || (s.startedBy === null && s.origin === 'ui');
}

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
  /**
   * The model the chat had before a move to a Claude without it changed the model (T-109): `model` is what applies there. Null (or absent)
   * when the chat runs on its own model.
   */
  originalModel?: string | null;
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
  /** What the oldest open request asks, in a few words ("Run a command: npm test"), or null when none is open. */
  waitingFor: string | null;
  /** Sub-agents and background tasks still running (the Agents panel's running ones): the main agent may be idle while they work. */
  agentsRunning?: number;
  /**
   * The session reads `working` only because tasks of its process still run: its main turn is over (T-41). A session is working while its
   * main turn runs OR any task of its current process runs, and idle only when neither does; this says which, so a client offers Send
   * (not Stop) and shows no live turn.
   */
  tasksOnly?: boolean;
  createdAt: string;
  lastActivityAt: string;
  endedReason: string | null;
  /**
   * T-136 slice 2: for a session ended for integrity, how the portal classified the line that ended it (`ChatEndedFor`), so a Resume
   * (`CHAT_API.recover`) can say what it brings back. Absent or null for any other session.
   */
  endedFor?: ChatEndedFor | null;
  /** The Claude directory this session runs in. Empty until a Claude is recorded. */
  claudeId: string;
  /** Display name of that Claude, when known. */
  claudeName: string | null;
  /** Legacy: a chat moved to another Claude used to become a second session. Never set now; the two were folded into one. */
  predecessorId: string | null;
  /** Legacy, as above. */
  successorId: string | null;
  /**
   * The session this one continues (T-136, D-30): a chat that ended and went on in a new row. Root to head they are one unit: its cost is
   * the sum over the chain (the server's lineage helper). Null when it continues nothing.
   */
  continuedFrom?: string | null;
  /** When it was archived (hidden from the list; an archived session has ended), or null. */
  archivedAt: string | null;
  /** When the person pinned it (FR2: the Pinned chip, first in its group), or null. Archiving unpins. */
  pinnedAt: string | null;
  /** The ticket this session works on (Tickets), or null. Set when it's created, or with `setTicket`. */
  ticketId: string | null;
  /** The session that started this one (multi-agent), or null for one a person or a ticket started. */
  parentId: string | null;
  /** The git worktree it runs in, which is also its `cwd`, or null when it runs in a plain folder. */
  worktree: ChatWorktree | null;
  /** Who started it: `ui` (a person), `ticket:<id>`, `session:<id>` or `portal-mcp:<token id>`; null for sessions from before this field. */
  startedBy: string | null;
  /**
   * T-294: the agent it runs as: every start of its process (new, resume, wake, restart, recover, a Move) is `claude --agent <name>`, the
   * definition `.claude/agents/<name>.md` in its folder (its prompt, its tools and, until the session's model is set, its model). Kept across
   * a Move. Claude Code ignores a name it finds no definition for. Null (or absent) when it runs as Claude Code's default.
   */
  agent?: string | null;
  /**
   * T-294: how many workers (sessions it starts with `session_spawn`) may run at once under THIS session. Null: the global
   * `sessions.maxChildren`. 0: it may not start workers. A value above the global cap counts as the cap (the global settings are the ceiling).
   * Checked at each spawn, so a change applies at once. Absent on rows from before (null).
   */
  maxWorkers?: number | null;
  /**
   * T-294: whether its Claude may start Claude Code sub-agents (the Agent tool, older name Task). False: every start of its process is
   * launched with `--disallowedTools Agent Task`, so a change applies at the next start (a Restart). On or off only: Claude Code has no count.
   * Absent on rows from before (true).
   */
  subagents?: boolean;
  /** The session was started with, or restarted for, Bypass permissions: only then can the person turn it on (FR20). */
  bypassCapable: boolean;
  /** The Claude Code session of the run going now. A chat that moved to another Claude has had several; this id is the portal's own, for every one of them. */
  claudeSessionId: string;
  /** The other Claudes this chat ran on before its current one, oldest first. */
  previousClaudes: { claudeId: string; name: string }[];
  /** While the chat moves to another Claude: where to and how far along. The composer waits; nothing is queued. */
  switching: { toClaude: string; step: 'handoff' | 'starting' | 'finishing' } | null;
  /**
   * When something was delivered into the workspace (MCP servers, settings, secrets) after this session's Claude Code process started,
   * the time it landed: the process read its configuration at start, so a Restart (`CHAT_API.restart`) is what loads it. Absent or null
   * when nothing newer landed, or the process isn't running.
   */
  configChangedAt?: string | null;
  /**
   * T-102: what changed since this session's process started, for the hint's sheet. `at` is the newest change (the same time as
   * {@link configChangedAt} when it came from a delivery); `reasons` names the areas, newest delivery first, each once. Absent with the hint.
   */
  configChanged?: { at: string; reasons: ChatConfigChange[] } | null;
  /** A Restart is under way (`CHAT_API.restart`): the composer waits; messages sent meanwhile go to the new process, in order. */
  restarting?: boolean;
  /**
   * T-102: a Restart waits for the next boundary (no turn and no task running, T-41): `person` asked for it ("Restart after this turn"),
   * `auto` the session applies tool changes by itself ({@link autoApply}). Absent: none waits.
   */
  restartQueued?: 'person' | 'auto' | null;
  /**
   * T-102: a queued or automatic Restart that the portal will NOT do by itself, and why: `bypass`, the session is in Bypass and a restart
   * could not keep it (the policy no longer allows it, or the session is not bypass-capable), so it would come back in Manual and wait for
   * approvals. A person restarts it by hand (the confirmation says Bypass turns off).
   */
  restartHeld?: 'bypass' | null;
  /** T-102: the hint was hidden until the next change: hidden while {@link configChanged}'s `at` is not newer than this. */
  configHiddenAt?: string | null;
  /** T-102: nobody may be watching (Bypass, started by a portal actor, or the person turned {@link autoApply} on): the hint informs rather than asks. */
  autonomous?: boolean;
  /** T-102: "Apply tool changes at the next turn end": the portal queues the Restart by itself. Its default is on for an autonomous session, off otherwise. */
  autoApply?: boolean;
  /** T-102: while it reads working or waiting, since when (the main turn's start, or the oldest running task's): the hint offers Restart now after 30 minutes. */
  busySince?: string | null;
  /** T-259: Keep going (the watchdog's policy for this chat, today's counts and its last action); absent or null when no policy was ever set. */
  keepGoing?: ChatKeepGoing | null;
}

/**
 * T-102: an area whose change a running Claude Code process has not read: a pool type's delivery (`mcpset` MCP servers, `settings`, `policy`,
 * `secrets`, `account`, `persona`, `context`, `skillset` skills, `browser`), the portal's own files (`foundation`), the portal's tools for
 * agents (`portal_tools`, the workspace's agent access turned on or off), or `other` (a delivery from before the portal recorded what it held).
 */
export type ChatConfigChange =
  | 'mcpset'
  | 'settings'
  | 'policy'
  | 'secrets'
  | 'account'
  | 'persona'
  | 'context'
  | 'skillset'
  | 'browser'
  | 'foundation'
  | 'portal_tools'
  | 'other';

/** T-102: how long a turn may run before the hint offers "Restart now" prominently (an autonomous session's turn can last hours). */
export const RESTART_LONG_TURN_MS = 30 * 60_000;

/** One run of a chat on a Claude: its Claude Code session, when, why it ended, and what it cost. */
export interface ChatSegment {
  n: number;
  claudeId: string;
  claudeName: string;
  claudeSessionId: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  /** `switched` when the chat moved to another Claude; `closed` and other reasons otherwise; null while it runs. */
  endedReason: string | null;
  costUsd: number;
  turns: number;
}

/**
 * A git worktree a session runs in (chat-sessions PRD, "Git worktrees per session"). The portal adds
 * it from `repo` on a branch of its own, and the session's folder is `path`.
 */
export interface ChatWorktree {
  /** The worktree's folder in the workspace. */
  path: string;
  /** The branch checked out in it. */
  branch: string;
  /** The repository (its main working folder) it belongs to. */
  repo: string;
}

/** What removing a session's worktree would lose (`GET CHAT_API.worktree(id)`). */
export interface ChatWorktreeStatus {
  /** Its folder is still there (it may be gone: removed by hand, or the workspace was rebuilt). */
  exists: boolean;
  branch: string | null;
  /** Files with changes, untracked files, and commits only this branch has (reachable from no other branch and no remote). */
  dirty: number;
  untracked: number;
  unique: number;
  /** Removing the folder now takes the person's word that the changes and untracked files may go. */
  needsForce: boolean;
}

/** What a delete or an archive does with a session's worktree: nothing (the default), remove it if nothing is lost, or remove it and discard its changes. */
export type ChatWorktreeRemoval = 'keep' | 'remove' | 'force';

/** One of a workspace's worktrees (`GET CHAT_API.worktrees`): the ones the portal made and the ones git lists beside them. */
export interface ChatWorktreeEntry {
  path: string;
  branch: string | null;
  repo: string | null;
  /** `active`: a chat runs in it. `kept`: its chat is over or gone and the folder stays. `reserved`: made for a start still waiting on folder trust. `other`: made outside the portal. */
  state: 'active' | 'kept' | 'reserved' | 'other';
  sessionId: string | null;
  sessionTitle: string | null;
  locked: boolean;
}

/** The error code (409) of a removal that would lose changes unless forced; its details are a `ChatWorktreeStatus`. */
export const WORKTREE_DIRTY = 'WORKTREE_DIRTY';

/**
 * What a portal-originated message says about who sent it (chat-sessions PRD FR14). Portal actors are
 * `ticket:<id>`, `session:<id>` and `portal-mcp:<token id>`, and `portal:<what>` for the portal acting on
 * its own after a person's click (`portal:handoff`: the request for a handoff when a chat moves to another Claude); a person
 * typing in the app is `ui`. Anything else is refused, so an actor can't be made up with characters that
 * would read as something else.
 */
export const CHAT_ACTOR_UI = 'ui';
export const CHAT_ACTOR_PATTERN = /^(?:ticket|session|portal-mcp|portal|ci):[A-Za-z0-9._:-]{1,64}$/;
export const isChatActor = (v: unknown): v is string => typeof v === 'string' && (v === CHAT_ACTOR_UI || CHAT_ACTOR_PATTERN.test(v));
/** A portal actor: anything an actor string can be except the person at the keyboard. */
export const isPortalActor = (v: unknown): v is string => typeof v === 'string' && CHAT_ACTOR_PATTERN.test(v);

/** A named Claude on one workspace volume. Its directory holds chats and any terminal login. No credential is stored here. */
export interface WorkspaceClaude {
  id: string;
  workspaceId: string;
  name: string;
  /** Relative directory on the volume, or empty for the workspace's original Claude home. */
  directory: string;
  removedAt: string | null;
  createdAt: string;
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
  /** One line of detail, redacted and cut at 200 characters: the command, the file, the question text. The card's and the transcript's summary, never what is approved on. */
  detail: string | null;
  /**
   * What the person is asked to allow, whole (chat-sessions PRD, approvals): the command, the path, the URL, the plan, or for a tool the
   * portal has no summary of, its whole input as JSON. Plain text exactly as the tool will receive it (nothing folded, so a run of spaces
   * that hides a tail stays in view), characters that can disguise text shown as escapes, redacted, and at most `REQUEST_FULL_MAX`
   * characters. Absent or empty: the portal has nothing to show for this request (one older than this field, or a call without input).
   */
  full?: string | null;
  /** `full` was cut at `REQUEST_FULL_MAX`: more is asked than can be shown. */
  fullCut?: boolean;
  createdAt: string;
}

/** The most of an approval's text kept and shown (`ChatRequest.full`). */
export const REQUEST_FULL_MAX = 8000;

/** One value of a tool's stored input (`ChatEvent.toolInput`): JSON. */
export type ChatToolInputValue = string | number | boolean | null | ChatToolInputValue[] | { [key: string]: ChatToolInputValue };

/**
 * Whether a request may be allowed: only when the text asked about is there and shown whole. A request that is cut at the cap or has
 * nothing to show can be denied and nothing else, on every surface that answers it (the session's card, the glance widget) and at
 * the server (`controller.respond`). `note` is the one terse line that says why.
 */
export function requestReview(r: Pick<ChatRequest, 'full' | 'fullCut'>): { allow: boolean; note: string | null } {
  if (r.fullCut) return { allow: false, note: 'Too long to show in full.' };
  if (!r.full || !r.full.trim()) return { allow: false, note: 'Nothing to show for this request.' };
  return { allow: true, note: null };
}

/** A stored transcript event, normalized by the controller so the UI can switch on `kind`. */
export type ChatEventKind =
  | 'user' // something you sent
  | 'assistant' // a finished assistant text block
  | 'system' // a system note (model, mode, a notice)
  | 'result' // a turn finished (with cost/usage)
  | 'tool_use' // the agent used a tool
  | 'tool_result' // a tool returned
  | 'thinking' // a finished thinking block (`text` is the reasoning, `durationMs` how long it took)
  | 'retry' // an API retry (rate limit, overloaded)
  | 'request' // something needs an answer (carries `request`)
  | 'resolved' // a request was answered or withdrawn (carries `requestId`, `outcome`)
  | 'artifact' // the agent produced files (carries `files`; chat content, artifacts.ts)
  | 'error'; // a turn or the session failed

export interface ChatEvent {
  seq: number;
  at: string;
  kind: ChatEventKind;
  text?: string;
  /** Set when the line came from a sub-agent (its `parent_tool_use_id`). */
  agentLabel?: string | null;
  /** Set when the line came from a sub-agent: the `Task` call that started it (`ChatTask.toolUseId`), whatever its label reads. */
  parentToolUseId?: string;
  toolName?: string;
  requestId?: string;
  request?: ChatRequest;
  /** For `resolved`: `allowed_once`, `allowed_session`, `denied`, `withdrawn`, `expired`, `stale` (its process was not the live one; T-284). */
  outcome?: string;
  /** For `result`: Claude Code's running cost for the process so far (it reports a total, not the turn's). */
  costUsd?: number;
  /** For `result`: what this turn alone cost (the change in that running total). */
  turnCostUsd?: number;
  /** For `result`: this turn's tokens, summed over its API calls. */
  tokens?: ChatTurnTokens;
  /** For `tool_use` and `tool_result`: the call they belong to, pairing a result with its call. */
  toolUseId?: string;
  /**
   * For `tool_use`: what the tool was given, for the row's Input block (chat PRD FR7): the fields the row shows of a built-in tool (Bash's
   * command, an edit's path and strings, a read's path and range), an MCP tool's whole input; absent for the rest (a sub-agent's prompt
   * is never stored). Strings as written (line breaks kept), disguising characters as `⟦U+XXXX⟧`, redacted, bounded (`toolInputCut`).
   */
  toolInput?: { [key: string]: ChatToolInputValue };
  /** For `tool_use`: `toolInput` was cut to its bound. */
  toolInputCut?: boolean;
  /** For `tool_result`: the tool failed. */
  isError?: boolean;
  /** For `thinking`: how long the block took, when the portal saw it start. For `result`: how long the turn took. */
  durationMs?: number;
  /** Images on this event (sent by you, or returned by a tool), served from `CHAT_API.blob`. */
  images?: ChatImage[];
  /** For `user`: the other files you attached. For `artifact`: what the agent produced. Served from `CHAT_API.blob`. */
  files?: ChatFile[];
  /** For `user`: the client UUID it was sent with, to match lifecycle updates (`input` messages). */
  uuid?: string;
  /**
   * For `user`: the opening of a chat that moved to another Claude (Workspace Claudes FR13). The text is the context
   * the portal sent, shown as prior context from the named Claude, not as a message you typed. For
   * `system`: the marker row of a move (FR14), on the new session and on the one left behind, which the
   * transcript shows as a marker rather than folding it into a turn's activity.
   */
  transfer?: ChatTransferContext;
  /** `system`: the divider a Restart leaves ("Restarted: MCP reconnected"), shown as a marker like a move's. */
  restart?: boolean;
  /** `system`: the divider a recover in place leaves (T-136: "Recovered in place after an integrity ending: <reason>"), a marker like a Restart's. */
  recovered?: boolean;
  /**
   * For `user`: who sent it, when it didn't come from the person at the keyboard (`ticket:<id>`,
   * `session:<id>`, `portal-mcp:<token id>`). Such a message shows as coming from that actor, never as
   * something you typed. Absent for your own messages.
   */
  actor?: string;
  /** For `user` with an `actor`: how to name it (a session's title, a ticket's number), as the portal knew it then. */
  actorLabel?: string;
  /**
   * Set on everything a move to another Claude wrote while it ran: progress rows, the handoff request and the
   * document, the opening, the acknowledgement. The transcript folds them into one card at the move's marker.
   */
  handoffId?: string;
  /**
   * For `system`: a side question pinned to the transcript (chat PRD §20, `chatBtw.ts`): one card with the question and the answer. `text` is its
   * plain fallback. Claude never saw it and a later btw doesn't read it: it is the person's record, not part of the session's context.
   */
  btw?: ChatPinnedBtw;
}

/** Where the context of a chat that moved to another Claude came from. */
export interface ChatTransferContext {
  /** The Claude the chat was moved from, and the one it runs on now. */
  fromClaude: string;
  toClaude: string;
  /** The chat itself (the same session before and after the move). */
  sourceSessionId: string;
  /** The context file on the workspace volume. */
  path: string;
  /** How many messages of the source the context carries, and whether older ones were left out. */
  messages: number;
  truncated: boolean;
  /** The Claude the chat ran on wrote a handoff document first (Workspace Claudes Q3), and it's in the context. */
  handoff?: boolean;
  /** The move this belongs to: the events it wrote (progress rows, the handoff exchange, the opening and its acknowledgement) carry it. */
  handoffId?: string;
}

/** The windows Usage charts over, newest last; each has its own bucket size. */
export const CHAT_USAGE_RANGES = ['30m', '1h', '12h', '1d', '7d', '30d'] as const;
export type ChatUsageRange = (typeof CHAT_USAGE_RANGES)[number];

/** What a slice of turns used: tokens, estimated cost, requests (turns) and sub-agents started. */
export interface ChatUsageTotals {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  agents: number;
}

/**
 * `GET /api/chat/usage?range=&claudeId=&tz=`: usage over a window, from the turns stored as metrics
 * (one row per model per turn, sub-agents included). Buckets cover the whole window, empty ones too.
 */
export interface ChatUsageReport {
  range: ChatUsageRange;
  from: string;
  to: string;
  bucketMs: number;
  totals: ChatUsageTotals;
  buckets: (ChatUsageTotals & { at: string })[];
  /** Per Claude (whose sign-in, or the pool, the turns ran as), most cost first. */
  byClaude: (ChatUsageTotals & { claudeId: string; name: string; workspaceId: string })[];
  /** Per model, most cost first. */
  byModel: (ChatUsageTotals & { model: string })[];
}

/** A turn's tokens: fresh input, output, and input read from or written to the prompt cache. */
export interface ChatTurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChatImage {
  /** sha256 of the bytes; fetch from `CHAT_API.blob(sessionId, blobId)`. */
  blobId: string;
  mediaType: string;
  name?: string;
  /** Pixels, when known (uploads): the image's box is sized before it loads. */
  width?: number;
  height?: number;
}

/** An image attached inline as base64 (the portal's API, tests). The app uploads first and sends a `ChatUploadRef`. */
export interface ChatInlineImage {
  name: string;
  mediaType: ChatImageType;
  /** Base64, without a `data:` prefix. */
  dataBase64: string;
}
/** What a message's `attachments` hold: inline images, or files uploaded first (chat content, `artifacts.ts`). */
export type ChatAttachment = ChatInlineImage | ChatUploadRef;
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
  /**
   * The model it runs on, as Claude Code reported it (e.g. `claude-sonnet-4-5`): the `resolvedModel` of the call that launched it, then the
   * `message.model` of its own lines. Null when neither was seen (a background command, an older Claude Code): unavailable, never guessed.
   */
  model: string | null;
  status: 'running' | 'completed' | 'failed' | 'killed';
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** At most this many events in one answer of `CHAT_API.taskEvents` (the newest of them). */
export const TASK_EVENTS_MAX = 200;

/** A sub-agent's own transcript (`CHAT_API.taskEvents`): the stored events of its lines, redacted like the main transcript. */
export interface ChatTaskTranscript {
  task: ChatTask;
  /** Oldest first; at most `TASK_EVENTS_MAX`, the newest when there are more. */
  events: ChatEvent[];
  /** More events (after `after`) than were returned: the oldest were left out. */
  truncated: boolean;
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
  /** Which Claude on that workspace. Omitted uses Default. */
  claudeId?: string;
  /**
   * The person ticked "Allow Bypass later in this session" (FR20). Read only from a person's own request through the
   * app's route, and only when the policy allows it; every other caller (Portal MCP, tickets, personas, a session
   * starting another) can't set it.
   */
  allowBypass?: boolean;
  /** The ticket it works on (Tickets). An opaque id: the portal only records it. */
  ticketId?: string;
  /** T-294: the agent it runs as ({@link CHAT_AGENT_NAME}; `ChatSession.agent`). Any other name is refused (422) before anything is created. */
  agent?: string;
  /**
   * The session this one continues (T-270, T-136 lineage): an ENDED session of the same workspace, else 409 and nothing is created. The
   * new row is linked to it (`continuedFrom`), and in the same transaction every unfinished ticket held by it and by its ended predecessors
   * down the chain is assigned to the new session (an `assigned` entry each, actor system, `continued: true`).
   */
  continuedFrom?: string;
  /**
   * Run it in a git worktree of its own: the portal adds one from `repo` (default: the repository
   * containing `cwd`) on `branch` (default: a new branch named after the session), starting from `base`
   * (default: the repository's current branch), and the session's folder is that worktree. Nothing is
   * created when the folder is untrusted or the start is refused.
   */
  worktree?: ChatWorktreeRequest;
}

/** The parts of a worktree a caller may choose; the portal picks the folder. */
export interface ChatWorktreeRequest {
  /** The repository's folder in the workspace. Defaults to the session's `cwd`. */
  repo?: string;
  /** The branch to check out in the worktree: a new one, or an existing one no other worktree has. */
  branch?: string;
  /** Where a new branch starts: a branch, tag or commit of the repository. Not with an existing branch. */
  base?: string;
}

/** What the Bypass confirmation and the mode picker need to know of a session (FR20). */
export interface ChatBypassFacts {
  workspaceId: string;
  /** The workspace can reach the internet (false only where the portal knows it can't). */
  internet: boolean;
  /** Credentials the portal delivered into it, by kind ("account pool key", "Secrets & env values"). */
  credentials: string[];
}

/** `GET CHAT_API.bypass(id)`. */
export interface ChatBypassState {
  /** The policy allows Bypass in chat (the interim switch `sessions.allowBypass`). */
  allowed: boolean;
  /** The session was started with, or restarted for, Bypass. */
  capable: boolean;
  /** It is on now. */
  active: boolean;
  /** Working or waiting: restarting it for Bypass has to wait for the turn to end. */
  busy: boolean;
  facts: ChatBypassFacts;
  /** The sign-in passed the re-check of the server code in the last 10 minutes. */
  reauthed: boolean;
}

/** `POST CHAT_API.bypass(id)`: the person's confirmation. The server code check comes first (`REAUTH_REQUIRED`). */
export interface EnterBypassRequest {
  /** The tick on "Claude will run every tool without asking in <workspace>…". */
  acknowledged: boolean;
}

/** `POST CHAT_API.reauth`: the server code again, for actions that guard it. */
export interface ReauthRequest {
  code: string;
}

/** The error code (403) of an action that needs the server code checked again, then the same request again. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';
/** Error codes of a Bypass request the portal refused: the policy blocks it (403), or the session wasn't started for it (409). */
export const BYPASS_BLOCKED = 'BYPASS_BLOCKED';
export const BYPASS_NOT_CAPABLE = 'BYPASS_NOT_CAPABLE';

/** One entry of the chat audit trail (`GET CHAT_API.audit`). */
export interface ChatAuditEntry {
  id: number;
  at: string;
  severity: 'info' | 'medium' | 'high';
  kind: string;
  sessionId: string | null;
  workspaceId: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
}

export interface CreateWorkspaceClaudeRequest {
  workspaceId: string;
  name: string;
}

/** `POST CHAT_API.restart(id)`: why the person restarts it (`mcp`: the hint that something was delivered; `manual`: the menu). */
export interface RestartChatRequest {
  why?: 'mcp' | 'manual';
  /**
   * T-102. `now` (the default): restart at once, and only at a turn boundary unless `interrupt`. `turn_end`: queue it for the next boundary
   * (no turn and no task running), or restart at once when the session is already there; refused for a Bypass session a restart could not
   * keep in Bypass (`BYPASS_NOT_KEPT`).
   */
  when?: 'now' | 'turn_end';
  /** T-102, with `now`: also while a turn runs or an approval waits: the turn is interrupted, open approvals expire, running agents stop. */
  interrupt?: boolean;
}

/** T-102: `PATCH CHAT_API.restartHint(id)`: the hint's per-session memory. Each field is optional; absent leaves it as it is. */
export interface UpdateRestartHintRequest {
  /** true: hide the hint until a newer change; false: show it again. */
  hidden?: boolean;
  /** "Apply tool changes at the next turn end"; null goes back to the default (on for an autonomous session). */
  autoApply?: boolean | null;
}

/** T-294: the highest `ChatSession.maxWorkers` a caller may set (the `sessions.maxChildren` setting's own maximum). */
export const CHAT_MAX_WORKERS_MAX = 20;

/**
 * T-294: `PATCH CHAT_API.limits(id)`, a person's (or an admin token's, over `session_configure`) change of a session's limits. Each field is
 * optional; absent leaves it as it is. `maxWorkers`: an integer from 0 to {@link CHAT_MAX_WORKERS_MAX}, or null for the global setting.
 */
export interface UpdateChatLimitsRequest {
  maxWorkers?: number | null;
  subagents?: boolean;
}

/** T-294: what a limits change answers: the session, and whether its live process needs a Restart for it (a `subagents` change). */
export interface ChatLimitsResult {
  session: ChatSession;
  restartNeeded: boolean;
}

/** The error code (409) of a queued or automatic restart refused because Bypass could not be kept (T-102). */
export const BYPASS_NOT_KEPT = 'BYPASS_NOT_KEPT';

/**
 * T-136 slice 2: how the portal classified the line an integrity ending was for. `harmless`: a near miss of a case INTEGRITY_CASES
 * accepts (a sub-agent of the process sent it, or a stream re-read): an agent may recover it. `suspicious`: anything else (an unknown
 * origin, an invented uuid, a different control body): only a person recovers it, after a confirmation that shows `origin`.
 */
export interface ChatEndedFor {
  /** The reason as shown (`endedReason` without its prefix). */
  reason: string;
  classified: 'harmless' | 'suspicious';
  /** The case's id (`replay-peer`, `control-duplicate`, `replay-unknown`, …). */
  case: string;
  /** Where the line came from, in words ("a sub-agent of this process", "unknown origin: channel"). Never the line's text. */
  origin: string;
}

/** `POST CHAT_API.clearRequest(id, requestId)` (T-284): the request and how it was resolved (`stale`), and the chat as it is now. */
export interface ClearChatRequestResult {
  requestId: string;
  outcome: string;
  session: ChatSession;
}

/** `POST CHAT_API.recover(id)`: bring a session ended for integrity back in place (the same row, its conversation resumed). */
export interface RecoverChatRequest {
  /** A person confirmed the sheet that showed the line's origin and classification (needed for a `suspicious` cause). */
  confirm?: boolean;
  /** `agent`: the caller is an agent acting with a person's sign-in (the dev supervisor): treated as an agent (no suspicious cause). */
  by?: 'agent' | 'person';
}

/** Recover refusals (T-136): 403 an agent asked for a suspicious cause; 409 a person must confirm it first; 409 the day's cap; 409 the pause. */
export const CHAT_RECOVER_SUSPICIOUS = 'RECOVER_SUSPICIOUS';
export const CHAT_RECOVER_CONFIRM = 'RECOVER_CONFIRM';
export const CHAT_RECOVER_CAPPED = 'RECOVER_CAPPED';
export const CHAT_RECOVER_PAUSED = 'RECOVER_PAUSED';

export interface SwitchChatRequest {
  /** The Claude to move the chat to, on the same workspace. */
  claudeId: string;
  /**
   * The model to run there (T-109), e.g. `opus` when the destination has no Fable: applied after the start and verified; when refused, the
   * next one down the catalogue's chain. Absent: the chat's own model (verified the same way).
   */
  model?: string;
  /**
   * `ask` (the default) first asks the Claude the chat runs on, with a message the portal sends, to compact what it
   * knows into a handoff document. `skip` moves with the conversation as the portal stored it. When the Claude
   * can't answer in time, the move goes ahead as if skipped and says why.
   */
  handoff?: 'ask' | 'skip';
}

/** One Claude a chat could move to, and whether a session could start there right now (asked before the person confirms). */
export interface ChatSwitchOption {
  claude: WorkspaceClaude;
  ok: boolean;
  /** Why not, in the portal's words, when it isn't. */
  reason: string | null;
  /** What would fix it: sign that Claude in, deal with the workspace's account pool, or start the workspace. */
  fix: 'sign_in' | 'pool' | 'start_workspace' | null;
  /**
   * The chat's model there (T-109): `from` the family the chat runs on, `to` the best family this Claude has at or below it (the catalogue's
   * downgrade chain; null when it has none of them or the chat's model is unknown), `known` whether its `list_models` was read (else the
   * catalogue and its usage windows decided). Absent when the chat's model isn't known.
   */
  model?: { from: string; to: string | null; known: boolean };
}

/** `GET CHAT_API.switchOptions(id)`: where a chat can move, before the person confirms (Workspace Claudes FR9, §11). */
export interface ChatSwitchOptions {
  sessionId: string;
  /** Sessions on this workspace run on its account pool's keys, or on each Claude's own sign-in. */
  via: 'pool' | 'own';
  options: ChatSwitchOption[];
  /** The folder the chat continues in (the worktree, when it has one). */
  folder: string;
  worktree: ChatWorktree | null;
  /** Whether the Claude the chat runs on can be asked for a handoff now. */
  handoff: { ok: boolean; reason: string | null };
  /** A turn is running: the move waits for it, then stops it. */
  working: boolean;
  /** What the move drops, because it ends with the process the chat leaves. */
  dropped: { approvals: number; queued: number; agents: number };
}

/** PATCH body for a session: rename it (FR4). */
export interface UpdateChatSessionRequest {
  title: string;
}

/** What a delete did: the portal's rows are gone; `purged` says whether its files in the workspace went too. */
export interface DeleteChatSessionResult {
  purged: boolean;
  /** What happened to its worktree: none, or `kept` (the folder stays) or `removed` (the branch goes only when merged). */
  worktree?: 'none' | 'kept' | 'removed';
}

export const CLAUDE_NAME_MAX = 40;

export const CHAT_SESSION_TITLE_MAX = 80;

/**
 * T-294: the name of an agent a session runs as (`ChatSession.agent`, a worker's `role`): an agent definition in the session's folder,
 * `.claude/agents/<name>.md`. A plain name, never a path, and never starting with `-` (it is passed to Claude Code as `--agent <name>`).
 */
export const CHAT_AGENT_NAME = /^[a-z][a-z0-9-]{1,40}$/;

export const CHAT_API = {
  /** GET: sessions, newest activity first. POST: create one. */
  list: '/api/chat/sessions',
  create: '/api/chat/sessions',
  /** GET: one session. PATCH `UpdateChatSessionRequest`: rename it. DELETE `?worktree=keep|remove|force`: delete it (ending it first), `DeleteChatSessionResult`. */
  one: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}`,
  /** POST: end it. */
  end: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/end`,
  /** POST `?worktree=keep|remove|force`: archive it (ending it first if it hasn't ended). DELETE: unarchive it. */
  archive: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/archive`,
  /** POST: pin it (any state). DELETE: unpin it. */
  pin: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/pin`,
  /** PATCH `UpdateRestartHintRequest`: hide the "Tools changed" hint until the next change, or the automatic restart setting (T-102). */
  restartHint: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/restart-hint`,
  /** PATCH `UpdateChatLimitsRequest`: its workers at once and its sub-agents on or off (T-294), `ChatLimitsResult`. Never by the session itself. */
  limits: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/limits`,
  /** GET: the chat's Keep going (`ChatKeepGoing`). PUT `UpdateKeepGoingRequest`: set it (a person; T-259). */
  keepGoing: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/keep-going`,
  /** GET `?after=<seq>`: stored transcript events after a sequence number (history and resume). */
  events: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/events`,
  /** GET: models this session can switch to. */
  models: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/models`,
  /** GET: sub-agents and background tasks. */
  tasks: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/tasks`,
  /** GET `?after=<seq>`: one sub-agent's own transcript (`ChatTaskTranscript`), bounded by `TASK_EVENTS_MAX`. */
  taskEvents: (id: string, taskId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/events`,
  /** GET: an image's bytes (attachments and tool images). */
  blob: (id: string, blobId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/blobs/${blobId}`,
  /** GET `?path=`: a folder's entries in the session's workspace (default: the session's folder). */
  files: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/files`,
  /** GET: what removing the session's worktree would lose (`ChatWorktreeStatus`), or null when it has none. */
  worktree: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/worktree`,
  /** GET `?workspaceId=&folder=`: a workspace's worktrees (`ChatWorktreeEntry[]`); `folder` also asks git about that repository's. */
  worktrees: '/api/chat/worktrees',
  /** GET: where Bypass stands for the session (`ChatBypassState`). POST `EnterBypassRequest`: turn it on, after the server code was checked again. */
  bypass: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/bypass`,
  /** POST: restart the session so it can enter Bypass (at its next turn boundary); the policy must allow it. */
  bypassAllow: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/bypass/allow`,
  /**
   * POST `RestartChatRequest`: stop the session's Claude Code process at a turn boundary and start it again on the same conversation
   * (`--resume`), so it reconnects its MCP servers and reads what was delivered since. Model, effort and mode come back; Bypass too
   * when the policy still allows it. Refused while a turn runs or an approval waits, unless `interrupt`; `when: 'turn_end'` queues it
   * for the next boundary (T-102). DELETE: cancel a queued restart.
   */
  restart: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/restart`,
  /**
   * POST `RecoverChatRequest` (T-136): a session ended for integrity comes back IN PLACE: the same id and row, its conversation resumed
   * (`--resume`) on a fresh log segment, the offending line not read again, Bypass kept only as a Restart keeps it. Never for a session
   * a person closed. Capped per day, with a pause between recoveries.
   */
  recover: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/recover`,
  /**
   * POST (no body; T-284): clear a request no Claude Code process can answer any more (the process that raised it is not the live one:
   * a move, a restart, a crash, a resume). Every stale request of the chat is resolved `stale` with it, audited. Refused (409) for a
   * request of the live process: that one is answered. Returns `ClearChatRequestResult`.
   */
  clearRequest: (id: string, requestId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}/clear`,
  /** POST `ReauthRequest`: check the server code again. */
  reauth: '/api/chat/reauth',
  /** GET: the chat policy (`{ bypass: { allowed } }`). */
  policy: '/api/chat/policy',
  /** GET `?kind=&sessionId=&limit=`: the audit trail (`ChatAuditEntry[]`). */
  audit: '/api/chat/audit',
  /** GET `?path=`: a file's bytes, as a download. */
  download: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/files/download`,
  /** GET: what changed in the session's folder (git), as a summary and a unified diff. */
  diff: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/diff`,
  /** GET `?range=&claudeId=&tz=`: usage over time (`ChatUsageReport`). */
  usage: '/api/chat/usage',
  /** GET `?workspaceId=&folder=`: what a folder would load (FR43). */
  scan: '/api/chat/trust/scan',
  /** POST `ChatTrustRequest`: trust a folder as scanned. */
  trust: '/api/chat/trust',
  /** GET `?workspaceId=`: Claudes on a workspace. POST: create one (empty directory, no sign-in). */
  claudes: '/api/chat/claudes',
  /** POST `SwitchChatRequest`: confirm the move of a chat to another Claude on the same workspace; the chat stays the same session. */
  switch: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/switch`,
  /** GET: where the chat can move, and whether each Claude can take it now (`ChatSwitchOptions`). */
  switchOptions: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/switch-options`,
  /** GET: the runs of the chat on Claudes, oldest first (`ChatSegment[]`). */
  segments: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/segments`,
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
  /**
   * Set when the folder is a worktree the portal just made for a start that is waiting on this trust: the request to send again
   * (repository, the branch it chose, the base), so the retry reuses that worktree instead of making another.
   */
  worktree?: ChatWorktreeRequest;
}

/** `POST CHAT_API.trust`: trust a folder as scanned. */
export interface ChatTrustRequest {
  workspaceId: string;
  folder: string;
  hash: string;
}

/** The error code a session start returns when its folder needs confirming first; `details` is the `ChatFolderScan`. */
export const CHAT_FOLDER_UNTRUSTED = 'FOLDER_UNTRUSTED';

/**
 * The error code (409) of a create, resume, wake or send refused because the workspace can't host
 * sessions now: sessions run only on the keys an active, synced Account Pool delivers. The message says why.
 */
export const CHAT_INELIGIBLE = 'CHAT_INELIGIBLE';

/** `endedReason` prefixes of sessions the portal ended at once (credential or integrity check); the rest is why. */
export const CHAT_ENDED_CREDENTIAL = 'credential: ';
export const CHAT_ENDED_INTEGRITY = 'integrity: ';

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
   * change what applies from the next request; `cancel_queued` withdraws a queued message; `rename`
   * sets the title.
   */
  op: 'stop' | 'end' | 'model' | 'effort' | 'ultracode' | 'mode' | 'cancel_queued' | 'resume' | 'stop_task' | 'rename';
  /** Used to key the `ack`; any client-chosen string. */
  uuid?: string;
  args?: { model?: string; effort?: string; ultracode?: boolean; mode?: ChatPermissionMode; inputUuid?: string; taskId?: string; title?: string };
}
export type ChatClientMessage = ChatSubscribe | ChatUnsubscribe | ChatSend | ChatRespond | ChatControl | BtwClientMessage;

/* ---------- Socket: portal → browser ---------- */

export type ChatServerMessage =
  /** Stored events, in order, for a subscribed session (also the backlog on subscribe). */
  | { type: 'events'; session: string; items: ChatEvent[] }
  /** Live assistant tokens for the open block; never stored, not replayed on resume. */
  | {
      type: 'delta';
      session: string;
      agentLabel: string | null;
      /** A sub-agent's piece: the `Task` call that started it (`ChatTask.toolUseId`). Absent for the main agent. */
      parentToolUseId?: string;
      text: string;
      /** A thinking block opened (no text); `elapsedMs` says how long ago, for a tab that joins late. */
      thinking?: boolean;
      elapsedMs?: number;
    }
  /** The session's state/counters changed. */
  | { type: 'session'; session: ChatSession }
  /** The session was deleted; its transcript is gone. */
  | { type: 'removed'; session: string }
  /** Result of a send/respond/control the tab sent. */
  | { type: 'ack'; uuid: string; ok: boolean; error?: string; code?: string }
  /** A sent message moved through Claude Code's queue (queued → started → completed, or cancelled). */
  | { type: 'input'; session: string; uuid: string; state: ChatInputState }
  /** The session's sub-agents and background tasks changed (the full current list). */
  | { type: 'tasks'; session: string; tasks: ChatTask[] }
  | { type: 'error'; session?: string; message: string }
  /** A side question's state and streamed text: only to the tabs of the person who asked (chatBtw.ts). */
  | BtwServerMessage;
