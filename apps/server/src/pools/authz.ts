// Pools: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router (a workspace's
// pools of every type, and changing one type's list); each runs `workspaceGuard` with the verb below. Reading them is `view`; changing what a
// workspace is delivered (secrets sets among them) is `manage`. The `/api/pools…` routes are not declared here yet (see T-531's report).

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import { onWorkspacePath } from '../workspaces/authz.js';

export const WORKSPACE_POOL_POLICIES: RoutePolicies = {
  'GET /api/workspaces/:target/:name/pools': onWorkspacePath('view'),
  'PUT /api/workspaces/:target/:name/pools/:type': onWorkspacePath('manage'),
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspacePoolPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('pools', WORKSPACE_POOL_POLICIES);
}
