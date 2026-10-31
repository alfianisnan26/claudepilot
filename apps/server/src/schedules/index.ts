// The schedules module (T-965, general-manager PRD §9.2; T-968 S2b): one read of every loop and cron trigger, as a route and a tool.
// Registered with one line in platform/index.ts. The helpers' heartbeat route has its own token (./heartbeat.ts). T-2950: given the
// triggers module, the tools `schedule_get`, `schedule_set_enabled` and `schedule_run_now` act on a trigger through its own service calls.

import type { Platform, PlatformModule } from '../platform/index.js';
import type { TriggersModule } from '../triggers/index.js';
import { TriggerStore } from '../triggers/store.js';
import { scheduleTriggers } from './actions.js';
import { declareSchedulesPolicies } from './authz.js';
import { registerScheduleActionTools, registerSchedulesTools } from './portalTools.js';
import { createSchedulesRoutes } from './routes.js';
import { Schedules } from './service.js';

export { defineLoop, portalLoops, type LoopHeartbeat } from './registry.js';
export { Schedules } from './service.js';

export interface SchedulesModule extends PlatformModule {
  schedules: Schedules;
}

export function createSchedulesModule(platform: Platform, opts: { tools?: boolean; triggers?: Pick<TriggersModule, 'service' | 'runner'> } = {}): SchedulesModule {
  declareSchedulesPolicies();
  const schedules = new Schedules({ triggers: new TriggerStore(platform.deps.store) });
  if (opts.tools ?? platform.deps.tools !== false) {
    registerSchedulesTools(schedules);
    const t = opts.triggers;
    registerScheduleActionTools(
      schedules,
      t ? scheduleTriggers({ service: t.service, runner: t.runner, audit: platform.audit, publish: () => platform.publish('triggers') }) : null,
    );
  }
  return { name: 'schedules', routes: [{ path: '/api/schedules', app: createSchedulesRoutes(schedules) }], schedules };
}
