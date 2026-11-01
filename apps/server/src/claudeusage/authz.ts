// Claude usage (organizations slice 1, P4): every route under /api/claude-usage, enforced centrally (authz/routeGuard.ts). The plan limits
// of the portal's Claudes and the all-Claudes reports are the platform's `usage` area (an admin's, D-82); one Claude's history, check and
// snooze name the Claude (view to read, operate to act).

import type { RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const usage = (verb: Verb): RoutePolicy => ({ kind: 'platform', area: 'usage', verb });
const claude = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'claude', verb, from: 'path', param: 'claudeId' }] });

export const CLAUDE_USAGE_POLICIES: RoutePolicies = {
  'GET /api/claude-usage': usage('view'),
  'GET /api/claude-usage/summary': usage('view'),
  'GET /api/claude-usage/requests': usage('view'),
  'GET /api/claude-usage/recommend': usage('view'),
  'GET /api/claude-usage/palette': usage('view'),
  'GET /api/claude-usage/export': usage('view'),
  'GET /api/claude-usage/:claudeId/history': claude('view'),
  'POST /api/claude-usage/:claudeId/check': claude('operate'),
  'PUT /api/claude-usage/:claudeId/snooze': claude('operate'),
  'DELETE /api/claude-usage/:claudeId/snooze': claude('operate'),
};

export function declareClaudeUsagePolicies(): void {
  declarePolicies('claudeusage', CLAUDE_USAGE_POLICIES);
}
