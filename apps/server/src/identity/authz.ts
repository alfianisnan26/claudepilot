// T-1043 S0b x T-976 (D-82): what each route of identity/routes.ts needs (teams, session shares, SSO). The route guard refuses a non-owner
// any route with no declaration, so T-976's routes are declared here, each as its handler already decides:
//   - SSO sign-in (discover, start, callback): no session yet; rate limited, the provider's answer is the check.
//   - An account's own teams (`/api/me/teams`) and one team's page and people (`/api/teams/:id…`): any signed-in account; the handler
//     answers the same 404 to an account that is not in the team, and only a team's owners (or a full session) change its people.
//   - The admin side (mounted on the admin router, a FULL session only): session shares and teams are the `users` area, SSO providers the
//     `registration` area, so a member is refused by the guard as well as by the router.
// The founding owner is not changed by any of this (the guard lets it through untouched).

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const users = (verb: 'view' | 'manage') => ({ kind: 'platform', area: 'users', verb }) as const;
const registration = (verb: 'view' | 'manage') => ({ kind: 'platform', area: 'registration', verb }) as const;

export const IDENTITY_POLICIES: RoutePolicies = {
  'POST /api/auth/discover': { kind: 'public', why: 'how an email signs in, before any session (rate limited; tells nothing about accounts)' },
  'GET /api/auth/sso/start': { kind: 'public', why: 'starts an SSO sign-in, before any session (rate limited)' },
  'GET /api/auth/sso/callback': { kind: 'public', why: 'the SSO provider sends the browser back here, before any session (bound to the start cookie)' },
  'GET /api/me/teams': { kind: 'self' },
  'GET /api/teams/:id': { kind: 'signed-in' },
  'POST /api/teams/:id/members': { kind: 'signed-in' },
  'PATCH /api/teams/:id/members/:uid': { kind: 'signed-in' },
  'DELETE /api/teams/:id/members/:uid': { kind: 'signed-in' },
  'GET /api/admin/session-grants/:sid': users('view'),
  'PUT /api/admin/session-grants/:sid': users('manage'),
  'DELETE /api/admin/session-grants/:sid/:uid': users('manage'),
  'GET /api/admin/session-shares': users('view'),
  'PATCH /api/admin/session-shares/:id': users('manage'),
  'DELETE /api/admin/session-shares/:id': users('manage'),
  'GET /api/admin/teams': users('view'),
  'POST /api/admin/teams': users('manage'),
  'GET /api/admin/teams/:id': users('view'),
  'PATCH /api/admin/teams/:id': users('manage'),
  'DELETE /api/admin/teams/:id': users('manage'),
  'GET /api/admin/sso': registration('view'),
  'POST /api/admin/sso': registration('manage'),
  'PATCH /api/admin/sso/:id': registration('manage'),
  'DELETE /api/admin/sso/:id': registration('manage'),
  'POST /api/admin/sso/:id/test': registration('manage'),
};

export function declareIdentityPolicies(): void {
  declarePolicies('identity', IDENTITY_POLICIES);
}
