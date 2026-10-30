// T-2360: the Metrics view models. Pure: the numbers and the words are checked without a browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  MetricsComponent,
  MetricsFlow,
  MetricsFlowGroup,
  MetricsFlowWindow,
  MetricsOverview,
  MetricsProgram,
  MetricsScore,
  MetricsStage,
  MetricsTicketRow,
  MetricsTickets,
} from '@portal/contracts';
import {
  closureColumns,
  componentLines,
  drillRows,
  drillTitle,
  headlineFigures,
  insightRows,
  leadLabel,
  leadRows,
  leadTimeSpread,
  metricsQuery,
  missingRows,
  nearestRank,
  paceView,
  pickProgram,
  programOptions,
  scoreView,
  stageRows,
  summaryStats,
  trendView,
  UNAVAILABLE,
  unavailableNote,
} from './metricsModel';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

const program = (id: string, over: Partial<MetricsProgram> = {}): MetricsProgram => ({
  id,
  label: id,
  kind: 'tickets',
  tags: [],
  source: 'builtin',
  targets: { closuresPerHour: 2, resolveHours: 24, reviewHours: 2 },
  ...over,
});
const stat = (stage: MetricsStage, n: number, medianMs: number | null, p90Ms: number | null, excluded = 0) => ({
  stage,
  n,
  excluded,
  medianMs,
  p90Ms,
});
const flowWin = (over: Partial<MetricsFlowWindow> = {}): MetricsFlowWindow => ({
  fromMs: 0,
  toMs: 1,
  done: 4,
  wontDo: 1,
  wontDoMedianMs: null,
  stages: [stat('resolve', 4, 2 * HOUR, 5 * HOUR), stat('start', 4, 60_000, 120_000)],
  rounds: { n: 0, medianRounds: null, reworked: 0, fails: 0 },
  ...over,
});
const group = (key: string, cur: Partial<MetricsFlowWindow> = {}, prev: Partial<MetricsFlowWindow> = {}): MetricsFlowGroup => ({
  key,
  current: flowWin(cur),
  previous: flowWin(prev),
});
const comp = (over: Partial<MetricsComponent> = {}): MetricsComponent => ({
  id: 'c',
  label: 'Closures',
  weight: 35,
  appliedWeight: 35,
  value: 72.4,
  basis: 'measured',
  source: 'tickets',
  raw: '3 done',
  ...over,
});
const score = (over: Partial<MetricsScore> = {}): MetricsScore => ({
  value: 72.4,
  previous: 60,
  components: [comp()],
  basis: 'weights from the ticket',
  ...over,
});
const overview = (over: Partial<MetricsOverview> = {}): MetricsOverview => ({
  program: program('all', { kind: 'all' }),
  window: '24h',
  nowMs: NOW,
  efficiency: score(),
  effectiveness: score({ value: 55.6 }),
  flow: group('all'),
  open: { open: 9, inProgress: 3, blocked: 2, inReview: 4, oldestReviewMs: 90 * 60_000, stalled: 1 },
  crew: null,
  basis: {},
  ...over,
});
const row = (ticket: string, ageH: number, over: Partial<MetricsTicketRow> = {}, resolve: number | null = 2 * HOUR): MetricsTicketRow => ({
  ticket,
  type: 'task',
  priority: 'high',
  status: 'done',
  closedAtMs: NOW - ageH * HOUR,
  lead: 'area-web',
  programs: [],
  stages: { start: null, report: null, implement: null, test: null, deliver: null, resolve, work: null },
  rounds: null,
  fails: null,
  ...over,
});
const tickets = (rows: MetricsTicketRow[], total: number | null = rows.length): MetricsTickets => ({
  program: 'all',
  window: '24h',
  nowMs: NOW,
  stage: null,
  group: null,
  groupBy: null,
  total,
  rows,
});

