// `GET /api/schedules` (T-965, general-manager PRD §9.2; T-968 S2b): the one list of the portal's loops, every trigger and the helpers
// outside the portal that send a heartbeat (./heartbeat.ts). Mounted behind
// the sign-in guard; `view` on the platform's `system` area (./authz.ts), so anyone else is told the route does not exist.

import { success } from '@isnanme/core';
import { platformRef } from '@portal/contracts';
import { Hono } from 'hono';
import { actorOf, requireCan } from '../authz/seam.js';
import type { Schedules } from './service.js';

export function createSchedulesRoutes(schedules: Pick<Schedules, 'list'>): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    requireCan(actorOf(c), 'view', platformRef('system'));
    return c.json(success({ items: schedules.list() }));
  });
  return app;
}
