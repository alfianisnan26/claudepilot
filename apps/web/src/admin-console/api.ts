import {
  ADMIN_API,
  type Ability,
  type AdminAuditEntry,
  type AdminAuditQuery,
  type AdminMe,
  type AdminOrg,
  type AdminSsoProvider,
  type AdminUserDetail,
  type AdminUserRow,
  type OrgId,
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
  signIn: (email: string, password: string) => call<AdminMe>('POST', ADMIN_API.session, { email, password }),
  signOut: () => call<{ ok: true }>('DELETE', ADMIN_API.session),
  stepUp: (password: string) => call<AdminMe>('POST', ADMIN_API.stepUp, { password }),
  users: () => call<AdminUserRow[]>('GET', ADMIN_API.users),
  user: (id: string) => call<AdminUserDetail>('GET', ADMIN_API.user(id)),
  suspend: (id: string) => call<AdminUserRow>('POST', ADMIN_API.suspend(id), {}),
  resume: (id: string) => call<AdminUserRow>('POST', ADMIN_API.resume(id), {}),
  endSessions: (id: string) => call<{ portal: number; admin: number }>('POST', ADMIN_API.endSessions(id), {}),
  revokeToken: (id: string, tokenId: string) => call<{ revoked: boolean }>('DELETE', ADMIN_API.token(id, tokenId)),
  setAbility: (id: string, ability: Ability, on: boolean) => call<{ changed: boolean }>(on ? 'PUT' : 'DELETE', ADMIN_API.ability(id, ability)),
  orgs: () => call<AdminOrg[]>('GET', ADMIN_API.orgs),
  recoverOwner: (id: OrgId, userId: string, reason: string) => call<{ recovered: true }>('POST', ADMIN_API.recoverOwner(id), { userId, reason }),
  sso: () => call<AdminSsoProvider[]>('GET', ADMIN_API.sso),
  audit: (q: AdminAuditQuery) => call<AdminAuditEntry[]>('GET', `${ADMIN_API.audit}${auditSearch(q)}`),
};
