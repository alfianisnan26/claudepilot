// The insight routes (docs/prd/claude-usage.md §20.10): shapes, parameters, refusals, the download headers, and the projection snooze's kind.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { ClaudeUsage, MoveRecommendation, RequestsReport, UsagePalette, UsageSummary } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createClaudeUsageRoutes } from './routes.js';
import { claude, HOUR, NOW, planResult, seedClaude, seedUsage, usageHarness, win } from './fixtures.js';

const appOf = (usage: Parameters<typeof createClaudeUsageRoutes>[0]) => {
  const app = new Hono();
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  app.route('/api/claude-usage', createClaudeUsageRoutes(usage));
  return app;
};
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const get = (app: Hono, path: string) => app.request(`/api/claude-usage${path}`);
const send = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(`/api/claude-usage${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function rig() {
  const h = await usageHarness({ probe: (async () => planResult([win('session', 40, NOW + 4 * HOUR, 'Session')])) as never });
  h.source.list = [claude({ id: 'c1' })];
  seedClaude(h.store, 'c1', 'docker/ws1', 'Default');
  seedUsage(h.store, [{ at: NOW - 30 * 60_000, claude: '', input: 100, output: 50, cacheRead: 300, cost: 0.2 }]);
  await h.usage.tick();
  await new Promise((r) => setTimeout(r, 5));
  return h;
}

test('summary, requests, recommend and palette answer in the contract’s shapes; a bad range, a stranger and a missing workspace are refused', async () => {
  const h = await rig();
  try {
    const app = appOf(h.usage);
    const s = await data<UsageSummary>(await get(app, '/summary?tz=0'));
    assert.deepEqual([s.today.requests.value, s.today.costUsd.value, s.claudes.map((c) => c.claudeId)], [1, 0.2, ['c1']]);
    assert.equal((await get(app, '/summary?claudeId=nobody')).status, 404);
    const one = await data<UsageSummary>(await get(app, '/summary?claudeId=c1&tz=-420'));
    assert.equal(one.scope.claudeId, 'c1');
    // A nonsense offset is ignored (UTC), not an error and not a crash.
    assert.equal((await get(app, '/summary?tz=99999')).status, 200);
    assert.equal((await get(app, '/summary?tz=abc')).status, 200);

    const r = await data<RequestsReport>(await get(app, '/requests?range=1d&tz=0'));
    assert.deepEqual([r.range, r.totals.requests, r.byClaude[0]?.claudeId, r.byClaude[0]?.slot, r.previous.coverage], ['1d', 1, 'c1', 0, 'none']);
    assert.equal((await data<RequestsReport>(await get(app, '/requests'))).range, '1d', 'a day by default');
    const bad = await get(app, '/requests?range=1y');
    assert.equal(bad.status, 422);
    assert.equal((await get(app, `/requests?claudeId=${'x'.repeat(200)}`)).status, 422);

    const m = await data<MoveRecommendation>(await get(app, '/recommend?from=c1'));
    assert.deepEqual([m.workspaceId, m.from, m.recommended, m.none], ['docker/ws1', 'c1', null, 'no_other_claude']);
    assert.equal((await get(app, '/recommend')).status, 422);

    await get(app, '/summary'); // the snapshot gives each Claude its slot
    const p = await data<UsagePalette>(await get(app, '/palette'));
    assert.deepEqual([p.slots, p.claudes, Object.keys(p.models)], [8, { c1: 0 }, ['claude-opus-4-5']]);
    // None of it names an account or a login.
    // (Token counts are spend, not a login: "tokens" is fine, a "token" is not.)
    for (const res of [s, r, m, p]) assert.ok(!/email|organi[sz]ation|\btoken\b|credential|orgName/i.test(JSON.stringify(res)));
  } finally {
    h.done();
  }
});

test('the download: the file’s type and name, JSON and CSV for the requests, the plan readings, and the refusals', async () => {
  const h = await rig();
  try {
    const app = appOf(h.usage);
    const json = await get(app, '/export?what=requests&format=json&range=1d&tz=0');
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(json.headers.get('content-disposition'), 'attachment; filename="claudepilot-usage-requests-1d.json"');
    assert.equal(json.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(json.headers.get('cache-control'), 'no-store');
    const report = JSON.parse(await json.text()) as RequestsReport;
    assert.equal(report.totals.requests, 1);
    assert.equal(report.basis.costUsd, 'estimate');

    const csv = await get(app, '/export?what=requests&format=csv&range=1d&tz=0');
    assert.match(csv.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="claudepilot-usage-requests-1d.csv"');
    const lines = (await csv.text()).trimEnd().split('\r\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.endsWith('cost_usd_estimate'));
    assert.match(lines[1]!, /,Default,ws1,claude-opus-4-5,1,0,100,50,300,0,0\.2$/);

    const quota = await get(app, '/export?what=quota&format=csv&range=7d');
    assert.equal(quota.status, 200);
    assert.deepEqual((await quota.text()).trimEnd().split('\r\n').map((l) => l.split(',').slice(1)), [['claude', 'workspace', 'window', 'used_pct'], ['Default', 'ws1', 'session', '40']]);
    const qjson = JSON.parse(await (await get(app, '/export?what=quota&format=json&range=1d&claudeId=c1')).text()) as { claudeId: string; series: { key: string }[] }[];
    assert.deepEqual(qjson.map((x) => [x.claudeId, x.series.map((s) => s.key)]), [['c1', ['session']]]);

    for (const q of ['what=other&format=csv', 'what=requests&format=xml', 'what=requests&format=csv&range=1y', 'what=quota&format=csv&range=1h']) assert.equal((await get(app, `/export?${q}`)).status, 422, q);
    assert.equal((await get(app, '/export?what=quota&format=csv&claudeId=nobody')).status, 404);
  } finally {
    h.done();
  }
});

test('snooze takes a kind: projection silences only projections; anything else is refused', async () => {
  const h = await rig();
  try {
    const app = appOf(h.usage);
    const on = await data<ClaudeUsage>(await send(app, 'PUT', '/c1/snooze', { until: '4h', kind: 'projection' }));
    assert.deepEqual([on.projectionSnoozedUntil, on.snoozedUntil], [new Date(NOW + 4 * HOUR).toISOString(), null]);
    const both = await data<ClaudeUsage>(await send(app, 'PUT', '/c1/snooze', { until: '1h' }));
    assert.deepEqual([both.snoozedUntil, both.projectionSnoozedUntil], [new Date(NOW + HOUR).toISOString(), new Date(NOW + 4 * HOUR).toISOString()], 'the two snoozes are independent');
    const off = await data<ClaudeUsage>(await app.request('/api/claude-usage/c1/snooze?kind=projection', { method: 'DELETE' }));
    assert.deepEqual([off.projectionSnoozedUntil, off.snoozedUntil === null], [null, false], 'only the projection snooze ended');
    assert.equal((await send(app, 'PUT', '/c1/snooze', { until: '1h', kind: 'threshold' })).status, 422);
    assert.equal((await app.request('/api/claude-usage/c1/snooze?kind=x', { method: 'DELETE' })).status, 422);
  } finally {
    h.done();
  }
});
