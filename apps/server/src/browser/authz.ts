// Browser & desktop: who may do what (docs/prd/authorization.md). T-531 declares the routes this module mounts on the workspaces router; each
// runs `workspaceGuard` with the verb below. The status and the configuration are `view`; control, handoffs and wake, stop or restart use the
// workspace (`operate`); retrying the install changes what is installed in it (`manage`, the PRD's Appendix A). The live-view sockets are
// checked at their own handshake.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import type { SocketPolicies } from '../authz/socketGuard.js';
import { onWorkspacePath } from '../workspaces/authz.js';

const WS = '/api/workspaces/:target/:name/browser';

export const BROWSER_POLICIES: RoutePolicies = {
  [`GET ${WS}`]: onWorkspacePath('view'),
  [`GET ${WS}/configuration`]: onWorkspacePath('view'),
  [`PUT ${WS}/control`]: onWorkspacePath('operate'),
  [`POST ${WS}/handoffs/:handoff`]: onWorkspacePath('operate'),
  [`POST ${WS}/install/retry`]: onWorkspacePath('manage'),
  [`POST ${WS}/:action`]: onWorkspacePath('operate'),
};

/**
 * T-1043 S0b: the live-view sockets (socket.ts). The VNC bridge and the proxy view show the workspace's browser and take its input, so both
 * are `operate` on the workspace, like the control route; their frames act on that browser only.
 */
export const BROWSER_SOCKET_POLICIES: SocketPolicies = {
  [`${WS}/view`]: { connect: onWorkspacePath('operate'), messages: {}, frames: 'the screen out, pointer and keys in, on the browser the handshake opened' },
  [`${WS}/preview`]: { connect: onWorkspacePath('operate'), messages: {}, frames: 'frames out, the page’s input in, on the browser the handshake opened' },
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareBrowserPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('browser', BROWSER_POLICIES);
}
