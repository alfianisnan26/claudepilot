// MCP sets (organizations slice 1, P4): every route under /api/mcp, enforced centrally (authz/routeGuard.ts). The catalog and the built-in
// templates are the platform's reviewed library (`library`): adding, changing, approving, deprecating and revoking entries are an admin's;
// reading an entry is open to whoever may use the library. Trying a set operates it; a workspace's MCP status, sign-ins and retries follow
// the workspace (view to read, operate to act).

import type { RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const library = (verb: Verb): RoutePolicy => ({ kind: 'platform', area: 'library', verb });
const entry = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'mcp_entry', verb, from: 'path', param: 'id' }] });
const ws = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'workspace', verb, from: 'path', param: 'target+name' }] });
const C = '/api/mcp/catalog';
const W = '/api/mcp/workspaces/:target/:name';

export const MCP_POLICIES: RoutePolicies = {
  [`GET ${C}`]: { kind: 'signed-in', filter: 'mcp_entry' },
  [`POST ${C}`]: library('manage'),
  [`GET ${C}/:id`]: entry('view'),
  [`PATCH ${C}/:id`]: library('manage'),
  [`DELETE ${C}/:id`]: library('manage'),
  [`POST ${C}/:id/versions`]: library('manage'),
  [`PUT ${C}/:id/versions/:vid`]: library('manage'),
  [`DELETE ${C}/:id/versions/:vid`]: library('manage'),
  [`POST ${C}/:id/versions/:vid/approve`]: library('manage'),
  [`POST ${C}/:id/versions/:vid/deprecate`]: library('manage'),
  [`POST ${C}/:id/versions/:vid/revoke`]: library('manage'),
  'GET /api/mcp/builtin': { kind: 'signed-in' },
  'POST /api/mcp/builtin/:id/add': library('manage'),
  'POST /api/mcp/builtin/:id/preview': library('manage'),
  'POST /api/mcp/sets/:poolId/try': { kind: 'objects', checks: [{ type: 'pool', verb: 'operate', from: 'path', param: 'poolId' }] },
  [`GET ${W}`]: ws('view'),
  [`GET ${W}/matchers`]: ws('view'),
  [`GET ${W}/auth`]: ws('view'),
  [`POST ${W}/auth`]: ws('operate'),
  [`POST ${W}/installs/retry`]: ws('operate'),
  [`POST ${W}/verify`]: ws('operate'),
  [`POST ${W}/signin`]: ws('operate'),
  [`DELETE ${W}/signin/:signInId`]: ws('operate'),
  [`POST ${W}/signin/:signInId/complete`]: ws('operate'),
  [`POST ${W}/signout`]: ws('operate'),
};

export function declareMcpPolicies(): void {
  declarePolicies('mcp', MCP_POLICIES);
}
