// The Requests report with the previous period, the cache split, palette slots and stacked series (docs/prd/claude-usage.md §20.3, §20.6, §20.8).
// Every expected number below was computed by hand from the rows seeded in the test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheSplit } from '@portal/contracts';
import { Palette } from './palette.js';
import { buildRequestsReport } from './requests.js';
import { seedClaude, seedUsage, usageHarness, type UsageSeed } from './fixtures.js';
import { SpendReader } from './spend.js';

const HOUR = 3_600_000;
const T = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h, m);
/** 2026-10-12 15:30 UTC. Range 1d, buckets of an hour, viewer at UTC: the window is 10-11 16:00 to 10-12 16:00 (24 buckets); the one before it 10-10 16:00 to 10-11 16:00. */
const NOW = T(12, 15, 30);

const ROWS: UsageSeed[] = [
  // This period. Bucket = hours since 10-11 16:00.
  { at: T(11, 16, 10), claude: '', model: 'claude-opus-4-5', input: 100, output: 50, cacheRead: 400, cacheWrite: 50, cost: 1.0, agents: 1 }, // bucket 0, Default before Claudes
  { at: T(12, 9, 20), claude: 's1', model: 'claude-sonnet-4-5', input: 200, output: 100, cacheRead: 0, cacheWrite: 100, cost: 0.5 }, // bucket 17
  { at: T(12, 9, 40), claude: 's1', model: 'claude-sonnet-4-5', input: 100, output: 50, cacheRead: 800, cacheWrite: 50, cost: 0.25 }, // bucket 17
  { at: T(12, 15, 10), claude: 'd1', model: 'claude-opus-4-5', input: 300, output: 150, cacheRead: 0, cacheWrite: 150, cost: 2.0 }, // bucket 23, Default after Claudes
  // The period before. Bucket = hours since 10-10 16:00.
  { at: T(10, 20), claude: 'd1', model: 'claude-opus-4-5', input: 200, output: 100, cacheRead: 0, cacheWrite: 100, cost: 0.6 }, // bucket 4
  { at: T(11, 2), claude: 's1', model: 'claude-sonnet-4-5', input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.4 }, // bucket 10
];
/** Older than both periods: the portal's history reaches back before the previous period began. */
const OLD: UsageSeed = { at: T(9, 12), claude: 'd1', input: 1, cost: 0.01 };

async function rig(rows: UsageSeed[]) {
  const h = await usageHarness();
  seedClaude(h.store, 'd1', 'docker/ws1', 'Default');
  seedClaude(h.store, 's1', 'docker/ws1', 'Satria', 'claudes/0123456789abcdef');
  seedUsage(h.store, rows);
  const deps = { reader: new SpendReader(h.store), palette: new Palette(h.store, () => NOW) };
  return { h, deps };
}

test('totals, the cache split and the rows by Claude and by model, with Default’s two kinds of request as one', async () => {
  // Hand (this period): cost 1.00 + 0.50 + 0.25 + 2.00 = 3.75; input 100 + 200 + 100 + 300 = 700; output 50 + 100 + 50 + 150 = 350;
  // read 400 + 0 + 800 + 0 = 1200; written 50 + 100 + 50 + 150 = 350; 4 requests, 1 sub-agent.
  // Cache hit rate = 1200 / (1200 + 700 + 350) = 1200 / 2250 = 8/15 = 0.5333.
  // Default (the request with no Claude, and the one with its id): cost 3.00, 2 requests. Satria: 0.75, 2 requests. Opus 3.00, Sonnet 0.75.
  const { h, deps } = await rig([...ROWS, OLD]);
  try {
    const r = buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0 });
    assert.deepEqual([r.range, r.from, r.to, r.bucketMs, r.buckets.length], ['1d', new Date(T(11, 16)).toISOString(), new Date(T(12, 16)).toISOString(), HOUR, 24]);
    assert.deepEqual(r.totals, { costUsd: 3.75, input: 700, output: 350, cacheRead: 1200, cacheWrite: 350, requests: 4, agents: 1 });
    assert.deepEqual([r.cache.uncached, r.cache.written, r.cache.read, r.cache.hitRate.basis], [700, 350, 1200, 'measured']);
    assert.ok(Math.abs(r.cache.hitRate.value! - 8 / 15) < 1e-12);
    assert.deepEqual(r.cache, cacheSplit(r.totals), 'one rule for the server and the page');
    assert.deepEqual(r.byClaude.map((c) => [c.claudeId, c.name, c.workspaceId, c.costUsd, c.requests, c.slot]), [['d1', 'Default', 'docker/ws1', 3, 2, 0], ['s1', 'Satria', 'docker/ws1', 0.75, 2, 1]]);
    assert.deepEqual(r.byModel.map((m) => [m.model, m.costUsd, m.requests, m.slot]), [['claude-opus-4-5', 3, 2, 0], ['claude-sonnet-4-5', 0.75, 2, 1]]);
    assert.ok(Math.abs(r.byClaude[1]!.cache.hitRate.value! - 800 / (800 + 300 + 150)) < 1e-12, 'Satria: 800 read of 800 + 300 uncached + 150 written');
    assert.deepEqual(r.basis, { costUsd: 'estimate', tokens: 'measured', requests: 'measured' });
    // The buckets: the old rows are outside; bucket 0, 17 and 23 hold the others.
    assert.deepEqual([0, 17, 23].map((i) => r.buckets[i]!.requests), [1, 2, 1]);
    assert.equal(r.buckets[17]!.costUsd, 0.75);
    assert.equal(r.buckets.reduce((n, b) => n + b.requests, 0), 4);
  } finally {
    h.done();
  }
});

