// The platform's own doors (organizations slice 1, P4): the routes outside /api that never carry a person's cookie. Each is its own door;
// declared so the whole-app enumeration (authz/routeTable.test.ts) covers them.

import type { RoutePolicies, RoutePolicy } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const HOOK: RoutePolicy = { kind: 'handler', checks: ['the trigger’s secret path token (triggers PRD): a wrong one is the same 404 as none'] };

export const PLATFORM_DOOR_POLICIES: RoutePolicies = {
  'GET /hooks/:token': HOOK,
  'HEAD /hooks/:token': HOOK,
  'PUT /hooks/:token': HOOK,
  'PATCH /hooks/:token': HOOK,
  'DELETE /hooks/:token': HOOK,
  'OPTIONS /hooks/:token': HOOK,
  'ALL /mcp': { kind: 'bearer', why: 'the Portal MCP endpoint: a Portal MCP token, capped by its scope and its user; each tool’s policy at dispatch' },
  'OPTIONS /reporter/v1/*': { kind: 'public', why: 'the UI reporter’s CORS preflight: no data, only which origins and headers are allowed' },
};

export function declarePlatformDoorPolicies(): void {
  declarePolicies('platform', PLATFORM_DOOR_POLICIES);
}
