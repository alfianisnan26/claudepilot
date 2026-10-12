// Auto transfer over the Portal MCP (docs/prd/auto-transfer.md FR22): ONE read tool, `autotransfer_status`: a chat's mode, whether the
// feature applies, the open card, the pause and the recent events. Nothing changes a mode or moves a chat over MCP.

import { AppError } from '@isnanme/core';
import { actorUserId } from '@portal/contracts';
import { actorOfPrincipal } from '../authz/seam.js';
import type { PlatformOwner } from '../platform/owner.js';
import { registerPortalTool, z } from '../portalmcp/registry.js';
import type { AutoTransferEngine } from './engine.js';
import type { AutoStore } from './store.js';

export function registerAutoTransferTools(d: { engine: AutoTransferEngine; store: AutoStore; owner: PlatformOwner }): void {
  registerPortalTool({
    name: 'autotransfer_status',
    title: 'Auto move status',
    description: 'For one chat: its auto move mode (off, ask, auto) and the effective one, whether it applies (not on an account pool, a plan reading), an open move suggestion, a pause, moves today, and its recent auto move events. Read only.',
    scope: 'read',
    hints: { readOnly: true },
    input: z.object({ session_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/) }),
    async handler(ctx, args) {
      const userId = actorUserId(actorOfPrincipal(ctx.principal));
      if (!userId || !d.owner.can(userId, 'view', { type: 'session', id: args.session_id })) throw new AppError('NOT_FOUND', 'No such session.');
      const state = await d.engine.state(args.session_id, userId);
      const events = d.store.events(userId, { session: args.session_id, limit: 10 });
      return {
        summary: `${state.effectiveMode}${state.applicable ? '' : ` (${state.why})`}, ${state.movesToday} move${state.movesToday === 1 ? '' : 's'} today${state.pending ? ', a move is suggested' : ''}`,
        mode: state.mode,
        effective_mode: state.effectiveMode,
        applicable: state.applicable,
        why: state.why,
        paused_until: state.pausedUntil,
        moves_today: state.movesToday,
        suggestion: state.pending ? { id: state.pending.id, reason: state.pending.reason, from: state.pending.from.name, to: state.pending.to.name, left_pct: state.pending.facts.leftPct.value } : null,
        events: events.map((e) => ({ at: e.at, kind: e.kind, reason: e.reason, from: e.from?.name ?? null, to: e.to?.name ?? null, code: e.code, actor: e.actor })),
      };
    },
  });
}
