// Claude usage: the HTTP routes (docs/prd/claude-usage.md FR18). No auth middleware here: app.ts mounts this under a
// guarded group (`requireSession`) at /api/claude-usage, like every other module.

import { AppError, success } from '@isnanme/core';
import type { SnoozeKind, SnoozeUntil, UsageExportQuery } from '@portal/contracts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { OWNER_ACTOR } from './actor.js';
import type { ClaudeUsageMonitor } from './service.js';

/** `until` of a snooze (FR17). */
const SNOOZE: readonly string[] = ['1h', '4h', 'reset'];

/** `?tz=`: the viewer's `Date.getTimezoneOffset()`; anything that is not a plausible offset is left out (UTC). */
function tzOf(c: Context): number | undefined {
  const raw = c.req.query('tz');
  const tz = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(tz) && Math.abs(tz) <= 24 * 60 ? tz : undefined;
}

/** A Claude's or workspace's id from a query: short text, or nothing. */
function idOf(c: Context, name: string): string | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  if (v.length > 120) throw new AppError('VALIDATION_FAILED', `${name} is too long.`, { details: { [name]: 'At most 120 characters.' } });
  return v;
}

/** Who is asking. Until users exist (PLAN-10) it is the owner; the monitor's seam filters by it. */
const actorOf = (_c: Context): string => OWNER_ACTOR;

export function createClaudeUsageRoutes(usage: ClaudeUsageMonitor): Hono {
  const r = new Hono();

  // GET /api/claude-usage/summary?claudeId=&tz=: the summary strip (docs §20.7).
  r.get('/summary', async (c) => c.json(success(await usage.summary({ claudeId: idOf(c, 'claudeId'), tzOffsetMin: tzOf(c), actorId: actorOf(c) }))));

  // GET /api/claude-usage/requests?range=&claudeId=&tz=: the Requests report with the previous period, cache split and palette slots (§20.8).
  r.get('/requests', (c) => c.json(success(usage.requestsReport(c.req.query('range') ?? '1d', { claudeId: idOf(c, 'claudeId'), tzOffsetMin: tzOf(c), actorId: actorOf(c) }))));

  // GET /api/claude-usage/recommend?workspaceId=&from=: the Claudes a chat can move to, ranked (§20.5).
  r.get('/recommend', async (c) => {
    const workspaceId = idOf(c, 'workspaceId');
    const from = idOf(c, 'from');
    if (workspaceId) return c.json(success(await usage.recommend(workspaceId, from, actorOf(c))));
    if (from) return c.json(success(await usage.recommendFrom(from, actorOf(c))));
    throw new AppError('VALIDATION_FAILED', 'Name the workspace, or the Claude the chat leaves.', { details: { workspaceId: 'Required without from.' } });
  });

  // GET /api/claude-usage/palette: every Claude's and model's palette slot (§20.6).
  r.get('/palette', (c) => c.json(success(usage.palette())));

  // GET /api/claude-usage/export?what=requests|quota&format=csv|json&range=&claudeId=&tz=: a file (§20.9).
  r.get('/export', async (c) => {
    const q: Partial<UsageExportQuery> = {
      what: c.req.query('what') as UsageExportQuery['what'] | undefined,
      format: c.req.query('format') as UsageExportQuery['format'] | undefined,
      range: c.req.query('range') as UsageExportQuery['range'] | undefined,
      claudeId: idOf(c, 'claudeId'),
      tz: tzOf(c),
    };
    const file = await usage.exportFile(q, actorOf(c));
    return c.body(file.body, 200, { 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.fileName}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });

  // GET /api/claude-usage[?watch=1]: every Claude's windows. `watch` is the Usage tab being open (faster probing).
  r.get('/', async (c) => c.json(success(await usage.report({ watch: c.req.query('watch') === '1' }))));

  // GET /api/claude-usage/:claudeId/history?range=1d|7d|30d
  r.get('/:claudeId/history', async (c) => c.json(success(await usage.history(c.req.param('claudeId'), c.req.query('range') ?? '1d'))));

  // POST /api/claude-usage/:claudeId/check: probe now (a cooldown applies; refused for a pool and a stopped workspace).
  r.post('/:claudeId/check', async (c) => c.json(success(await usage.check(c.req.param('claudeId')))));

  // PUT /api/claude-usage/:claudeId/snooze {until, kind?: 'projection'}; DELETE ends it (`?kind=projection`: only the projection snooze).
  r.put('/:claudeId/snooze', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    }
    const until = (body as { until?: unknown } | null)?.until;
    if (typeof until !== 'string' || !SNOOZE.includes(until)) throw new AppError('VALIDATION_FAILED', 'Pick 1h, 4h or reset.', { details: { until: 'One of 1h, 4h, reset.' } });
    const kind = (body as { kind?: unknown } | null)?.kind;
    if (kind !== undefined && kind !== 'projection') throw new AppError('VALIDATION_FAILED', 'Snooze projection alerts, or leave it out.', { details: { kind: 'Absent or projection.' } });
    return c.json(success(await usage.snooze(c.req.param('claudeId'), until as SnoozeUntil, kind as SnoozeKind | undefined)));
  });
  r.delete('/:claudeId/snooze', async (c) => {
    const kind = c.req.query('kind');
    if (kind !== undefined && kind !== 'projection') throw new AppError('VALIDATION_FAILED', 'Snooze projection alerts, or leave it out.', { details: { kind: 'Absent or projection.' } });
    return c.json(success(await usage.unsnooze(c.req.param('claudeId'), kind as SnoozeKind | undefined)));
  });

  return r;
}

