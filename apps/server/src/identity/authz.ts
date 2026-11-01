// Identity and the portal's own door (organizations slice 1, P4): every route app.ts and identity/routes.ts register for signing in, the
// person's own account, accounts, teams, SSO, delegated sessions and the admin page's state. Cookie routes behind the session middleware are
// enforced centrally (authz/routeGuard.ts); the routes outside it (sign-in, SSO, the member's delegate door `/api/me/*`, `/api/teams/*`)
// declare their own door, and the enumeration test (authz/routeTable.test.ts) fails on any route of the app that has no declaration.

import type { PlatformArea, RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const platform = (area: PlatformArea, verb: Verb): RoutePolicy => ({ kind: 'platform', area, verb });
const session = (verb: Verb, param: string): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'session', verb, from: 'path', param }] });
const DELEGATE: RoutePolicy = {
  kind: 'handler',
  checks: ['any signed-in account (portal.anySession), member included: only sessions a grant names to this account (identity/grants.ts) at the level it gives'],
};
const SELF_DOOR: RoutePolicy = { kind: 'handler', checks: ['any signed-in account (portal.anySession), member included: its own profile row only (identity/profile.ts); the server code is refused'] };
const TEAM_DOOR: RoutePolicy = { kind: 'handler', checks: ['any signed-in account (portal.anySession): the team must be one the account is in; changing members needs its owner role (identity/teams.ts)'] };

export const IDENTITY_POLICIES: RoutePolicies = {
  'GET /healthz': { kind: 'public', why: 'the liveness probe: says the service is up, nothing more' },
  'GET /api/session': { kind: 'public', why: 'whether the caller is signed in, and as what (no other data)' },
  'POST /api/login': { kind: 'public', why: 'signing in: rate limited per client, the throttle per account' },
  'POST /api/logout': { kind: 'public', why: 'ends the caller’s own sign-in (the cookie it sends)' },
  'POST /api/auth/discover': { kind: 'public', why: 'SSO discovery by email domain (names a provider only for a configured domain)' },
  'GET /api/auth/sso/start': { kind: 'public', why: 'starts an OpenID Connect sign-in (PKCE, nonce, a binding cookie)' },
  'GET /api/auth/sso/callback': { kind: 'public', why: 'the provider’s redirect back: state, nonce and the binding cookie are checked' },
  'ALL /api/*': { kind: 'public', why: 'the 404 of every /api path no route answers' },
  // The person's own account.
  'POST /api/me/password': { kind: 'handler', checks: ['the signed-in account’s own current password (identity/users.ts), throttled'] },
  'GET /api/me': DELEGATE,
  // Owner request 2026-11-01, the Profile: only the signed-in account's own row, by the session's id (never one from the request).
  'PATCH /api/me': SELF_DOOR,
  'POST /api/me/avatar': SELF_DOOR,
  'DELETE /api/me/avatar': SELF_DOOR,
  'GET /api/me/devices': SELF_DOOR,
  'DELETE /api/me/devices/:id': { kind: 'handler', checks: ['any signed-in account: ends one of ITS OWN web sessions by handle (portal.revokeSessionOf looks only at that account’s sessions)'] },
  'GET /api/users/avatars/:sha': { kind: 'handler', checks: ['any live session (portal.anySession): a picture by its content hash, no account data'] },
  'GET /api/me/teams': TEAM_DOOR,
  'GET /api/me/sessions': DELEGATE,
  'GET /api/me/sessions/:id': DELEGATE,
  'GET /api/me/sessions/:id/events': DELEGATE,
  'POST /api/me/sessions/:id/respond': DELEGATE,
  'POST /api/me/sessions/:id/send': DELEGATE,
  'POST /api/me/sessions/:id/stop': DELEGATE,
  'GET /api/teams/:id': TEAM_DOOR,
  'POST /api/teams/:id/members': TEAM_DOOR,
  'PATCH /api/teams/:id/members/:uid': TEAM_DOOR,
  'DELETE /api/teams/:id/members/:uid': TEAM_DOOR,
  // The admin page (a full session only).
  'GET /api/admin/state': { kind: 'signed-in' },
  'POST /api/admin/code': platform('system', 'manage'),
  'PUT /api/admin/enabled': platform('system', 'manage'),
  'GET /api/admin/system': platform('system', 'view'),
  'POST /api/admin/system/key/reset': platform('system', 'manage'),
  'POST /api/admin/system/key/setup': platform('system', 'manage'),
  'POST /api/admin/system/key/unlock': platform('system', 'manage'),
  'POST /api/admin/system/resume': platform('system', 'manage'),
  'GET /api/admin/loops': platform('system', 'view'),
  // The person's own General Manager (T-968): one per person, theirs alone.
  'GET /api/admin/manager': { kind: 'self' },
  'POST /api/admin/manager/prepare': { kind: 'self' },
  'POST /api/admin/manager/enable': { kind: 'self' },
  'POST /api/admin/manager/disable': { kind: 'self' },
  // Accounts, teams and SSO providers: the platform's users area.
  'GET /api/admin/users': platform('users', 'view'),
  'POST /api/admin/users': platform('users', 'manage'),
  'PATCH /api/admin/users/:id': platform('users', 'manage'),
  'DELETE /api/admin/users/:id': platform('users', 'manage'),
  'GET /api/admin/teams': platform('users', 'view'),
  'POST /api/admin/teams': platform('users', 'manage'),
  'GET /api/admin/teams/:id': platform('users', 'view'),
  'PATCH /api/admin/teams/:id': platform('users', 'manage'),
  'DELETE /api/admin/teams/:id': platform('users', 'manage'),
  'GET /api/admin/sso': platform('registration', 'view'),
  'POST /api/admin/sso': platform('registration', 'manage'),
  'PATCH /api/admin/sso/:id': platform('registration', 'manage'),
  'DELETE /api/admin/sso/:id': platform('registration', 'manage'),
  'POST /api/admin/sso/:id/test': platform('registration', 'manage'),
  // Delegating one session to an account: managing the session itself.
  'GET /api/admin/session-grants/:sid': session('manage', 'sid'),
  'PUT /api/admin/session-grants/:sid': session('manage', 'sid'),
  'DELETE /api/admin/session-grants/:sid/:uid': session('manage', 'sid'),
  'GET /api/admin/session-shares': platform('users', 'view'),
  'PATCH /api/admin/session-shares/:id': platform('users', 'manage'),
  'DELETE /api/admin/session-shares/:id': platform('users', 'manage'),
};

export function declareIdentityPolicies(): void {
  declarePolicies('identity', IDENTITY_POLICIES);
}
