// Schedules: who may see them (docs/prd/authorization.md, general-manager PRD §9.2). The list names every loop of the portal and every
// user's cron triggers, so it is the platform's: `view` on the `system` area (admins). T-965 asked for a `schedules.read` permission; the
// platform areas are a closed list (contracts authz.ts), and `system` is the one that already says "how the portal itself runs". A person
// or a token without it gets NOT_FOUND, on the route and on the tool, before the handler runs.

import type { RoutePolicies, ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

export const SCHEDULES_POLICIES: RoutePolicies = {
  'GET /api/schedules': { kind: 'platform', area: 'system', verb: 'view' },
};

export const SCHEDULES_TOOL_POLICIES = {
  schedules_list: { kind: 'platform', area: 'system', verb: 'view' },
} satisfies ToolPolicies;

let declared = false;
/** Declares the route and the tool once (idempotent: modules load more than once in tests). */
export function declareSchedulesPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('schedules', SCHEDULES_POLICIES);
  declareToolPolicies('schedules', SCHEDULES_TOOL_POLICIES);
}
