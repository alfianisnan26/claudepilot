import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { ClaudeUsageHistory, ClaudeUsage, ClaudeUsageReport } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createClaudeUsageRoutes } from './routes.js';
import { claude, HOUR, NOW, planResult, usageHarness, win } from './fixtures.js';

/** The routes as app.ts mounts them (the guard is app.ts's), with its error handler. */
const appOf = (usage: Parameters<typeof createClaudeUsageRoutes>[0]) => {
  const app = new Hono();
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  app.route('/api/claude-usage', createClaudeUsageRoutes(usage));
  return app;
};
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const send = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(`/api/claude-usage${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('GET returns every Claude with its windows, the thresholds and the alerts, and nothing that names an account', async () => {
  const h = await usageHarness({ probe: (async () => planResult([win('session', 96, NOW + 4 * HOUR, 'Session'), win('week', 20, NOW + 70 * HOUR, 'Week')])) as never });
  try {
    h.source.list = [claude({ id: 'c1' }), claude({ id: 'c2', name: 'Satria', workspaceId: 'docker/ws2', workspaceName: 'ws2', running: false })];
    await h.usage.tick();
    await new Promise((r) => setTimeout(r, 5));
    const res = await send(appOf(h.usage), 'GET', '');
    assert.equal(res.status, 200);
    const report = await data<ClaudeUsageReport>(res);
    assert.deepEqual(report.claudes.map((c) => [c.claudeId, c.claudeName, c.workspaceName, c.state]), [['c1', 'Default', 'ws1', 'near'], ['c2', 'Satria', 'ws2', 'unknown']]);
    assert.deepEqual(report.thresholds, { warn: 80, critical: 95 });
    assert.deepEqual(report.alerts.map((a) => [a.claudeId, a.window, a.level]), [['c1', 'session', 'high']]);
    assert.equal(report.intervalMs, 600_000);
    const json = JSON.stringify(report);
    assert.ok(!/email|organi[sz]ation|orgName|orgId|token|credential/i.test(json), 'no field names an account or a login');
    // ?watch=1 makes probing faster while the page is open.
    assert.equal((await data<ClaudeUsageReport>(await send(appOf(h.usage), 'GET', '?watch=1'))).intervalMs, 120_000);
  } finally {
    h.done();
  }
});

test('history: the ranges, and a bad one is a 422', async () => {
  const h = await usageHarness();
  try {
    const app = appOf(h.usage);
    h.store.db!.prepare(`INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, 'c1', 'x', 'session', 33, NULL, 'ok', 'probe')`).run(NOW - HOUR);
    const ok = await data<ClaudeUsageHistory>(await send(app, 'GET', '/c1/history?range=7d'));
    assert.equal(ok.range, '7d');
    assert.deepEqual(ok.series.map((s) => [s.key, s.points.map((p) => p.usedPct)]), [['session', [33]]]);
    assert.equal((await data<ClaudeUsageHistory>(await send(app, 'GET', '/c1/history'))).range, '1d', 'a day by default');
    const bad = await send(app, 'GET', '/c1/history?range=1y');
    assert.equal(bad.status, 422);
    assert.equal((await send(app, 'GET', '/nobody/history?range=1d')).status, 404);
  } finally {
    h.done();
  }
});

test('check: the fresh row, then the cooldown (429), a stopped workspace and a pool (409), a stranger (404)', async () => {
  const h = await usageHarness({ probe: (async () => planResult([win('session', 20, NOW + 4 * HOUR, 'Session')])) as never });
  try {
    h.source.list = [claude({ id: 'c1' }), claude({ id: 'c2', workspaceId: 'docker/ws2', workspaceName: 'ws2', running: false }), claude({ id: 'c3', workspaceId: 'docker/ws3', workspaceName: 'ws3' })];
    h.source.pools.add('docker/ws3');
    const app = appOf(h.usage);
    const first = await send(app, 'POST', '/c1/check');
    assert.equal(first.status, 200);
    assert.equal((await data<ClaudeUsage>(first)).windows[0]!.usedPct, 20);
    assert.equal((await send(app, 'POST', '/c1/check')).status, 429);
    assert.equal((await send(app, 'POST', '/c2/check')).status, 409);
    assert.equal((await send(app, 'POST', '/c3/check')).status, 409);
    assert.equal((await send(app, 'POST', '/nobody/check')).status, 404);
  } finally {
    h.done();
  }
});

test('snooze: a PUT with 1h, 4h or reset, a DELETE to end it, and anything else is refused', async () => {
  const h = await usageHarness();
  try {
    h.source.list = [claude({ id: 'c1' })];
    await h.usage.report();
    const app = appOf(h.usage);
    const on = await data<ClaudeUsage>(await send(app, 'PUT', '/c1/snooze', { until: '4h' }));
    assert.equal(on.snoozedUntil, new Date(NOW + 4 * HOUR).toISOString());
    const off = await data<ClaudeUsage>(await send(app, 'DELETE', '/c1/snooze'));
    assert.equal(off.snoozedUntil, null);
    for (const body of [{ until: '2h' }, { until: 3 }, {}, null, 'x']) assert.equal((await send(app, 'PUT', '/c1/snooze', body)).status, 422, JSON.stringify(body));
    const notJson = await app.request('/api/claude-usage/c1/snooze', { method: 'PUT', body: 'nope' });
    assert.equal(notJson.status, 400);
    assert.equal((await send(app, 'PUT', '/nobody/snooze', { until: '1h' })).status, 404);
  } finally {
    h.done();
  }
});
