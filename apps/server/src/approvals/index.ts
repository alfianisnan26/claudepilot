// Approvals (docs/prd/approvals.md, PILOT-1000 / T-2867): index.ts builds the service, app.ts mounts its routes at /api/approvals, and
// the Needs you source and the Portal MCP tools are registered from here.

import type { Store } from '../store/store.js';
import { declareApprovalPolicies } from './authz.js';
import type { ApprovalChat, ApprovalPools } from './kinds.js';
import { Approvals } from './service.js';

export { Approvals, type ApprovalCreate } from './service.js';
export { APPROVAL_KIND_DEFS, type ApprovalChat, type ApprovalRequester } from './kinds.js';
export { approvalAttentionSource } from './attention.js';
export { createApprovalRoutes } from './routes.js';
export { registerApprovalTools } from './portalTools.js';

export function createApprovals(store: Pick<Store, 'db'>, opts: { chat?: ApprovalChat | null; pools?: ApprovalPools | null; changed?: () => void } = {}): Approvals {
  declareApprovalPolicies();
  return new Approvals({
    db: () => store.db,
    chat: opts.chat ?? null,
    pools: opts.pools ?? null,
    ...(opts.changed ? { changed: opts.changed } : {}),
    log: (what, e) => console.error(`[approvals] ${what} failed: ${(e as Error).message}`),
  });
}
