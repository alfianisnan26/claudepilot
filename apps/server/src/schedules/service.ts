// The one list of schedules (T-965, general-manager PRD §9.2; T-968 S2b): the portal's loops from their registry, then every cron trigger
// with its next and last time and how its last run ended. Pipelines with a `schedule` are not listed: CI refuses that key as "not yet"
// (ci/spec/validate.ts), so there are none to list.

import type { ScheduleRow, TriggerRunState } from '@portal/contracts';
import { redactSecrets } from '../portalmcp/sanitize.js';
import type { TriggerRecord, TriggerStore } from '../triggers/store.js';
import { portalLoops, type LoopRegistry } from './registry.js';

export interface SchedulesDeps {
  loops?: LoopRegistry;
  /** The triggers' store; absent when the triggers module is not there. */
  triggers?: Pick<TriggerStore, 'bySource'> & { runs(f: { triggerId: string; ownerId: null; limit: number }): { rows: { state: TriggerRunState }[] } };
  now?: () => Date;
}

const FAILED: ReadonlySet<TriggerRunState> = new Set(['failed', 'denied', 'expired']);

export class Schedules {
  constructor(private readonly d: SchedulesDeps = {}) {}

  list(): ScheduleRow[] {
    const now = this.d.now?.() ?? new Date();
    const loops = (this.d.loops ?? portalLoops).rows(now);
    const triggers = this.d.triggers ? this.d.triggers.bySource('cron').map((t) => this.#trigger(t)) : [];
    return [...loops, ...triggers];
  }

  #trigger(t: TriggerRecord): ScheduleRow {
    const last = this.d.triggers!.runs({ triggerId: t.id, ownerId: null, limit: 1 }).rows[0];
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
      next_run: t.enabled && !t.paused ? t.nextRunAt : null,
      state: !t.enabled || t.paused ? 'disabled' : last && FAILED.has(last.state) ? 'failing' : 'ok',
    };
  }
}
