// Claude Code version pinning (docs/prd/claude-version-pinning.md): index.ts builds one `ClaudeVersions`, starts its scheduler and wires its hooks
// (the workspace list's `claude` brief, the default pin for new workspaces, the live topic); app.ts mounts its two route sets.

import './settings.js';
import { declareClaudeVersionPolicies } from './authz.js';

export { ClaudeVersions, type ClaudeVersionsDeps } from './service.js';
export { createClaudeVersionRoutes, createWorkspaceClaudeVersionRoutes } from './routes.js';
export { registerClaudeVersionTools } from './portalTools.js';
export { registerCanaryCheck } from './canary/checks.js';

declareClaudeVersionPolicies();
