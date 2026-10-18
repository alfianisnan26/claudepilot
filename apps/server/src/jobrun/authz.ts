// The job-run Mac door (T-1083 S1b, D-84): who may do what.
//
// - The admin routes (`/api/jobrun/tokens`, behind the cookie, the CSRF check and `requireSession`): minting, listing and revoking a door
//   token need `manage` on the platform's `targets` area: an admin, signed in, in the browser. A Portal MCP token (`cpat_`), an agent's
//   (`cpst_`) or a door token never reaches `/api` (it takes the cookie only); and the seam refuses an agent the platform anyway.
// - The door (`/jobrun/mac/*`, outside /api, like /mcp and /hooks/ci): its own key is a `cpjr_` door token (tokens.ts) and no other. The
//   door then acts as the admin who minted it (`asUser`, a job acting for them) and asks can(operate) on the token's ONE workspace on every
//   call. A run is seen and stopped only by the token that started it. Every refusal is the same 404 as a route that does not exist.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

export const JOBRUN_POLICIES = {
  'GET /api/jobrun/tokens': { kind: 'platform', area: 'targets', verb: 'manage' },
  'POST /api/jobrun/tokens': { kind: 'platform', area: 'targets', verb: 'manage', reauth: true, audit: 'jobrun.token.create' },
  'DELETE /api/jobrun/tokens/:id': { kind: 'platform', area: 'targets', verb: 'manage', audit: 'jobrun.token.revoke' },
} satisfies RoutePolicies;

const DOOR_CHECKS = ['a cpjr_ door token: exists, not revoked, not expired (tokens.ts)', 'the minting admin may operate the token’s workspace: can(asUser, operate, workspace)'];

export const JOBRUN_DOOR_POLICIES = {
  'GET /jobrun/mac/slot': { kind: 'handler', checks: DOOR_CHECKS },
  'GET /jobrun/mac/runs': { kind: 'handler', checks: [...DOOR_CHECKS, 'only the runs this token started'] },
  'POST /jobrun/mac/runs': { kind: 'handler', checks: [...DOOR_CHECKS, 'a body of at most 64 KiB'] },
  'GET /jobrun/mac/runs/:id/log': { kind: 'handler', checks: [...DOOR_CHECKS, 'a run this token started'] },
  'DELETE /jobrun/mac/runs/:id': { kind: 'handler', checks: [...DOOR_CHECKS, 'a run this token started'] },
} satisfies RoutePolicies;

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareJobRunPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('jobrun', JOBRUN_POLICIES);
  declarePolicies('jobrun', JOBRUN_DOOR_POLICIES);
}
