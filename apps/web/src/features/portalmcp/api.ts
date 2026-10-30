import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  PORTAL_MCP_API,
  type CreatePortalTokenRequest,
  type CreatedPortalToken,
  type PortalAgentWorkspace,
  type PortalAuditRow,
  type PortalLockdownResult,
  type PortalMcpSettings,
  type PortalMcpState,
  type PortalToken,
  type RevokePortalTokenLabelRequest,
  type RevokePortalTokenLabelResult,
  type UpdatePortalMcpSettingsRequest,
  type UpdatePortalTokenRequest,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/** Same contract as lib/api's client: `{ data }` on success, an ApiError otherwise; a 401 tells the app the session ended. */
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

export const portalMcpApi = {
  state: () => request<PortalMcpState>('GET', PORTAL_MCP_API.state),
  updateSettings: (body: UpdatePortalMcpSettingsRequest) => request<PortalMcpSettings>('PUT', PORTAL_MCP_API.settings, body),
  createToken: (body: CreatePortalTokenRequest) => request<CreatedPortalToken>('POST', PORTAL_MCP_API.tokens, body),
  updateToken: (id: string, body: UpdatePortalTokenRequest) => request<PortalToken>('PATCH', PORTAL_MCP_API.token(id), body),
  revokeToken: (id: string) => request<{ ok: true }>('DELETE', PORTAL_MCP_API.token(id)),
  revokeLabel: (body: RevokePortalTokenLabelRequest) => request<RevokePortalTokenLabelResult>('POST', PORTAL_MCP_API.revokeLabel, body),
  revokeAll: () => request<PortalLockdownResult>('POST', PORTAL_MCP_API.revokeAll),
  audit: (query: { tool?: string; outcome?: string; before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, String(v));
    return request<PortalAuditRow[]>('GET', `${PORTAL_MCP_API.audit}${q.size ? `?${q}` : ''}`);
  },
  agents: () => request<PortalAgentWorkspace[]>('GET', PORTAL_MCP_API.agents),
  setAgentAccess: (workspaceId: string, enabled: boolean) => request<{ workspaceId: string; enabled: boolean; revoked: number }>('PUT', PORTAL_MCP_API.agent(workspaceId), { enabled }),
};
