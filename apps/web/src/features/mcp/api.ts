import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  MCP_API,
  type McpApproveRequest,
  type McpAuthEntry,
  type McpBuiltinAddRequest,
  type McpBuiltinAddResult,
  type McpBuiltinItem,
  type McpBuiltinPreview,
  type McpCatalogEntry,
  type McpEntryRequest,
  type McpEntryUpdate,
  type McpMatcher,
  type McpRevokeResult,
  type McpServerAuth,
  type McpSignInRequest,
  type McpSignInStart,
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
async function request<T>(method: string, path: string, body?: unknown, opts: { quiet?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    const sent = fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // `quiet`: a call made as someone types (the built-in preview) doesn't flash the page's activity bar.
    res = await (opts.quiet ? sent : track(sent));
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/** `?claude=<id>`: which of a workspace's Claudes an OAuth call is for; Default when absent (each Claude has its own sign-in). */
const asClaude = (claudeId?: string) => (claudeId ? `?claude=${encodeURIComponent(claudeId)}` : '');

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
  /** The built-in catalogue (PRD `mcp-builtin-catalogue`): templates with their instances; preview changes nothing, add is idempotent. */
  builtin: () => request<McpBuiltinItem[]>('GET', MCP_API.builtin),
  builtinPreview: (templateId: string, body: McpBuiltinAddRequest) => request<McpBuiltinPreview>('POST', MCP_API.builtinPreview(templateId), body, { quiet: true }),
  builtinAdd: (templateId: string, body: McpBuiltinAddRequest) => request<McpBuiltinAddResult>('POST', MCP_API.builtinAdd(templateId), body),
  /** OAuth status and the guided sign-in (MCP set PRD §13.3): Claude Code in the workspace holds the token, the portal only relays the address. */
  auth: (workspaceId: string, claudeId?: string) => request<McpAuthEntry[]>('GET', MCP_API.auth(workspaceId) + asClaude(claudeId)),
  checkAuth: (workspaceId: string, body: Partial<McpSignInRequest> = {}, claudeId?: string) => request<McpAuthEntry[]>('POST', MCP_API.auth(workspaceId) + asClaude(claudeId), body),
  signIn: (workspaceId: string, body: McpSignInRequest, claudeId?: string) => request<McpSignInStart>('POST', MCP_API.signIn(workspaceId) + asClaude(claudeId), body),
  cancelSignIn: (workspaceId: string, signInId: string) => request<{ ok: true }>('DELETE', MCP_API.signInOne(workspaceId, signInId)),
  /** The address carries the authorization code: it goes in the body, once, and the caller keeps no copy. */
  completeSignIn: (workspaceId: string, signInId: string, redirectUrl: string) => request<McpServerAuth>('POST', MCP_API.signInComplete(workspaceId, signInId), { redirectUrl }),
  signOut: (workspaceId: string, body: McpSignInRequest, claudeId?: string) => request<McpServerAuth>('POST', MCP_API.signOut(workspaceId) + asClaude(claudeId), body),
};
