// Claude Code version pinning: who may do what (docs/prd/claude-version-pinning.md §17, docs/prd/authorization.md). The registry, the canary and
// its schedule, the candidate report, the images and the default pin are PLATFORM-level: the platform area `version`. Applying an upgrade to, or
// rolling back, ONE workspace needs `manage` on that workspace. There is no object type of its own, so there is no resolver here: a workspace's
// history rides the workspace's own. The routes are declared now (a route with no declaration is refused once the layer lands); today the seam
// answers the one owner, so nothing behaves differently.

import { platformRef, type ObjectCheck, type RoutePolicies, type RoutePolicy, type ToolPolicies, type Verb } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

/** The platform object every platform-level route here is about. */
export const versionArea = platformRef('version');

const platform = (verb: Verb, audit?: string): RoutePolicy => ({ kind: 'platform', area: 'version', verb, ...(audit ? { audit } : {}) });
const workspace = (verb: Verb, audit?: string): RoutePolicy => {
  const check: ObjectCheck = { type: 'workspace', verb, from: 'path', param: 'target+name' };
  return { kind: 'objects', checks: [check], ...(audit ? { audit } : {}) };
};

const WS = '/api/workspaces/:target/:name/claude-version';

export const CLAUDE_VERSION_POLICIES: RoutePolicies = {
  'GET /api/claude-version': platform('view'),
  'GET /api/claude-version/features': platform('view'),
  'GET /api/claude-version/checks': platform('view'),
  'GET /api/claude-version/warnings': platform('view'),
  // Every workspace's version: the rows are the ones the asker may view (the handler filters).
  'GET /api/claude-version/workspaces': { kind: 'signed-in', filter: 'workspace' },
  'GET /api/claude-version/candidate': platform('view'),
  'POST /api/claude-version/candidate': platform('manage', 'claude.candidate.read'),
  'GET /api/claude-version/canary': platform('view'),
  'GET /api/claude-version/canary/:id': platform('view'),
  'POST /api/claude-version/canary': platform('manage', 'claude.canary.start'),
  'GET /api/claude-version/images': platform('view'),
  'POST /api/claude-version/images': platform('manage', 'claude.image.build'),
  'POST /api/claude-version/images/prune': platform('manage', 'claude.image.prune'),
  'PUT /api/claude-version/default': platform('manage', 'claude.default.set'),
  [`GET ${WS}`]: workspace('view'),
  [`GET ${WS}/history`]: workspace('view'),
  [`GET ${WS}/plan`]: workspace('view'),
  [`POST ${WS}/apply`]: workspace('manage', 'claude.upgrade'),
  [`POST ${WS}/rollback`]: workspace('manage', 'claude.rollback'),
};

/**
 * The Portal MCP tools: both are reads of the platform area `version` (the registry, the default pin, the canary's report); the workspace rows in
 * `claude_versions` are the ones the caller may view (the handler filters with `visible`). No tool here upgrades, builds or rolls back.
 */
export const CLAUDE_VERSION_TOOL_POLICIES: ToolPolicies = {
  claude_versions: { kind: 'platform', area: 'version', verb: 'view' },
  claude_minimums: { kind: 'platform', area: 'version', verb: 'view' },
};

let declared = false;
/** Declares the routes and tools once (idempotent: modules load more than once in tests). */
export function declareClaudeVersionPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('claudeversion', CLAUDE_VERSION_POLICIES);
  declareToolPolicies('claudeversion', CLAUDE_VERSION_TOOL_POLICIES);
}
