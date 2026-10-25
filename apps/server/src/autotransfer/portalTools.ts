// Auto transfer over the Portal MCP (docs/prd/auto-transfer.md FR22), read only; nothing changes a mode or moves a chat over MCP:
// - `autotransfer_status`: a chat's mode, whether the feature applies, the open card, the pause and the recent events.
// - `autotransfer_events` (T-968 S2a, general-manager PRD §9.1): the caller's trail across chats, whether each recent move can still be
//   undone, and the cards waiting for an answer. Every row is kept only when the caller may view its session.
// Declared in ./authz.ts (AUTOTRANSFER_TOOL_POLICIES).

import { AppError } from '@isnanme/core';
import { actorUserId, sessionRef, type ManagerAutoCardRow, type ManagerAutoEventRow } from '@portal/contracts';
import { actorOfPrincipal, can } from '../authz/seam.js';
import type { PlatformOwner } from '../platform/owner.js';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { AutoTransferEngine } from './engine.js';
import type { AutoStore } from './store.js';

export function registerAutoTransferTools(d: { engine: Pick<AutoTransferEngine, 'state' | 'claudeExcluded'>; store: AutoStore; owner: PlatformOwner }, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'autotransfer_status',
    title: 'Auto move status',
    description:
      'For one chat: its auto move mode (off, ask, auto) and the effective one, whether it applies (not on an account pool, a plan reading), whether the Claude it runs on is left out of auto move (claude_excluded: never a destination, never moved off by itself), an open move suggestion, a pause, moves today, and its recent auto move events. Read only.',
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
        claude_excluded: d.engine.claudeExcluded(args.session_id),
        paused_until: state.pausedUntil,
        moves_today: state.movesToday,
        suggestion: state.pending ? { id: state.pending.id, reason: state.pending.reason, from: state.pending.from.name, to: state.pending.to.name, left_pct: state.pending.facts.leftPct.value } : null,
        events: events.map((e) => ({ at: e.at, kind: e.kind, reason: e.reason, from: e.from?.name ?? null, to: e.to?.name ?? null, code: e.code, actor: e.actor })),
      };
    },
  });

  registry.register({
    name: 'autotransfer_events',
    title: 'Auto move events',
    description:
      'Your auto move trail, newest first, across your chats or for one: what happened (suggested, moved, declined, refused, undone, ...), why, from and to which Claude, and for a move whether its Undo is open now; ' +
      'plus the move cards waiting for an answer. Read only: nothing here moves a chat or answers a card.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      session_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Only this chat\'s.'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async handler(ctx, args) {
      const actor = actorOfPrincipal(ctx.principal);
      const userId = actorUserId(actor);
      if (!userId) throw new AppError('NOT_FOUND', 'No such session.');
      const mayView = (id: string) => can(actor, 'view', sessionRef(id)).allow;
      const events = d.store.events(userId, { session: args.session_id, limit: args.limit ?? 50 }).filter((e) => mayView(e.sessionId));
      // Only a chat's latest move within a day can be undone (the engine's own rule); one look per chat that has a move in the list.
      const undo = new Map<string, { eventId: number; ok: boolean } | null>();
      for (const e of events) {
        if (e.kind !== 'moved' || undo.has(e.sessionId)) continue;
        const last = (await d.engine.state(e.sessionId, userId)).lastMove;
        undo.set(e.sessionId, last ? { eventId: last.event.id, ok: last.undo.ok } : null);
      }
      const rows: ManagerAutoEventRow[] = events.map((e) => ({
        id: e.id,
        at: e.at,
        session_id: e.sessionId,
        kind: e.kind,
        reason: ctx.untrusted(e.reason, 'autotransfer', 300),
        from: ctx.untrusted(e.from?.name, 'claude', 80),
        to: ctx.untrusted(e.to?.name, 'claude', 80),
        code: ctx.untrusted(e.code, 'autotransfer', 80),
        actor: ctx.untrusted(e.actor, 'autotransfer', 80),
        undoable: e.kind === 'moved' ? undo.get(e.sessionId)?.eventId === e.id && undo.get(e.sessionId)!.ok : null,
      }));
      const cards: ManagerAutoCardRow[] = d.store
        .openSuggestions(userId)
        .filter((c) => (!args.session_id || c.sessionId === args.session_id) && mayView(c.sessionId))
        .map((c) => ({
          id: c.id,
          session_id: c.sessionId,
          at: c.at,
          reason: ctx.untrusted(c.reason, 'autotransfer', 300),
          from: ctx.untrusted(c.from.name, 'claude', 80),
          to: ctx.untrusted(c.to.name, 'claude', 80),
        }));
      return {
        summary: `${rows.length} event${rows.length === 1 ? '' : 's'}, ${cards.length} card${cards.length === 1 ? '' : 's'} waiting${rows.some((r) => r.undoable) ? ', a move can be undone' : ''}`,
        events: rows,
        cards,
      };
    },
  });
}
