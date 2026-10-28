// Pools: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router (a workspace's
// pools of every type, and changing one type's list); each runs `workspaceGuard` with the verb below. Reading them is `view`; changing what a
// workspace is delivered (secrets sets among them) is `manage`. The `/api/pools…` routes are not declared here yet (see T-531's report).

import { poolRef, workspaceRef, type Actor, type RoutePolicies, type ToolPolicies } from '@portal/contracts';
import { can, declarePolicies, declareToolPolicies } from '../authz/seam.js';
import { onWorkspacePath } from '../workspaces/authz.js';

export const WORKSPACE_POOL_POLICIES: RoutePolicies = {
  'GET /api/workspaces/:target/:name/pools': onWorkspacePath('view'),
  'PUT /api/workspaces/:target/:name/pools/:type': onWorkspacePath('manage'),
};

/**
 * T-2866: `pool_secret_set` writes one secret's value into a secrets pool. Its reach is the agent's own workspace, decided by the handler
 * through {@link secretWriteAccess} (the pool is named by an argument that may be a name, so there is no id for an `objects` check).
 */
export const POOL_TOOL_POLICIES = {
  pool_secret_set: { kind: 'agent', reach: 'workspace', audit: 'pool.secret.set' },
} satisfies ToolPolicies;

/**
 * Who may write a secret into a secrets pool over MCP (T-2866), through the one `can()`:
 *  - an agent: `operate` on its own workspace and on the pool, and the pool is assigned to its workspace. A pool it can't reach is
 *    `not_found`, the same answer as one that does not exist. A pool other workspaces use too is `shared`: a value set there would replace
 *    another workspace's credential, so a person changes it in the portal.
 *  - a token: `manage` on the pool (an admin token); a read or operate token is `not_found`.
 * The protected-pool refusal comes after this (PILOT-1000), so a pool the caller can't see never says it is protected.
 */
export function secretWriteAccess(actor: Actor, pool: { id: string; workspaces: readonly string[] }): 'ok' | 'not_found' | 'shared' {
  const ref = poolRef(pool.id, 'secrets');
  if (actor.kind === 'agent') {
    if (!can(actor, 'operate', workspaceRef(actor.workspaceId)).allow) return 'not_found';
    if (!can(actor, 'operate', ref).allow) return 'not_found';
    if (!pool.workspaces.includes(actor.workspaceId)) return 'not_found';
    return pool.workspaces.every((w) => w === actor.workspaceId) ? 'ok' : 'shared';
  }
  return can(actor, 'manage', ref).allow ? 'ok' : 'not_found';
}

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspacePoolPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('pools', WORKSPACE_POOL_POLICIES);
  declarePoolToolPolicies();
}

/** Declares the pool tools' access (idempotent: the same table declared twice is a no-op). Called where the tools are registered. */
export function declarePoolToolPolicies(): void {
  declareToolPolicies('pools', POOL_TOOL_POLICIES);
}
