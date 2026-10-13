// The client of `/api/autotransfer` (AUTOTRANSFER_API): the caller's own choices, a Claude's destinations, a chat's state and its card.
import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  AUTOTRANSFER_API,
  type AutoClaudeConfig,
  type AutoMode,
  type AutoSessionState,
  type AutoTransferEvent,
  type AutoTransferSettings,
  type AutoUserPrefs,
  type UpdateAutoClaudeRequest,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

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
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

export interface AutoOverview {
  platform: AutoTransferSettings;
  prefs: AutoUserPrefs;
  effective: AutoTransferSettings;
  claudes: AutoClaudeConfig[];
}

export const autoApi = {
  overview: () => request<AutoOverview>('GET', AUTOTRANSFER_API.settings),
  setPrefs: (p: Partial<AutoUserPrefs>) => request<{ prefs: AutoUserPrefs; effective: AutoTransferSettings }>('PUT', AUTOTRANSFER_API.prefs, p),
  setClaude: (claudeId: string, body: UpdateAutoClaudeRequest) => request<AutoClaudeConfig>('PUT', AUTOTRANSFER_API.claude(claudeId), body),
  session: (id: string) => request<AutoSessionState>('GET', AUTOTRANSFER_API.session(id)),
  setSessionMode: (id: string, mode: AutoMode | null) => request<AutoSessionState>('PUT', AUTOTRANSFER_API.session(id), { mode }),
  move: (suggestionId: string, to?: string) => request<AutoSessionState>('POST', AUTOTRANSFER_API.move(suggestionId), to ? { to } : {}),
  later: (suggestionId: string) => request<AutoSessionState>('POST', AUTOTRANSFER_API.later(suggestionId)),
  always: (suggestionId: string) => request<AutoSessionState>('POST', AUTOTRANSFER_API.always(suggestionId)),
  /** The caller's latest moves (any chat), newest first: the Home page's "last automatic move". */
  moves: (limit = 20) => request<AutoTransferEvent[]>('GET', `${AUTOTRANSFER_API.events}?kind=moved&limit=${limit}`),
  events: (session: string, limit = 20) => request<AutoTransferEvent[]>('GET', `${AUTOTRANSFER_API.events}?session=${encodeURIComponent(session)}&limit=${limit}`),
};
