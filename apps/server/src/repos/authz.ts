// Workspace git: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router; each runs
// `workspaceGuard` with the verb below. The tree and the scan settings are `view`; a scan uses the workspace (`operate`); changing its scan
// settings changes the workspace (`manage`, the PRD's Appendix A). The `/api/repos…` routes are not declared here yet (T-539).

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import { onWorkspacePath } from '../workspaces/authz.js';

const WS = '/api/workspaces/:target/:name/repos';

export const WORKSPACE_REPOS_POLICIES: RoutePolicies = {
  [`GET ${WS}`]: onWorkspacePath('view'),
  [`POST ${WS}/scan`]: onWorkspacePath('operate'),
  [`GET ${WS}/settings`]: onWorkspacePath('view'),
  [`PUT ${WS}/settings`]: onWorkspacePath('manage'),
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspaceReposPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('repos', WORKSPACE_REPOS_POLICIES);
}