test('metricsQuery leaves empty values out and encodes the rest', () => {
  assert.equal(metricsQuery({ program: 'a b', window: '24h', stage: null, group: undefined, groupBy: '' }), 'program=a+b&window=24h');
});

test('programOptions puts All first; pickProgram falls back to it', () => {
  const ps = [program('konfersi'), program('all', { kind: 'all', label: 'All' }), program('memor', { kind: 'commits' })];
  assert.deepEqual(
    programOptions(ps).map((o) => o.value),
    ['all', 'konfersi', 'memor'],
  );
  assert.equal(pickProgram(ps, 'konfersi'), 'konfersi');
  assert.equal(pickProgram(ps, 'gone'), 'all');
  assert.equal(pickProgram(ps, null), 'all');
  assert.equal(pickProgram([], null), 'all');
});

test('componentLines: the applied weight shows only when it differs; an unavailable one says why', () => {
  const lines = componentLines(
    score({
      components: [
        comp(),
        comp({ id: 'd', weight: 20, appliedWeight: 25 }),
        comp({ id: 'q', value: null, appliedWeight: 0, basis: 'unavailable', reason: 'no_claude', raw: '' }),
      ],
    }),
  );
  assert.equal(lines[0]?.weight, '35 %');
  assert.equal(lines[0]?.value, '72');
  assert.equal(lines[1]?.weight, '20 % (25 % applied)');
  assert.equal(lines[2]?.value, UNAVAILABLE);
  assert.match(lines[2]?.basis ?? '', /^unavailable: /);
});

test('scoreView: no value takes the program reason, else the first unavailable component, never 0', () => {
  const off = score({
    value: null,
    previous: null,
    components: [comp({ value: null, appliedWeight: 0, basis: 'unavailable', reason: 'no_source' })],
  });
  const own = scoreView(
    'Efficiency',
    off,
    program('memor', { kind: 'commits', unavailable: { reason: 'no_source', text: 'memor.id has no tickets in the portal' } }),
  );
  assert.equal(own.value, null);
  assert.equal(own.reason, 'memor.id has no tickets in the portal');
  const comp1 = scoreView('Efficiency', off, program('all'));
  assert.match(comp1.reason ?? '', /^Closures: /);
  assert.equal(scoreView('Efficiency', undefined, undefined).reason, 'not read yet');
  const ok = scoreView('Efficiency', score(), program('all'));
  assert.equal(ok.reason, undefined);
  assert.equal(ok.previous, 60);
});

test('stageRows: a stage with no ticket says why; excluded is kept', () => {
  const g = group('all', { stages: [stat('start', 3, 1000, 2000, 1), stat('report', 0, null, null, 2)] });
  const rows = stageRows(g, ['start', 'report', 'test']);
  assert.equal(rows[0]?.n, 3);
  assert.equal(rows[0]?.excluded, 1);
  assert.equal(rows[0]?.note, undefined);
  assert.equal(rows[1]?.median, null);
  assert.equal(rows[1]?.note, 'no ticket had both ends of this stage recorded');
  assert.equal(rows[2]?.note, 'not recorded');
  assert.equal(stageRows(group('all', { done: 0, stages: [] }), ['start'])[0]?.note, 'no ticket was done in this window');
  assert.deepEqual(stageRows(null, ['start']), []);
});

test('leadLabel and leadRows: lead names in words, at most ten rows, the rest counted', () => {
  assert.equal(leadLabel('unrecorded'), 'Unrecorded');
  assert.equal(leadLabel('lead:abcdef0123456789'), 'lead abcdef01');
  assert.equal(leadLabel('area-web'), 'area-web');
  const flow: MetricsFlow = {
    program: 'all',
    window: '24h',
    nowMs: NOW,
    groupBy: 'lead',
    total: group('all'),
    groups: Array.from({ length: 12 }, (_, i) => group(`area-${i}`)),
    basis: {},
  };
  const r = leadRows(flow);
  assert.equal(r.rows.length, 10);
  assert.equal(r.hidden, 2);
  assert.equal(r.rows[0]?.sub, '4 done');
  assert.deepEqual(leadRows(null), { rows: [], hidden: 0 });
});

