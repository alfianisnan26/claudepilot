// What the schedule tools may do to a trigger (T-2950, general-manager PRD §9.2): read it and its recent runs, switch it, run it now. The
// same service calls as the trigger routes (`PATCH /api/triggers/:id { enabled }`, `POST /api/triggers/:id/run`), so the trigger's own
// limits, approval and audit apply; no second path. Built from the triggers module in ./index.ts; absent when that module is not there.

import type { TriggerRun, TriggerRunState } from '@portal/contracts';
import type { PlatformAudit } from '../platform/audit.js';
import type { FireResult, TriggerRunner } from '../triggers/runner.js';
import { manualFacts } from '../triggers/routes.js';
import type { TriggerService } from '../triggers/service.js';
import type { TriggerRecord } from '../triggers/store.js';

export interface ScheduleTriggers {
  get(id: string): TriggerRecord | null;
  /** Newest first, at most `limit`. */
  runs(t: TriggerRecord, limit: number): Pick<TriggerRun, 'id' | 'at' | 'state' | 'reason' | 'sessionId' | 'ticketId'>[];
  setEnabled(t: TriggerRecord, enabled: boolean, actor: string): TriggerRecord;
  runNow(t: TriggerRecord, actor: string): Promise<FireResult>;
}

export function scheduleTriggers(d: {
  service: Pick<TriggerService, 'update' | 'store'>;
  runner: Pick<TriggerRunner, 'fire'>;
  audit: Pick<PlatformAudit, 'record'>;
  publish(): void;
  now?: () => Date;
}): ScheduleTriggers {
  return {
    get: (id) => d.service.store.get(id),
    runs: (t, limit) =>
      d.service.store.runs({ triggerId: t.id, ownerId: null, limit }).rows.map((r) => ({
        id: r.id,
        at: r.at,
        state: r.state as TriggerRunState,
        reason: d.service.store.view(r, t.name).reason,
        sessionId: r.session_id,
        ticketId: r.ticket_id,
      })),
    setEnabled(t, enabled, actor) {
      // The route's path: `update` also ends a pause by the portal when a person turns it on again.
      const next = d.service.update(t, { enabled });
      d.audit.record({ kind: 'trigger.updated', actor, userId: t.ownerId, subject: `trigger:${t.id}`, severity: 'info', detail: { triggerId: t.id, enabled: next.enabled, via: 'schedule_set_enabled' } });
      d.publish();
      return next;
    },
    runNow: (t, actor) => d.runner.fire(t, { facts: manualFacts(t, (d.now ?? (() => new Date()))().toISOString()), actor, unfiltered: true }),
  };
}
