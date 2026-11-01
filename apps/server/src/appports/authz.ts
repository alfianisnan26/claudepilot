// App ports (organizations slice 1, P4): the admin page's list of open app sessions and closing one (app.ts). Opening a port is declared
// with the workspace routes; the list of every open app session across workspaces is the platform's `system` area.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

export const APP_PORT_POLICIES: RoutePolicies = {
  'GET /api/admin/app-sessions': { kind: 'platform', area: 'system', verb: 'view' },
  'DELETE /api/admin/app-sessions/:id': { kind: 'platform', area: 'system', verb: 'manage', audit: 'workspace.port.closed' },
};

export function declareAppPortPolicies(): void {
  declarePolicies('appports', APP_PORT_POLICIES);
}
