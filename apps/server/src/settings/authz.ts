// Settings: who may do what (docs/prd/authorization.md, the `/api/settings` rows). The list is for every signed-in person (the effective values
// tell a person why something is refused); the audit trail and a change are the platform area `settings` (`view`, `manage`: admins); a
// workspace's lockdown and agent policy status are `view` on that workspace, by its `<target>/<name>` (T-309, T-329). There is no resolver of
// the `workspace` or `platform` type yet, so nothing behaves differently today: the seam answers the one owner.

import type { ObjectCheck, RoutePolicies, RoutePolicy, ToolPolicies, Verb } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

const platform = (verb: Verb): RoutePolicy => ({ kind: 'platform', area: 'settings', verb });
const workspace = (verb: Verb): RoutePolicy => {
  const check: ObjectCheck = { type: 'workspace', verb, from: 'path', param: 'target+name' };
  return { kind: 'objects', checks: [check] };
};

export const SETTINGS_POLICIES: RoutePolicies = {
  'GET /api/settings': { kind: 'signed-in' },
  'GET /api/settings/audit': platform('view'),
  'GET /api/settings/lockdown/:target/:name': workspace('view'),
  'GET /api/settings/agent-env/:target/:name': workspace('view'),
  'PUT /api/settings/:key': platform('manage'),
};

/**
 * T-968 S2a (general-manager PRD §9.1): `settings_get` reads the whole list with who changed what, which is the platform's (`view` on the
 * `settings` area, as the audit trail): the dispatch refuses anyone else with the tool's own NOT_FOUND, before the handler runs.
 */
export const SETTINGS_TOOL_POLICIES = {
  settings_get: { kind: 'platform', area: 'settings', verb: 'view' },
} satisfies ToolPolicies;

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareSettingsPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('settings', SETTINGS_POLICIES);
  declareToolPolicies('settings', SETTINGS_TOOL_POLICIES);
}
