// The one list of schedules (T-965, general-manager PRD §9.2; T-968 S2b): the portal's loops (those that beat through ./registry.ts, then
// those measured by platform/loops.ts that have no twin there), every trigger of any source with its owner, workspace and action, and the
// helpers outside the portal that send a heartbeat (./helpers.ts). Pipelines with a `schedule` are not listed: CI refuses that key as
// "not yet" (ci/spec/validate.ts), so there are none to list.

import type { ScheduleRow, TriggerRunState } from '@portal/contracts';
import { listLoops, type LoopInfo } from '../platform/loops.js';
import { redactSecrets } from '../portalmcp/sanitize.js';
import type { TriggerRecord, TriggerStore } from '../triggers/store.js';
import { portalHelpers, type HelperRegistry } from './helpers.js';
import { iso, NOT_A_TRIGGER, portalLoops, STALE_INTERVALS, type LoopRegistry } from './registry.js';

export interface SchedulesDeps {
  loops?: LoopRegistry;
  /** The loops platform/loops.ts measures (`listLoops`). */
  measured?: () => LoopInfo[];
  helpers?: Pick<HelperRegistry, 'rows'>;
  /** The triggers' store; absent when the triggers module is not there. */
  triggers?: Pick<TriggerStore, 'list'> & {
    runs(f: { triggerId: string; ownerId: null; limit: number }): { rows: { state: TriggerRunState }[] };
  };
  now?: () => Date;
}

const FAILED: ReadonlySet<TriggerRunState> = new Set(['failed', 'denied', 'expired']);

/**
 * Measured loops that are the same loop as one with a heartbeat (both registries wrap the same timer): listed once, by the heartbeat,
 * which also knows when the loop stopped.
 */
export const MEASURED_TWINS: Readonly<Record<string, string>> = {
  'claudeusage.poll': 'usage-probe',
  'claudeversion.schedule': 'version-canary',
};

export class Schedules {
  constructor(private readonly d: SchedulesDeps = {}) {}

  list(): ScheduleRow[] {
    const now = this.d.now?.() ?? new Date();
    const loops = (this.d.loops ?? portalLoops).rows(now);
    const beating = new Set(loops.map((r) => r.name));
    const measured = (this.d.measured ?? listLoops)()
      .filter((l) => !beating.has(MEASURED_TWINS[l.id] ?? ''))
      .map((l) => measuredRow(l, now.getTime()));
    const triggers = this.d.triggers ? this.d.triggers.list(null).map((t) => this.#trigger(t)) : [];
    const helpers = (this.d.helpers ?? portalHelpers).rows(now);
    return [...loops, ...measured, ...triggers, ...helpers];
  }

  #trigger(t: TriggerRecord): ScheduleRow {
    const last = this.d.triggers!.runs({ triggerId: t.id, ownerId: null, limit: 1 }).rows[0];
    const on = t.enabled && !t.paused;
    return {
      id: `trigger:${t.id}`,
      kind: 'trigger',
      name: redactSecrets(t.name),
      module: 'triggers',
      description: null,
      interval_ms: null,
      cron: t.cron ? { expr: t.cron.expr, tz: t.cron.tz } : null,
      last_run: t.lastRunAt,
      last_result: !last ? null : FAILED.has(last.state) ? 'failed' : last.state === 'succeeded' ? 'ok' : null,
      last_error: null,
      next_run: on && t.source === 'cron' ? t.nextRunAt : null,
      state: !on ? 'disabled' : last && FAILED.has(last.state) ? 'failing' : 'ok',
      source: t.source,
      owner: t.ownerId,
      target: t.action.workspaceId ?? null,
      action: t.action.type,
      enabled: on,
    };
  }
}

/** A measured loop: stale when it has not started a run (or been registered, before the first) for two intervals; failing after a throw. */
function measuredRow(l: LoopInfo, now: number): ScheduleRow {
  const since = l.lastRunAt ? Date.parse(l.lastRunAt) : Date.parse(l.since);
  const stale = now - since > STALE_INTERVALS * l.everyMs;
  return {
    id: `loop:${l.id}`,
    kind: 'loop',
    name: l.id,
    module: l.id.split('.')[0] ?? l.id,
    description: l.what,
    interval_ms: l.everyMs,
    cron: null,
    last_run: l.lastRunAt,
    last_result: l.lastOk === null ? null : l.lastOk ? 'ok' : 'failed',
    last_error: l.lastOk === false && l.lastError ? redactSecrets(l.lastError) : null,
    next_run: iso(since + l.everyMs),
    state: stale ? 'stale' : l.lastOk === false ? 'failing' : 'ok',
    ...NOT_A_TRIGGER,
  };
}
