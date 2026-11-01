// Secrets & env: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router; each runs
// `workspaceGuard` with the verb below. What a workspace's sets deliver (names only, never values) is for those who use it (`operate`, the
// PRD's Appendix A); the migration check runs a command in the workspace, so it is `operate` too.

import type { RoutePolicies, RoutePolicy } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import { onWorkspacePath } from '../workspaces/authz.js';

export const WORKSPACE_SECRETS_POLICIES: RoutePolicies = {
  'GET /api/workspaces/:target/:name/secrets': onWorkspacePath('operate'),
  'POST /api/workspaces/:target/:name/secrets/check': onWorkspacePath('operate'),
};

/**
 * Organizations slice 1 (P4): rotation, versions and revocation of a secrets set's values (`/api/secrets/:poolId…`), enforced centrally through
 * the set's owner: the history is `view` (names and dates, never a value); rotating or revoking a value is `manage`.
 */
const secretsSet = (verb: 'view' | 'manage'): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'pool', verb, from: 'path', param: 'poolId' }] });
export const SECRET_ROTATION_POLICIES: RoutePolicies = {
  'GET /api/secrets/:poolId/rotations': secretsSet('view'),
  'GET /api/secrets/:poolId/entries/:entryId/versions': secretsSet('view'),
  'POST /api/secrets/:poolId/entries/:entryId/rotate': secretsSet('manage'),
  'POST /api/secrets/:poolId/values/:valueId/revoke': secretsSet('manage'),
};
export function declareSecretRotationPolicies(): void {
  declarePolicies('secrets', SECRET_ROTATION_POLICIES);
}

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspaceSecretsPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('secrets', WORKSPACE_SECRETS_POLICIES);
}
