// T-1043 S0a (D-82): the declarations of the routes app.ts owns itself (sign-in, the admin page, Claude accounts, endpoints, account pools),
// the catch-alls, and every module route whose module has no `authz.ts` of its own yet. The route guard (routeGuard.ts) refuses a non-owner
// any route that is not declared, and `routePolicies.test.ts` fails on one, so every route the app answers is named somewhere.
//
// The interim rule for a module that is not actor-aware yet (its handlers do not take the actor and filter): `platform` (an admin's area),
// `view` for a read and `manage` for a change. A member is refused there (403 "Only an admin can do this.") until the module's own slice
// declares the PRD's target row (docs/prd/authorization.md Appendix A) and its handlers take the actor. The founding owner, the server code and
// an admin account are not changed by any of this (D-82: admins keep full access).

import type { PlatformArea, RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from './seam.js';

const admin = (area: PlatformArea, verb: Verb): RoutePolicy => ({ kind: 'platform', area, verb });
const read = (area: PlatformArea) => admin(area, 'view');
const change = (area: PlatformArea) => admin(area, 'manage');

/** One area for a set of paths: GET reads (`view`), every other method changes (`manage`). */
function area(a: PlatformArea, keys: string[]): RoutePolicies {
  const out: RoutePolicies = {};
  for (const key of keys) out[key as keyof RoutePolicies] = key.startsWith('GET ') ? read(a) : change(a);
  return out;
}

export const APP_POLICIES: RoutePolicies = {
  // The doors before sign-in: the probe, the session check, signing in and out.
  'GET /healthz': { kind: 'public', why: 'the liveness probe' },
  'GET /api/session': { kind: 'public', why: 'tells the sign-in page whether a session is live' },
  'POST /api/login': { kind: 'public', why: 'signing in (rate limited)' },
  'POST /api/logout': { kind: 'public', why: 'signing out ends only the caller’s own cookie' },
  'GET /api/me': { kind: 'self' },
  // The catch-all of the API answers 404 for a path nobody serves; the web app's shell is the same page for every path.
  'ALL /api/*': { kind: 'public', why: 'answers 404 for an unknown API path' },
  'GET *': { kind: 'public', why: 'the web app shell and its static files' },
  // The admin page (Access): accounts and roles, the server code, sign-ups, the secret key and the database.
  ...area('users', ['GET /api/admin/users', 'POST /api/admin/users', 'PATCH /api/admin/users/:id', 'DELETE /api/admin/users/:id']),
  ...area('system', ['GET /api/admin/state', 'POST /api/admin/code', 'GET /api/admin/system', 'POST /api/admin/system/key/reset', 'POST /api/admin/system/key/setup', 'POST /api/admin/system/key/unlock', 'POST /api/admin/system/resume']),
  'PUT /api/admin/enabled': change('registration'),
  // Claude accounts, API endpoints and account pools: the portal's credentials, an admin's (Settings → Claude).
  ...area('settings', [
    'GET /api/accounts',
    'POST /api/accounts',
    'POST /api/accounts/bulk',
    'PATCH /api/accounts/:id',
    'POST /api/accounts/:id/check',
    'POST /api/accounts/:id/clear',
    'DELETE /api/accounts/:id',
    'POST /api/endpoints',
    'PATCH /api/endpoints/:id',
    'GET /api/endpoints/:id/models',
    'DELETE /api/endpoints/:id',
    'GET /api/account-pools',
    'POST /api/account-pools',
    'PATCH /api/account-pools/:id',
    'DELETE /api/account-pools/:id',
  ]),
};

let declared = false;
/** Declares the routes once (idempotent: the app is built more than once in tests). */
export function declareAppPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('app', APP_POLICIES);
}
