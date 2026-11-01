// Usage spend (organizations slice 1, P4): every route under /api/usage-spend, enforced centrally (authz/routeGuard.ts). The summaries,
// alerts, budgets and spikes are filtered by the caller in the service (`Visibility`, usagespend/actor.ts); a budget is named by its id
// (`manage` to change, snooze or remove it); the spend audit is the platform's audit, the spike snooze the platform's usage.

import type { RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const budget = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'budget', verb, from: 'path', param: 'id' }] });

export const USAGE_SPEND_POLICIES: RoutePolicies = {
  'GET /api/usage-spend': { kind: 'signed-in', filter: 'budget' },
  'GET /api/usage-spend/alerts': { kind: 'signed-in', filter: 'budget' },
  'GET /api/usage-spend/attribution': { kind: 'signed-in', filter: 'budget' },
  'GET /api/usage-spend/audit': { kind: 'platform', area: 'audit', verb: 'view' },
  'GET /api/usage-spend/budgets': { kind: 'signed-in', filter: 'budget' },
  'POST /api/usage-spend/budgets': { kind: 'signed-in', creates: 'budget' },
  'PUT /api/usage-spend/budgets/:id': budget('manage'),
  'DELETE /api/usage-spend/budgets/:id': budget('manage'),
  'PUT /api/usage-spend/budgets/:id/snooze': budget('manage'),
  'DELETE /api/usage-spend/budgets/:id/snooze': budget('manage'),
  'GET /api/usage-spend/spikes': { kind: 'signed-in', filter: 'budget' },
  'PUT /api/usage-spend/spikes/snooze': { kind: 'platform', area: 'usage', verb: 'manage' },
  'DELETE /api/usage-spend/spikes/snooze': { kind: 'platform', area: 'usage', verb: 'manage' },
};

export function declareUsageSpendPolicies(): void {
  declarePolicies('usagespend', USAGE_SPEND_POLICIES);
}
