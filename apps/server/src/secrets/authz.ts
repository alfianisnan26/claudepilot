// Secrets & env: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router; each runs
// `workspaceGuard` with the verb below. What a workspace's sets deliver (names only, never values) is for those who use it (`operate`, the
// PRD's Appendix A); the migration check runs a command in the workspace, so it is `operate` too.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import { onWorkspacePath } from '../workspaces/authz.js';

export const WORKSPACE_SECRETS_POLICIES: RoutePolicies = {
  'GET /api/workspaces/:target/:name/secrets': onWorkspacePath('operate'),
  'POST /api/workspaces/:target/:name/secrets/check': onWorkspacePath('operate'),
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspaceSecretsPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('secrets', WORKSPACE_SECRETS_POLICIES);
}
