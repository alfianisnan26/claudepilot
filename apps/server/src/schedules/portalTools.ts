// `schedules_list` on the Portal MCP (general-manager PRD §9.2, T-968 S2b): the same list as `GET /api/schedules`, read only. Declared in
// ./authz.ts (`view` on the platform's `system` area): the dispatch refuses anyone else with NOT_FOUND before this runs. A trigger's name
// was written by a person or an agent, and a helper's name, kind, owner and description by the helper (T-965): they are returned as
// untrusted text.

import { AppError } from '@isnanme/core';
import { objectRef, type ScheduleRow, type ScheduleState } from '@portal/contracts';
import { actorOfPrincipal, can } from '../authz/seam.js';
import { portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import type { UntrustedText } from '../portalmcp/sanitize.js';
import type { ScheduleTriggers } from './actions.js';
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
      const out: ScheduleToolRow[] = rows.map((r) => toolRow(ctx, r));
      const stale = rows.filter((r) => r.state === 'stale').length;
      const failing = rows.filter((r) => r.state === 'failing').length;
      return {
        summary: `${rows.length} schedule${rows.length === 1 ? '' : 's'}${stale ? `, ${stale} stale` : ''}${failing ? `, ${failing} failing` : ''}`,
        schedules: out,
      };
    },
  });
}

/** One row as the tools return it: what came from a person, an agent or a helper is untrusted text. */
function toolRow(ctx: PortalToolContext, r: ScheduleRow): ScheduleToolRow {
  if (r.kind === 'trigger') return { ...r, name: ctx.untrusted(r.name, 'trigger') };
  if (r.kind === 'helper')
    return {
      ...r,
      name: ctx.untrusted(r.name, 'helper'),
      module: ctx.untrusted(r.module, 'helper'),
      owner: ctx.untrusted(r.owner, 'helper'),
      description: ctx.untrusted(r.description, 'helper'),
    };
  return r;
}

const NOT_FOUND = 'No such schedule. List them with schedules_list.';
const idArg = z.string().min(1).max(120).describe('The row id from schedules_list: `trigger:<id>`, `loop:<name>` or `helper:<name>`.');

/**
 * `schedule_get`, `schedule_set_enabled`, `schedule_run_now` (T-2950, general-manager PRD §9.2). Declared in ./authz.ts: `view` (get) and
 * `operate` (the two writes) on the platform's `system` area, refused with NOT_FOUND at dispatch. Then, for a trigger, the seam again on
 * that trigger: `view` to read it, `operate` to switch or run it (an operate token is capped at `operate`; `PATCH /api/triggers/:id` asks
 * `manage` because it changes everything, this tool only the switch). A refusal is the same NOT_FOUND as a missing id, so a call can't
 * tell them apart. Only a trigger can be switched or run; a webhook trigger runs on its events only. The writes go through the trigger
 * routes' service calls (./actions.ts).
 */
export function registerScheduleActionTools(
  schedules: Pick<Schedules, 'list'>,
  triggers: ScheduleTriggers | null,
  registry: ToolRegistry = portalTools,
): void {
  /** The row with this id, when the caller may see it; for a trigger, also its record when the caller holds `verb` on it. */
  const find = (ctx: PortalToolContext, id: string, verb: 'view' | 'operate') => {
    const row = schedules.list().find((r) => r.id === id);
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
    if (row.kind !== 'trigger') return { row, trigger: null };
    const triggerId = row.id.slice('trigger:'.length);
    const actor = actorOfPrincipal(ctx.principal);
    const ref = objectRef('trigger', triggerId);
    const t = triggers?.get(triggerId) ?? null;
    if (!t || !can(actor, 'view', ref).allow || !can(actor, verb, ref).allow) throw new AppError('NOT_FOUND', NOT_FOUND);
    return { row, trigger: t };
  };
  const onlyTrigger = (row: ScheduleRow, what: string) => {
    if (row.kind !== 'trigger') throw new AppError('CONFLICT', `Only a trigger can be ${what}: a ${row.kind} runs by itself.`);
  };

  registry.register({
    name: 'schedule_get',
    title: 'One schedule',
    description:
      'One row of schedules_list by its id (`trigger:<id>`, `loop:<name>`, `helper:<name>`), and for a trigger its last runs (state, reason code, session and ticket ids). Read only.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ id: idArg, runs: z.number().int().min(1).max(50).optional().describe('How many recent runs of a trigger (default 10).') }),
    handler(ctx, args) {
      const { row, trigger } = find(ctx, args.id, 'view');
      const runs = trigger && triggers ? triggers.runs(trigger, args.runs ?? 10) : [];
      return {
        summary: `${row.id}: ${row.state}${trigger ? `, ${runs.length} recent run${runs.length === 1 ? '' : 's'}` : ''}`,
        schedule: toolRow(ctx, row),
        runs: runs.map((r) => ({ id: r.id, at: r.at, state: r.state, reason: r.reason, session_id: r.sessionId, ticket_id: r.ticketId })),
      };
    },
  });

  registry.register({
    name: 'schedule_set_enabled',
    title: 'Switch a schedule',
    description:
      'Turns a trigger on or off (`trigger:<id>` from schedules_list), as its switch on the Schedules page does; turning it on also ends a pause by the portal. Loops and helpers cannot be switched. Needs the right to run that trigger.',
    scope: 'operate',
    hints: { idempotent: true },
    input: z.object({ id: idArg, enabled: z.boolean().describe('true: on; false: off.') }),
    handler(ctx, args) {
      const { row, trigger } = find(ctx, args.id, 'operate');
      onlyTrigger(row, 'switched');
      const next = triggers!.setEnabled(trigger!, args.enabled, ctx.actorLabel ?? ctx.actor);
      const now = schedules.list().find((r) => r.id === row.id) ?? row;
      return { summary: `${row.id} is ${next.enabled && !next.paused ? 'on' : 'off'}`, schedule: toolRow(ctx, now) };
    },
  });

  registry.register({
    name: 'schedule_run_now',
    title: 'Run a schedule now',
    description:
      'Runs a cron or failed-CI trigger once now (`trigger:<id>` from schedules_list), as Run now on the Schedules page does: the trigger’s own limits and approval apply, so the run may wait for approval or be skipped. A webhook trigger runs on its events only; loops and helpers run by themselves. Needs the right to run that trigger.',
    scope: 'operate',
    input: z.object({ id: idArg }),
    async handler(ctx, args) {
      const { row, trigger } = find(ctx, args.id, 'operate');
      onlyTrigger(row, 'run now');
      if (trigger!.source === 'webhook') throw new AppError('CONFLICT', 'A webhook trigger runs on its events: use Test on its page, or the Git host’s test delivery.');
      const res = await triggers!.runNow(trigger!, ctx.actorLabel ?? ctx.actor);
      if (res.kind !== 'run') throw new AppError('SERVICE_UNAVAILABLE', 'Nothing was started: the portal is not accepting runs now.');
      return {
        summary: `${row.id}: run ${res.run.id} ${res.run.state}${res.run.reason ? ` (${res.run.reason})` : ''}`,
        run: { id: res.run.id, at: res.run.at, state: res.run.state, reason: res.run.reason, session_id: res.run.sessionId, ticket_id: res.run.ticketId },
      };
    },
  });
}
