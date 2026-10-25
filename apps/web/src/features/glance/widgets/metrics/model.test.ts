import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricsOverview, MetricsScore } from '@portal/contracts';
import { metricsCompact, metricsFigures } from './model';

const score = (value: number | null): MetricsScore => ({ value, previous: null, components: [], basis: '' });
const flow = (done: number, medianMs: number | null) => {
  const w = { fromMs: 0, toMs: 1, done, wontDo: 0, wontDoMedianMs: null, stages: medianMs === null ? [] : [{ stage: 'resolve' as const, n: done, excluded: 0, medianMs, p90Ms: medianMs }], rounds: { n: 0, medianRounds: null, reworked: 0, fails: 0 } };
  return { key: 'all', current: w, previous: w };
};
const overview = (eff: number | null, done = 6, medianMs: number | null = 3_600_000): MetricsOverview => ({
  program: { id: 'all', label: 'All', kind: 'all', tags: [], source: 'builtin', targets: { closuresPerHour: 2, resolveHours: 24, reviewHours: 2 } },
  window: '24h',
  nowMs: 0,
  efficiency: score(eff),
  effectiveness: score(40),
  flow: flow(done, medianMs),
  open: null,
  crew: null,
  basis: {},
});

test('metricsFigures: four numbers in the order efficiency, effectiveness, resolved, median', () => {
  assert.deepEqual(metricsFigures(overview(72)).map((f) => f.value), ['72', '40', '6', '1h']);
});

test('metricsCompact: the efficiency score, five characters at most, the four numbers in the title', () => {
  const c = metricsCompact(overview(72.4), false);
  assert.equal(c.value, '72');
  assert.equal(c.level, 'idle');
  assert.match(c.title, /efficiency 72, effectiveness 40, resolved 6, median 1h/);
});

test('metricsCompact: no efficiency is "-" with unknown, and the title says unavailable; loading and failed are told apart', () => {
  const c = metricsCompact(overview(null, 0, null), false);
  assert.equal(c.value, '-');
  assert.equal(c.level, 'unknown');
  assert.match(c.title, /efficiency unavailable/);
  assert.equal(metricsCompact(null, false).loading, true);
  const failed = metricsCompact(null, true);
  assert.equal(failed.value, '-');
  assert.equal(failed.loading, false);
});
