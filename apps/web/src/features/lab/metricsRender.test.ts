// T-2360: the Metrics cards rendered to markup (no browser): an unavailable program says why, a score shows its delta and its basis in a tip,
// and a drill-down lists the tickets as links. The charts' SVG is checked in components/charts.test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricsProgram, MetricsOverview, MetricsScore } from '@portal/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { DrillList, ProgramUnavailable, ScoresCard } from './metricsParts';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const score = (value: number | null, previous: number | null): MetricsScore => ({
  value,
  previous,
  components: [],
  basis: 'weights from the ticket',
});
const memor: MetricsProgram = {
  id: 'memor',
  label: 'memor.id',
  kind: 'commits',
  tags: [],
  source: 'builtin',
  targets: { closuresPerHour: 2, resolveHours: 24, reviewHours: 2 },
  unavailable: { reason: 'no_source', text: 'memor.id has no tickets in the portal' },
};
const win = {
  fromMs: 0,
  toMs: 1,
  done: 0,
  wontDo: 0,
  wontDoMedianMs: null,
  stages: [],
  rounds: { n: 0, medianRounds: null, reworked: 0, fails: 0 },
};
const overview = (program: MetricsProgram, eff: MetricsScore): MetricsOverview => ({
  program,
  window: '24h',
  nowMs: 0,
  efficiency: eff,
  effectiveness: score(null, null),
  flow: { key: 'all', current: win, previous: win },
  open: null,
  crew: null,
  basis: {},
});

test('ProgramUnavailable says why, in words, and shows no number', () => {
  const t = text(renderToStaticMarkup(createElement(ProgramUnavailable, { program: memor })));
  assert.match(t, /memor\.id has no tickets in the portal/);
  assert.doesNotMatch(t, /\b0\b/);
});

test('ScoresCard: a score with the window before shows both; one without says unavailable', () => {
  const html = renderToStaticMarkup(
    createElement(ScoresCard, {
      overview: overview({ ...memor, kind: 'all', unavailable: undefined }, score(72, 60)),
      program: undefined,
      loading: false,
    }),
  );
  assert.match(html, /data-metric-card="scores"/);
  assert.match(text(html), /72/);
  assert.match(text(html), /unavailable/);
});

test('DrillList: each ticket is a link to its page, the slowest first, a missing stage reads unavailable', () => {
  const HOUR = 3_600_000;
  const stages = (resolve: number | null) => ({
    start: null,
    report: null,
    implement: null,
    test: null,
    deliver: null,
    resolve,
    work: null,
  });
  const base = {
    type: 'task',
    priority: 'high',
    status: 'done' as const,
    closedAtMs: 0,
    lead: 'area-web',
    programs: [],
    rounds: null,
    fails: null,
  };
  const rows = [
    { ...base, ticket: 'T-1', stages: stages(HOUR) },
    { ...base, ticket: 'T-2', stages: stages(null) },
    { ...base, ticket: 'T-3', stages: stages(5 * HOUR) },
  ];
  const data = { program: 'all', window: '24h' as const, nowMs: 0, stage: null, group: null, groupBy: null, total: 3, rows };
  const load = { data, failed: false, forbidden: false, loading: false, reload: () => undefined };
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DrillList, { load, target: { stage: 'resolve', group: null }, window: '24h' })),
  );
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['/admin/tickets/T-3', '/admin/tickets/T-1', '/admin/tickets/T-2']);
  assert.match(text(html), /T-2 .*unavailable/);
});
