// Needs you: the HTTP route (docs/prd/attention.md). app.ts mounts it under the session guard at /api/attention. Read only: approving
// stays on each module's own route.

import { AppError, success } from '@isnanme/core';
import { isAttentionKind } from '@portal/contracts';
import { Hono } from 'hono';
import { actorOf } from '../authz/seam.js';
import type { AttentionRegistry } from './registry.js';

export function createAttentionRoutes(registry: AttentionRegistry): Hono {
  const r = new Hono();
  // GET /api/attention?kind=&limit=&offset=: what waits on the asker, counted by kind, one page of it.
  r.get('/', (c) => {
    const actor = actorOf(c);
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    const kind = c.req.query('kind');
    if (kind && !isAttentionKind(kind)) throw new AppError('VALIDATION_FAILED', 'Unknown kind.', { details: { kind: 'Unknown kind.' } });
    const chosen = kind && isAttentionKind(kind) ? kind : null;
    const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
    return c.json(success(registry.list(actor, { kind: chosen, limit: num(c.req.query('limit')), offset: num(c.req.query('offset')) })));
  });
  return r;
}
