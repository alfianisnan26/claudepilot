// `schedules_list` on the Portal MCP (general-manager PRD §9.2, T-968 S2b): the same list as `GET /api/schedules`, read only. Declared in
// ./authz.ts (`view` on the platform's `system` area): the dispatch refuses anyone else with NOT_FOUND before this runs. A trigger's name
// was written by a person or an agent: it is returned as untrusted text.

import type { ManagerUntrusted, ScheduleRow, ScheduleState } from '@portal/contracts';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { Schedules } from './service.js';

export type ScheduleToolRow = Omit<ScheduleRow, 'name'> & { name: string | ManagerUntrusted };

const ATTENTION: ReadonlySet<ScheduleState> = new Set(['stale', 'failing']);

export function registerSchedulesTools(schedules: Pick<Schedules, 'list'>, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'schedules_list',
    title: 'List the schedules',
    description:
      'Every scheduler and background loop of the portal in one list: its own loops (orphan sweep, cron tick, usage probe, delivery, version canary, notification clock) ' +
      'with interval, last run, last result and error, next run, and every cron trigger with its expression, last and next time. ' +
      'state: ok, failing (the last run failed), stale (running but no heartbeat for two intervals), stopped, disabled. `attention: true` returns only stale and failing ones. Read only.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      kind: z.enum(['loop', 'trigger']).optional().describe('Only loops or only triggers.'),
      attention: z.boolean().optional().describe('Only the stale and failing ones.'),
    }),
    handler(_ctx, args) {
      const rows = schedules.list().filter((r) => (!args.kind || r.kind === args.kind) && (!args.attention || ATTENTION.has(r.state)));
      const out: ScheduleToolRow[] = rows.map((r) => (r.kind === 'trigger' ? { ...r, name: { untrusted_text: r.name } } : r));
      const stale = rows.filter((r) => r.state === 'stale').length;
      const failing = rows.filter((r) => r.state === 'failing').length;
      return {
        summary: `${rows.length} schedule${rows.length === 1 ? '' : 's'}${stale ? `, ${stale} stale` : ''}${failing ? `, ${failing} failing` : ''}`,
        schedules: out,
      };
    },
  });
}
