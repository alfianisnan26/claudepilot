import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  rememberWorkspaceLabelMap,
  rememberWorkspaceLabels,
  type RenameWorkspaceResult,
  ACCOUNT_API,
  API,
  POOLS_API,
  WORKSPACE_API,
  type AssignPoolResult,
  type MultiPoolType,
  type PoolCurrentRequest,
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
  type CreateTerminalRequest,
  type WorkspaceClaude,
  type WorkspaceClaudeState,
  type WorkspaceTerminal,
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
  PORTAL_USER_API,
  type CreatePortalUserRequest,
  type PortalUser,
  type SignedInAs,
  type ChatEvent,
  type ChatEventPage,
  type SessionGrant,
  type SessionShare,
  type SessionShareOverview,
  type SessionShareRequest,
  type PortalTeam,
  type PortalTeamDetail,
  type PortalTeamRole,
  type CreatePortalTeamRequest,
  type UpdatePortalTeamRequest,
  type AddPortalTeamMemberRequest,
  PORTAL_TEAM_API,
  type SignInMethod,
  type SsoProvider,
  type SsoProviderRequest,
  SSO_API,
  SCHEDULES_API,
  MANAGER_API,
  type ManagerStatus,
  type PortalLoop,
  TRIGGER_API,
  type Trigger,
  APP_PORTS_API,
  type AppPortSession,
  type DelegatedSession,
  SESSION_GRANT_API,
  type UpdatePortalUserRequest,
  type SystemStatus,
  type Workspace,
  type WorkspaceTarget,
  type WorkspaceUsage,
  type WorkspaceResources,
  type UpdateWorkspaceResourcesRequest,
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

/** `?claude=<id>` for a Claude other than Default. */
const asClaude = (claudeId?: string) => (claudeId ? `?claude=${encodeURIComponent(claudeId)}` : '');

