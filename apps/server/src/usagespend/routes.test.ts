import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { AttributionReport, BudgetState, BudgetsReport, SpendAlert, SpendAuditEntry, SpendSummary, SpikesReport } from '@portal/contracts';
import { USAGE_SPEND_API } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { attributionCsv, csvCell } from './csv.js';
import { createUsageSpendRoutes } from './routes.js';
import { HOUR, MIN, NOW, spendHarness } from './testkit.js';

/** The routes as app.ts mounts them (the guard is app.ts's), with its error handler. */
const appOf = (spend: Parameters<typeof createUsageSpendRoutes>[0]) => {
  const app = new Hono();
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  app.route('/api/usage-spend', createUsageSpendRoutes(spend));
  return app;
};
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const send = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(`/api/usage-spend${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

test('the paths in the contract are the paths the routes answer', async () => {
  const h = await spendHarness();
  try {
    const app = appOf(h.spend);
    for (const path of [USAGE_SPEND_API.summary, USAGE_SPEND_API.alerts, USAGE_SPEND_API.attribution, USAGE_SPEND_API.budgets, USAGE_SPEND_API.spikes, USAGE_SPEND_API.audit]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
    }
    assert.equal(USAGE_SPEND_API.budget('b_1'), '/api/usage-spend/budgets/b_1');
    assert.equal(USAGE_SPEND_API.budgetSnooze('b_1'), '/api/usage-spend/budgets/b_1/snooze');
    assert.equal(USAGE_SPEND_API.spikeSnooze, '/api/usage-spend/spikes/snooze');
    assert.equal(USAGE_SPEND_API.audit, '/api/usage-spend/audit');
  } finally {
    h.done();
  }
});

test('summary, alerts and the attribution report as JSON; nothing in them names an account', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.seed.session('S1', { claudeId: 'c1', ticketId: 'T-1', title: 'Fix the build' });
    h.clock.t = NOW;
    h.seed.usage({ atMs: NOW - HOUR, session: 'S1', costUsd: 1.5, input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
    const app = appOf(h.spend);
    const summary = await data<SpendSummary>(await send(app, 'GET', ''));
    assert.deepEqual([summary.today.costUsd, summary.today.requests, summary.timezone, summary.alerts, summary.spikes24h, summary.budgets.total], [1.5, 1, 'UTC', [], 0, 0]);
    assert.deepEqual(await data<SpendAlert[]>(await send(app, 'GET', '/alerts')), []);
    const report = await data<AttributionReport>(await send(app, 'GET', '/attribution?by=ticket&range=1d'));
    assert.deepEqual([report.by, report.range, report.totals.costUsd, report.rows.map((r) => [r.key, r.total.costUsd, r.share])], ['ticket', '1d', 1.5, [['T-1', 1.5, { value: 100, basis: 'estimate' }]]]);
    const bySession = await data<AttributionReport>(await send(app, 'GET', '/attribution'));
    assert.equal(bySession.by, 'session', 'by session over 7 days by default');
    assert.ok(!/email|organi[sz]ation|token|credential|password/i.test(JSON.stringify([summary, report, bySession])));
    for (const q of ['?by=team', '?range=1y', '?limit=0', '?limit=abc', '?format=xml']) assert.equal((await send(app, 'GET', `/attribution${q}`)).status, 422, q);
  } finally {
    h.done();
  }
});

test('the CSV: one line per row, dollars named as estimates, a title that could be a formula neutralised, quotes doubled', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.seed.session('S1', { claudeId: 'c1', ticketId: 'T-1', title: '=1+1, "quoted"' });
    h.clock.t = NOW;
    h.seed.usage({ atMs: NOW - HOUR, session: 'S1', costUsd: 1.5, input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
    const res = await send(appOf(h.spend), 'GET', '/attribution?by=session&format=csv');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="usage-by-session-7d.csv"');
    const text = await res.text();
    const at = new Date(NOW - HOUR).toISOString();
    assert.equal(
      text,
      [
        'by,key,label,state,reason,cost_usd_estimate,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,requests,agents,own_cost_usd_estimate,own_requests,share_pct_estimate,sessions,first_at,last_at,depth,parent_id,workspace,claude,ticket,session_exists',
        `session,S1,"'=1+1, ""quoted""",known,,1.5,100,50,10,5,1,0,1.5,1,100,1,${at},${at},0,,api,Kresna,T-1,true`,
        '',
      ].join('\r\n'),
    );
    // The cell rules on their own.
    assert.deepEqual(['=a', '+a', '-a', '@a', '\ta', '\ra', 'a=', 'a,b', 'a"b', 'a\nb'].map(csvCell), ["'=a", "'+a", "'-a", "'@a", "'\ta", "\"'\ra\"", 'a=', '"a,b"', '"a""b"', '"a\nb"']);
    assert.deepEqual([csvCell(null), csvCell(undefined), csvCell(3), csvCell(0), csvCell(Number.NaN), csvCell(true)], ['', '', '3', '0', '', 'true']);
    // An empty window is just the header.
    const empty = attributionCsv({ ...(await data<AttributionReport>(await send(appOf(h.spend), 'GET', '/attribution?range=30m'))) });
    assert.equal(empty.split('\r\n').length, 2);
  } finally {
    h.done();
  }
});

test('budgets over HTTP: made (201), listed, changed, snoozed, removed; the refusals are 400, 404, 409 and 422', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    const app = appOf(h.spend);
    const made = await send(app, 'POST', '/budgets', { scope: { kind: 'claude', id: 'c1' }, period: 'day', limitUsd: 10 });
    assert.equal(made.status, 201);
    const b = await data<BudgetState>(made);
    assert.deepEqual([b.scopeLabel, b.budget.mode, b.level, b.paused], ['Kresna · api', 'alert', 'ok', false]);
    assert.deepEqual((await data<BudgetsReport>(await send(app, 'GET', '/budgets'))).budgets.map((s) => s.budget.id), [b.budget.id]);
    const changed = await data<BudgetState>(await send(app, 'PUT', `/budgets/${b.budget.id}`, { limitUsd: 20, name: 'Kresna daily' }));
    assert.deepEqual([changed.budget.limitUsd, changed.budget.name], [20, 'Kresna daily']);
    const snoozed = await data<BudgetState>(await send(app, 'PUT', `/budgets/${b.budget.id}/snooze`, { until: '1h' }));
    assert.equal(snoozed.snoozedUntil, new Date(NOW + HOUR).toISOString());
    assert.equal((await data<BudgetState>(await send(app, 'DELETE', `/budgets/${b.budget.id}/snooze`))).snoozedUntil, null);
    assert.equal((await send(app, 'PUT', `/budgets/${b.budget.id}/snooze`, { until: 'forever' })).status, 422);
    assert.equal((await send(app, 'PUT', `/budgets/${b.budget.id}/snooze`, {})).status, 422);
    // A budget that pauses can't be snoozed.
    await send(app, 'PUT', `/budgets/${b.budget.id}`, { mode: 'pause' });
    assert.equal((await send(app, 'PUT', `/budgets/${b.budget.id}/snooze`, { until: '1h' })).status, 409);

    assert.equal((await send(app, 'POST', '/budgets', { scope: { kind: 'all' }, period: 'day' })).status, 422, 'no limit');
    assert.equal((await send(app, 'POST', '/budgets', { scope: { kind: 'claude', id: 'nobody' }, period: 'day', limitUsd: 1 })).status, 422, 'unknown Claude');
    assert.equal((await send(app, 'POST', '/budgets', 'not json')).status, 400);
    assert.equal((await send(app, 'POST', '/budgets', [1])).status, 400, 'an array is not a body');
    assert.equal((await send(app, 'PUT', '/budgets/b_nope', { limitUsd: 1 })).status, 404);
    assert.equal((await send(app, 'DELETE', '/budgets/b_nope')).status, 404);
    assert.deepEqual(await data<{ id: string }>(await send(app, 'DELETE', `/budgets/${b.budget.id}`)), { id: b.budget.id });
    assert.equal((await data<BudgetsReport>(await send(app, 'GET', '/budgets'))).budgets.length, 0);
    // What was done is on the audit trail, by the owner at the keyboard, newest first.
    const trail = await data<SpendAuditEntry[]>(await send(app, 'GET', '/audit'));
    assert.deepEqual(trail.map((e) => [e.actor, e.via, e.action]), [
      ['u_owner', 'ui', 'budget.delete'],
      ['u_owner', 'ui', 'budget.update'],
      ['u_owner', 'ui', 'budget.unsnooze'],
      ['u_owner', 'ui', 'budget.snooze'],
      ['u_owner', 'ui', 'budget.update'],
      ['u_owner', 'ui', 'budget.create'],
    ]);
    assert.equal((await data<SpendAuditEntry[]>(await send(app, 'GET', '/audit?limit=2'))).length, 2);
    assert.equal((await send(app, 'GET', '/audit?limit=0')).status, 422);
    assert.equal((await send(app, 'GET', '/audit?limit=abc')).status, 422);
  } finally {
    h.done();
  }
});

test('spikes over HTTP: the report, a snooze for a session or a Claude, and its end', async () => {
  const h = await spendHarness({ settings: { 'usage.spikes.burstRequests': 3 } });
  try {
    const app = appOf(h.spend);
    h.clock.t = NOW;
    for (let i = 0; i < 3; i++) h.seed.turn({ atMs: NOW - 3 * MIN + i * MIN, session: 'S', costUsd: 0.01 });
    const report = await data<SpikesReport>(await send(app, 'GET', '/spikes?range=1d'));
    assert.deepEqual([report.range, report.events.map((e) => [e.kind, e.subject, e.summary, e.heuristic]), report.settings.burstRequests], ['1d', [['burst', 'S', '3 requests in 10 min (limit 3)', true]], 3]);
    assert.equal((await data<SpikesReport>(await send(app, 'GET', '/spikes'))).range, '7d');
    assert.equal((await send(app, 'GET', '/spikes?range=1y')).status, 422);
    const snoozed = await data<SpikesReport>(await send(app, 'PUT', '/spikes/snooze', { subject: 'S', until: '4h' }));
    assert.equal(snoozed.events[0]!.snoozedUntil, new Date(NOW + 4 * HOUR).toISOString());
    assert.equal((await send(app, 'PUT', '/spikes/snooze', { subject: 'S', until: 'week' })).status, 422);
    assert.equal((await send(app, 'PUT', '/spikes/snooze', { until: '1h' })).status, 422);
    const ended = await data<SpikesReport>(await send(app, 'DELETE', '/spikes/snooze?subject=S'));
    assert.equal(ended.events[0]!.snoozedUntil, null);
    assert.equal((await send(app, 'DELETE', '/spikes/snooze')).status, 422);
  } finally {
    h.done();
  }
});
