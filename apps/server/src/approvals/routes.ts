// /api/approvals (docs/prd/approvals.md): a person's queue, one request, Allow and Deny. The service refuses anyone but a signed-in person
// with the same NOT_FOUND as a missing request.

import { success } from '@isnanme/core';
import type { DenyApprovalRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf } from '../authz/seam.js';
import type { Approvals } from './service.js';

/** The signed-in person's sign-in, for a kind that needs a fresh server code (session.bypass), as the Bypass route reads it. */
const tokenOf = (c: Context): string | undefined => (c as unknown as Context<{ Variables: { token?: string } }>).get('token');

export function createApprovalRoutes(approvals: Approvals): Hono {
  const r = new Hono();
  r.get('/', (c) => {
    approvals.expire();
    return c.json(success({ items: approvals.pending(actorOf(c)) }));
  });
  r.get('/:id', (c) => c.json(success(approvals.getFor(actorOf(c), c.req.param('id')))));
  r.post('/:id/allow', async (c) => c.json(success(await approvals.allow(actorOf(c), c.req.param('id'), { sessionToken: tokenOf(c), decidedBy: 'ui' }))));
  r.post('/:id/deny', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<DenyApprovalRequest> | null;
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    return c.json(success(await approvals.deny(actorOf(c), c.req.param('id'), reason, 'ui')));
  });
  return r;
}
