// Glance: the HTTP route (docs/prd/glance-widgets.md §4). No auth middleware here: app.ts mounts this under a guarded group
// (`requireSession`) at /api/glance, like every other module. Read-only: what a widget lets a person do (answer an approval,
// stop an agent) goes through the chat socket's own messages, so none of its rules is repeated, or bypassed, here.

import { AppError, success } from '@isnanme/core';
import { Hono } from 'hono';
import { actorOf } from '../authz/seam.js';
import type { Glance } from './service.js';

export function createGlanceRoutes(glance: Glance): Hono {
  const r = new Hono();
  // GET /api/glance: the asker's snapshot (counts and the few top items for Sessions, Agents and Needs attention). Who is asking comes
  // from the authorization seam (`actorOf`), never from a header or a parameter.
  r.get('/', (c) => {
    const actor = actorOf(c);
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    return c.json(success(glance.snapshot(actor)));
  });
  return r;
}
