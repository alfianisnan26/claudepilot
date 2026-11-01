// `GET /api/schedules` (T-965, general-manager PRD §9.2; T-968 S2b): the one list of the portal's loops, every trigger and the helpers
// outside the portal that send a heartbeat (./heartbeat.ts). Mounted behind
// the sign-in guard; `view` on the platform's `system` area (./authz.ts), so anyone else is told the route does not exist.
// `?org=` (the org switcher, D-111): a trigger follows its workspace's org (authz/orgScope.ts); the portal's own loops and helpers are the
// instance's, listed in Personal (and with no `?org=`) only, never in an org's context.

import { success } from '@isnanme/core';
import { platformRef, workspaceRef } from '@portal/contracts';
import { orgScopeFilter, orgScopeOf } from '../authz/orgScope.js';
import { Hono } from 'hono';
import { actorOf, requireCan } from '../authz/seam.js';
import type { Schedules } from './service.js';

export function createSchedulesRoutes(schedules: Pick<Schedules, 'list'>): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'view', platformRef('system'));
    const scope = orgScopeOf(c);
    const inScope = orgScopeFilter(actor, scope);
    const items = schedules.list();
    if (!inScope) return c.json(success({ items }));
    return c.json(
      success({ items: items.filter((r) => (r.kind === 'trigger' ? inScope(r.target ? workspaceRef(r.target) : null) : scope?.kind === 'personal')) }),
    );
  });
  return app;
}
