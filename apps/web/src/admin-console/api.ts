import {
  ADMIN_API,
  type Ability,
  type AdminAuditEntry,
  type AdminAuditQuery,
  type AdminCreateOrgRequest,
  type AdminCreateUserRequest,
  type AdminMe,
  type AdminOrg,
  type AdminOrgDetail,
  type AdminPasswordResult,
  type AdminRotatedCode,
  type AdminSignInConfig,
  type AdminSignInMethods,
  type AdminSsoProvider,
  type AdminSsoRequest,
  type AdminTarget,
  type AdminUpdateUserRequest,
  type AdminUserDetail,
  type AdminUserRow,
  type AdminWorkspaceRow,
  type BreakGlassEntry,
  type OrgId,
  type SettingValue,
  type SettingView,
  type SettingsView,
  type AdminFounderTransferResult,
  type AdminTransferFounderRequest,
} from '@portal/contracts';

/*
 * The Admin console's client (docs/prd/organizations.md §6.11): same origin, its own cookie (`__Host-pilot_admin`, sent by the browser), never a
 * token. `REAUTH_REQUIRED` means the action needs the password again (step-up); `UNAUTHORIZED` means the session ended (sign in again).
 */

export class AdminApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AdminApiError('NETWORK_ERROR', 'Could not reach the portal.', 0);
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code?: string; message?: string } } | null;
  if (res.ok) return (json && 'data' in json ? json.data : json) as T;
  throw new AdminApiError(json?.error?.code ?? 'ERROR', json?.error?.message ?? `Request failed (${res.status}).`, res.status);
}

export function auditSearch(q: AdminAuditQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  me: () => call<AdminMe>('GET', ADMIN_API.session),
  methods: () => call<AdminSignInMethods>('GET', ADMIN_API.methods),
  signIn: (email: string, password: string) => call<AdminMe>('POST', ADMIN_API.session, { email, password }),
  signOut: () => call<{ ok: true }>('DELETE', ADMIN_API.session),
  stepUp: (password: string) => call<AdminMe>('POST', ADMIN_API.stepUp, { password }),
  // Users
  users: () => call<AdminUserRow[]>('GET', ADMIN_API.users),
  user: (id: string) => call<AdminUserDetail>('GET', ADMIN_API.user(id)),
  createUser: (req: AdminCreateUserRequest) => call<AdminPasswordResult>('POST', ADMIN_API.users, req),
  updateUser: (id: string, req: AdminUpdateUserRequest) => call<AdminUserRow>('PATCH', ADMIN_API.user(id), req),
  resetPassword: (id: string) => call<AdminPasswordResult>('POST', ADMIN_API.password(id), {}),
  removeUser: (id: string) => call<{ removed: true }>('DELETE', ADMIN_API.user(id)),
  /** Owner request 2026-11-01: makes the account the founder (the current founder, or with the server code). */
  transferFounder: (id: string, req: AdminTransferFounderRequest) => call<AdminFounderTransferResult>('POST', ADMIN_API.founder(id), req),
  suspend: (id: string, reason?: string) => call<AdminUserRow>('POST', ADMIN_API.suspend(id), { reason }),
  resume: (id: string) => call<AdminUserRow>('POST', ADMIN_API.resume(id), {}),
  endSessions: (id: string) => call<{ portal: number; admin: number }>('POST', ADMIN_API.endSessions(id), {}),
  revokeToken: (id: string, tokenId: string) => call<{ revoked: boolean }>('DELETE', ADMIN_API.token(id, tokenId)),
  setAbility: (id: string, ability: Ability, on: boolean) => call<{ changed: boolean }>(on ? 'PUT' : 'DELETE', ADMIN_API.ability(id, ability)),
  // Orgs
  orgs: () => call<AdminOrg[]>('GET', ADMIN_API.orgs),
  org: (id: OrgId) => call<AdminOrgDetail>('GET', ADMIN_API.org(id)),
  createOrg: (req: AdminCreateOrgRequest) => call<AdminOrgDetail>('POST', ADMIN_API.orgs, req),
  deleteOrg: (id: OrgId, reason?: string) => call<{ deleted: true }>('DELETE', ADMIN_API.org(id), { reason }),
  suspendOrg: (id: OrgId, reason?: string) => call<{ suspended: true }>('POST', ADMIN_API.suspendOrg(id), { reason }),
  resumeOrg: (id: OrgId) => call<{ resumed: true }>('POST', ADMIN_API.resumeOrg(id), {}),
  recoverOwner: (id: OrgId, userId: string, reason: string) => call<{ recovered: true }>('POST', ADMIN_API.recoverOwner(id), { userId, reason }),
  startBreakGlass: (id: OrgId, reason: string) => call<BreakGlassEntry>('POST', ADMIN_API.breakGlass(id), { reason }),
  endBreakGlass: (id: OrgId) => call<{ ended: number }>('DELETE', ADMIN_API.breakGlass(id)),
  breakGlass: () => call<BreakGlassEntry[]>('GET', ADMIN_API.breakGlassList),
  // Workspaces
  workspaces: () => call<AdminWorkspaceRow[]>('GET', ADMIN_API.workspaces),
  targets: () => call<AdminTarget[]>('GET', ADMIN_API.targets),
  startWorkspace: (id: string) => call<{ ok: true }>('POST', ADMIN_API.workspaceStart(id), {}),
  stopWorkspace: (id: string) => call<{ ok: true }>('POST', ADMIN_API.workspaceStop(id), {}),
  // Sign-in
  sso: () => call<AdminSsoProvider[]>('GET', ADMIN_API.sso),
  createSso: (req: AdminSsoRequest) => call<AdminSsoProvider>('POST', ADMIN_API.sso, req),
  updateSso: (id: string, req: AdminSsoRequest) => call<AdminSsoProvider>('PATCH', ADMIN_API.ssoProvider(id), req),
  signInConfig: () => call<AdminSignInConfig>('GET', ADMIN_API.signIn),
  setServerCode: (enabled: boolean) => call<AdminSignInConfig>('PUT', ADMIN_API.serverCode, { enabled }),
  rotateCode: () => call<AdminRotatedCode>('POST', ADMIN_API.rotateCode, {}),
  // Settings
  settings: () => call<SettingsView>('GET', ADMIN_API.settings),
  setSetting: (key: string, value: SettingValue, confirm?: boolean) => call<SettingView>('PUT', ADMIN_API.setting(key), { value, confirm }),
  // Audit
  audit: (q: AdminAuditQuery) => call<AdminAuditEntry[]>('GET', `${ADMIN_API.audit}${auditSearch(q)}`),
};
