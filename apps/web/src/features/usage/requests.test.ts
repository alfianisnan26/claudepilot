import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheSplit, estimatedFigure, measuredFigure, REQUEST_BASIS, unavailableFigure, type ChatUsageTotals, type RequestsReport, type UsageSeries } from '@portal/contracts';
import { stackItems } from '@/lib/usage/fold';
import { chartColumns, displayName, MEASURE, nameCounts, spentTokens, tileChange } from './requests.js';

const totals = (over: Partial<ChatUsageTotals> = {}): ChatUsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0, ...over });
const c = (costUsd: number) => totals({ costUsd, requests: 1 });
const sum = (bs: (ChatUsageTotals | null)[]) => totals({ costUsd: bs.reduce((a, b) => a + (b?.costUsd ?? 0), 0), requests: bs.reduce((a, b) => a + (b?.requests ?? 0), 0) });
const series = (key: string, label: string, sub: string | null, slot: number | null, buckets: (ChatUsageTotals | null)[]): UsageSeries => ({ kind: 'claude', key, label, sub, workspaceId: null, slot, totals: sum(buckets), cache: cacheSplit(sum(buckets)), buckets });

// Three hourly buckets, cost per bucket by hand:
//   a Satria       slot 1  [1, 2, -]       total 3
//   b Kresna       slot 4  [0.5, -, 0.5]   total 1
//   c Default/api  slot 0  [0.1, -, 0.1]   total 0.2
//   d Default/web  slot 6  [-, 0.06, -]    total 0.06
//   e Zed          no slot [0.3, -, -]     total 0.3
const A = series('a', 'Satria', 'api', 1, [c(1), c(2), null]);
const B = series('b', 'Kresna', 'api', 4, [c(0.5), null, c(0.5)]);
const C = series('c', 'Default', 'api', 0, [c(0.1), null, c(0.1)]);
const D = series('d', 'Default', 'web', 6, [null, c(0.06), null]);
const E = series('e', 'Zed', null, null, [c(0.3), null, null]);
const cost = MEASURE.cost;
const fillOf = (slot: number | null) => ({ fill: `slot${slot}`, overlay: slot === null ? null : `pat${slot}` });

const report = (previousCost: number[], coverage: 'full' | 'partial' | 'none' = 'full'): RequestsReport => {
  const at = ['2026-10-12T01:00:00.000Z', '2026-10-12T02:00:00.000Z', '2026-10-12T03:00:00.000Z'];
  const bucket = (i: number, costUsd: number) => ({ at: at[i]!, ...totals({ costUsd, requests: costUsd ? 1 : 0 }) });
  return {
    range: '1d',
    from: at[0]!,
    to: '2026-10-12T04:00:00.000Z',
    bucketMs: 3_600_000,
    totals: totals(),
    buckets: [bucket(0, 1.9), bucket(1, 2.06), bucket(2, 0.6)],
    byClaude: [],
    byModel: [],
    cache: cacheSplit(totals()),
    previous: { from: '2026-10-11T01:00:00.000Z', to: at[0]!, coverage, totals: totals(), buckets: previousCost.map((v, i) => ({ at: at[i]!, ...totals({ costUsd: v }) })), change: { costUsd: unavailableFigure('not_recorded'), tokens: unavailableFigure('not_recorded'), requests: unavailableFigure('not_recorded') } },
    claudes: [],
    models: [],
    basis: REQUEST_BASIS,
  };
};

test('names: a name two Claudes share carries its workspace, and so does one folded into Others', () => {
  const items = stackItems([A, B, C, D, E], cost, 3); // kept: a (3), b (1), e? no: e has no slot and folds; c and d are kept? top 3 slotted by cost: a 3, b 1, c 0.2 ; d and e fold
  assert.deepEqual(items.map((i) => i.key), ['c', 'a', 'b', 'others']);
  const counts = nameCounts(items);
  assert.equal(counts.get('Default'), 2); // c shown, d inside Others
  assert.equal(displayName('Default', 'api', 'claude', counts), 'Default · api');
  assert.equal(displayName('Satria', 'api', 'claude', counts), 'Satria');
  assert.equal(displayName('claude-opus-4-5', null, 'model', counts), 'Opus 4.5');
});

