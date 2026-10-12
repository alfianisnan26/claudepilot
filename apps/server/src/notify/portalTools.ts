// Notifications over the Portal MCP (docs/prd/web-app-pwa.md §11.8): ONE read tool for an admin's token at the read scope, none for
// agents. No tool changes a destination, a policy or answers a request. It returns states, counts and fixed codes: never a URL, an
// endpoint, a host of a channel, a key or a token.

import { actorUserId } from '@portal/contracts';
import { actorOfPrincipal } from '../authz/seam.js';
import { registerPortalTool, z } from '../portalmcp/registry.js';
import type { Destinations } from './destinations.js';
import type { NotifyHistory } from './history.js';
import type { NotifyPipeline } from './pipeline.js';

export function registerNotifyTools(d: { destinations: Destinations; history: NotifyHistory; pipeline: NotifyPipeline; ceiling: () => boolean }): void {
  registerPortalTool({
    name: 'notify_status',
    title: 'Notification status',
    description: 'Whether notifications are delivered (ready, locked, frozen, readonly), the token owner’s destinations by type and state with their last error code, the answer ceiling, and how many Inbox items are unread. No addresses or keys.',
    scope: 'read',
    hints: { readOnly: true },
    input: z.object({}),
    handler(ctx) {
      const userId = actorUserId(actorOfPrincipal(ctx.principal));
      const dests = userId ? d.destinations.list(userId) : [];
      return {
        summary: `${d.pipeline.state()}: ${dests.length} destination${dests.length === 1 ? '' : 's'}, ${userId ? d.history.unread(userId) : 0} unread`,
        state: d.pipeline.state(),
        answers_ceiling: d.ceiling(),
        unread: userId ? d.history.unread(userId) : 0,
        destinations: dests.map((x) => ({ id: x.id, type: x.type, enabled: x.enabled, state: x.state, last_error: x.lastError, last_ok_at: x.lastOkAt, kinds: x.kinds.length })),
      };
    },
  });
}
