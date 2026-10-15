// Efficiency lab and the authorization seam (apps/server/src/authz/seam.ts, docs/prd/authorization.md). The lab's numbers are the portal's
// usage across every session: the platform area `usage`, `view` to read (the owner, an admin). An agent reads only its own session's slices
// (the Portal MCP tool `lab_summary`, reach `session`, or an agent actor on a route; with the rows its chat continues, `continued_from`,
// T-312: one chat, never another chat's) and draws arms for its own session's next slice
// (`lab_arm_draw`, reach `session`, T-292 slice 3); changing an experiment is `manage` on the area with the
// confirmation round trip. Every denial on a route answers the same 404 as a route that is not there (no existence leak).

import type { RoutePolicies, ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

export const LAB_POLICIES = {
  'GET /api/lab/slices': { kind: 'platform', area: 'usage', verb: 'view' },
  'GET /api/lab/experiments': { kind: 'platform', area: 'usage', verb: 'view' },
  'GET /api/lab/summary': { kind: 'platform', area: 'usage', verb: 'view' },
} satisfies RoutePolicies;

export const LAB_TOOL_POLICIES: ToolPolicies = {
  lab_summary: { kind: 'agent', reach: 'session' },
  lab_arm_draw: { kind: 'agent', reach: 'session', audit: 'lab.arm.draw' },
  lab_experiment_set: { kind: 'platform', area: 'usage', verb: 'manage', confirm: true, audit: 'lab.experiment.set' },
};

let declared = false;
/** Declares the routes and tools once (idempotent: modules load more than once in tests). */
export function declareLabPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('lab', LAB_POLICIES);
  declareToolPolicies('lab', LAB_TOOL_POLICIES);
}
