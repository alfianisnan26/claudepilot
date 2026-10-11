import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  ACCOUNT_API,
  API,
  POOLS_API,
  WORKSPACE_API,
  type AssignPoolResult,
  type MultiPoolType,
  type PoolDetail,
  type PoolPreview,
  type PoolPreviewRequest,
  type PoolRequest,
  type PoolSummary,
  type SetWorkspacePoolsRequest,
  type SetWorkspacePoolsResult,
  type WorkspacePools,
  type Account,
  type AccountPool,
  type AccountPoolRequest,
  type AccountsOverview,
  type AssignAccountPoolRequest,
  type BulkAddAccountsRequest,
  type BulkAddAccountsResult,
  type ClaudeAuthStatus,
  type ClaudeLoginRequest,
  type ClaudeLoginStart,
  type CreateAccountRequest,
  type KeySetupResult,
  type KeyUnlockResult,
  type Endpoint,
  type EndpointRequest,
  type PreflightResult,
  type UpdateAccountRequest,
  type WorkspaceAccountState,
  type WorkspaceDeliveryState,
  type AdminState,
  type CreateWorkspaceRequest,
  type RotateCodeRequest,
  type SessionStatus,
  type SystemStatus,
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
  system: () => request<SystemStatus>('GET', API.system),
  resumeDelivery: () => request<SystemStatus>('POST', API.resumeDelivery),
  keySetup: () => request<KeySetupResult>('POST', API.keySetup),
  keyReset: () => request<KeySetupResult>('POST', API.keyReset),
  keyUnlock: (key: string) => request<KeyUnlockResult>('POST', API.keyUnlock, { key }),
  accounts: {
    overview: () => request<AccountsOverview>('GET', ACCOUNT_API.overview),
    create: (body: CreateAccountRequest) => request<Account>('POST', ACCOUNT_API.create, body),
    bulk: (body: BulkAddAccountsRequest) => request<BulkAddAccountsResult>('POST', ACCOUNT_API.bulk, body),
    update: (id: string, body: UpdateAccountRequest) => request<Account>('PATCH', ACCOUNT_API.one(id), body),
    check: (id: string) => request<Account>('POST', ACCOUNT_API.check(id)),
    clearHealth: (id: string) => request<Account>('POST', ACCOUNT_API.clearHealth(id)),
    remove: (id: string) => request<{ ok: true }>('DELETE', ACCOUNT_API.one(id)),
    createEndpoint: (body: EndpointRequest) => request<Endpoint>('POST', ACCOUNT_API.endpoints, body),
    updateEndpoint: (id: string, body: EndpointRequest) => request<Endpoint>('PATCH', ACCOUNT_API.endpoint(id), body),
    removeEndpoint: (id: string) => request<{ ok: true }>('DELETE', ACCOUNT_API.endpoint(id)),
    endpointModels: (id: string) => request<string[]>('GET', ACCOUNT_API.endpointModels(id)),
    pools: () => request<AccountPool[]>('GET', ACCOUNT_API.pools),
    createPool: (body: AccountPoolRequest) => request<AccountPool>('POST', ACCOUNT_API.pools, body),
    updatePool: (id: string, body: Partial<AccountPoolRequest>) => request<AccountPool>('PATCH', ACCOUNT_API.pool(id), body),
    removePool: (id: string) => request<{ ok: true }>('DELETE', ACCOUNT_API.pool(id)),
    assign: (workspaceId: string, body: AssignAccountPoolRequest) =>
      request<{ account: WorkspaceAccountState | null }>('PUT', ACCOUNT_API.workspaceAccount(workspaceId), body),
    preflight: (workspaceId: string) => request<PreflightResult>('GET', ACCOUNT_API.workspacePreflight(workspaceId)),
    adopt: (workspaceId: string) => request<{ delivery: WorkspaceDeliveryState | null }>('POST', ACCOUNT_API.workspaceAdopt(workspaceId)),
  },
  workspaces: {
    targets: (fresh = false) => request<WorkspaceTarget[]>('GET', WORKSPACE_API.targets + (fresh ? '?fresh=1' : '')),
    list: () => request<Workspace[]>('GET', WORKSPACE_API.list),
    usage: () => request<WorkspaceUsage[]>('GET', WORKSPACE_API.usage),
    create: (body: CreateWorkspaceRequest) => request<Workspace>('POST', WORKSPACE_API.list, body),
    start: (id: string) => request<{ ok: true }>('POST', `${WORKSPACE_API.one(id)}/start`),
    stop: (id: string) => request<{ ok: true }>('POST', `${WORKSPACE_API.one(id)}/stop`),
    remove: (id: string) => request<{ ok: true }>('DELETE', WORKSPACE_API.one(id)),
    claudeAuthStatus: (id: string) => request<ClaudeAuthStatus>('GET', WORKSPACE_API.claudeLogin(id)),
    claudeLogin: (id: string, body: ClaudeLoginRequest = {}) => request<ClaudeLoginStart>('POST', WORKSPACE_API.claudeLogin(id), body),
    claudeLoginCode: (id: string, code: string) => request<{ ok: true }>('POST', WORKSPACE_API.claudeLoginCode(id), { code }),
    cancelClaudeLogin: (id: string) => request<{ ok: true }>('DELETE', WORKSPACE_API.claudeLogin(id)),
    claudeLogout: (id: string) => request<{ ok: true }>('POST', WORKSPACE_API.claudeLogout(id)),
  },
  /** Multi-assignment pools (secrets & env, skillsets, MCP sets): one API for every type. */
  pools: {
    types: () => request<{ types: MultiPoolType[] }>('GET', POOLS_API.types),
    list: (type: MultiPoolType) => request<PoolSummary[]>('GET', POOLS_API.list(type)),
    get: (type: MultiPoolType, id: string) => request<PoolDetail>('GET', POOLS_API.one(type, id)),
    create: (type: MultiPoolType, body: PoolRequest) => request<PoolSummary>('POST', POOLS_API.list(type), body),
    update: (type: MultiPoolType, id: string, body: Partial<PoolRequest>) => request<PoolSummary>('PUT', POOLS_API.one(type, id), body),
    remove: (type: MultiPoolType, id: string) => request<{ ok: true }>('DELETE', POOLS_API.one(type, id)),
    duplicate: (type: MultiPoolType, id: string, name: string) => request<PoolSummary>('POST', POOLS_API.duplicate(type, id), { name }),
    approve: (type: MultiPoolType, id: string, revision: number) => request<PoolSummary>('POST', POOLS_API.approve(type, id, revision)),
    makeCurrent: (type: MultiPoolType, id: string, revision: number) => request<PoolSummary>('POST', POOLS_API.current(type, id, revision)),
    rollout: (type: MultiPoolType, id: string, paused: boolean, reason?: string) =>
      request<PoolSummary>('POST', POOLS_API.rollout(type, id), { paused, reason }),
    assign: (type: MultiPoolType, id: string, workspaceIds: string[]) => request<AssignPoolResult>('POST', POOLS_API.assign(type, id), { workspaceIds }),
    /** `id` null: a pool not saved yet (then `content` is required). */
    preview: (type: MultiPoolType, id: string | null, body: PoolPreviewRequest = {}) => request<PoolPreview>('POST', POOLS_API.preview(type, id), body),
    workspace: (workspaceId: string) => request<WorkspacePools>('GET', POOLS_API.workspace(workspaceId)),
    setWorkspace: (workspaceId: string, type: MultiPoolType, body: SetWorkspacePoolsRequest) =>
      request<SetWorkspacePoolsResult>('PUT', POOLS_API.workspaceType(workspaceId, type), body),
  },
};

export const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
