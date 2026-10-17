// The schedules module (T-965, general-manager PRD §9.2; T-968 S2b): one read of every loop and cron trigger, as a route and a tool.
// Registered with one line in platform/index.ts. Later slices (PRD §9.2): the helpers' heartbeat route with its own token, the page, the
// actions (enable, run now).

import type { Platform, PlatformModule } from '../platform/index.js';
import { TriggerStore } from '../triggers/store.js';
import { declareSchedulesPolicies } from './authz.js';
import { registerSchedulesTools } from './portalTools.js';
import { createSchedulesRoutes } from './routes.js';
import { Schedules } from './service.js';

export { defineLoop, portalLoops, type LoopHeartbeat } from './registry.js';
export { Schedules } from './service.js';

export interface SchedulesModule extends PlatformModule {
  schedules: Schedules;
}

export function createSchedulesModule(platform: Platform, opts: { tools?: boolean } = {}): SchedulesModule {
  declareSchedulesPolicies();
  const schedules = new Schedules({ triggers: new TriggerStore(platform.deps.store) });
  if (opts.tools ?? platform.deps.tools !== false) registerSchedulesTools(schedules);
  return { name: 'schedules', routes: [{ path: '/api/schedules', app: createSchedulesRoutes(schedules) }], schedules };
}
