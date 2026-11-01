// Approvals and the authorization seam (docs/prd/approvals.md, PILOT-1000 / T-2867). The routes are only "signed in": the service decides,
// and deciding (allow, deny) and reading the queue are a PERSON's (a signed-in user) only. A token or an agent gets the same NOT_FOUND as a
// missing request, so nothing says a request exists. The Portal MCP tools are an agent's own: it asks, and lists or reads its own requests.

import { objectRef, workspaceRef, type Actor, type RoutePolicies, type ToolPolicies } from '@portal/contracts';
import { can, declarePolicies, declareToolPolicies, isPlatformAdmin } from '../authz/seam.js';

export const APPROVAL_POLICIES = {
  // The pending queue (and one request whole): a person's; anyone else reads an empty list or NOT_FOUND (the service checks the actor).
  'GET /api/approvals': { kind: 'signed-in' },
  'GET /api/approvals/:id': { kind: 'signed-in' },
  // Allow runs the stored payload as the portal; deny stores the reason. A person only (the service); the kind adds its own checks
  // (session.bypass: operate on the session and a fresh server code, as the Bypass route itself).
  'POST /api/approvals/:id/allow': { kind: 'signed-in' },
  'POST /api/approvals/:id/deny': { kind: 'signed-in' },
} satisfies RoutePolicies;

/** An agent asks for itself, and sees only what it asked (the handler filters by the verified session of its token). */
export const APPROVAL_TOOL_POLICIES = {
  approval_request: { kind: 'agent', reach: 'session', audit: 'approval.request' },
  approval_list: { kind: 'agent', reach: 'session' },
  approval_get: { kind: 'agent', reach: 'session' },
} satisfies ToolPolicies;

export function declareApprovalPolicies(): void {
  declarePolicies('approvals', APPROVAL_POLICIES);
  declareToolPolicies('approvals', APPROVAL_TOOL_POLICIES);
}

/** Who may decide and see the queue: a signed-in person. Never a token (the owner's own included), an agent, a job or the system. */
export const mayDecide = (actor: Actor): boolean => actor.kind === 'user';

/**
 * Org isolation (owner request 2026-11-01): who may see and decide ONE request: a person (`mayDecide`) who may use what it is about:
 * `operate` on its workspace, else on the asking session; a request with neither (the portal asked) is a platform admin's. Anyone else gets
 * the same NOT_FOUND as a missing request, and it is not in their queue or their Needs you, so another org's asks never cross over.
 */
export function mayDecideOn(actor: Actor, at: { workspace: string | null; requesterSession: string | null }): boolean {
  if (actor.kind !== 'user' || !mayDecide(actor)) return false;
  if (at.workspace) return can(actor, 'operate', workspaceRef(at.workspace)).allow;
  if (at.requesterSession) return can(actor, 'operate', objectRef('session', at.requesterSession)).allow;
  return isPlatformAdmin(actor.userId);
}

/** What a request one may not see and one that does not exist both answer. */
export const NO_APPROVAL = 'No such request.';
