// Workspace git: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router; each runs
// `workspaceGuard` with the verb below. The tree and the scan settings are `view`; a scan uses the workspace (`operate`); changing its scan
// settings changes the workspace (`manage`, the PRD's Appendix A). The `/api/repos…` routes are not declared here yet (T-539).

import type { RoutePolicies, RoutePolicy } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import { onWorkspacePath } from '../workspaces/authz.js';

const WS = '/api/workspaces/:target/:name/repos';

export const WORKSPACE_REPOS_POLICIES: RoutePolicies = {
  [`GET ${WS}`]: onWorkspacePath('view'),
  [`POST ${WS}/scan`]: onWorkspacePath('operate'),
  [`GET ${WS}/settings`]: onWorkspacePath('view'),
  [`PUT ${WS}/settings`]: onWorkspacePath('manage'),
};

/**
 * Organizations slice 1 (P4): the `/api/repos…` routes, enforced centrally. A repository is read through its workspace (OBJECT_TYPES `repo`,
 * inherit 'same'): its detail and events are `view`; a scan, a sync and a worktree use the workspace (`operate`). The overview and the
 * event feed list across workspaces (the handler's; per person filtering is P5).
 */
const repo = (verb: 'view' | 'operate'): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'repo', verb, from: 'path', param: 'id' }] });
export const REPO_POLICIES: RoutePolicies = {
  'GET /api/repos': { kind: 'signed-in', filter: 'repo' },
  'GET /api/repos/events': { kind: 'signed-in', filter: 'repo' },
  'GET /api/repos/:id': repo('view'),
  'POST /api/repos/:id/scan': repo('operate'),
  'POST /api/repos/:id/worktrees': repo('operate'),
  'DELETE /api/repos/:id/worktree': repo('operate'),
  'PUT /api/repos/:id/sync': repo('operate'),
  'POST /api/repos/:id/sync': repo('operate'),
};
export function declareRepoPolicies(): void {
  declarePolicies('repos', REPO_POLICIES);
}

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspaceReposPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('repos', WORKSPACE_REPOS_POLICIES);
}