test('columns: bands in slot order, tooltip rows top first, Others names its members in that bucket', () => {
  const items = stackItems([A, B, C, D, E], cost, 2); // b slot 4 and a slot 1 kept; c, d, e fold into Others
  const cols = chartColumns({ report: report([1, 2, 0]), items, kind: 'claude', metric: 'cost', hidden: new Set(), previous: false, fillOf });
  assert.equal(cols.length, 3);
  // bucket 0: a 1 + b 0.5 + Others (e 0.3 + c 0.1) 0.4 = 1.9
  assert.deepEqual(cols[0]!.segments!.map((s) => [s.key, Math.round(s.value * 1000) / 1000]), [['a', 1], ['b', 0.5], ['others', 0.4]]);
  assert.equal(Math.round(cols[0]!.value * 1000) / 1000, 1.9);
  assert.deepEqual(cols[0]!.segments!.map((s) => [s.fill, s.overlay]), [['slot1', 'pat1'], ['slot4', 'pat4'], ['slotnull', null]]);
  assert.deepEqual(cols[0]!.rows!.map((r) => [r.label, r.value]), [['Others', '$0.40'], ['Kresna', '$0.50'], ['Satria', '$1']]);
  assert.deepEqual(cols[0]!.rows![0]!.sub!.map((m) => [m.label, m.value]), [['Zed', '$0.30'], ['Default · api', '$0.10']]);
  // bucket 1: a 2 + Others (d 0.06) = 2.06 ; bucket 2: b 0.5 + Others (c 0.1) = 0.6. Under 10 cents a cost has three decimals ($0.060), from 10 cents two.
  assert.deepEqual(cols[1]!.rows!.map((r) => [r.label, r.value]), [['Others', '$0.060'], ['Satria', '$2']]);
  assert.deepEqual(cols[1]!.rows![0]!.sub!.map((m) => [m.label, m.value]), [['Default · web', '$0.060']]);
  assert.equal(Math.round(cols[2]!.value * 1000) / 1000, 0.6);
  assert.ok(cols[0]!.label!.includes('Others $0.40') && cols[0]!.label!.includes('Satria $1'));
  assert.equal(cols[0]!.marker, null);
});

test('a legend item switched off leaves the column and its row', () => {
  const items = stackItems([A, B, C, D, E], cost, 2);
  const cols = chartColumns({ report: report([1, 2, 0]), items, kind: 'claude', metric: 'cost', hidden: new Set(['a']), previous: false, fillOf });
  assert.deepEqual(cols[0]!.segments!.map((s) => s.key), ['b', 'others']);
  assert.equal(Math.round(cols[0]!.value * 1000) / 1000, 0.9); // 0.5 + 0.4
  assert.deepEqual(cols[1]!.rows!.map((r) => r.label), ['Others']);
});

test('previous period: the marker sits at the same bucket, the tooltip says before and the change; zero before has no percent', () => {
  const items = stackItems([A, B, C, D, E], cost, 2);
  const cols = chartColumns({ report: report([1, 2, 0]), items, kind: 'claude', metric: 'cost', hidden: new Set(), previous: true, fillOf });
  assert.deepEqual(cols.map((col) => col.marker), [1, 2, 0]);
  // 1.9 vs 1: +90 % ; 2.06 vs 2: +3 % ; 0.6 vs 0: no percent
  assert.deepEqual(cols.map((col) => col.compare), ['Before $1 · +90 %', 'Before $2 · +3 %', 'Before $0']);
  assert.ok(cols[0]!.label!.endsWith('Before $1 · +90 %'));
});

test('previous period: partial history is said so, none draws nothing', () => {
  const items = stackItems([A, B, C, D, E], cost, 2);
  const partial = chartColumns({ report: report([1, 2, 0], 'partial'), items, kind: 'claude', metric: 'cost', hidden: new Set(), previous: true, fillOf });
  assert.equal(partial[0]!.compare, 'Before $1 · +90 % (partial)');
  const none = chartColumns({ report: report([0, 0, 0], 'none'), items, kind: 'claude', metric: 'cost', hidden: new Set(), previous: true, fillOf });
  assert.deepEqual(none.map((col) => [col.marker, col.compare]), [[null, undefined], [null, undefined], [null, undefined]]);
});

test('tokens: input + output + cache writes, cache reads apart (hand sum: 2000 + 500 + 1000 = 3500)', () => {
  assert.equal(spentTokens(totals({ input: 2000, output: 500, cacheWrite: 1000, cacheRead: 40000 })), 3500);
  assert.equal(MEASURE.tokens(totals({ input: 2000, output: 500, cacheWrite: 1000, cacheRead: 40000 })), 3500);
  assert.equal(MEASURE.requests(totals({ requests: 4 })), 4);
});

test('tile change: "+321 % vs $1" when known, a short reason when not', () => {
  const money = (v: number) => (v === 1 ? '$1' : `$${v}`);
  assert.deepEqual(tileChange(estimatedFigure(321), 1, money, '24 hours'), { hint: '+321 % vs $1', reason: null, note: 'Against the 24 hours before ($1).' });
  assert.equal(tileChange(measuredFigure(-8.6), 12, (v) => String(v), 'week').hint, '-9 % vs 12');
  assert.equal(tileChange(unavailableFigure('not_recorded'), 0, money, 'week').hint, 'no earlier data');
  // The whole sentence is the portal's own reason, for the tile's tip.
  assert.equal(tileChange(unavailableFigure('not_recorded'), 0, money, 'week').note, 'Against the week before: Not recorded then.');
  assert.equal(tileChange(unavailableFigure('no_baseline'), 0, money, 'week').hint, 'none before');
  assert.equal(tileChange(unavailableFigure('stale'), 0, money, 'week').hint, '-');
});
