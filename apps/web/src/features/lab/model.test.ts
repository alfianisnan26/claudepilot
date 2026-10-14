import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LabSummaryRow } from '@portal/contracts';
import { figures, fmtInterval, fmtStat, fmtCount, rowTitle, UNAVAILABLE } from './model';

const row = (o: Partial<LabSummaryRow> = {}): LabSummaryRow => ({
  period: '2026-10-14',
  role: 'implementer',
  model: 'claude-opus-5-5',
  n: 3,
  requests: { median: 47, p90: 120 },
  ctxP50: { median: 77000, p90: 77000 },
  resultChars: { median: 1, p90: 1 },
  resultTokens: { median: 1, p90: 1 },
  minutes: { median: 28, p90: 60 },
  costUsd: null,
  bashShare: {},
  bashCalls: 0,
  rewriteTokens: 0,
  rewriteShare: null,
  outcomes: { accepted: 0, rework: 0, defect: 0, unknown: 3 },
  firstPassYield: null,
  costPerAccepted: null,
  costPerAcceptedN: 0,
  costPerAcceptedInterval: 'n too small',
  ...o,
});

test('a figure without a reading is "unavailable", never 0', () => {
  const f = Object.fromEntries(figures(row()).map((x) => [x.key, x.value]));
  assert.equal(f.cost, UNAVAILABLE);
  assert.equal(f.insp, UNAVAILABLE, 'no Bash call: no share');
  assert.equal(f.fpy, UNAVAILABLE);
  assert.equal(f.cpa, UNAVAILABLE);
  assert.equal(f.ci, UNAVAILABLE, 'no accepted slice: no interval');
  assert.equal(f.req, '47 / 120', 'median / p90');
  assert.equal(f.ctx, '77k', 'p90 equal to the median is not repeated');
  assert.equal(fmtStat({ median: null, p90: null }, fmtCount), UNAVAILABLE);
});

test('titles and intervals', () => {
  assert.equal(rowTitle(row()), 'Implementer · Opus 5.5');
  assert.equal(rowTitle(row({ role: 'main', model: null })), 'Main');
  assert.equal(fmtInterval('n too small'), 'n too small');
  assert.equal(fmtInterval({ low: 1.2, high: 1.9 }), '$1.2–$1.9');
  const f = Object.fromEntries(figures(row({ bashCalls: 4, bashShare: { inspect: 0.25 }, firstPassYield: 0.6, costPerAccepted: 0.36, costPerAcceptedN: 3 })).map((x) => [x.key, x.value]));
  assert.deepEqual([f.insp, f.fpy, f.cpa, f.ci], ['25 %', '60 %', '$0.36', 'n too small']);
  const g = Object.fromEntries(figures(row({ costPerAccepted: 0.65, costPerAcceptedN: 24, costPerAcceptedInterval: { low: 0.44, high: 0.91 } })).map((x) => [x.key, x.value]));
  assert.equal(g.ci, '$0.44–$0.91');
});
