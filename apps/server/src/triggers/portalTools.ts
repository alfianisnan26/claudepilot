// Triggers over the Portal MCP (docs/prd/triggers.md FR22): two READ tools at the read scope, for a person's token only (no agent token
// reaches them). No tool creates, edits, enables, approves or fires a trigger. They return names, states, counts and fixed codes: never a
// receiver path, a secret, a template or any event text (the facts' validated fields only, without the quoted text).

import { actorUserId } from '@portal/contracts';
import { actorOfPrincipal } from '../authz/seam.js';
import type { PlatformOwner } from '../platform/owner.js';
import { registerPortalTool, z } from '../portalmcp/registry.js';
import type { TriggerService } from './service.js';
import { ticketKeyField } from '../tickets/keys.js';

export function registerTriggerTools(d: { service: TriggerService; owner: PlatformOwner }): void {
  const mine = (userId: string | null) => (userId ? d.service.store.list(userId).filter((t) => d.owner.can(userId, 'view', { type: 'trigger', id: t.id })) : []);

  registerPortalTool({
    name: 'trigger_list',
    title: 'List triggers',
    description: 'The token owner’s triggers: name, source (cron, webhook, ci_failed), on or off, the action type and workspace, the next and last run, runs and estimated cost today. No addresses, secrets or templates.',
    scope: 'read',
    hints: { readOnly: true },
    input: z.object({}),
    handler(ctx) {
      const userId = actorUserId(actorOfPrincipal(ctx.principal));
      const list = mine(userId).map((t) => d.service.view(t));
      return {
        summary: `${list.length} trigger${list.length === 1 ? '' : 's'}`,
        triggers: list.map((t) => ({
          id: t.id,
          name: t.name,
          source: t.source,
          provider: t.webhook?.provider ?? null,
          enabled: t.enabled,
          action: t.action.type,
          workspace_id: t.action.workspaceId,
          approval: t.approval.mode,
          next_run_at: t.nextRunAt,
          last_run_at: t.lastRunAt,
          runs_today: t.runsToday,
          cost_today_usd_estimate: t.costToday.value,
        })),
      };
    },
  });

  registerPortalTool({
    name: 'trigger_runs',
    title: 'Trigger runs',
    description: 'Recent runs of the token owner’s triggers (or of one, by trigger_id): state, reason code, event type, repository, branch, number, the session and ticket ids, and the estimated cost. No event text. Tickets show as ticket_id and ticket_key.',
    scope: 'read',
    hints: { readOnly: true },
    input: z.object({ trigger_id: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).optional() }),
    handler(ctx, args) {
      const userId = actorUserId(actorOfPrincipal(ctx.principal));
      const names = new Map(mine(userId).map((t) => [t.id, t.name]));
      if (!userId || (args.trigger_id && !names.has(args.trigger_id))) return { summary: '0 runs', runs: [] };
      const page = d.service.store.runs({ ownerId: userId, triggerId: args.trigger_id, limit: args.limit ?? 20 });
      const runs = page.rows.map((row) => d.service.store.view(row, names.get(row.trigger_id) ?? 'Deleted trigger'));
      return {
        summary: `${runs.length} run${runs.length === 1 ? '' : 's'}`,
        runs: runs.map((r) => ({
          id: r.id,
          trigger_id: r.triggerId,
          trigger: r.triggerName,
          at: r.at,
          state: r.state,
          reason: r.reason,
          event: r.event.event,
          action: r.event.action,
          repo: r.event.repo,
          branch: r.event.branch,
          number: r.event.number,
          session_id: r.sessionId,
          ticket_id: r.ticketId,
          ...ticketKeyField(r.ticketId),
          cost_usd_estimate: r.costUsd.value,
        })),
      };
    },
  });
}