test('series for stacked charts: per Claude and per model, per bucket, null where nothing ran', async () => {
  const { h, deps } = await rig([...ROWS, OLD]);
  try {
    const r = buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0 });
    const [d, s] = r.claudes;
    assert.deepEqual([d!.kind, d!.key, d!.label, d!.sub, d!.slot, d!.totals.requests], ['claude', 'd1', 'Default', 'ws1', 0, 2]);
    assert.deepEqual([s!.key, s!.label, s!.slot], ['s1', 'Satria', 1]);
    assert.equal(d!.buckets.length, 24);
    assert.deepEqual(d!.buckets.map((b, i) => (b ? [i, b.costUsd] : null)).filter(Boolean), [[0, 1], [23, 2]]);
    assert.deepEqual(s!.buckets[17], { costUsd: 0.75, input: 300, output: 150, cacheRead: 800, cacheWrite: 150, requests: 2, agents: 0 });
    assert.equal(s!.buckets[0], null);
    assert.deepEqual(r.models.map((m) => [m.kind, m.key, m.label, m.sub, m.workspaceId, m.slot]), [['model', 'claude-opus-4-5', 'claude-opus-4-5', null, null, 0], ['model', 'claude-sonnet-4-5', 'claude-sonnet-4-5', null, null, 1]]);
    // Every series' buckets add up to its totals, and the series add up to the report's.
    for (const list of [r.claudes, r.models]) {
      assert.equal(list.reduce((n, x) => n + x.totals.requests, 0), r.totals.requests);
      for (const x of list) assert.equal(x.buckets.reduce((n, b) => n + (b?.requests ?? 0), 0), x.totals.requests);
    }
  } finally {
    h.done();
  }
});

test('the previous period, bucket for bucket, and the change against it when the portal’s history reaches back that far', async () => {
  // Hand (before): cost 0.60 + 0.40 = 1.00; tokens (input + output + written) (200 + 100 + 100) + (100 + 100 + 0) = 400 + 200 = 600; 2 requests.
  // Now: cost 3.75, tokens 700 + 350 + 350 = 1400, 4 requests.
  // Change: cost (3.75 - 1.00) / 1.00 = +275.0 % (an estimate); tokens (1400 - 600) / 600 = +133.3 %; requests (4 - 2) / 2 = +100.0 %.
  const { h, deps } = await rig([...ROWS, OLD]);
  try {
    const p = buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0 }).previous;
    assert.deepEqual([p.from, p.to, p.coverage], [new Date(T(10, 16)).toISOString(), new Date(T(11, 16)).toISOString(), 'full']);
    assert.deepEqual([p.totals.costUsd, p.totals.requests, p.totals.input], [1, 2, 300]);
    assert.equal(p.buckets.length, 24);
    assert.equal(p.buckets[0]!.at, new Date(T(10, 16)).toISOString());
    assert.deepEqual([4, 10].map((i) => p.buckets[i]!.costUsd), [0.6, 0.4]);
    assert.deepEqual([p.change.costUsd.value, p.change.costUsd.basis], [275, 'estimate']);
    assert.deepEqual([p.change.tokens.value, p.change.tokens.basis], [133.3, 'measured']);
    assert.deepEqual([p.change.requests.value, p.change.requests.basis], [100, 'measured']);
  } finally {
    h.done();
  }
});