export const api = {
  session: () => request<SessionStatus>('GET', API.session),
  login: (code: string) => request<AdminState>('POST', API.login, { code }),
  /** T-118: an email account's sign-in (the same session the code gives). */
  loginEmail: (email: string, password: string) => request<AdminState>('POST', API.login, { email, password }),
  users: () => request<PortalUser[]>('GET', PORTAL_USER_API.list),
  createUser: (body: CreatePortalUserRequest) => request<PortalUser>('POST', PORTAL_USER_API.list, body),
  updateUser: (id: string, body: UpdatePortalUserRequest) => request<PortalUser>('PATCH', PORTAL_USER_API.one(id), body),
  removeUser: (id: string) => request<{ removed: true }>('DELETE', PORTAL_USER_API.one(id)),
  /** Your own password (an account session, a member too): the other sessions of the account end. */
  changeMyPassword: (current: string, next: string) => request<{ ok: true }>('POST', PORTAL_USER_API.myPassword, { current, next }),
  me: () => request<SignedInAs>('GET', PORTAL_USER_API.me),
  // Session delegation (owner, 2026-10-17).
  sessionGrants: (sessionId: string) => request<SessionGrant[]>('GET', SESSION_GRANT_API.grants(sessionId)),
  shareSession: (sessionId: string, req: SessionShareRequest) => request<SessionShare>('PUT', SESSION_GRANT_API.grants(sessionId), req),
  allShares: () => request<SessionShareOverview[]>('GET', SESSION_GRANT_API.all),
  updateShare: (id: string, patch: Partial<Omit<SessionShareRequest, 'subject'>>) => request<SessionShare>('PATCH', SESSION_GRANT_API.share(id), patch),
  revokeShare: (id: string) => request<{ removed: boolean }>('DELETE', SESSION_GRANT_API.share(id)),
  // Teams (owner, 2026-10-17).
  teams: () => request<PortalTeam[]>('GET', PORTAL_TEAM_API.teams),
  createTeam: (req: CreatePortalTeamRequest) => request<PortalTeam>('POST', PORTAL_TEAM_API.teams, req),
  updateTeam: (id: string, req: UpdatePortalTeamRequest) => request<PortalTeam>('PATCH', PORTAL_TEAM_API.team(id), req),
  removeTeam: (id: string) => request<{ removed: true }>('DELETE', PORTAL_TEAM_API.team(id)),
  team: (id: string) => request<PortalTeamDetail>('GET', PORTAL_TEAM_API.one(id)),
  myTeams: () => request<PortalTeam[]>('GET', PORTAL_TEAM_API.mine),
  addTeamMember: (id: string, req: AddPortalTeamMemberRequest) => request<PortalTeamDetail>('POST', PORTAL_TEAM_API.members(id), req),
  setTeamRole: (id: string, userId: string, role: PortalTeamRole) => request<PortalTeamDetail>('PATCH', PORTAL_TEAM_API.member(id, userId), { role }),
  removeTeamMember: (id: string, userId: string) => request<{ removed: boolean }>('DELETE', PORTAL_TEAM_API.member(id, userId)),
  // The General Manager (T-968).
  managerStatus: () => request<ManagerStatus>('GET', MANAGER_API.status),
  enableManager: (workspaceId?: string) => request<ManagerStatus>('POST', MANAGER_API.enable, workspaceId ? { workspaceId } : {}),
  disableManager: () => request<ManagerStatus>('POST', MANAGER_API.disable, {}),
  // Schedules and open apps (owner, 2026-10-18).
  portalLoops: () => request<PortalLoop[]>('GET', SCHEDULES_API.loops),
  triggers: () => request<Trigger[] | { items: Trigger[] }>('GET', TRIGGER_API.list).then((d) => (Array.isArray(d) ? d : (d.items ?? []))),
  appSessions: () => request<AppPortSession[]>('GET', APP_PORTS_API.sessions),
  closeAppSession: (id: string) => request<{ removed: boolean }>('DELETE', APP_PORTS_API.session(id)),
  // SSO (owner, 2026-10-17).
  signInMethod: (email: string) => request<SignInMethod>('POST', SSO_API.discover, { email }),
  ssoProviders: () => request<SsoProvider[]>('GET', SSO_API.providers),
  createSso: (req: SsoProviderRequest) => request<SsoProvider>('POST', SSO_API.providers, req),
  updateSso: (id: string, req: SsoProviderRequest) => request<SsoProvider>('PATCH', SSO_API.provider(id), req),
  removeSso: (id: string) => request<{ removed: true }>('DELETE', SSO_API.provider(id)),
  testSso: (id: string) => request<{ ok: true; authorizationEndpoint: string }>('POST', SSO_API.test(id), {}),
  delegated: () => request<DelegatedSession[]>('GET', SESSION_GRANT_API.mine),
  delegatedOne: (id: string) => request<DelegatedSession>('GET', SESSION_GRANT_API.one(id)),
  delegatedEvents: (id: string, after: number) => request<ChatEvent[]>('GET', `${SESSION_GRANT_API.events(id)}?after=${after}`),
  delegatedPage: (id: string) => request<ChatEventPage>('GET', `${SESSION_GRANT_API.events(id)}?limit=80`),
  delegatedSend: (id: string, text: string) => request<{ ok: true }>('POST', SESSION_GRANT_API.send(id), { text, uuid: crypto.randomUUID() }),
  delegatedRespond: (id: string, requestId: string, decision: 'allow' | 'deny') => request<{ ok: true }>('POST', SESSION_GRANT_API.respond(id), { requestId, decision }),
  delegatedStop: (id: string) => request<{ ok: true }>('POST', SESSION_GRANT_API.stop(id), {}),
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
    // Every list teaches the labels (T-42), so places that only hold a workspace id name it by its label.
    list: () => request<Workspace[]>('GET', WORKSPACE_API.list).then((list) => (rememberWorkspaceLabels(list), list)),
    /** The labels of renamed workspaces (T-42), learned once at the app's start. */
    labels: () => request<Record<string, string>>('GET', WORKSPACE_API.labels).then((map) => (rememberWorkspaceLabelMap(map), map)),
    /** Renames a workspace: its label only (T-42); nothing running is touched. */
    rename: (id: string, label: string) => request<RenameWorkspaceResult>('PATCH', WORKSPACE_API.one(id), { label }),
    /** CPU and memory of a Kubernetes workspace (T-98): stored, live, and whether a change waits for its next start. */
    resources: (id: string) => request<WorkspaceResources>('GET', WORKSPACE_API.resources(id)),
    /** `apply: 'now'` restarts its pod (every session in it ends); `next_restart` keeps them for its next start. */
    setResources: (id: string, body: UpdateWorkspaceResourcesRequest) => request<WorkspaceResources>('PATCH', WORKSPACE_API.resources(id), body),
    usage: () => request<WorkspaceUsage[]>('GET', WORKSPACE_API.usage),
    create: (body: CreateWorkspaceRequest) => request<Workspace>('POST', WORKSPACE_API.list, body),
    start: (id: string) => request<{ ok: true }>('POST', `${WORKSPACE_API.one(id)}/start`),
    stop: (id: string) => request<{ ok: true }>('POST', `${WORKSPACE_API.one(id)}/stop`),
    remove: (id: string) => request<{ ok: true }>('DELETE', WORKSPACE_API.one(id)),
    // `claudeId`: one of the workspace's Claudes (each has its own login); Default when absent.
    claudeAuthStatus: (id: string, claudeId?: string) => request<ClaudeAuthStatus>('GET', WORKSPACE_API.claudeLogin(id) + asClaude(claudeId)),
    claudeLogin: (id: string, body: ClaudeLoginRequest = {}, claudeId?: string) =>
      request<ClaudeLoginStart>('POST', WORKSPACE_API.claudeLogin(id) + asClaude(claudeId), body),
    claudeLoginCode: (id: string, code: string, claudeId?: string) =>
      request<{ ok: true }>('POST', WORKSPACE_API.claudeLoginCode(id) + asClaude(claudeId), { code }),
    cancelClaudeLogin: (id: string, claudeId?: string) => request<{ ok: true }>('DELETE', WORKSPACE_API.claudeLogin(id) + asClaude(claudeId)),
    claudeLogout: (id: string, claudeId?: string) => request<{ ok: true }>('POST', WORKSPACE_API.claudeLogout(id) + asClaude(claudeId)),
    claudes: (id: string) => request<WorkspaceClaudeState[]>('GET', WORKSPACE_API.claudes(id)),
    renameClaude: (id: string, claudeId: string, name: string) =>
      request<WorkspaceClaude>('PATCH', `${WORKSPACE_API.claudes(id)}/${encodeURIComponent(claudeId)}`, { name }),
    removeClaude: (id: string, claudeId: string) => request<{ ok: true }>('DELETE', `${WORKSPACE_API.claudes(id)}/${encodeURIComponent(claudeId)}`),
    terminals: (id: string) => request<WorkspaceTerminal[]>('GET', WORKSPACE_API.terminals(id)),
    openTerminal: (id: string, body: CreateTerminalRequest) => request<WorkspaceTerminal>('POST', WORKSPACE_API.terminals(id), body),
    closeTerminal: (id: string, terminal: string) => request<{ ok: true }>('DELETE', `${WORKSPACE_API.terminals(id)}/${terminal}`),
  },
  /** Multi-assignment pools (secrets & env, skillsets, MCP sets): one API for every type. */
  pools: {
    types: () => request<{ types: MultiPoolType[] }>('GET', POOLS_API.types),
    list: (type: MultiPoolType) => request<PoolSummary[]>('GET', POOLS_API.list(type)),
    get: (type: MultiPoolType, id: string) => request<PoolDetail>('GET', POOLS_API.one(type, id)),
    create: (type: MultiPoolType, body: PoolRequest) => request<PoolSummary>('POST', POOLS_API.list(type), body),
    update: (type: MultiPoolType, id: string, body: Partial<PoolRequest>) => request<PoolSummary>('PUT', POOLS_API.one(type, id), body),
    remove: (type: MultiPoolType, id: string, opts: { unassign?: boolean } = {}) => request<{ ok: true } | { workspaces: string[]; warnings: string[] }>('DELETE', POOLS_API.one(type, id) + (opts.unassign ? '?unassign=1' : '')),
    duplicate: (type: MultiPoolType, id: string, name: string) => request<PoolSummary>('POST', POOLS_API.duplicate(type, id), { name }),
    approve: (type: MultiPoolType, id: string, revision: number) => request<PoolSummary>('POST', POOLS_API.approve(type, id, revision)),
    /** `restoreSecretVersions`: a Secrets & env roll back that brings back the old secret versions too (FR18). */
    makeCurrent: (type: MultiPoolType, id: string, revision: number, opts: PoolCurrentRequest = {}) => request<PoolSummary>('POST', POOLS_API.current(type, id, revision), opts),
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
