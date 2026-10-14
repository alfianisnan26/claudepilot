import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  CHAT_API,
  type ChatBypassState,
  type ChatDiff,
  type ChatEvent,
  type ChatFolder,
  type ChatFolderScan,
  type ChatKeepGoing,
  type ChatModelOption,
  type ChatSession,
  type ChatSegment,
  type ChatSwitchOptions,
  type ChatTask,
  type ChatTaskTranscript,
  type ChatTrustRequest,
  type ChatWorktreeRemoval,
  type ChatWorktreeStatus,
  type ChatUsageRange,
  type ChatUsageReport,
  type UpdateKeepGoingRequest,
  type CreateChatSessionRequest,
  type CreateWorkspaceClaudeRequest,
  type DeleteChatSessionResult,
  type EnterBypassRequest,
  type ReauthRequest,
  type RestartChatRequest,
  type SwitchChatRequest,
  type UpdateChatSessionRequest,
  type UpdateRestartHintRequest,
  type WorkspaceClaude,
} from '@portal/contracts';
import { ApiError } from '@/lib/api';

/**
 * The chat endpoints, fetched exactly like `lib/api.ts`: same-origin credentials (Hono's `csrf`
 * is satisfied by the browser's `Origin` on a same-origin request), JSON only when there's a body,
 * and the shared `{ data }` / `{ error }` envelope unwrapped into the value or an `ApiError`.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await track(
      fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/** A query string from the options that are set. */