test("closureColumns: 24 hourly columns ending now; won't-do is a note, not a count; out-of-window rows are left out", () => {
  const c = closureColumns(
    tickets([row('T-1', 0.5), row('T-2', 0.6), row('T-3', 4.5), row('T-4', 2.5, { status: 'wont_do' }), row('T-5', 30)], 9),
    '24h',
  );
  assert.equal(c.columns.length, 24);
  assert.equal(c.per, 'hour');
  assert.equal(c.done, 3);
  assert.equal(c.columns[23]?.value, 2);
  assert.equal(c.columns[19]?.value, 1);
  assert.equal(c.columns[21]?.detail, "1 won't do");
  assert.equal(c.missing, 4);
  assert.equal(closureColumns(tickets([row('T-1', 50)]), '7d').columns.length, 7);
  assert.equal(closureColumns(tickets([row('T-1', 50)]), '7d').per, 'day');
  assert.equal(closureColumns(null, '24h').done, 0);
});

test('nearestRank follows the server: the value at ceil(p * n)', () => {
  assert.equal(nearestRank([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(nearestRank([], 0.5), null);
});

test('leadTimeSpread: ten bins, a ticket without a resolve time is left out, the axis stops at 3 x p90 and counts what is beyond', () => {
  assert.equal(leadTimeSpread(null).n, 0);
  assert.deepEqual(leadTimeSpread(tickets([row('T-1', 1, {}, null)])).counts, []);
  const rows = [...Array.from({ length: 9 }, (_, i) => row(`T-${i}`, 1, {}, (i + 1) * HOUR)), row('T-99', 1, {}, 200 * HOUR)];
  const s = leadTimeSpread(tickets(rows));
  assert.equal(s.n, 10);
  assert.equal(s.counts.length, 10);
  assert.equal(s.beyond, 1);
  assert.equal(
    s.counts.reduce((a, b) => a + b, 0),
    9,
  );
  assert.equal(s.median, 5 * HOUR);
  assert.equal(leadTimeSpread(tickets([row('T-1', 1)], 5)).missing, 4);
});

test('trendView: empty when no snapshot has a score', () => {
  const t = (values: (number | null)[]) => ({
    program: 'all',
    metric: 'efficiency' as const,
    window: '24h' as const,
    nowMs: NOW,
    points: values.map((value, i) => ({ atMs: i, value })),
    everyMs: 1,
    keepMs: 1,
    source: 's',
  });
  assert.equal(trendView(t([null, null]), t([])).empty, true);
  assert.equal(trendView(t([null, 40]), null).empty, false);
  assert.equal(trendView(null, null).series.length, 2);
  assert.deepEqual(trendView(t([10]), null).series[0]?.points, [{ t: 0, v: 10 }]);
});

test('paceView: a note, never an invented row, when the crew figures are not there', () => {
  assert.match(paceView(overview({ crew: null })).note ?? '', /unavailable/);
  assert.deepEqual(paceView(null), { rows: [], note: null });
});

test('insightRows carry the severity in words and the tickets', () => {
  const rows = insightRows({
    program: 'all',
    window: '24h',
    nowMs: NOW,
    items: [
      { kind: 'outlier', severity: 'act', text: 'T-1 took long', tickets: ['T-1'] },
      { kind: 'no_data', severity: 'info', text: 'No data', tickets: [] },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.word),
    ['Act', 'Note'],
  );
  assert.deepEqual(rows[0]?.tickets, ['T-1']);
  assert.deepEqual(insightRows(null), []);
});

test('drillTitle and drillRows: slowest first, a ticket without the stage last and "unavailable", links to the ticket', () => {
  assert.equal(drillTitle({ stage: null, group: null }), 'Tickets');
  assert.equal(drillTitle({ stage: 'implement', group: 'area-web' }), 'area-web · Implement');
  const rows = drillRows(tickets([row('T-1', 1, {}, null), row('T-2', 1, {}, HOUR), row('T-3', 1, { status: 'wont_do' }, 3 * HOUR)]), null);
  assert.deepEqual(
    rows.map((r) => r.ticket),
    ['T-3', 'T-2', 'T-1'],
  );
  assert.equal(rows[2]?.duration, UNAVAILABLE);
  assert.equal(rows[0]?.href, '/admin/tickets/T-3');
  assert.match(rows[0]?.meta ?? '', /won't do/);
  assert.equal(drillRows(tickets([row('T-1', 1, { stages: { ...row('x', 1).stages, test: 5000 } })]), 'test')[0]?.duration, '5s');
});

test('headlineFigures: the four numbers; unavailable is "-" and not available, never 0', () => {
  const f = headlineFigures(overview());
  assert.deepEqual(
    f.map((x) => [x.key, x.value, x.available]),
    [
      ['efficiency', '72', true],
      ['effectiveness', '56', true],
      ['resolved', '4', true],
      ['median', '2h', true],
    ],
  );
  const none = headlineFigures(
    overview({ program: program('memor', { kind: 'commits', unavailable: { reason: 'no_source', text: 'x' } }) }),
  );
  assert.ok(none.every((x) => !x.available && x.value === '-'));
  assert.ok(headlineFigures(null).every((x) => !x.available));
  const noMedian = headlineFigures(overview({ efficiency: score({ value: null }), flow: group('all', { stages: [] }) }));
  assert.equal(noMedian[0]?.available, false);
  assert.equal(noMedian[3]?.available, false);
});

test('summaryStats: the window before as "was", open work unavailable when the store could not be read', () => {
  const s = summaryStats(overview({ flow: group('all', { done: 5 }, { done: 3 }) }));
  assert.equal(s.find((x) => x.key === 'done')?.sub, 'was 3');
  assert.equal(s.find((x) => x.key === 'review')?.value, '4');
  assert.equal(s.find((x) => x.key === 'review')?.sub, 'oldest 1.5h');
  const off = summaryStats(overview({ open: null }));
  assert.equal(off.find((x) => x.key === 'blocked')?.value, '-');
  assert.equal(off.find((x) => x.key === 'blocked')?.sub, UNAVAILABLE);
  assert.deepEqual(summaryStats(null), []);
});

const noRead = { reason: 'no_source' as const, text: 'The closed tickets could not be read, so the flow figures are unavailable (not 0).' };

test('a failed read of the closed tickets (total, flow null) is unavailable in every figure, never 0 or "no ticket"', () => {
  const down = tickets([], null);
  assert.equal(down.total, null);
  assert.equal(closureColumns(down, '24h').missing, 0);
  assert.equal(leadTimeSpread(down).missing, 0);
  const o = overview({ flow: null, flowUnavailable: noRead });
  const s = summaryStats(o);
  for (const k of ['done', 'wontDo', 'median']) {
    assert.equal(s.find((x) => x.key === k)?.value, '-', k);
    assert.equal(s.find((x) => x.key === k)?.sub, UNAVAILABLE, k);
  }
  assert.equal(s.find((x) => x.key === 'review')?.value, '4', 'the open work was read on its own');
  const f = headlineFigures(o);
  assert.deepEqual(
    f.map((x) => [x.key, x.value, x.available]),
    [
      ['efficiency', '72', true],
      ['effectiveness', '56', true],
      ['resolved', '-', false],
      ['median', '-', false],
    ],
  );
  assert.deepEqual(stageRows(null, ['start']), []);
  assert.equal(unavailableNote(noRead), noRead.text);
  assert.equal(unavailableNote(undefined), null);
  assert.equal(missingRows(tickets([row('T-1', 1)], 5)), 4);
});
