// Settings: who may do what (docs/prd/authorization.md). Only the route T-309 put behind the seam is declared here so far: a workspace's agent
// policy status (`view` on that workspace, by its `<target>/<name>`). The list, a change, the audit trail and the lockdown status are not declared
// yet. There is no resolver of the `workspace` type yet, so nothing behaves differently today: the seam answers the one owner.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

export const SETTINGS_POLICIES: RoutePolicies = {
  'GET /api/settings/agent-env/:target/:name': { kind: 'objects', checks: [{ type: 'workspace', verb: 'view', from: 'path', param: 'target+name' }] },
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareSettingsPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('settings', SETTINGS_POLICIES);
}
