// Portal MCP: who may do what with the admin routes (`/api/portal-mcp`, docs/prd/authorization.md, the Portal MCP rows). A token is one
// person's own (`personal`): minting, revoking one and revoking a label's tokens need `manage` on it, so a read or operate token is capped
// below it and an agent's per-session token (`cpst_`) is refused outright (agent_box). Today the seam answers the one owner through the
// cookie; the declarations are what the multi-user layer enforces.

import type { ObjectRef, RoutePolicies, ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

/** The personal object a token route acts on: one token, or the person's tokens as a whole (minting, a label). */
export const tokenRef = (id = '*'): ObjectRef => ({ type: 'personal', id: `pmcp_token:${id}` });

const API = '/api/portal-mcp';

export const PORTAL_MCP_POLICIES: RoutePolicies = {
  [`GET ${API}`]: { kind: 'signed-in' },
  [`PUT ${API}/settings`]: { kind: 'platform', area: 'settings', verb: 'manage', reauth: true },
  [`POST ${API}/tokens`]: { kind: 'self', reauth: true, audit: 'pmcp.token.create' },
  [`POST ${API}/tokens/revoke-label`]: { kind: 'self', audit: 'pmcp.token.revoke' },
  [`DELETE ${API}/tokens/:id`]: { kind: 'objects', checks: [{ type: 'personal', verb: 'manage', from: 'path', param: 'id' }], audit: 'pmcp.token.revoke' },
  [`POST ${API}/revoke-all`]: { kind: 'self' },
  [`GET ${API}/agents`]: { kind: 'signed-in', filter: 'workspace' },
  [`PUT ${API}/agents/:target/:name`]: { kind: 'objects', checks: [{ type: 'workspace', verb: 'manage', from: 'path', param: 'target+name' }], reauth: true },
  [`GET ${API}/audit`]: { kind: 'signed-in' },
};

/**
 * T-336: `session_start` operates the workspace it starts in, the Claude it names and, with `parent`, the parent session (the handler asks the seam, and a refused
 * parent is the same not found as a missing one: tools/sessions.ts `leadFor`).
 */
export const PORTAL_MCP_TOOL_POLICIES = {
  session_start: {
    kind: 'objects',
    checks: [
      { type: 'workspace', verb: 'operate', arg: 'workspace_id' },
      { type: 'claude', verb: 'operate', arg: 'claude_id', optional: true },
      { type: 'session', verb: 'operate', arg: 'parent', optional: true },
    ],
  },
} satisfies ToolPolicies;

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declarePortalMcpPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('portalmcp', PORTAL_MCP_POLICIES);
  declareToolPolicies('portalmcp', PORTAL_MCP_TOOL_POLICIES);
}
