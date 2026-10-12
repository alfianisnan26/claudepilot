// Claude usage: the HTTP routes (docs/prd/claude-usage.md FR18). No auth middleware here: app.ts mounts this under a
// guarded group (`requireSession`) at /api/claude-usage, like every other module.

import { AppError, success } from '@isnanme/core';
import type { SnoozeUntil } from '@portal/contracts';
import { Hono } from 'hono';
import type { ClaudeUsageMonitor } from './service.js';

/** `until` of a snooze (FR17). */
const SNOOZE: readonly string[] = ['1h', '4h', 'reset'];

export function createClaudeUsageRoutes(usage: ClaudeUsageMonitor): Hono {
  const r = new Hono();

  // GET /api/claude-usage[?watch=1]: every Claude's windows. `watch` is the Usage tab being open (faster probing).
  r.get('/', async (c) => c.json(success(await usage.report({ watch: c.req.query('watch') === '1' }))));

  // GET /api/claude-usage/:claudeId/history?range=1d|7d|30d
  r.get('/:claudeId/history', async (c) => c.json(success(await usage.history(c.req.param('claudeId'), c.req.query('range') ?? '1d'))));

  // POST /api/claude-usage/:claudeId/check: probe now (a cooldown applies; refused for a pool and a stopped workspace).
  r.post('/:claudeId/check', async (c) => c.json(success(await usage.check(c.req.param('claudeId')))));

  // PUT /api/claude-usage/:claudeId/snooze {until}; DELETE ends it.
  r.put('/:claudeId/snooze', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    }
    const until = (body as { until?: unknown } | null)?.until;
    if (typeof until !== 'string' || !SNOOZE.includes(until)) throw new AppError('VALIDATION_FAILED', 'Pick 1h, 4h or reset.', { details: { until: 'One of 1h, 4h, reset.' } });
    return c.json(success(await usage.snooze(c.req.param('claudeId'), until as SnoozeUntil)));
  });
  r.delete('/:claudeId/snooze', async (c) => c.json(success(await usage.unsnooze(c.req.param('claudeId')))));

  return r;
}

