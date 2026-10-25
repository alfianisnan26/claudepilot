// T-2360: the Metrics cards rendered to markup (no browser): an unavailable program says why, a score shows its delta and its basis in a tip,
// and a drill-down lists the tickets as links. The charts' SVG is checked in components/charts.test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricsProgram, MetricsOverview, MetricsScore } from '@portal/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ClosuresCard, DrillList, LeadsCard, LeadTimeCard, ProgramUnavailable, ScoresCard, StagesCard } from './metricsParts';

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

// Slice 1 made the totals nullable: a failed read of the closed tickets must read "unavailable" with its reason, never 0 or "no ticket".
const noRead = { reason: 'no_source' as const, text: 'The closed tickets could not be read, so the flow figures are unavailable (not 0).' };
const loaded = <T>(data: T) => ({ data, failed: false, forbidden: false, loading: false, reload: () => undefined });

test('ScoresCard: flow null says why, and the done, won-t-do and median figures are a dash with unavailable', () => {
  const html = renderToStaticMarkup(
    createElement(ScoresCard, {
      overview: { ...overview({ ...memor, kind: 'all', unavailable: undefined }, score(72, 60)), flow: null, flowUnavailable: noRead },
      program: undefined,
      loading: false,
    }),
  );
  const t = text(html);
  assert.match(t, /The closed tickets could not be read/);
  assert.match(html, /data-metric-stat="done"[^>]*>.*?<dd[^>]*>-<\/dd>/);
  assert.match(t, /Done - unavailable Won&#?\w*;?t do - unavailable Median - unavailable/);
});

test('the cards over the closed tickets: total null is "unavailable" with the reason, not an empty chart or "No ticket"', () => {
  const none = {
    program: 'all',
    window: '24h' as const,
    nowMs: 0,
    stage: null,
    group: null,
    groupBy: null,
    total: null,
    rows: [],
    unavailable: noRead,
  };
  const flow = {
    program: 'all',
    window: '24h' as const,
    nowMs: 0,
    groupBy: 'lead' as const,
    total: null,
    groups: [],
    basis: {},
    unavailable: noRead,
  };
  const pick = () => undefined;
  const cards = [
    createElement(ClosuresCard, { load: loaded(none), window: '24h' }),
    createElement(LeadTimeCard, { load: loaded(none) }),
    createElement(StagesCard, { load: loaded(flow), onPick: pick, picked: null }),
    createElement(LeadsCard, { load: loaded(flow), onPick: pick, picked: null }),
    createElement(
      MemoryRouter,
      null,
      createElement(DrillList, { load: loaded(none), target: { stage: null, group: null }, window: '24h' }),
    ),
  ];
  for (const c of cards) {
    const t = text(renderToStaticMarkup(c));
    assert.match(t, /unavailable: The closed tickets could not be read/);
    assert.doesNotMatch(t, /No ticket was done|Nothing closed|No lead closed|\b0 done\b/);
  }
});
