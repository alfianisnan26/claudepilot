// Efficiency lab, slice 2: outcomes, the summary math on the slice 1 tape, the bootstrap, retention, the routes behind the seam and the
// Portal MCP tools' shapes. Fixed expected numbers carry their derivation from the tape (lab/testkit.ts).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import type { Actor, LabSliceView } from '@portal/contracts';
import { clearResolvers, declaredPolicies, declaredToolPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { LAB_POLICIES, LAB_TOOL_POLICIES } from './authz.js';
import { Lab } from './index.js';
import { DAY_MS, estimateSizeOf, outcomeOf, type TicketFacts } from './outcomes.js';
import { compactRow, registerLabTools } from './portalTools.js';
import { cacheReadWeight } from './prices.js';
import { createLabRoutes } from './routes.js';
import { bootstrapMedian, loadedCosts, periodOf, stat, summarize } from './summary.js';
import { buildTape, T0, TAPE_SESSION } from './testkit.js';

const MARKER = ['MARKER', 'X'].join('_');
const S = 1000;
/** The implementer slice's last request is at T0 + 1987 s (testkit.ts msg_a_6). */
const IMPL_END = T0 + 1987 * S;

async function harness(opts: { now?: () => number; tickets?: (t: string) => TicketFacts | null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lab2-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const lab = new Lab({ store, now: opts.now ?? (() => T0 + 3_600_000), ...(opts.tickets ? { tickets: opts.tickets } : {}) });
  for (const l of buildTape(MARKER)) lab.line(TAPE_SESSION, l);
  return { store, lab, db: store.db!, done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

afterEach(() => clearResolvers());

test('outcomes from the ticket timeline: done is accepted, a send-back is rework, a reopen within 7 days is a defect, else unknown', () => {
  const end = 1_000;
  const facts = (...c: [number, string, string][]): TicketFacts => ({
    changes: c.map(([atMs, from, to]) => ({ atMs, from, to })),
    estimateSize: null,
  });
  assert.equal(outcomeOf(end, facts([500, 'open', 'in_progress'], [2_000, 'in_review', 'done'])), 'accepted');
  assert.equal(
    outcomeOf(end, facts([2_000, 'in_review', 'in_progress'], [3_000, 'in_review', 'done'])),
    'rework',
    'the first decision after the slice counts',
  );
  assert.equal(outcomeOf(end, facts([2_000, 'in_review', 'done'], [2_000 + 6 * DAY_MS, 'done', 'in_progress'])), 'defect');
  assert.equal(
    outcomeOf(end, facts([2_000, 'in_review', 'done'], [2_000 + 8 * DAY_MS, 'done', 'in_progress'])),
    'accepted',
    'a reopen after 7 days is not this slice’s defect',
  );
  assert.equal(outcomeOf(end, facts([500, 'in_review', 'done'])), 'unknown', 'a decision before the slice ended is not about it');
  assert.equal(outcomeOf(end, facts()), 'unknown');
  assert.equal(outcomeOf(end, null), 'unknown');
  assert.equal(outcomeOf(null, facts([2_000, 'in_review', 'done'])), 'unknown');
  assert.equal(estimateSizeOf('ESTIMATE slice 2: size L, about 6 h, severity 3'), 'L');
  assert.equal(estimateSizeOf('**ESTIMATE**: effort class XL'), 'XL');
  assert.equal(estimateSizeOf('size L but not an estimate'), null);
});

test('per-model cache-read weight: Opus 5.5 0.05, Fable 5.1 0.025, others the design’s 0.1', () => {
  assert.equal(cacheReadWeight('claude-opus-5-5'), 0.05);
  assert.equal(cacheReadWeight('claude-opus-5-5[1m]'), 0.05);
  assert.equal(cacheReadWeight('claude-fable-5-1'), 0.025);
  assert.equal(cacheReadWeight('claude-sonnet-5-5'), 0.1);
  assert.equal(cacheReadWeight(null), 0.1);
});

test('stat, period and bootstrap: the p90 rule is the script’s, weeks start on Monday, the interval is fixed per seed and needs 20 values', () => {
  assert.deepEqual(stat([5, 1, 3, 2, 4]), { median: 3, p90: 5 }); // sorted 1..5, index floor(4.5) = 4
  assert.deepEqual(stat([4, 1, 3, 2]), { median: 2.5, p90: 4 }); // index floor(3.6) = 3
  assert.deepEqual(stat([]), { median: null, p90: null });
  assert.equal(periodOf(T0, 'day'), '2026-10-14');
  assert.equal(periodOf(T0, 'week'), '2026-10-12'); // 2026-10-14 is a Wednesday
  assert.equal(periodOf(Date.UTC(2026, 9, 18, 23), 'week'), '2026-10-12'); // Sunday belongs to the week before
  assert.equal(bootstrapMedian([1, 2, 3], 'x'), 'n too small');
  assert.equal(
    bootstrapMedian(
      Array.from({ length: 19 }, (_, i) => i),
      'x',
    ),
    'n too small',
  );
  const v = Array.from({ length: 21 }, (_, i) => i + 1); // median 11
  const a = bootstrapMedian(v, 'seed'),
    b = bootstrapMedian(v, 'seed');
  assert.deepEqual(a, b, 'the same values and seed give the same interval');
  assert.ok(typeof a === 'object' && a.low <= 11 && 11 <= a.high && a.low >= 1 && a.high <= 21 && a.low < a.high, JSON.stringify(a));
  const flat = bootstrapMedian(
    Array.from({ length: 20 }, () => 7),
    'seed',
  );
  assert.deepEqual(flat, { low: 7, high: 7 });
});

test('loaded cost per accepted slice: rework and defect slices on the ticket count against the next accepted one; first-pass yield', () => {
  const v = (sliceId: string, ticket: string, outcome: LabSliceView['outcome'], costUsd: number | null, endMs: number): LabSliceView =>
    ({
      sessionId: 's',
      sliceId,
      kind: 'agent',
      ticket,
      role: 'implementer',
      model: 'm',
      outcome,
      costUsd,
      endMs,
      startMs: endMs - 10,
      requests: 1,
      ctxP50: 0,
      ctxP90: 0,
      minutes: 0,
      resultChars: 0,
      bashCalls: 0,
      bashByClass: {},
      rewriteTokens: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }) as unknown as LabSliceView;
  const slices = [
    v('a', 'T-1', 'rework', 1, 100), // sent back: carried to b
    v('b', 'T-1', 'accepted', 2, 200), // loaded 1 + 2 = 3
    v('c', 'T-2', 'accepted', 5, 100), // loaded 5
    v('d', 'T-3', 'rework', null, 100), // no price: the accepted slice after it has no loaded cost
    v('e', 'T-3', 'accepted', 1, 200),
    v('f', 'T-4', 'unknown', 9, 100), // not decided: in no loaded cost
  ];
  const loaded = loadedCosts(slices);
  assert.deepEqual([...loaded.entries()].sort(), [
    ['s\u0000b', 3],
    ['s\u0000c', 5],
  ]);
  const [row] = summarize(slices, 'day');
  assert.equal(row!.costPerAccepted, 4); // median of 3 and 5
  assert.equal(row!.costPerAcceptedN, 2);
  assert.equal(row!.costPerAcceptedInterval, 'n too small');
  assert.equal(row!.firstPassYield, 0.6); // accepted b, c, e over decided a..e = 3 / 5
  assert.deepEqual(row!.outcomes, { accepted: 3, rework: 2, defect: 0, unknown: 1 });
});

test('the summary on the slice 1 tape: per role and model, with the numbers the tape gives', async () => {
  const tickets = (t: string): TicketFacts | null =>
    t === 'T-287' ? { changes: [{ atMs: IMPL_END + 600_000, from: 'in_review', to: 'done' }], estimateSize: 'L' } : null;
  const h = await harness({ tickets });
  try {
    const s = h.lab.summary({ period: 'day', sinceMs: T0 - 1 });
    const impl = s.rows.find((r) => r.role === 'implementer')!;
    const qa = s.rows.find((r) => r.role === 'qa')!;
    assert.ok(
      s.rows.some((r) => r.role === 'main'),
      'the main-thread turns are their own row',
    );
    assert.equal(impl.period, '2026-10-14');
    assert.equal(impl.model, 'claude-opus-5-5');
    // One slice: every median and p90 is the slice's own number (lab.test.ts RECORDED: 6 requests, ctx p50 33,750, 4,132 characters, 33.1 min).
    assert.deepEqual(
      [impl.n, impl.requests, impl.ctxP50, impl.resultChars, impl.minutes],
      [1, { median: 6, p90: 6 }, { median: 33750, p90: 33750 }, { median: 4132, p90: 4132 }, { median: 33.1, p90: 33.1 }],
    );
    // Cost: input 3 + 5 x 2 = 13; cache read 30,000 + 32,000 + 5,000 + 34,000 + 34,800 = 135,800 at 0.05 = 6,790; writes 80,250 units (lab.test.ts);
    // output 830 x 5 = 4,150. (13 + 6,790 + 80,250 + 4,150) x 4e-6 = 91,203 x 4e-6 = 0.364812 dollars.
    assert.ok(Math.abs(impl.costUsd!.median! - 0.364812) < 1e-12, String(impl.costUsd!.median));
    // Bash: 6 calls, inspect 1 (grep), git_read 2 (rtk git status, ...), test 2 (npm test, rtk npm test), wait 1 (sleep 20).
    assert.equal(impl.bashCalls, 6);
    assert.deepEqual(impl.bashShare, { inspect: 1 / 6, git_read: 2 / 6, test: 2 / 6, wait: 1 / 6 });
    // Re-written 28,500 of the writes 5 min 2,000 + 29,000 + 800 + 30,000 (legacy) = 61,800 and 1 h 1,500: 28,500 / 63,300.
    assert.equal(impl.rewriteTokens, 28500);
    assert.equal(impl.rewriteShare, 28500 / 63300);
    // T-287 went to done 10 minutes after the slice ended: accepted, loaded cost = its own.
    assert.deepEqual(impl.outcomes, { accepted: 1, rework: 0, defect: 0, unknown: 0 });
    assert.equal(impl.firstPassYield, 1);
    assert.equal(impl.costPerAccepted, impl.costUsd!.median);
    assert.equal(impl.costPerAcceptedInterval, 'n too small');
    // The qa slice has no ticket: unknown, no yield. 3 requests, ctx 12,900, 2 Bash calls of which 1 inspection.
    assert.deepEqual(
      [qa.n, qa.requests.median, qa.ctxP50.median, qa.bashCalls, qa.bashShare.inspect, qa.outcomes.unknown, qa.firstPassYield],
      [1, 3, 12900, 2, 0.5, 1, null],
    );
    const views = h.lab.views({ kind: 'agent' });
    assert.deepEqual(views.map((x) => [x.role, x.outcome, x.estimateSize]).sort(), [
      ['implementer', 'accepted', 'L'],
      ['qa', 'unknown', null],
    ]);
    // The filters: ticket, role, model, since.
    assert.deepEqual(
      h.lab.views({ ticket: 'T-287' }).map((x) => x.role),
      ['implementer'],
    );
    assert.deepEqual(
      h.lab.views({ role: 'qa' }).map((x) => x.model),
      ['claude-sonnet-5-5'],
    );
    assert.equal(h.lab.views({ fromMs: T0 + DAY_MS }).length, 0);
    // The compact row of the MCP tool is short and rounded.
    assert.deepEqual(Object.keys(compactRow(impl)), [
      'period',
      'role',
      'model',
      'n',
      'req_p50',
      'ctx_p50',
      'result_tok_p50',
      'min_p50',
      'cost_p50',
      'inspect_share',
      'rewrite_share',
      'fpy',
      'cost_per_accepted',
    ]);
    assert.deepEqual([compactRow(impl).cost_p50, compactRow(impl).inspect_share, compactRow(impl).rewrite_share], [0.36, 0.167, 0.45]);
  } finally {
    h.done();
  }
});

test('experiments: arm counts and the primary per arm; the arm filter on slices', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lab2e-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const lab = new Lab({
    store,
    now: () => T0,
    tickets: () => ({ changes: [{ atMs: IMPL_END + 1, from: 'in_review', to: 'done' }], estimateSize: null }),
  });
  try {
    const e = lab.createExperiment({
      name: 'rtk',
      design: 'randomized',
      arms: ['on', 'off'],
      primaryMetric: 'median cost per accepted slice',
      startMs: T0 - 1,
      minN: 20,
    });
    for (const l of buildTape(MARKER)) lab.line(TAPE_SESSION, l);
    const [view] = lab.experimentViews();
    assert.equal(view!.experiment.id, e.id);
    assert.equal(
      view!.arms.reduce((t, a) => t + a.n, 0),
      2,
      'both sub-agent slices have an arm',
    );
    assert.deepEqual(
      view!.arms.map((a) => a.costPerAcceptedInterval),
      ['n too small', 'n too small'],
    );
    const implArm = lab.views({ ticket: 'T-287' })[0]!.arms[e.id]!;
    assert.deepEqual(
      lab
        .views({ experiment: e.id, arm: implArm })
        .map((x) => x.ticket)
        .includes('T-287'),
      true,
    );
    assert.equal(view!.arms.find((a) => a.arm === implArm)!.accepted, 1);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('retention: after 14 days the request and tool rows go, the slices keep their numbers, and a second run does nothing', async () => {
  let now = T0 + 3_600_000;
  const h = await harness({ now: () => now });
  try {
    const count = (t: string) => (h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = h.lab.slices();
    assert.deepEqual(h.lab.prune(), { frozen: 0, requests: 0, tools: 0, draws: 0 }, 'nothing is 14 days old yet');
    const reqs = count('lab_requests'),
      tools = count('lab_tools');
    assert.ok(reqs > 0 && tools > 0);
    now = T0 + 15 * DAY_MS;
    const r = h.lab.prune()!;
    assert.equal(r.frozen, before.length);
    assert.equal(r.requests, reqs);
    assert.equal(r.tools, tools);
    assert.deepEqual([count('lab_requests'), count('lab_tools')], [0, 0]);
    assert.deepEqual(h.lab.slices(), before, 'the frozen numbers are the numbers');
    assert.deepEqual(h.lab.prune(), { frozen: 0, requests: 0, tools: 0, draws: 0 });
    // A frozen row holds counts only: no text of the tape.
    const frozen = (h.db.prepare('SELECT frozen FROM lab_slices').all() as { frozen: string }[]).map((x) => x.frozen).join('');
    assert.ok(!frozen.includes(MARKER));
  } finally {
    h.done();
  }
});

/** The routes behind a stand-in for the sign-in guard: `actor` is who asks (the owner by default). */
function app(lab: Lab, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) =>
    isAppError(e) ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500),
  );
  a.route('/api/lab', createLabRoutes(lab));
  return a;
}

test('routes: declared with the seam; the owner reads; another user and an agent asking beyond its session get the same 404', async () => {
  const h = await harness();
  try {
    const owner = app(h.lab);
    const routes = new Set(owner.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path.replace(/\/$/, '')}`));
    assert.deepEqual([...routes].sort(), Object.keys(LAB_POLICIES).sort());
    for (const k of Object.keys(LAB_POLICIES)) assert.equal(declaredPolicies().get(k)?.kind, 'platform', k);
    assert.equal(declaredToolPolicies().get('lab_summary')?.kind, 'agent');
    assert.equal(declaredToolPolicies().get('lab_experiment_set')?.kind, 'platform');
    assert.deepEqual(Object.keys(LAB_TOOL_POLICIES).sort(), ['crew_scorecard', 'lab_arm_draw', 'lab_experiment_set', 'lab_summary']);

    const sl = (await (await owner.request('/api/lab/slices?role=implementer')).json()) as {
      data: { items: LabSliceView[]; next: string | null; total: number };
    };
    assert.deepEqual([sl.data.total, sl.data.items[0]!.ticket, sl.data.next], [1, 'T-287', null]);
    assert.equal((await owner.request('/api/lab/summary?period=week')).status, 200);
    assert.equal((await owner.request('/api/lab/experiments')).status, 200);
    assert.equal((await owner.request('/api/lab/summary?period=year')).status, 422);
    assert.equal((await owner.request('/api/lab/slices?since=yesterday')).status, 422);

    const bob = app(h.lab, { kind: 'user', userId: 'u_bob', loginSessionId: 'x', via: 'ui' } as Actor);
    for (const p of ['/api/lab/slices', '/api/lab/summary', '/api/lab/experiments']) {
      const res = await bob.request(p);
      assert.equal(res.status, 404, p);
      assert.deepEqual(await res.json(), { error: { code: 'NOT_FOUND' } }, p);
    }
    assert.equal((await bob.request('/api/lab/nothing')).status, 404, 'the same answer as a route that is not there');

    const agent = app(h.lab, {
      kind: 'agent',
      userId: 'u_owner',
      tokenId: 't',
      sessionId: TAPE_SESSION,
      workspaceId: 'docker/api',
    } as Actor);
    const own = (await (await agent.request('/api/lab/slices')).json()) as { data: { total: number } };
    assert.ok(own.data.total > 0, 'its own session’s slices');
    assert.equal((await agent.request('/api/lab/slices?session=someone-else')).status, 404);
    assert.equal((await agent.request('/api/lab/experiments')).status, 404);
    const other = app(h.lab, { kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId: 'another', workspaceId: 'docker/api' } as Actor);
    const none = ((await (await other.request('/api/lab/slices')).json()) as { data: { total: number; items: unknown[] } }).data;
    assert.deepEqual([none.total, none.items.length], [0, 0], 'another session sees none of these');
  } finally {
    h.done();
  }
});

type Row = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const refused = (m: Row) => !!(m.error || m.result?.isError);

test('MCP: lab_summary is short by default and full on ask; an agent reads its own session only; lab_experiment_set is admin with a confirmation', async () => {
  const h = await harness();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(h.lab, registry);
  try {
    const admin = mcp.token('admin');
    const short = where(await mcp.call(admin.secret, 'lab_summary', { since: String(T0 - 1) }));
    assert.equal(short.scope, 'portal');
    assert.ok(short.rows.length >= 3);
    for (const r of short.rows)
      assert.deepEqual(Object.keys(r), [
        'period',
        'role',
        'model',
        'n',
        'req_p50',
        'ctx_p50',
        'result_tok_p50',
        'min_p50',
        'cost_p50',
        'inspect_share',
        'rewrite_share',
        'fpy',
        'cost_per_accepted',
      ]);
    assert.equal(short.basis, undefined, 'the sources are in the full form');
    const full = where(await mcp.call(admin.secret, 'lab_summary', { since: String(T0 - 1), full: true }));
    assert.ok(full.basis.costUsd && Array.isArray(full.experiments));
    assert.ok(JSON.stringify(full).length > JSON.stringify(short).length);
    assert.ok(!JSON.stringify(full).includes(MARKER), 'no text of the stream');

    const agent = await mcp.agentToken('docker/api', 'P');
    const mine = where(await mcp.call(agent.secret, 'lab_summary', { since: String(T0 - 1), full: true }));
    assert.deepEqual(
      [mine.scope, mine.rows.length, mine.experiments],
      ['session', 0, undefined],
      'session P has no slices; no experiments for an agent',
    );
    assert.ok(
      refused(await mcp.call(agent.secret, 'lab_experiment_set', { action: 'start', name: 'x', design: 'randomized', arms: ['a', 'b'] })),
    );
    assert.ok(
      refused(
        await mcp.call(mcp.token('read').secret, 'lab_experiment_set', {
          action: 'start',
          name: 'x',
          design: 'randomized',
          arms: ['a', 'b'],
        }),
      ),
    );

    const args = { action: 'start', name: 'rtk', design: 'randomized', arms: ['on', 'off'], min_n: 20 };
    const ask = where(await mcp.call(admin.secret, 'lab_experiment_set', args));
    assert.equal(ask.status, 'confirmation_required');
    assert.equal(h.lab.experiments().length, 0, 'nothing before the confirmation');
    const made = where(await mcp.call(admin.secret, 'lab_experiment_set', { ...args, confirm_token: ask.confirm_token }));
    assert.deepEqual([made.did, made.arms], ['started', ['on', 'off']]);
    const stopArgs = { action: 'stop', id: made.id };
    const ask2 = where(await mcp.call(admin.secret, 'lab_experiment_set', stopArgs));
    assert.equal(ask2.status, 'confirmation_required');
    assert.equal(
      where(await mcp.call(admin.secret, 'lab_experiment_set', { ...stopArgs, confirm_token: ask2.confirm_token })).did,
      'stopped',
    );
    assert.equal(h.lab.experiments()[0]!.status, 'stopped');
  } finally {
    mcp.done();
    h.done();
  }
});
