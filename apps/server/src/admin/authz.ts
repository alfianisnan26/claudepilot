// The Admin console's route declarations (docs/prd/organizations.md §6.11, slice 4). Every route of the console's app is here, and the app
// refuses to start with one that is not (`assertDeclared`); the test enumerates both ways. The console's router ENFORCES each declaration
// (routes.ts `on`): `public` needs nothing (sign-in only), `self` needs the admin session, `platform` needs the admin session of an instance
// admin (`requireInstanceAdmin`, read on every use), and `reauth` needs a step-up within 5 minutes. A denial on a platform route is the
// platform's (404 for anything that is not a person). No route takes a bearer token: the console refuses any `Authorization` header.

import type { RoutePolicies, RoutePolicy } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const users = (verb: 'view' | 'manage', extra: Partial<RoutePolicy> = {}): RoutePolicy => ({ kind: 'platform', area: 'users', verb, ...extra }) as RoutePolicy;

export const ADMIN_ROUTE_POLICIES: RoutePolicies = {
  'POST /admin-api/session': { kind: 'public', why: 'the console’s sign-in: an active admin account’s email and password, throttled per email and address', audit: 'admin.signin' },
  'GET /admin-api/session': { kind: 'self' },
  'DELETE /admin-api/session': { kind: 'self', audit: 'admin.signout' },
  'POST /admin-api/session/step-up': { kind: 'self', audit: 'admin.step_up' },
  // Sign-in through the console's OIDC provider (owner, 2026-11-01; ./oidc.ts). Public like the password sign-in: what the page offers, the
  // redirect to the provider (with `for=step-up` the handler itself requires the admin session and binds the step-up to it), and the
  // provider's return, which lets in ONLY an identity on PORTAL_ADMIN_OIDC_ALLOW that maps to an active admin account. Off: 404.
  'GET /admin-api/session/methods': { kind: 'public', why: 'the sign-in page asks whether the OIDC button is shown; nothing about any account' },
  'GET /admin-api/session/oidc/start': { kind: 'public', why: 'redirects to the console’s OIDC provider; a step-up start requires the admin session in the handler' },
  'GET /admin-api/session/oidc/callback': {
    kind: 'public',
    why: 'the OIDC provider’s return: state cookie, code exchange, ID token checks, the allow list, an active admin account; every refusal is an admin.signin_refused row',
    audit: 'admin.signin',
  },
  'GET /admin-api/users': users('view'),
  'GET /admin-api/users/:id': users('view'),
  'POST /admin-api/users/:id/suspend': users('manage', { reauth: true, audit: 'account.suspended' }),
  'POST /admin-api/users/:id/resume': users('manage', { reauth: true, audit: 'account.resumed' }),
  'POST /admin-api/users/:id/sessions/end': users('manage', { reauth: true, audit: 'account.sessions_ended' }),
  'DELETE /admin-api/users/:id/tokens/:tid': users('manage', { reauth: true, audit: 'account.token_revoked' }),
  'PUT /admin-api/users/:id/abilities/:ability': users('manage', { reauth: true, audit: 'ability.granted' }),
  'DELETE /admin-api/users/:id/abilities/:ability': users('manage', { reauth: true, audit: 'ability.revoked' }),
  'GET /admin-api/orgs': users('view'),
  'POST /admin-api/orgs/:id/recover-owner': users('manage', { reauth: true, audit: 'org.ownership_recovered' }),
  // Slice 8 (§6.9): suspending and resuming an org, step-up like every console write (resume restores access, so the same bar).
  'POST /admin-api/orgs/:id/suspend': users('manage', { reauth: true, audit: 'org.suspended' }),
  'POST /admin-api/orgs/:id/resume': users('manage', { reauth: true, audit: 'org.resumed' }),
  // Slice 5 (§6.7, OD-4): break-glass. Like every write of the console, opening one and ending your own need the step-up.
  'POST /admin-api/orgs/:id/break-glass': users('manage', { reauth: true, audit: 'org.break_glass_started' }),
  'DELETE /admin-api/orgs/:id/break-glass': users('manage', { reauth: true, audit: 'org.break_glass_ended' }),
  'GET /admin-api/break-glass': users('view'),
  'GET /admin-api/sso': users('view'),
  'GET /admin-api/audit': users('view'),
};

export function declareAdminPolicies(): void {
  declarePolicies('admin', ADMIN_ROUTE_POLICIES);
}

/** Throws when the app has an /admin-api route the table does not declare, or the table declares a route the app does not have. */
export function assertDeclared(routes: readonly { method: string; path: string }[], table: RoutePolicies): void {
  const have = new Set(routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/admin-api')).map((r) => `${r.method} ${r.path}`));
  const undeclared = [...have].filter((k) => !(k in table));
  const missing = Object.keys(table).filter((k) => !have.has(k));
  if (undeclared.length || missing.length)
    throw new Error(`admin routes and declarations differ: undeclared ${JSON.stringify(undeclared)}, declared without a route ${JSON.stringify(missing)}`);
}
