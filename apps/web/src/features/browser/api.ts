import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { BROWSER_API, type BrowserAction, type BrowserContainerState, type BrowserControl, type BrowserControlRequest, type BrowserHandoffAnswer, type BrowserStatus } from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/** The browser routes (`/api/workspaces/:target/:name/browser`): same contract as lib/api's client. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

export interface BrowserConfigurationStatus {
  container: BrowserContainerState;
  error: string | null;
  sandbox: string | null;
  install: { state: 'installing' | 'installed' | 'failed'; error: string | null } | null;
}

export const browserApi = {
  status: (workspaceId: string, deviceId?: string) => request<BrowserStatus>('GET', `${BROWSER_API.workspace(workspaceId)}${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
  configuration: (workspaceId: string) => request<BrowserConfigurationStatus>('GET', `${BROWSER_API.workspace(workspaceId)}/configuration`),
  action: (workspaceId: string, action: BrowserAction) => request<{ ok: true }>('POST', `${BROWSER_API.workspace(workspaceId)}/${action}`),
  control: (workspaceId: string, body: BrowserControlRequest) => request<BrowserControl>('PUT', `${BROWSER_API.workspace(workspaceId)}/control`, body),
  answerHandoff: (workspaceId: string, handoffId: string, body: BrowserHandoffAnswer) => request<{ ok: true }>('POST', `${BROWSER_API.workspace(workspaceId)}/handoffs/${handoffId}`, body),
  retryInstall: (workspaceId: string) => request<{ ok: true }>('POST', `${BROWSER_API.workspace(workspaceId)}/install/retry`),
};
