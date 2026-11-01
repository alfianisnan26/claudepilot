// Usage spend: the HTTP routes (docs/prd/claude-usage.md §26, USAGE_SPEND_API). No auth middleware here: app.ts mounts this under a
// guarded group (`requireSession`) at /api/usage-spend, like every other module; its Origin check covers the mutating calls.

import { AppError, success } from '@isnanme/core';
import { Hono, type Context } from 'hono';
import { byWorkspace, orgScopeFilter, orgScopeOf } from '../authz/orgScope.js';
import { actorUserId, actorOf as seamActorOf } from '../authz/seam.js';
import type { Who } from './actor.js';
import { attributionCsv } from './csv.js';
import type { UsageSpend } from './service.js';

// Who is asking: the signed-in person (org isolation, owner request 2026-11-01). Every read takes the actor it is for (the service's
// `visible`, installed by index.ts, keeps what they may view), every change records who made it. Nobody is an empty id (sees nothing).
const actorOf = (c: Context): string => actorUserId(seamActorOf(c)) ?? '';
const whoOf = (c: Context): Who => ({ actorId: actorOf(c), via: 'ui' });

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
}

export function createUsageSpendRoutes(spend: UsageSpend): Hono {
  const r = new Hono();

  // GET /api/usage-spend[?org=]: today, this week and this month, the budgets' levels, spikes of the last day, and the alerts. `?org=` (personal |
  // an org id; authz/orgScope.ts): only the usage of the workspaces that context owns (a request through its session's workspace).
  r.get('/', (c) => {
    const inScope = orgScopeFilter(seamActorOf(c), orgScopeOf(c));
    return c.json(success(spend.summary(actorOf(c), inScope ? byWorkspace(inScope) : undefined)));
  });

  // GET /api/usage-spend/alerts: the last day's alerts that are not snoozed.
  r.get('/alerts', (c) => c.json(success(spend.alerts(actorOf(c)))));

  // GET /api/usage-spend/audit?limit=: what people changed here (budgets made, changed, snoozed, removed; spike snoozes), and who.
  r.get('/audit', (c) => c.json(success(spend.audit(c.req.query('limit')))));

  // GET /api/usage-spend/attribution?by=&range=&claudeId=&workspaceId=&limit=&format=json|csv
  r.get('/attribution', (c) => {
    const q = c.req.query();
    const format = q.format ?? 'json';
    if (format !== 'json' && format !== 'csv') throw new AppError('VALIDATION_FAILED', 'Pick json or csv.', { details: { format: 'One of json, csv.' } });
    const report = spend.attribution({ by: q.by, range: q.range, claudeId: q.claudeId || undefined, workspaceId: q.workspaceId || undefined, limit: q.limit, done: q.done === '1' || q.done === 'true' }, actorOf(c));
    if (format === 'json') return c.json(success(report));
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="usage-by-${report.by}-${report.range}.csv"`);
    c.header('Cache-Control', 'no-store');
    return c.body(attributionCsv(report));
  });

  // GET /api/usage-spend/budgets; POST makes one (201).
  r.get('/budgets', (c) => c.json(success(spend.budgets(actorOf(c)))));
  r.post('/budgets', async (c) => c.json(success(await spend.createBudget(await body(c), whoOf(c))), 201));
  // PUT /api/usage-spend/budgets/:id: only what changes. DELETE removes it.
  r.put('/budgets/:id', async (c) => c.json(success(await spend.updateBudget(c.req.param('id'), await body(c), whoOf(c)))));
  r.delete('/budgets/:id', (c) => c.json(success(spend.deleteBudget(c.req.param('id'), whoOf(c)))));
  // PUT /api/usage-spend/budgets/:id/snooze {until: 1h|4h|reset}; DELETE ends it. 409 for a budget that pauses.
  r.put('/budgets/:id/snooze', async (c) => c.json(success(spend.snoozeBudget(c.req.param('id'), (await body(c)).until, whoOf(c)))));
  r.delete('/budgets/:id/snooze', (c) => c.json(success(spend.unsnoozeBudget(c.req.param('id'), whoOf(c)))));

  // GET /api/usage-spend/spikes?range=1d|7d|30d
  r.get('/spikes', (c) => c.json(success(spend.spikes(c.req.query('range') ?? '7d', actorOf(c)))));
  // PUT /api/usage-spend/spikes/snooze {subject, until: 1h|4h|day}; DELETE ?subject= ends it.
  r.put('/spikes/snooze', async (c) => {
    const b = await body(c);
    return c.json(success(spend.snoozeSpikes(b.subject, b.until, whoOf(c))));
  });
  r.delete('/spikes/snooze', (c) => c.json(success(spend.unsnoozeSpikes(c.req.query('subject'), whoOf(c)))));

  return r;
}
