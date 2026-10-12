import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  REPOS_API,
  type CreateRepoWorktreeRequest,
  type CreateRepoWorktreeResult,
  type RemoveRepoWorktreeResult,
  type RepoDetail,
  type RepoEventPage,
  type RepoEventQuery,
  type RepoNode,
  type RepoSettings,
  type RepoSyncResult,
  type ReposOverview,
  type UpdateRepoSettingsRequest,
  type WorkspaceRepos,
} from '@portal/contracts';
import { ApiError } from '@/lib/api';

/** Same shape as the other features' `request`: same-origin credentials, the `{ data }` / `{ error }` envelope unwrapped. */
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

/** A query string from the set values only. */
function query(q: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const reposApi = {
  /** Every workspace's summary (the list's chips) and the repositories that need a look first. */
  overview: () => request<ReposOverview>('GET', REPOS_API.overview),
  /** A workspace's tree, from what the last scan kept (nothing is read from the workspace). */
  workspace: (workspaceId: string) => request<WorkspaceRepos>('GET', REPOS_API.workspace(workspaceId)),
  /** Scan the workspace now, or one repository and what hangs off it. */
  scan: (workspaceId: string, repoId?: string) => request<WorkspaceRepos>('POST', REPOS_API.workspaceScan(workspaceId), repoId ? { repoId } : {}),
  settings: (workspaceId: string) => request<RepoSettings>('GET', REPOS_API.workspaceSettings(workspaceId)),
  saveSettings: (workspaceId: string, body: UpdateRepoSettingsRequest) => request<RepoSettings>('PUT', REPOS_API.workspaceSettings(workspaceId), body),
  one: (id: string) => request<RepoDetail>('GET', REPOS_API.one(id)),
  events: (q: RepoEventQuery) => request<RepoEventPage>('GET', REPOS_API.events + query(q)),
  createWorktree: (id: string, body: CreateRepoWorktreeRequest) => request<CreateRepoWorktreeResult>('POST', REPOS_API.worktrees(id), body),
  removeWorktree: (id: string, mode: 'safe' | 'force') => request<RemoveRepoWorktreeResult>('DELETE', REPOS_API.worktree(id) + query({ mode })),
  /** Keep a worktree synced (fast-forward only, when clean) or stop. */
  keepSynced: (id: string, enabled: boolean) => request<RepoNode>('PUT', REPOS_API.sync(id), { enabled }),
  /** Fetch, then fast-forward when that is all it takes. */
  syncNow: (id: string) => request<RepoSyncResult>('POST', REPOS_API.sync(id)),
};
