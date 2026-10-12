import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatUsageTotals, UsageSeries } from '@portal/contracts';
import { cacheSplit } from '@portal/contracts';
import { stackColumns, stackItems } from './fold.js';
import { OTHERS_KEY } from './palette.js';

const totals = (over: Partial<ChatUsageTotals> = {}): ChatUsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0, ...over });
const sum = (bs: (ChatUsageTotals | null)[]): ChatUsageTotals => bs.reduce<ChatUsageTotals>((a, b) => (b ? totals({ costUsd: a.costUsd + b.costUsd, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, requests: a.requests + b.requests }) : a), totals());
const series = (key: string, slot: number | null, buckets: (ChatUsageTotals | null)[]): UsageSeries => {
  const t = sum(buckets);
  return { kind: 'claude', key, label: key.toUpperCase(), sub: null, workspaceId: null, slot, totals: t, cache: cacheSplit(t), buckets };
};
const cost = (t: ChatUsageTotals) => t.costUsd;
const c = (costUsd: number, over: Partial<ChatUsageTotals> = {}) => totals({ costUsd, requests: 1, ...over });

// Hand-computed fixture, cost per bucket (three buckets):
//   a  slot 4  [1, 2, -]      total 3
//   b  slot 1  [0.5, 0, 0.5]  total 1
//   c  slot 0  [0.1, -, 0.1]  total 0.2
//   d  slot 6  [-, 0.05, -]   total 0.05
//   e  no slot [0.3, -, -]    total 0.3 (the palette ran out of colours: always grey)
const A = series('a', 4, [c(1), c(2), null]);
const B = series('b', 1, [c(0.5), c(0), c(0.5)]);
const C = series('c', 0, [c(0.1), null, c(0.1)]);
const D = series('d', 6, [null, c(0.05), null]);
const E = series('e', null, [c(0.3), null, null]);

test('top 2 by cost keep their colour in slot order; the rest fold into Others with the members biggest first', () => {
  const items = stackItems([A, B, C, D, E], cost, 2);
  assert.deepEqual(items.map((i) => i.key), ['b', 'a', OTHERS_KEY]); // slot 1, slot 4, then Others on top
  const [b, a, others] = items;
  assert.deepEqual(b!.values, [0.5, 0, 0.5]);
  assert.deepEqual(a!.values, [1, 2, 0]);
  assert.equal(a!.total, 3);
  // Others = e + c + d: 0.3 + 0.2 + 0.05 = 0.55 over the window; bucket by bucket 0.3 + 0.1 + 0 = 0.4, 0 + 0 + 0.05 = 0.05, 0 + 0.1 + 0 = 0.1.
  assert.equal(others!.slot, null);
  assert.equal(others!.label, 'Others');
  assert.ok(Math.abs(others!.total - 0.55) < 1e-9);
  assert.deepEqual(others!.values.map((v) => Math.round(v * 1000) / 1000), [0.4, 0.05, 0.1]);
  assert.deepEqual(others!.members!.map((m) => m.key), ['e', 'c', 'd']);
});

test('a series without a palette slot always folds, even when it is the biggest', () => {
  const big = series('big', null, [c(9)]);
  const items = stackItems([A, big], cost, 6);
  assert.deepEqual(items.map((i) => i.key), ['a', OTHERS_KEY]);
  assert.deepEqual(items[1]!.members!.map((m) => m.key), ['big']);
});

test('with room for all of them nothing folds: four series and N = 6', () => {
  const items = stackItems([A, B, C, D], cost, 6);
  assert.deepEqual(items.map((i) => i.key), ['c', 'b', 'a', 'd']); // slots 0, 1, 4, 6
  assert.ok(items.every((i) => i.members === null));
});

test('a single series is never folded alone: N + 1 series all show', () => {
  const items = stackItems([A, B, C], cost, 2);
  assert.deepEqual(items.map((i) => i.key), ['c', 'b', 'a']);
  // ...but N + 2 fold the two smallest.
  const four = stackItems([A, B, C, D], cost, 2);
  assert.deepEqual(four.map((i) => i.key), ['b', 'a', OTHERS_KEY]);
  assert.deepEqual(four[2]!.members!.map((m) => m.key), ['c', 'd']);
});

test('a series that measured nothing is left out, and the measure decides who is big', () => {
  const quiet = series('quiet', 3, [totals({ requests: 4 })]); // 4 requests, no dollars
  assert.deepEqual(stackItems([A, quiet], cost, 6).map((i) => i.key), ['a']);
  const requests = (t: ChatUsageTotals) => t.requests;
  // By requests a has 2, quiet 4: both show, in slot order (quiet is slot 3, a slot 4).
  assert.deepEqual(stackItems([A, quiet], requests, 6).map((i) => i.key), ['quiet', 'a']);
  assert.deepEqual(stackItems([], cost), []);
});

test('ties break by name so the order never flickers between loads', () => {
  const x = series('x', 2, [c(1)]);
  const y = series('y', 3, [c(1)]);
  const z = series('z', 5, [c(1)]);
  assert.deepEqual(stackItems([z, y, x], cost, 1).map((i) => i.key), ['x', OTHERS_KEY]);
  assert.deepEqual(stackItems([z, y, x], cost, 1)[1]!.members!.map((m) => m.key), ['y', 'z']);
});

test('switching a legend item off removes its segment and repaints nobody', () => {
  const items = stackItems([A, B, C, D, E], cost, 2); // b, a, others (values above)
  const all = stackColumns(items, 3, new Set());
  assert.deepEqual(all.map((col) => Math.round(col.total * 1000) / 1000), [1.9, 2.05, 0.6]); // 0.5+1+0.4, 0+2+0.05, 0.5+0+0.1
  const noA = stackColumns(items, 3, new Set(['a']));
  assert.deepEqual(noA[0]!.segments.map((s) => s.key), ['b', OTHERS_KEY]);
  assert.deepEqual(noA.map((col) => Math.round(col.total * 1000) / 1000), [0.9, 0.05, 0.6]);
  // The rest keep their order and their values: only the removed one is gone.
  assert.deepEqual(noA[0]!.segments.map((s) => s.value), [0.5, 0.4]);
});

test('tokens as a measure: input + output + cache writes, cache reads left out (P4)', () => {
  const tokens = (t: ChatUsageTotals) => t.input + t.output + t.cacheWrite;
  const s = series('s', 2, [totals({ input: 100, output: 50, cacheWrite: 30, cacheRead: 5000, requests: 1 })]);
  const [only] = stackItems([s], tokens);
  assert.equal(only!.total, 180);
});