const query = (o: Record<string, string | undefined>) => {
  const set = Object.entries(o).filter((e): e is [string, string] => !!e[1]);
  return set.length ? `?${set.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : '';
};
/** `?children=end` on an end: also end the sessions this one started (absent, they keep running). */
const childrenQuery = (children?: 'end') => query({ children });

export const chatApi = {
  list: () => request<ChatSession[]>('GET', CHAT_API.list),
  create: (body: CreateChatSessionRequest) => request<ChatSession>('POST', CHAT_API.create, body),
  get: (id: string) => request<ChatSession>('GET', CHAT_API.one(id)),
  end: (id: string, children?: 'end') => request<{ ok: true }>('POST', CHAT_API.end(id) + childrenQuery(children)),
  /** The sessions a session started. */
  children: (id: string) => request<ChatSession[]>('GET', `${CHAT_API.list}?parentId=${encodeURIComponent(id)}`),
  rename: (id: string, title: string) => request<ChatSession>('PATCH', CHAT_API.one(id), { title } satisfies UpdateChatSessionRequest),
  /** Deletes it, ending it first: the transcript and its files in the workspace go (FR4). */
  remove: (id: string, worktree?: ChatWorktreeRemoval, children?: 'end') =>
    request<DeleteChatSessionResult>('DELETE', CHAT_API.one(id) + query({ worktree: worktree && worktree !== 'keep' ? worktree : undefined, children })),
  /** Usage over a window, in buckets that line up with this device's clock; optionally one Claude's. */
  usage: (range: ChatUsageRange, claudeId?: string) =>
    request<ChatUsageReport>(
      'GET',
      `${CHAT_API.usage}?range=${range}&tz=${new Date().getTimezoneOffset()}${claudeId ? `&claudeId=${encodeURIComponent(claudeId)}` : ''}`,
    ),
  /** Archive (ending it first if it hasn't ended), or bring it back to the list. */
  archive: (id: string, worktree?: ChatWorktreeRemoval, children?: 'end') =>
    request<ChatSession>('POST', CHAT_API.archive(id) + query({ worktree: worktree && worktree !== 'keep' ? worktree : undefined, children })),
  /** What removing the session's worktree would lose; null for a session in a plain folder. */
  worktreeStatus: (id: string) => request<ChatWorktreeStatus | null>('GET', CHAT_API.worktree(id)),
  unarchive: (id: string) => request<ChatSession>('DELETE', CHAT_API.archive(id)),
  pin: (id: string) => request<ChatSession>('POST', CHAT_API.pin(id)),
  unpin: (id: string) => request<ChatSession>('DELETE', CHAT_API.pin(id)),
  history: (id: string, after?: number) =>
    request<ChatEvent[]>('GET', CHAT_API.events(id) + (after !== undefined ? `?after=${after}` : '')),
  /** Models this session can switch to (Claude Code's own list). */
  models: (id: string) => request<ChatModelOption[]>('GET', CHAT_API.models(id)),
  /** Sub-agents and background tasks, the full current list. */
  tasks: (id: string) => request<ChatTask[]>('GET', CHAT_API.tasks(id)),
  /** One sub-agent's own transcript after a seq (bounded): the detail view's lines. */
  taskEvents: (id: string, taskId: string, after = 0) => request<ChatTaskTranscript>('GET', `${CHAT_API.taskEvents(id, taskId)}?after=${after}`),
  /** Where an image's bytes are served (attachments and tool images); plain same-origin GET. */
  blobUrl: (id: string, blobId: string) => CHAT_API.blob(id, blobId),
  /** A folder in the session's workspace; without a path, the session's own folder. */
  files: (id: string, path?: string) =>
    request<ChatFolder>('GET', CHAT_API.files(id) + (path ? `?path=${encodeURIComponent(path)}` : '')),
  /** Where a file downloads from (an attachment); plain same-origin GET, for `<a download>`. */
  downloadUrl: (id: string, path: string) => `${CHAT_API.download(id)}?path=${encodeURIComponent(path)}`,
  /** What changed in the session's folder (git status and the unified diff). */
  diff: (id: string) => request<ChatDiff>('GET', CHAT_API.diff(id)),
  /** What a folder's own Claude Code settings would load when a session starts there, by name. */
  scan: (workspaceId: string, folder: string) =>
    request<ChatFolderScan>('GET', `${CHAT_API.scan}?workspaceId=${encodeURIComponent(workspaceId)}&folder=${encodeURIComponent(folder)}`),
  /** Trusts a folder as scanned; `FOLDER_UNTRUSTED` (with the new scan) when its files changed since. */
  trust: (body: ChatTrustRequest) => request<unknown>('POST', CHAT_API.trust, body).then(() => undefined),
  claudes: (workspaceId: string) => request<WorkspaceClaude[]>('GET', `${CHAT_API.claudes}?workspaceId=${encodeURIComponent(workspaceId)}`),
  createClaude: (body: CreateWorkspaceClaudeRequest) => request<WorkspaceClaude>('POST', CHAT_API.claudes, body),
  /** Moves the chat to another Claude; it stays the same session. Resolves when the new Claude has taken the context. */
  switch: (id: string, body: SwitchChatRequest) => request<ChatSession>('POST', CHAT_API.switch(id), body),
  /** Where the chat can move, and whether each Claude can take it now: asked before the person confirms. */
  switchOptions: (id: string) => request<ChatSwitchOptions>('GET', CHAT_API.switchOptions(id)),
  /** The runs of the chat on Claudes, oldest first. */
  segments: (id: string) => request<ChatSegment[]>('GET', CHAT_API.segments(id)),
  /** Where Bypass stands for the session: the mode picker and the confirmation read it. */
  bypass: (id: string) => request<ChatBypassState>('GET', CHAT_API.bypass(id)),
  /** Turns Bypass on, after the person's confirmation; `REAUTH_REQUIRED` until the server code was checked again. */
  enterBypass: (id: string, body: EnterBypassRequest) => request<ChatSession>('POST', CHAT_API.bypass(id), body),
  /** Restarts the session so it can enter Bypass, at its next turn boundary. */
  allowBypass: (id: string) => request<ChatSession>('POST', CHAT_API.bypassAllow(id)),
  /** Restarts the session's Claude Code on the same conversation, at a turn boundary, so its MCP servers reconnect. */
  restart: (id: string, why: 'mcp' | 'manual', opts: Omit<RestartChatRequest, 'why'> = {}) => request<ChatSession>('POST', CHAT_API.restart(id), { why, ...opts } satisfies RestartChatRequest),
  /** Cancels a restart that waits for the turn's end (T-102). */
  cancelRestart: (id: string) => request<ChatSession>('DELETE', CHAT_API.restart(id)),
  /** The "Tools changed" hint's memory: hidden until the next change, and applying changes at the turn's end by itself (T-102). */
  restartHint: (id: string, body: UpdateRestartHintRequest) => request<ChatSession>('PATCH', CHAT_API.restartHint(id), body),
  /** Keep going (T-259): the chat's policy, today's counts and its last action; null when it never had one. */
  keepGoing: (id: string) => request<ChatKeepGoing | null>('GET', CHAT_API.keepGoing(id)),
  /** Sets Keep going (a person only). */
  setKeepGoing: (id: string, body: UpdateKeepGoingRequest) => request<ChatKeepGoing>('PUT', CHAT_API.keepGoing(id), body),
  /** Checks the server code again (what Bypass guards). */
  reauth: (code: string) => request<{ ok: true }>('POST', CHAT_API.reauth, { code } satisfies ReauthRequest),
  /** What the chat policy allows: whether a session can be started to allow Bypass. */
  policy: () => request<{ bypass: { allowed: boolean } }>('GET', CHAT_API.policy),
};
