import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  MCP_API,
  type McpApproveRequest,
  type McpCatalogEntry,
  type McpEntryRequest,
  type McpEntryUpdate,
  type McpMatcher,
  type McpRevokeResult,
  type McpVersionRequest,
  type McpWorkspaceStatus,
  type PoolSummary,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/**
 * The MCP set routes (`/api/mcp`). Same contract as lib/api's client: `{ data }` on success, an
 * ApiError otherwise. On 401 it asks lib/api for the admin state once, which tells the app the
 * session ended the same way every other call does.
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
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

export const mcpApi = {
  catalog: () => request<McpCatalogEntry[]>('GET', MCP_API.catalog),
  entry: (id: string) => request<McpCatalogEntry>('GET', MCP_API.entry(id)),
  create: (body: McpEntryRequest) => request<McpCatalogEntry>('POST', MCP_API.catalog, body),
  update: (id: string, body: McpEntryUpdate) => request<McpCatalogEntry>('PATCH', MCP_API.entry(id), body),
  remove: (id: string) => request<{ ok: true }>('DELETE', MCP_API.entry(id)),
  addVersion: (id: string, body: McpVersionRequest) => request<McpCatalogEntry>('POST', MCP_API.versions(id), body),
  updateVersion: (id: string, versionId: string, body: McpVersionRequest) => request<McpCatalogEntry>('PUT', MCP_API.version(id, versionId), body),
  removeVersion: (id: string, versionId: string) => request<{ ok: true }>('DELETE', MCP_API.version(id, versionId)),
  approve: (id: string, versionId: string, body: McpApproveRequest) => request<McpCatalogEntry>('POST', MCP_API.approve(id, versionId), body),
  deprecate: (id: string, versionId: string) => request<McpCatalogEntry>('POST', MCP_API.deprecate(id, versionId)),
  revoke: (id: string, versionId: string, reason?: string) => request<McpRevokeResult>('POST', MCP_API.revoke(id, versionId), { reason }),
  tryInSet: (poolId: string, entry: string, version: string) => request<PoolSummary>('POST', MCP_API.tryInSet(poolId), { entry, version }),
  workspace: (workspaceId: string) => request<McpWorkspaceStatus>('GET', MCP_API.workspace(workspaceId)),
  matchers: (workspaceId: string) => request<McpMatcher[]>('GET', MCP_API.matchers(workspaceId)),
  retryInstalls: (workspaceId: string) => request<{ ok: true }>('POST', MCP_API.retryInstalls(workspaceId)),
  verify: (workspaceId: string) => request<{ ok: true }>('POST', MCP_API.verify(workspaceId)),
};
