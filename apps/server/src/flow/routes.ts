// `GET /api/flow` (T-1966, `FLOW_API.snapshot`): the watchdog's last round per program and its newest actions, for the Home card. Owner
// only: a platform admin as a person or through an admin token (`mayPause`'s rule, the same as Keep going's pause switch); an agent, a
// narrower token or another user gets the same 404 as an unknown route. Who is asking is read once (`owner.actorOf(c)`).

import { AppError, success } from '@isnanme/core';
import { Hono } from 'hono';
import { mayPause as isOwnerCaller } from '../keepgoing/routes.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { FlowEngine } from './engine.js';

export function createFlowRoutes(d: { owner: PlatformOwner; engine: Pick<FlowEngine, 'snapshot'> }): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const who = d.owner.actorOf(c);
    if (!isOwnerCaller(d.owner, who)) throw new AppError('NOT_FOUND', 'Not found.');
    return c.json(success(d.engine.snapshot()));
  });
  return app;
}
