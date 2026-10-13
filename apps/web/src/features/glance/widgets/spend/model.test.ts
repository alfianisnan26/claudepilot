import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpendSummary, SpendTotals } from '@portal/contracts';
import { spendCompact, spendView } from './model.js';

const totals = (costUsd: number, input: number, output: number, cacheWrite: number, requests: number): SpendTotals => ({ costUsd, input, output, cacheRead: 999_999, cacheWrite, requests, agents: 0 });
const summary = (over: Partial<SpendSummary> = {}): SpendSummary => ({
  today: totals(3.2, 400_000, 100_000, 50_000, 12),
  week: totals(41.5, 6_000_000, 1_000_000, 500_000, 230),
  month: totals(1234, 90_000_000, 9_000_000, 1_000_000, 4000),
  timezone: 'Asia/Jakarta',
  budgets: { total: 0, near: 0, high: 0, exhausted: 0, paused: 0 },
  spikes24h: 0,
  alerts: [],
  now: '2026-10-13T05:00:00Z',
  ...over,
});

test('today, this week and this month: dollars as the estimate they are, tokens without cache reads (input + output + cache writes)', () => {
  const v = spendView(summary());
  // today 400k + 100k + 50k = 550k; week 6M + 1M + 0.5M = 7.5M; month 100M
  assert.deepEqual(v.today, { cost: '$3.2', tokens: '550k', requests: 12 });
  assert.deepEqual(v.week, { cost: '$41.5', tokens: '7.5M', requests: 230 });
  assert.deepEqual(v.month, { cost: '$1.2k', tokens: '100M', requests: 4000 });
  assert.deepEqual(spendCompact(v, false), { value: '$3.2', level: 'idle', title: 'Usage today: $3.2 (estimate), 550k tokens in 12 requests' });
});

test('a portal without the week says it is unavailable, not zero; loading and failed are states', () => {
  const { week: _w, ...old } = summary();
  assert.equal(spendView(old as SpendSummary).week, null);
  assert.equal(spendCompact(null, false).loading, true);
  assert.equal(spendCompact(null, true).value, '-');
  // "$45.67" is six characters: the chip drops the cents (the title keeps them)
  const c = spendCompact(spendView(summary({ today: totals(45.67, 0, 0, 0, 1) })), false);
  assert.deepEqual([c.value, c.title], ['$45', 'Usage today: $45.67 (estimate), 0 tokens in 1 request']);
});
