import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  rememberWorkspaceLabelMap,
  rememberWorkspaceLabels,
  type RenameWorkspaceResult,
  ACCOUNT_API,
  API,
  VSCODE_API,
  type VscodePending,
  type AcceptedOrgInvitation,
  type AcceptOrgInvitationRequest,
  ACCESS_API,
  type AccessCatalogItem,
  type AccessObjectType,
  type AccessRequest,
  type CreateAccessRequest,
  type CreateOrgShareRequest,
  type DecideAccessRequest,
  type ObjectAccess,
  type PersonAccess,
  type CreatedOrgInvitation,
  type CreateOrgInvitationRequest,
  type OrgInvitation,
  MULTI_POOL_TYPES,
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
  LAYOUT_API,
  type LayoutKind,
  type Layouts,
  MANAGER_API,
  type ManagerStatus,
  type ScheduleRow,
  TRIGGER_API,
  type Trigger,
  type TriggerRun,
  type TriggerInput,
  type CreatedTrigger,
  type TriggerRunPage,
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
  ORGS_API,
  type ChangeOrgMemberRoleRequest,
  type CreateOrgRequest,
  type MyAbilities,
  type Org,
  type OrgDomain,
  type OrgMember,
  type OrgSignInSettings,
  type OrgSsoPolicyRequest,
  type OrgSsoProvider,
  type OrgSsoProviderRequest,
  type UpdateOrgRequest,
  KNOWLEDGE_API,
  TICKET_API,
  type BreakGlassEntry,
  type CreateOrgTeamRequest,
  type MoveToOrgRequest,
  type MoveToOrgResult,
  type OrgBreakGlassView,
  type OrgShare,
  type OrgTeam,
  type OrgTeamMember,
  type OrgTeamRole,
  type OrgTranscriptView,
  type PlatformAuditEntry,
  type SuspendOrgRequest,
  type TicketBucket,
  type VaultSummary,
} from '@portal/contracts';
import { scopedList, withOrg } from './orgContext';

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
  prepareManager: () => request<ManagerStatus>('POST', MANAGER_API.prepare, {}),
  enableManager: () => request<ManagerStatus>('POST', MANAGER_API.enable, {}),
  disableManager: () => request<ManagerStatus>('POST', MANAGER_API.disable, {}),
  // Schedules and open apps (owner, 2026-10-18).
  /** In the app's context (`?org=`): an org lists the triggers of its workspaces; Personal also the portal's own loops and helpers. */
  schedules: () => scopedList<{ items: ScheduleRow[] }>(SCHEDULES_API.list, (p) => request<{ items: ScheduleRow[] }>('GET', p)).then((d) => d.items),
  /** D-111 D6: the Home and Glance layouts of the signed-in person in one context (`personal` or an org id). */
  layouts: {
    get: (scope: string) => request<Layouts>('GET', withOrg(LAYOUT_API.all, scope)),
    save: (scope: string, kind: LayoutKind, layout: Record<string, unknown>) => request<{ saved: true }>('PUT', withOrg(LAYOUT_API.one(kind), scope), { layout }),
  },
  setTriggerEnabled: (id: string, enabled: boolean) => request<Trigger>('PATCH', TRIGGER_API.one(id), { enabled }),
  runTrigger: (id: string) => request<TriggerRun>('POST', TRIGGER_API.run(id), {}),
  // The triggers editor and the detail sheet on the Schedules page (T-2950): the trigger routes as they are.
  trigger: (id: string) => request<Trigger>('GET', TRIGGER_API.one(id)),
  triggerRuns: (id: string, limit = 5) => request<TriggerRunPage>('GET', `${TRIGGER_API.runs(id)}?limit=${limit}`),
  createTrigger: (body: TriggerInput) => request<CreatedTrigger>('POST', TRIGGER_API.list, body),
  updateTrigger: (id: string, body: Partial<TriggerInput>) => request<Trigger>('PATCH', TRIGGER_API.one(id), body),
  deleteTrigger: (id: string) => request<{ ok: true }>('DELETE', TRIGGER_API.one(id)),
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
  // The VS Code extension's sign-in (T-1974): what a code asks for, and the person's answer.
  vscodePending: (code: string) => request<VscodePending>('GET', `${VSCODE_API.pending}?code=${encodeURIComponent(code)}`),
  vscodeAnswer: (userCode: string, decision: 'approve' | 'deny') => request<{ ok: true; decision: string }>('POST', VSCODE_API.approve, { userCode, decision }),
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
    /** `scoped`: in the app's context (`?org=`, the Pools page); the workspace dialogs ask for every pool the person may use. */
    pools: (scoped = false) => (scoped ? scopedList<AccountPool[]>(ACCOUNT_API.pools, (p) => request<AccountPool[]>('GET', p)) : request<AccountPool[]>('GET', ACCOUNT_API.pools)),
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
    /** The targets of the app's context (D-111): what the Workspaces page and New workspace offer. */
    targetsScoped: () => scopedList<WorkspaceTarget[]>(WORKSPACE_API.targets, (p) => request<WorkspaceTarget[]>('GET', p)),
    // Every list teaches the labels (T-42), so places that only hold a workspace id name it by its label.
    list: () =>
      scopedList<Workspace[]>(WORKSPACE_API.list, (p) => request<Workspace[]>('GET', p)).then((list) => (rememberWorkspaceLabels(list), list)),
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
  /** Organizations (docs/prd/organizations.md §10): mine, create, settings, members. Never scoped by the context (they ARE the contexts). */
  orgs: {
    mine: () => request<Org[]>('GET', ORGS_API.orgs),
    abilities: () => request<MyAbilities>('GET', ORGS_API.abilities),
    create: (body: CreateOrgRequest) => request<Org>('POST', ORGS_API.orgs, body),
    get: (id: string) => request<Org>('GET', ORGS_API.org(id)),
    update: (id: string, body: UpdateOrgRequest) => request<Org>('PATCH', ORGS_API.org(id), body),
    members: (id: string) => request<OrgMember[]>('GET', ORGS_API.members(id)),
    setRole: (id: string, userId: string, body: ChangeOrgMemberRoleRequest) => request<OrgMember[]>('PATCH', ORGS_API.member(id, userId), body),
    remove: (id: string, userId: string) => request<{ removed: true }>('DELETE', ORGS_API.member(id, userId)),
    leave: (id: string) => request<{ left: true }>('POST', ORGS_API.leave(id)),
    /** Slice 10: the Sign-in tab (domains, the org's provider, requireSso). */
    signIn: (id: string) => request<OrgSignInSettings>('GET', ORGS_API.signIn(id)),
    addDomain: (id: string, domain: string) => request<OrgDomain>('POST', ORGS_API.domains(id), { domain }),
    removeDomain: (id: string, domain: string) => request<{ removed: true }>('DELETE', ORGS_API.domain(id, domain)),
    checkDomain: (id: string, domain: string) => request<OrgDomain>('POST', ORGS_API.checkDomain(id, domain)),
    saveSso: (id: string, body: OrgSsoProviderRequest) => request<OrgSsoProvider>('PUT', ORGS_API.sso(id), body),
    removeSso: (id: string) => request<{ removed: true }>('DELETE', ORGS_API.sso(id)),
    testSso: (id: string) => request<{ ok: true; authorizationEndpoint: string }>('POST', ORGS_API.ssoTest(id)),
    ssoPolicy: (id: string, body: OrgSsoPolicyRequest) => request<OrgSignInSettings>('PUT', ORGS_API.ssoPolicy(id), body),
    /** Slice 8: invitations (the code is answered once, on create), accepting one, suspension and deletion. */
    invitations: (id: string) => request<OrgInvitation[]>('GET', ORGS_API.invitations(id)),
    invite: (id: string, body: CreateOrgInvitationRequest) => request<CreatedOrgInvitation>('POST', ORGS_API.invitations(id), body),
    revokeInvitation: (id: string, invitationId: string) => request<{ revoked: true }>('DELETE', ORGS_API.invitation(id, invitationId)),
    acceptInvitation: (body: AcceptOrgInvitationRequest) => request<AcceptedOrgInvitation>('POST', ORGS_API.acceptInvitation, body),
    suspend: (id: string, body: SuspendOrgRequest = {}) => request<Org>('POST', ORGS_API.suspend(id), body),
    resume: (id: string) => request<Org>('POST', ORGS_API.resume(id)),
    delete: (id: string) => request<{ deleted: true }>('DELETE', ORGS_API.org(id)),
    /** Org settings (owner request 2026-11-01): teams, shares, the audit (with a kind prefix), transcript views and break-glass (owners). */
    teams: (id: string) => request<OrgTeam[]>('GET', ORGS_API.teams(id)),
    createTeam: (id: string, body: CreateOrgTeamRequest) => request<OrgTeam>('POST', ORGS_API.teams(id), body),
    removeTeam: (id: string, teamId: string) => request<{ removed: true }>('DELETE', ORGS_API.team(id, teamId)),
    teamMembers: (id: string, teamId: string) => request<OrgTeamMember[]>('GET', ORGS_API.teamMembers(id, teamId)),
    setTeamMember: (id: string, teamId: string, userId: string, role: OrgTeamRole) => request<OrgTeamMember[]>('PUT', ORGS_API.teamMember(id, teamId, userId), { role }),
    removeTeamMember: (id: string, teamId: string, userId: string) => request<{ removed: true }>('DELETE', ORGS_API.teamMember(id, teamId, userId)),
    shares: (id: string) => request<OrgShare[]>('GET', ORGS_API.shares(id)),
    /** Fine-grained access (docs/prd/access.md): grant (to the org, a team or a person, with an end and a note), and the answers around it. */
    share: (id: string, body: CreateOrgShareRequest) => request<OrgShare>('POST', ORGS_API.shares(id), body),
    accessCatalog: (id: string) => request<AccessCatalogItem[]>('GET', ACCESS_API.catalog(id)),
    objectAccess: (id: string, type: AccessObjectType, objectId: string) => request<ObjectAccess>('GET', ACCESS_API.object(id, type, objectId)),
    personAccess: (id: string, userId: string) => request<PersonAccess>('GET', ACCESS_API.person(id, userId)),
    accessRequests: (id: string) => request<AccessRequest[]>('GET', ACCESS_API.requests(id)),
    requestAccess: (id: string, body: CreateAccessRequest) => request<AccessRequest>('POST', ACCESS_API.requests(id), body),
    approveAccess: (id: string, requestId: string, body: DecideAccessRequest) => request<AccessRequest>('POST', ACCESS_API.approve(id, requestId), body),
    denyAccess: (id: string, requestId: string, body: DecideAccessRequest = {}) => request<AccessRequest>('POST', ACCESS_API.deny(id, requestId), body),
    cancelAccessRequest: (id: string, requestId: string) => request<{ cancelled: true }>('DELETE', ACCESS_API.request(id, requestId)),
    revokeShare: (id: string, shareId: string) => request<{ revoked: true }>('DELETE', ORGS_API.share(id, shareId)),
    audit: (id: string, q: { before?: number; kind?: string } = {}) => {
      const qs = new URLSearchParams();
      if (q.before) qs.set('before', String(q.before));
      if (q.kind) qs.set('kind', q.kind);
      qs.set('limit', '50');
      return request<PlatformAuditEntry[]>('GET', `${ORGS_API.audit(id)}?${qs.toString()}`);
    },
    transcriptViews: (id: string) => request<OrgTranscriptView[]>('GET', ORGS_API.transcriptViews(id)),
    breakGlass: (id: string) => request<OrgBreakGlassView>('GET', ORGS_API.breakGlass(id)),
    endBreakGlass: (id: string, entryId: string) => request<BreakGlassEntry>('POST', ORGS_API.endBreakGlass(id, entryId)),
    /** What an org owns (`scope` = its id) or what no org owns (`personal`), through the lists' `?org=` (never the app's current context). */
    objects: async (scope: string) => {
      const [workspaces, buckets, vaults, sets] = await Promise.all([
        request<Workspace[]>('GET', withOrg(WORKSPACE_API.list, scope)),
        request<TicketBucket[]>('GET', withOrg(TICKET_API.buckets, scope)),
        request<VaultSummary[]>('GET', withOrg(KNOWLEDGE_API.vaults, scope)),
        // D-111 D2: the sets of every multi-pool type (a type this portal lacks, or one that fails, adds none).
        Promise.all(MULTI_POOL_TYPES.map((t) => request<PoolSummary[]>('GET', withOrg(POOLS_API.list(t), scope)).catch(() => [] as PoolSummary[]))),
      ]);
      // Shared sets are the org's to use, not its own: Objects lists what it owns.
      return { workspaces, buckets, vaults, sets: sets.flat().filter((p) => !p.shared) };
    },
    moveWorkspace: (ref: string, body: MoveToOrgRequest) => request<MoveToOrgResult>('POST', ORGS_API.moveWorkspace(ref), body),
    moveBucket: (key: string, body: MoveToOrgRequest) => request<MoveToOrgResult>('POST', ORGS_API.moveBucket(key), body),
    moveVault: (vaultId: string, body: MoveToOrgRequest) => request<MoveToOrgResult>('POST', ORGS_API.moveVault(vaultId), body),
    movePool: (type: string, id: string, body: MoveToOrgRequest) => request<MoveToOrgResult>('POST', ORGS_API.movePool(type, id), body),
  },
  /** Multi-assignment pools (secrets & env, skillsets, MCP sets): one API for every type. */
  pools: {
    types: () => request<{ types: MultiPoolType[] }>('GET', POOLS_API.types),
    list: (type: MultiPoolType) => request<PoolSummary[]>('GET', POOLS_API.list(type)),
    /** The Pools page: the sets of the app's context (`?org=`: an org's own and those shared to it; Personal: what no org owns). */
    listScoped: (type: MultiPoolType) => scopedList<PoolSummary[]>(POOLS_API.list(type), (p) => request<PoolSummary[]>('GET', p)),
    /** The sets of one context by name (`personal` or an org id): the New workspace dialog's owner, Org settings' Objects. */
    listIn: (type: MultiPoolType, scope: string) => request<PoolSummary[]>('GET', withOrg(POOLS_API.list(type), scope)),
    /** The sets valid for one workspace (its owner's context) and the ones it has: what assigning offers. */
    listFor: (type: MultiPoolType, workspaceId: string) => request<PoolSummary[]>('GET', `${POOLS_API.list(type)}?for=${encodeURIComponent(workspaceId)}`),
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
