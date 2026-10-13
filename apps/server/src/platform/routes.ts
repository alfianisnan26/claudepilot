// `GET /api/platform/audit` (docs/prd/web-app-pwa.md §11.8): the rows every platform module writes. A user reads the rows about them; an
// admin reads all. Behind the session guard (app.ts mounts it).

import { success } from '@isnanme/core';
import { Hono } from 'hono';
import type { PlatformAudit } from './audit.js';
import type { PlatformOwner } from './owner.js';

export function createPlatformRoutes(d: { audit: PlatformAudit; owner: PlatformOwner }): Hono {
  const r = new Hono();
  r.get('/audit', (c) => {
    const a = d.owner.actorOf(c);
    const kind = c.req.query('kind');
    const limit = Number(c.req.query('limit'));
    const before = Number(c.req.query('before'));
    const rows = d.audit.list(
      {
        kind: kind && /^[a-z][a-z0-9_.]{0,60}$/.test(kind) ? kind : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        before: Number.isInteger(before) && before > 0 ? before : undefined,
        // Identity's filters (identity PRD §14): an exact actor string and an outcome.
        actor: /^[A-Za-z0-9:_.-]{1,120}$/.test(c.req.query('actor') ?? '') ? c.req.query('actor') : undefined,
        outcome: (['ok', 'denied', 'failed'] as const).find((o) => o === c.req.query('outcome')),
      },
      a.admin ? null : (a.userId ?? 'anonymous'),
    );
    return c.json(success(rows));
  });
  return r;
}
