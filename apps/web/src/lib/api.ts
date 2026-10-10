import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  API,
  WORKSPACE_API,
  type AdminState,
  type CreateWorkspaceRequest,
  type RotateCodeRequest,
  type SessionStatus,
  type Workspace,
  type WorkspaceTarget,
  type WorkspaceUsage,
} from '@portal/contracts';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Calls fired when any request comes back 401 (the session ended elsewhere). */
const unauthorizedListeners = new Set<() => void>();
export const onUnauthorized = (fn: () => void) => {
  unauthorizedListeners.add(fn);
  return () => void unauthorizedListeners.delete(fn);
};

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
  if (res.status === 401 && path !== API.login) unauthorizedListeners.forEach((fn) => fn());
  if (isApiErrorBody(json))
    throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

export const api = {
  session: () => request<SessionStatus>('GET', API.session),
  login: (code: string) => request<AdminState>('POST', API.login, { code }),
  logout: () => request<{ ok: true }>('POST', API.logout),
  adminState: () => request<AdminState>('GET', API.adminState),
  rotateCode: (body: RotateCodeRequest = {}) => request<AdminState>('POST', API.rotateCode, body),
  setEnabled: (enabled: boolean) => request<AdminState>('PUT', API.enabled, { enabled }),
  workspaces: {
    targets: (fresh = false) => request<WorkspaceTarget[]>('GET', WORKSPACE_API.targets + (fresh ? '?fresh=1' : '')),
    list: () => request<Workspace[]>('GET', WORKSPACE_API.list),
    usage: () => request<WorkspaceUsage[]>('GET', WORKSPACE_API.usage),
    create: (body: CreateWorkspaceRequest) => request<Workspace>('POST', WORKSPACE_API.list, body),
    start: (id: string) => request<{ ok: true }>('POST', `${WORKSPACE_API.one(id)}/start`),
    stop: (id: string) => request<{ ok: true }>('POST', `${WORKSPACE_API.one(id)}/stop`),
    remove: (id: string) => request<{ ok: true }>('DELETE', WORKSPACE_API.one(id)),
  },
};

export const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
