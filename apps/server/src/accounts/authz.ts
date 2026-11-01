// Accounts, endpoints and account pools (organizations slice 1, P4): every route of /api/accounts, /api/endpoints and /api/account-pools
// (app.ts), enforced centrally (authz/routeGuard.ts) through the object's owner (authz/owners.ts, migration 410). A key is a credential:
// changing or removing one is `manage`; checking it or clearing its health is `operate`; an endpoint's model list is `view`. The lists are
// the handler's (per person filtering of lists is P5).

import type { ObjectType, RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const on = (type: ObjectType, verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type, verb, from: 'path', param: 'id' }] });

export const ACCOUNT_POLICIES: RoutePolicies = {
  'GET /api/accounts': { kind: 'signed-in' },
  'POST /api/accounts': { kind: 'signed-in', creates: 'account' },
  'POST /api/accounts/bulk': { kind: 'signed-in', creates: 'account' },
  'PATCH /api/accounts/:id': on('account', 'manage'),
  'DELETE /api/accounts/:id': on('account', 'manage'),
  'POST /api/accounts/:id/check': on('account', 'operate'),
  'POST /api/accounts/:id/clear': on('account', 'operate'),
  'POST /api/endpoints': { kind: 'signed-in', creates: 'endpoint' },
  'PATCH /api/endpoints/:id': on('endpoint', 'manage'),
  'DELETE /api/endpoints/:id': on('endpoint', 'manage'),
  'GET /api/endpoints/:id/models': on('endpoint', 'view'),
  'GET /api/account-pools': { kind: 'signed-in' },
  'POST /api/account-pools': { kind: 'signed-in', creates: 'account_pool' },
  'PATCH /api/account-pools/:id': on('account_pool', 'manage'),
  'DELETE /api/account-pools/:id': on('account_pool', 'manage'),
};

export function declareAccountPolicies(): void {
  declarePolicies('accounts', ACCOUNT_POLICIES);
}
