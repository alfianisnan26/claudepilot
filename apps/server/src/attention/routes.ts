// Needs you: the HTTP route (docs/prd/attention.md). app.ts mounts it under the session guard at /api/attention. Read only: approving
// stays on each module's own route.

import { AppError, success } from '@isnanme/core';
import { ATTENTION_SNOOZE_MAX_MIN, isAttentionKind, type AttentionSnoozeRequest } from '@portal/contracts';
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
  // POST /api/attention/snooze { kind, id, minutes? }: Later for the signed-in person (an hour by default, 0 brings it back). Not a decision.
  r.post('/snooze', async (c) => {
    const actor = actorOf(c);
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    const body = (await c.req.json().catch(() => null)) as Partial<AttentionSnoozeRequest> | null;
    if (!body || !isAttentionKind(body.kind) || typeof body.id !== 'string' || !body.id || body.id.length > 200)
      throw new AppError('VALIDATION_FAILED', 'Say which item.', { details: { id: 'Say which item.' } });
    if (body.minutes !== undefined && (typeof body.minutes !== 'number' || !Number.isFinite(body.minutes) || body.minutes < 0 || body.minutes > ATTENTION_SNOOZE_MAX_MIN))
      throw new AppError('VALIDATION_FAILED', 'Minutes out of range.', { details: { minutes: `0 to ${ATTENTION_SNOOZE_MAX_MIN}.` } });
    return c.json(success(registry.snooze(actor, body.kind, body.id, body.minutes)));
  });
  return r;
}
