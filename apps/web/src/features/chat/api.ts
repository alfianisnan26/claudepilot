import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  CHAT_API,
  type ChatDiff,
  type ChatEvent,
  type ChatFolder,
  type ChatFolderScan,
  type ChatModelOption,
  type ChatSession,
  type ChatTask,
  type ChatTrustRequest,
  type CreateChatSessionRequest,
  type CreateWorkspaceClaudeRequest,
  type TransferChatRequest,
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

export const chatApi = {
  list: () => request<ChatSession[]>('GET', CHAT_API.list),
  create: (body: CreateChatSessionRequest) => request<ChatSession>('POST', CHAT_API.create, body),
  get: (id: string) => request<ChatSession>('GET', CHAT_API.one(id)),
  end: (id: string) => request<{ ok: true }>('DELETE', CHAT_API.one(id)),
  history: (id: string, after?: number) =>
    request<ChatEvent[]>('GET', CHAT_API.events(id) + (after !== undefined ? `?after=${after}` : '')),
  /** Models this session can switch to (Claude Code's own list). */
  models: (id: string) => request<ChatModelOption[]>('GET', CHAT_API.models(id)),
  /** Sub-agents and background tasks, the full current list. */
  tasks: (id: string) => request<ChatTask[]>('GET', CHAT_API.tasks(id)),
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
  transfer: (id: string, body: TransferChatRequest) => request<ChatSession>('POST', CHAT_API.transfer(id), body),
};
