// `schedules_list` on the Portal MCP (general-manager PRD §9.2, T-968 S2b): the same list as `GET /api/schedules`, read only. Declared in
// ./authz.ts (`view` on the platform's `system` area): the dispatch refuses anyone else with NOT_FOUND before this runs. A trigger's name
// was written by a person or an agent, and a helper's name, kind, owner and description by the helper (T-965): they are returned as
// untrusted text.

import type { ScheduleRow, ScheduleState } from '@portal/contracts';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { UntrustedText } from '../portalmcp/sanitize.js';
import type { Schedules } from './service.js';

type Said = string | UntrustedText | null;
export type ScheduleToolRow = Omit<ScheduleRow, 'name' | 'module' | 'owner' | 'description'> & {
  name: Said;
  module: Said;
  owner: Said;
  description: Said;
};

const ATTENTION: ReadonlySet<ScheduleState> = new Set(['stale', 'failing']);

export function registerSchedulesTools(schedules: Pick<Schedules, 'list'>, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'schedules_list',
    title: 'List the schedules',
    description:
      'Every scheduler and background loop of the portal in one list: its own loops (orphan sweep, cron tick, usage probe, delivery, version canary, notification clock, auto move, backup and the other measured loops) ' +
      'with interval, last run, last result and error, next run; every trigger (cron, ci_failed, webhook) with its owner, workspace, action, switch and last and next time; ' +
      'and the helpers outside the portal that send a heartbeat (the supervisor, monitors) with their last beat. ' +
      'state: ok, failing (the last run failed), stale (running but no heartbeat for two intervals), stopped, disabled. `attention: true` returns only stale and failing ones. Read only.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      kind: z.enum(['loop', 'trigger', 'helper']).optional().describe('Only loops, only triggers or only helpers.'),
      attention: z.boolean().optional().describe('Only the stale and failing ones.'),
    }),
    handler(ctx, args) {
      const rows = schedules.list().filter((r) => (!args.kind || r.kind === args.kind) && (!args.attention || ATTENTION.has(r.state)));
      const out: ScheduleToolRow[] = rows.map((r) =>
        r.kind === 'trigger'
          ? { ...r, name: ctx.untrusted(r.name, 'trigger') }
          : r.kind === 'helper'
            ? {
                ...r,
                name: ctx.untrusted(r.name, 'helper'),
                module: ctx.untrusted(r.module, 'helper'),
                owner: ctx.untrusted(r.owner, 'helper'),
                description: ctx.untrusted(r.description, 'helper'),
              }
            : r,
      );
      const stale = rows.filter((r) => r.state === 'stale').length;
      const failing = rows.filter((r) => r.state === 'failing').length;
      return {
        summary: `${rows.length} schedule${rows.length === 1 ? '' : 's'}${stale ? `, ${stale} stale` : ''}${failing ? `, ${failing} failing` : ''}`,
        schedules: out,
      };
    },
  });
}
