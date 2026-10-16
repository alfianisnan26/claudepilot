// Spend speed and the rows it stands on (docs/prd/claude-usage.md §20.1). Expected values are computed by hand next to each fixture.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayStart, ClaudeIndex, SpendReader, spendSpeed, spendToday, type SpendRow } from './spend.js';
import { seedClaude, seedUsage, usageHarness } from './fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-10-12 12:00 UTC; with the viewer at UTC the day began at 00:00. */
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const DAY0 = Date.UTC(2026, 9, 12, 0, 0, 0);
const at = (h: number, m = 0) => DAY0 + h * HOUR + m * MIN;
const v = (f: { value: unknown; reason?: string }) => (f.value === null ? `unavailable:${f.reason}` : f.value);

const row = (over: Partial<SpendRow> & Pick<SpendRow, 'atMs'>): SpendRow => ({ workspaceId: 'docker/ws1', claudeId: '', model: 'claude-opus-4-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 1, agents: 0, durationMs: 0, ...over });

// Three requests today. Tokens are input + output + cache writes; cache reads apart.
//   11:50  1000 in, 500 out, 200 written, 8000 read, $0.30, took 2 min (so it began at 11:48)
//   11:40   600 in, 300 out, 100 written, 4000 read, $0.20
//   09:30  3000 in, 1000 out, 1000 written, 0 read, $0.50, took 5 min (began at 09:25)
const R1 = row({ atMs: at(11, 50), input: 1000, output: 500, cacheWrite: 200, cacheRead: 8000, costUsd: 0.3, durationMs: 2 * MIN });
const R2 = row({ atMs: at(11, 40), input: 600, output: 300, cacheWrite: 100, cacheRead: 4000, costUsd: 0.2 });
const R3 = row({ atMs: at(9, 30), input: 3000, output: 1000, cacheWrite: 1000, cacheRead: 0, costUsd: 0.5, durationMs: 5 * MIN });

test('trailing 15 minutes: what finished in (11:45, 12:00] over 15 minutes', () => {
  // Hand: only 11:50 qualifies. Tokens 1000 + 500 + 200 = 1700; 1700 / 15 = 113.33 -> 113.3 per minute. Cache read 8000 / 15 = 533.3. Dollars 0.30 / 15 = 0.02.
  const t = spendSpeed([R3, R2, R1], NOW, DAY0).trailing;
  assert.deepEqual([t.window, t.spanMin, t.requests], ['15m', 15, 1]);
  assert.equal(v(t.tokensPerMin), 113.3);
  assert.equal(v(t.cacheReadPerMin), 533.3);
  assert.equal(v(t.costPerMin), 0.02);
  for (const f of [t.tokensPerMin, t.cacheReadPerMin, t.costPerMin]) assert.equal(f.basis, 'estimate', 'a rate rests on the assumption that a request counts when it finishes');
});

test('today: everything since midnight over the time from the first request’s start', () => {
  // Hand: sums 1700 + 1000 + 5000 = 7700 tokens, 12000 read, $1.00, 3 requests. The first to start was 09:30 less its 5 minutes: 09:25.
  // Span 09:25 to 12:00 = 2 h 35 m = 155 min. 7700 / 155 = 49.68 -> 49.7; 12000 / 155 = 77.42 -> 77.4; 1.00 / 155 = 0.00645 -> 0.0065.
  const t = spendSpeed([R3, R2, R1], NOW, DAY0).today;
  assert.deepEqual([t.window, t.spanMin, t.requests], ['today', 155, 3]);
  assert.equal(v(t.tokensPerMin), 49.7);
  assert.equal(v(t.cacheReadPerMin), 77.4);
  assert.equal(v(t.costPerMin), 0.0065);
  const sum = spendToday([R3, R2, R1], NOW, DAY0);
  assert.deepEqual([v(sum.costUsd), v(sum.tokens), v(sum.cacheRead), v(sum.requests)], [1, 7700, 12000, 3]);
  assert.deepEqual([sum.costUsd.basis, sum.tokens.basis, sum.cacheRead.basis, sum.requests.basis], ['estimate', 'measured', 'measured', 'measured'], 'dollars are Claude Code’s price estimate; counts are stored');
  assert.equal(sum.from, new Date(DAY0).toISOString());
});

test('an idle quarter hour is a real zero; no request today says so; the first minutes of a day are not a rate', () => {
  const idle = spendSpeed([R3], NOW, DAY0);
  assert.equal(v(idle.trailing.tokensPerMin), 0, 'nothing in the last 15 minutes is zero, not unknown');
  assert.equal(idle.trailing.requests, 0);
  assert.equal(v(idle.today.tokensPerMin), 32.3, 'only 09:30 (5000 tokens, began 09:25): 5000 / 155 min = 32.26');
  const none = spendSpeed([], NOW, DAY0);
  for (const f of [none.today.tokensPerMin, none.today.cacheReadPerMin, none.today.costPerMin]) assert.equal(v(f), 'unavailable:no_requests');
  assert.equal(v(none.trailing.costPerMin), 0);
  // Hand: one request finished at 11:58 after a minute: it began at 11:57, so three minutes ago: under five minutes is no rate. The count still shows.
  const fresh = spendSpeed([row({ atMs: at(11, 58), input: 100, durationMs: MIN })], NOW, DAY0).today;
  assert.equal(v(fresh.tokensPerMin), 'unavailable:short_span');
  assert.deepEqual([fresh.requests, fresh.spanMin], [1, 3]);
});

test('a request that began before midnight counts from midnight; a request exactly 15 minutes old is out of the trailing window', () => {
  // Hand: now 00:20; a request finished at 00:05 after 30 minutes (it began at 23:35 the day before). The day began at 00:00, so the span is 20 min:
  // tokens 200 + 100 = 300; 300 / 20 = 15 per minute. 00:05 is exactly 15 minutes before 00:20: the trailing window is (00:05, 00:20], so it is out.
  const now = at(0, 20);
  const s = spendSpeed([row({ atMs: at(0, 5), input: 200, output: 100, durationMs: 30 * MIN })], now, DAY0);
  assert.equal(v(s.today.tokensPerMin), 15);
  assert.equal(s.today.spanMin, 20);
  assert.equal(s.trailing.requests, 0);
  // A request dated after the clock (skew) is in no window.
  assert.equal(spendSpeed([row({ atMs: NOW + 5 * MIN, input: 999 })], NOW, DAY0).today.requests, 0);
});

test('the viewer’s day starts at their midnight', () => {
  // Hand: at 12:00 UTC it is 19:00 in UTC+7 (getTimezoneOffset -420), so that day began at 17:00 UTC the day before; in UTC-5 (+300) it is 07:00, began 05:00 UTC.
  assert.equal(dayStart(NOW, -420), Date.UTC(2026, 9, 11, 17));
  assert.equal(dayStart(NOW, 300), Date.UTC(2026, 9, 12, 5));
  assert.equal(dayStart(NOW, 0), DAY0);
  assert.equal(dayStart(NOW), DAY0);
  assert.equal(dayStart(NOW, Number.NaN), DAY0);
});

test('a request recorded without a Claude is Default’s; a Claude that was removed still has its name; an unknown id says so', () => {
  const index = new ClaudeIndex([
    { id: 'd1', workspaceId: 'docker/a', name: 'Default', directory: '', removed: false },
    { id: 's1', workspaceId: 'docker/a', name: 'Satria', directory: 'claudes/0123456789abcdef', removed: false },
    { id: 'r1', workspaceId: 'docker/a', name: 'Rama', directory: 'claudes/fedcba9876543210', removed: true },
  ]);
  assert.deepEqual(index.resolve({ workspaceId: 'docker/a', claudeId: '' }), { key: 'd1', claudeId: 'd1', name: 'Default', workspaceId: 'docker/a' });
  assert.equal(index.resolve({ workspaceId: 'docker/a', claudeId: 'd1' }).key, 'd1', 'before and after Claudes existed: one row');
  assert.equal(index.resolve({ workspaceId: 'docker/a', claudeId: 's1' }).name, 'Satria');
  assert.equal(index.resolve({ workspaceId: 'docker/a', claudeId: 'r1' }).name, 'Rama');
  assert.equal(index.resolve({ workspaceId: 'docker/a', claudeId: 'zz' }).name, 'Removed');
  assert.deepEqual(index.resolve({ workspaceId: 'docker/zzz', claudeId: '' }), { key: 'default:docker/zzz', claudeId: '', name: 'Default', workspaceId: 'docker/zzz' });
});

test('T-610: the reader leaves out a row marked suspect (a running total booked as one request)', async () => {
  const h = await usageHarness();
  try {
    seedUsage(h.store, [
      { at: at(9), claude: null, input: 7, cost: 0.25 },
      { at: at(10), claude: null, input: 8, cost: 96.31 },
    ]);
    h.store.db!.exec(`UPDATE chat_usage SET kind = 'suspect' WHERE input_tokens = 8`);
    const r = new SpendReader(h.store);
    assert.deepEqual(r.rowsBetween(at(0)).map((x) => x.input), [7]);
  } finally {
    h.done();
  }
});

test('the reader: rows in time order with a null Claude read as empty, the history starts at the first row, and a store without the table reads as nothing', async () => {
  const h = await usageHarness();
  try {
    seedClaude(h.store, 'd1', 'docker/ws1', 'Default');
    seedUsage(h.store, [
      { at: at(10), claude: null, input: 5 },
      { at: at(9), claude: 'd1', input: 7, cost: 0.25 },
      { at: at(11), claude: '', input: 9 },
    ]);
    const r = new SpendReader(h.store);
    assert.deepEqual(r.rowsBetween(at(0)).map((x) => [x.atMs, x.claudeId, x.input]), [[at(9), 'd1', 7], [at(10), '', 5], [at(11), '', 9]]);
    assert.deepEqual(r.rowsBetween(at(10), at(11)).map((x) => x.input), [5], 'from is inclusive, to is not');
    assert.equal(r.firstAtMs(), at(9));
    assert.deepEqual(r.claudes().map((c) => [c.id, c.name, c.directory, c.removed]), [['d1', 'Default', '', false]]);
    h.store.db!.exec('DROP TABLE chat_usage');
    assert.deepEqual([r.rowsBetween(0), r.firstAtMs()], [[], null]);
  } finally {
    h.done();
  }
});