test('history that begins inside the previous period is partial and gives no change; one that begins after it is none; a zero base has no percent', async () => {
  // The first request ever was 10-10 20:00, inside the previous period (it began 16:00): partial. The change would overstate growth, so it is not given.
  const { h, deps } = await rig(ROWS);
  try {
    const p = buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0 }).previous;
    assert.equal(p.coverage, 'partial');
    for (const f of [p.change.costUsd, p.change.tokens, p.change.requests]) assert.deepEqual([f.value, f.basis, f.reason], [null, 'unavailable', 'not_recorded']);
    assert.equal(p.totals.requests, 2, 'what was recorded is still shown');
  } finally {
    h.done();
  }
  const young = await rig(ROWS.slice(0, 4));
  try {
    const p = buildRequestsReport(young.deps, '1d', { now: NOW, tzOffsetMin: 0 }).previous;
    assert.equal(p.coverage, 'none', 'the first request was 10-11 16:10, after the previous period ended');
    assert.equal(p.change.requests.reason, 'not_recorded');
  } finally {
    young.h.done();
  }
  // Full history but nothing in the previous period: a percent of zero is not defined.
  const quiet = await rig([...ROWS.slice(0, 4), OLD]);
  try {
    const p = buildRequestsReport(quiet.deps, '1d', { now: NOW, tzOffsetMin: 0 }).previous;
    assert.equal(p.coverage, 'full');
    assert.deepEqual([p.totals.requests, p.change.costUsd.reason, p.change.tokens.reason, p.change.requests.reason], [0, 'no_baseline', 'no_baseline', 'no_baseline']);
  } finally {
    quiet.h.done();
  }
  // No request at all: nothing to report, nothing invented.
  const empty = await rig([]);
  try {
    const r = buildRequestsReport(empty.deps, '1d', { now: NOW, tzOffsetMin: 0 });
    assert.deepEqual([r.totals.requests, r.byClaude.length, r.claudes.length, r.previous.coverage, r.cache.hitRate.reason], [0, 0, 0, 'none', 'no_requests']);
  } finally {
    empty.h.done();
  }
});

test('one Claude: its rows only (Default includes the requests recorded without one), in the totals, the series and the previous period', async () => {
  const { h, deps } = await rig([...ROWS, OLD]);
  try {
    const d = buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0, claudeId: 'd1' });
    // Hand: Default's this period: 1.00 + 2.00 = 3.00 over 2 requests; its previous: 0.60 over 1.
    assert.deepEqual([d.totals.costUsd, d.totals.requests, d.byClaude.length, d.claudes.length], [3, 2, 1, 1]);
    assert.deepEqual([d.previous.totals.costUsd, d.previous.totals.requests], [0.6, 1]);
    const s = buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0, claudeId: 's1' });
    assert.deepEqual([s.totals.costUsd, s.previous.totals.costUsd, s.byModel.map((m) => m.model)], [0.75, 0.4, ['claude-sonnet-4-5']]);
    assert.equal(s.byClaude[0]!.slot, 1, 'the colour does not change with the filter');
    assert.equal(buildRequestsReport(deps, '1d', { now: NOW, tzOffsetMin: 0, claudeId: 'nobody' }).totals.requests, 0);
  } finally {
    h.done();
  }
});

test('the buckets line up with the viewer’s clock, as the chat report’s do', async () => {
  // Hand: a 30-day range in UTC+7 (getTimezoneOffset -420): buckets are days starting at 17:00 UTC. Now is 10-12 15:30 UTC = 22:30 local, so the last bucket
  // is the local day 10-12 (17:00 UTC 10-11 to 17:00 UTC 10-12) and ends at 17:00 UTC.
  const { h, deps } = await rig([{ at: T(12, 1), claude: 'd1', input: 10, cost: 1 }]);
  try {
    const r = buildRequestsReport(deps, '30d', { now: NOW, tzOffsetMin: -420 });
    assert.equal(r.to, new Date(T(12, 17)).toISOString());
    assert.equal(r.bucketMs, 24 * HOUR);
    assert.equal(r.buckets.length, 30);
    assert.equal(r.buckets[29]!.requests, 1, '01:00 UTC is 08:00 on the local 10-12');
    assert.equal(r.previous.to, r.from);
  } finally {
    h.done();
  }
});
