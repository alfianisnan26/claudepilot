// Pilot metrics (T-2360, §28.15): the pure parts. Golden fixtures per stage (with the left-out cases and won't-do), grouping with the
// median and p90, the programs setting, both scores with their weights, the findings. No clock: every time is an offset from a fixed NOW.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricsOpenWork, MetricsProgram } from '@portal/contracts';
import {
  combine,
  DEFAULT_ALL_TARGETS,
  DEFAULT_METRICS_PROGRAMS,
  DEFAULT_TARGETS,
  downsample,
  EFFECTIVENESS_WEIGHTS,
  EFFICIENCY_WEIGHTS,
  effectivenessScore,
  efficiencyScore,
  flowWindow,
  fmtDur,
  groupFlow,
  inProgram,
  insights,
  LONG_IDLE_MS,
  MAX_TAG_PROGRAMS,
  openWork,
  parseMetricsPrograms,
  resolvePrograms,
  snapshotValues,
  stageStat,
  ticketFlow,
  ticketRows,
  type FlowRow,
  type FlowTicketFacts,
} from './flowMetrics.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const MIN = 60_000;
const H = 3_600_000;
const ago = (h: number) => NOW - h * H;

const facts = (o: Partial<FlowTicketFacts> & { id: string }): FlowTicketFacts => ({
  type: 'feature',
  priority: 'normal',
  status: 'done',
  createdAtMs: ago(10),
  closedAtMs: ago(1),
  tags: [],
  lead: 'area-lab',
  starts: [],
  firstAgentCommentMs: null,
  verdicts: [],
  merges: [],
  ...o,
});

/* ---------- Stages: the golden fixture ---------- */

test('ticketFlow: every stage of a full journey, with the test rounds and rework', () => {
  // created 10 h ago; agent comment at 9.5; in progress at 9; verdicts fail 6, fail 5, pass 4; merged 3; closed 1.
  const r = ticketFlow(
    facts({
      id: 'T-1',
      starts: [ago(9)],
      firstAgentCommentMs: ago(9.5),
      verdicts: [
        { atMs: ago(6), pass: false },
        { atMs: ago(5), pass: false },
        { atMs: ago(4), pass: true },
      ],
      merges: [ago(3)],
    }),
  );
  assert.deepEqual(r.stages, { start: 1 * H, report: 0.5 * H, implement: 3 * H, test: 2 * H, deliver: 2 * H, resolve: 9 * H, work: 8 * H });
  assert.equal(r.rounds, 3);
  assert.equal(r.fails, 2);
  assert.equal(r.lifeMs, 9 * H);
});

test('ticketFlow: a missing moment leaves its stage out (null), never 0', () => {
  // Never moved into in_progress, no agent comment, no verdict, no merge: only resolve is known.
  const r = ticketFlow(facts({ id: 'T-2' }));
  assert.deepEqual(r.stages, { start: null, report: null, implement: null, test: null, deliver: null, resolve: 9 * H, work: null });
  assert.equal(r.rounds, null);
  assert.equal(r.fails, null);
});

test('ticketFlow: implement ends at the first merge when there is no verdict; no passing verdict means no test stage', () => {
  const noVerdict = ticketFlow(facts({ id: 'T-3', starts: [ago(8)], merges: [ago(5), ago(2)] }));
  assert.equal(noVerdict.stages.implement, 3 * H);
  assert.equal(noVerdict.stages.test, null);
  assert.equal(noVerdict.stages.deliver, 1 * H, 'deliver runs from the LAST merge');
  const onlyFails = ticketFlow(facts({ id: 'T-4', starts: [ago(8)], verdicts: [{ atMs: ago(6), pass: false }], merges: [ago(2)] }));
  assert.equal(onlyFails.stages.implement, 2 * H, 'the first verdict, failing or not, ends implement');
  assert.equal(onlyFails.stages.test, null);
  assert.equal(onlyFails.rounds, null);
});

test('ticketFlow: nothing after the close counts, and a negative span is left out', () => {
  const r = ticketFlow(
    facts({
      id: 'T-5',
      starts: [ago(8)],
      firstAgentCommentMs: ago(0.5), // after the close (1 h ago)
      verdicts: [
        { atMs: ago(4), pass: true },
        { atMs: ago(0.5), pass: false },
      ],
      merges: [ago(3), ago(0.2)],
    }),
  );
  assert.equal(r.stages.report, null);
  assert.equal(r.stages.deliver, 2 * H, 'the merge after the close is ignored');
  assert.equal(r.rounds, 1);
  assert.equal(r.fails, 0);
  // A start recorded before the ticket was created (two writers' clocks) is not a start.
  const skew = ticketFlow(facts({ id: 'T-6', createdAtMs: ago(5), starts: [ago(6)] }));
  assert.equal(skew.stages.start, null);
  assert.equal(skew.stages.work, null);
  // A test stage's verdicts before the first start belong to no one.
  const early = ticketFlow(
    facts({
      id: 'T-7',
      starts: [ago(5)],
      verdicts: [
        { atMs: ago(7), pass: true },
        { atMs: ago(3), pass: true },
      ],
    }),
  );
  assert.equal(early.stages.implement, 2 * H);
  assert.equal(early.stages.test, 0);
  assert.equal(early.rounds, 1);
});

test('ticketFlow: a pass after the last merge does not stretch the test stage', () => {
  const r = ticketFlow(
    facts({
      id: 'T-8',
      starts: [ago(9)],
      verdicts: [
        { atMs: ago(7), pass: true },
        { atMs: ago(5), pass: false },
        { atMs: ago(2), pass: true },
      ],
      merges: [ago(4)],
    }),
  );
  assert.equal(r.stages.test, 0, 'the last pass at or before the merge is the first verdict');
  assert.equal(r.rounds, 1);
});

test('ticketFlow: won’t-do has no stage and keeps its life apart', () => {
  const r = ticketFlow(facts({ id: 'T-9', status: 'wont_do', starts: [ago(9)], merges: [ago(3)] }));
  assert.ok(Object.values(r.stages).every((v) => v === null));
  assert.equal(r.lifeMs, 9 * H);
});

/* ---------- Aggregates ---------- */

const row = (id: string, closedAgo: number, resolveH: number | null, o: Partial<FlowRow> = {}): FlowRow => ({
  id,
  type: 'feature',
  priority: 'normal',
  status: 'done',
  createdAtMs: ago(closedAgo + (resolveH ?? 1)),
  closedAtMs: ago(closedAgo),
  tags: [],
  lead: 'area-lab',
  stages: {
    start: null,
    report: null,
    implement: null,
    test: null,
    deliver: null,
    resolve: resolveH === null ? null : resolveH * H,
    work: null,
  },
  rounds: null,
  fails: null,
  lifeMs: resolveH === null ? null : resolveH * H,
  ...o,
});

test('stageStat: n, excluded, median and p90 by nearest rank', () => {
  // 10 resolves of 1..10 h plus 2 rows with no resolve: n 10, excluded 2, median the 5th (5 h), p90 the 9th (9 h).
  const rows = [...Array.from({ length: 10 }, (_, i) => row(`T-${i + 1}`, 1, i + 1)), row('T-90', 1, null), row('T-91', 1, null)];
  const s = stageStat(rows, 'resolve');
  assert.deepEqual(s, { stage: 'resolve', n: 10, excluded: 2, medianMs: 5 * H, p90Ms: 9 * H });
  const none = stageStat([row('T-1', 1, null)], 'test');
  assert.deepEqual(none, { stage: 'test', n: 0, excluded: 1, medianMs: null, p90Ms: null });
});

test('flowWindow: won’t-do is counted apart, rounds and rework are summed, the window is [from, to)', () => {
  const rows = [
    row('T-1', 1, 4, {
      rounds: 3,
      fails: 2,
      stages: { start: null, report: null, implement: null, test: 2 * H, deliver: null, resolve: 4 * H, work: null },
    }),
    row('T-2', 2, 6, {
      rounds: 1,
      fails: 0,
      stages: { start: null, report: null, implement: null, test: 0, deliver: null, resolve: 6 * H, work: null },
    }),
    row('T-3', 3, 8),
    row('T-4', 5, null, { status: 'wont_do', lifeMs: 7 * H }),
    row('T-5', 30, 2), // outside the 24 h window
  ];
  const w = flowWindow(rows, ago(24), NOW);
  assert.equal(w.done, 3);
  assert.equal(w.wontDo, 1);
  assert.equal(w.wontDoMedianMs, 7 * H);
  assert.deepEqual(w.rounds, { n: 2, medianRounds: 1, reworked: 1, fails: 2 });
  const resolve = w.stages.find((s) => s.stage === 'resolve')!;
  assert.deepEqual([resolve.n, resolve.excluded, resolve.medianMs], [3, 0, 6 * H]);
  const test2 = w.stages.find((s) => s.stage === 'test')!;
  assert.deepEqual([test2.n, test2.excluded], [2, 1], 'T-3 has no test stage: left out, counted in excluded');
  assert.equal(flowWindow(rows, ago(24), ago(1)).done, 2, 'a close at the window end is outside it');
});

const progs: MetricsProgram[] = resolvePrograms({ setting: DEFAULT_METRICS_PROGRAMS, programTags: [], flow: [] });

test('groupFlow: current and previous windows per group, sorted by most done', () => {
  const rows = [
    row('T-1', 1, 2, { tags: ['claudepilot'], lead: 'area-lab', priority: 'high' }),
    row('T-2', 2, 4, { tags: ['claudepilot'], lead: 'area-lab', priority: 'normal' }),
    row('T-3', 3, 6, { tags: ['konfersi'], lead: 'area-console', priority: 'normal' }),
    row('T-4', 30, 10, { tags: ['konfersi'], lead: 'area-console' }), // previous window
    row('T-5', 4, 1, { tags: [], lead: 'unrecorded' }),
  ];
  const byProgram = groupFlow(rows, NOW, 24 * H, 'program', progs);
  assert.equal(byProgram.total.current.done, 4);
  assert.equal(byProgram.total.previous.done, 1);
  assert.deepEqual(
    byProgram.groups.map((g) => [g.key, g.current.done, g.previous.done]),
    [
      ['claudepilot', 2, 0],
      ['konfersi', 1, 1],
      ['unrecorded', 1, 0],
    ],
  );
  const cp = byProgram.groups[0]!.current.stages.find((s) => s.stage === 'resolve')!;
  assert.deepEqual([cp.medianMs, cp.p90Ms], [2 * H, 4 * H]);
  assert.deepEqual(
    groupFlow(rows, NOW, 24 * H, 'lead', progs).groups.map((g) => g.key),
    ['area-lab', 'area-console', 'unrecorded'],
  );
  assert.deepEqual(
    groupFlow(rows, NOW, 24 * H, 'priority', progs).groups.map((g) => g.key),
    ['normal', 'high'],
  );
  assert.deepEqual(groupFlow(rows, NOW, 24 * H, null, progs).groups, []);
});

test('ticketRows: the drill-down keeps every row of the window, newest first, with its programs', () => {
  const rows = [row('T-1', 3, 2, { tags: ['konfersi'] }), row('T-2', 1, 2, { tags: ['claudepilot', 'konfersi'] }), row('T-3', 40, 2)];
  const out = ticketRows(rows, ago(24), NOW, progs);
  assert.deepEqual(
    out.map((r) => [r.ticket, r.programs]),
    [
      ['T-2', ['claudepilot', 'konfersi']],
      ['T-1', ['konfersi']],
    ],
  );
  assert.equal(out[0]!.stages.resolve, 2 * H);
});

/* ---------- Programs ---------- */

test('parseMetricsPrograms: the default parses clean; bad entries are named and the rest still parses', () => {
  const ok = parseMetricsPrograms(DEFAULT_METRICS_PROGRAMS);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(
    ok.programs.map((p) => [p.id, p.kind]),
    [
      ['all', 'all'],
      ['claudepilot', 'tickets'],
      ['konfersi', 'tickets'],
      ['memor-id', 'commits'],
    ],
  );
  assert.deepEqual(ok.programs[0]!.targets, { closuresPerHour: 4, resolveHours: 24, reviewHours: 2 });
  const bad = parseMetricsPrograms('x=X|a;x=Y|b;Bad Id|a;y=Y|;z=Z|a|1/2;all=All|a;w=W|UPPER;v|v-tag|1/2/3');
  assert.deepEqual(
    bad.programs.map((p) => p.id),
    ['x', 'v'],
  );
  assert.equal(bad.programs[1]!.label, 'v');
  assert.deepEqual(bad.programs[1]!.targets, { closuresPerHour: 1, resolveHours: 2, reviewHours: 3 });
  assert.equal(bad.errors.length, 6);
  assert.deepEqual(parseMetricsPrograms(42).errors, ['not text']);
});

test('resolvePrograms: at most MAX_TAG_PROGRAMS from program-* tags, the first of the ranked list, shown by id; setting and flow always', () => {
  const ranked = Array.from({ length: 15 }, (_, i) => `program-p${String(14 - i).padStart(2, '0')}`); // p14 ranks first
  const p = resolvePrograms({
    setting: DEFAULT_METRICS_PROGRAMS,
    programTags: ['program-konfersi', ...ranked],
    flow: [{ name: 'event', tag: 'event' }],
  });
  const tagged = p.filter((x) => x.source === 'program-tag').map((x) => x.id);
  assert.equal(MAX_TAG_PROGRAMS, 12);
  assert.deepEqual(
    tagged,
    ['p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11', 'p12', 'p13', 'p14'],
    'a covered tag does not use a place',
  );
  assert.deepEqual(
    p.filter((x) => x.source !== 'program-tag').map((x) => x.id),
    ['all', 'claudepilot', 'konfersi', 'memor-id', 'event'],
  );
});

test('resolvePrograms: all first, then the setting, then uncovered program-* tags, then uncovered flow tags', () => {
  const p = resolvePrograms({
    setting: DEFAULT_METRICS_PROGRAMS,
    programTags: ['program-konfersi', 'program-kohi'],
    flow: [
      { name: 'konfersi', tag: 'konfersi' },
      { name: 'event', tag: 'event' },
    ],
  });
  assert.deepEqual(
    p.map((x) => [x.id, x.source]),
    [
      ['all', 'setting'],
      ['claudepilot', 'setting'],
      ['konfersi', 'setting'],
      ['memor-id', 'setting'],
      ['kohi', 'program-tag'],
      ['event', 'flow'],
    ],
  );
  assert.equal(p.find((x) => x.id === 'memor-id')!.unavailable?.reason, 'no_source');
  assert.deepEqual(p.find((x) => x.id === 'kohi')!.targets, DEFAULT_TARGETS);
  // No setting at all: a builtin `all` with its own targets.
  const bare = resolvePrograms({ setting: undefined, programTags: [], flow: [] });
  assert.deepEqual(
    bare.map((x) => [x.id, x.source]),
    [['all', 'builtin']],
  );
  assert.deepEqual(bare[0]!.targets, DEFAULT_ALL_TARGETS);
  assert.ok(inProgram(['anything'], bare[0]!));
  assert.ok(
    !inProgram(
      ['claudepilot'],
      p.find((x) => x.id === 'memor-id')!,
    ),
  );
  assert.ok(
    inProgram(
      ['program-claudepilot'],
      p.find((x) => x.id === 'claudepilot')!,
    ),
  );
});

/* ---------- Scores ---------- */

test('combine: the weighted mean of the available parts; an unavailable part shares its weight and is named', () => {
  const s = combine(
    [
      { id: 'a', label: 'A', weight: 60, value: 50, basis: 'measured', source: 's', raw: 'r' },
      { id: 'b', label: 'B', weight: 20, value: 100, basis: 'measured', source: 's', raw: 'r' },
      { id: 'c', label: 'C', weight: 20, value: null, basis: 'unavailable', source: 's', reason: 'no_source', raw: 'r' },
    ],
    'Spec.',
    40,
  );
  assert.equal(s.value, 62.5); // (50*60 + 100*20) / 80
  assert.equal(s.previous, 40);
  assert.deepEqual(
    s.components.map((c) => c.appliedWeight),
    [75, 25, 0],
  );
  assert.match(s.basis, /Weights: a 60, b 20, c 20\. Left out, their weight shared by the rest: c \(no_source\)\./);
  const none = combine(
    [{ id: 'a', label: 'A', weight: 1, value: null, basis: 'unavailable', source: 's', reason: 'no_samples', raw: 'r' }],
    'S.',
    null,
  );
  assert.equal(none.value, null, 'nothing measured is unavailable, never 0');
});

test('the weights add up to 100 and the basis says the skill was not available', () => {
  assert.equal(
    Object.values(EFFICIENCY_WEIGHTS).reduce((a, b) => a + b, 0),
    100,
  );
  assert.equal(
    Object.values(EFFECTIVENESS_WEIGHTS).reduce((a, b) => a + b, 0),
    100,
  );
  const e = efficiencyScore({ nowMs: NOW, crews: null, exhausted: null, previous: null });
  assert.match(e.basis, /pilot-health skill was not available/);
  assert.equal(e.value, null);
  assert.ok(e.components.every((c) => c.basis === 'unavailable' && c.reason === 'no_source'));
});

test('efficiencyScore: utilisation, leads active, not exhausted, no long idle', () => {
  const s = efficiencyScore({
    nowMs: NOW,
    crews: [
      {
        lead: { id: 'L1', state: 'idle', claudeId: 'c1' },
        workers: [
          { id: 'w1', state: 'working', stateSinceMs: ago(1) },
          { id: 'w2', state: 'idle', stateSinceMs: NOW - LONG_IDLE_MS - MIN }, // long idle
          { id: 'w3', state: 'ended', stateSinceMs: ago(5) }, // not live: not counted
        ],
        openWork: true,
      },
      {
        lead: { id: 'L2', state: 'idle', claudeId: 'c2' },
        workers: [{ id: 'w4', state: 'idle', stateSinceMs: NOW - MIN }],
        openWork: true,
      },
    ],
    exhausted: new Set(['c2']),
    previous: 10,
  });
  const v = Object.fromEntries(s.components.map((c) => [c.id, c.value]));
  assert.deepEqual(v, { utilisation: 33.3, leadsActive: 50, notExhausted: 50, noLongIdle: 66.7 });
  // (33.3*40 + 50*25 + 50*20 + 66.7*15) / 100, from the rounded parts
  assert.equal(s.value, 45.8);
  assert.equal(s.previous, 10);
  assert.ok(s.components.every((c) => c.weight === c.appliedWeight && c.source.length > 0));
  // No quota reading: notExhausted is unavailable (no_source) and its 20 is shared by the other three.
  const nq = efficiencyScore({
    nowMs: NOW,
    crews: [{ lead: null, workers: [{ id: 'w', state: 'working', stateSinceMs: NOW }], openWork: false }],
    exhausted: null,
    previous: null,
  });
  const ne = nq.components.find((c) => c.id === 'notExhausted')!;
  assert.deepEqual([ne.value, ne.reason, ne.appliedWeight], [null, 'no_source', 0]);
  assert.equal(nq.components.find((c) => c.id === 'utilisation')!.appliedWeight, 50);
  assert.equal(nq.value, 100);
});

const openW = (o: Partial<MetricsOpenWork> = {}): MetricsOpenWork => ({
  open: 0,
  inProgress: 0,
  blocked: 0,
  inReview: 0,
  oldestReviewMs: null,
  stalled: 0,
  ...o,
});

test('effectivenessScore: each component against the program targets', () => {
  // 6 done in the last 6 h (1/h against 2/h: 50); 1 won't-do in 24 h; resolve median 12 h against 24 h: 100.
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row(`T-${i + 1}`, i + 0.5, 12)),
    row('T-7', 20, 12),
    row('T-8', 10, null, { status: 'wont_do' }),
  ];
  const s = effectivenessScore({
    nowMs: NOW,
    rows,
    open: openW({ open: 4, inProgress: 4, blocked: 1, inReview: 1, oldestReviewMs: 4 * H, stalled: 1 }),
    targets: DEFAULT_TARGETS,
    previous: null,
  });
  const v = Object.fromEntries(s.components.map((c) => [c.id, c.value]));
  assert.deepEqual(v, { closures: 50, reviewFlow: 50, notBlocked: 90, doneVsWontDo: 87.5, noStall: 75, flowTime: 100 });
  assert.deepEqual(
    s.components.map((c) => c.id),
    Object.keys(EFFECTIVENESS_WEIGHTS),
  );
  // (50*35 + 50*20 + 90*15 + 87.5*10 + 75*10 + 100*10) / 100
  assert.equal(s.value, 67.3);
  // Slow flow: a median twice the target scores 50.
  const slow = effectivenessScore({ nowMs: NOW, rows: [row('T-1', 1, 48)], open: openW(), targets: DEFAULT_TARGETS, previous: null });
  assert.equal(slow.components.find((c) => c.id === 'flowTime')!.value, 50);
  assert.equal(slow.components.find((c) => c.id === 'closures')!.value, 8.3);
});

test('effectivenessScore: missing inputs are unavailable with a reason, never 0', () => {
  const s = effectivenessScore({ nowMs: NOW, rows: [], open: null, targets: DEFAULT_TARGETS, previous: null });
  const by = Object.fromEntries(s.components.map((c) => [c.id, c]));
  assert.equal(by.closures!.value, 0, 'zero closures is a measured 0');
  assert.deepEqual([by.doneVsWontDo!.value, by.doneVsWontDo!.reason], [null, 'no_samples']);
  assert.deepEqual([by.flowTime!.value, by.flowTime!.reason], [null, 'no_samples']);
  for (const id of ['reviewFlow', 'notBlocked', 'noStall']) assert.equal(by[id]!.reason, 'no_source');
  assert.equal(s.value, 0);
  const unread = effectivenessScore({ nowMs: NOW, rows: null, open: null, targets: DEFAULT_TARGETS, previous: null });
  assert.equal(unread.value, null);
});

/* ---------- Open work, snapshots, downsampling ---------- */

test('openWork: counts, the oldest in review and the stalled', () => {
  const o = openWork(
    [
      { id: 'T-10', status: 'in_review', tags: [], updatedAtMs: ago(1), statusSinceMs: ago(3), assigneeSession: null },
      { id: 'T-11', status: 'in_review', tags: [], updatedAtMs: ago(1), statusSinceMs: ago(5), assigneeSession: null },
      { id: 'T-12', status: 'in_progress', tags: [], updatedAtMs: ago(7), statusSinceMs: ago(8), assigneeSession: 's1' },
      { id: 'T-13', status: 'in_progress', tags: [], updatedAtMs: ago(1), statusSinceMs: ago(8), assigneeSession: 's1' },
      { id: 'T-9', status: 'blocked', tags: [], updatedAtMs: ago(1), statusSinceMs: ago(1), assigneeSession: null },
      { id: 'T-100', status: 'blocked', tags: [], updatedAtMs: ago(1), statusSinceMs: ago(1), assigneeSession: null },
      { id: 'T-14', status: 'open', tags: [], updatedAtMs: ago(1), statusSinceMs: ago(1), assigneeSession: null },
    ],
    NOW,
    6 * H,
  );
  assert.deepEqual(
    { ...o },
    {
      open: 1,
      inProgress: 2,
      blocked: 2,
      inReview: 2,
      oldestReviewMs: 5 * H,
      stalled: 1,
      blockedIds: ['T-9', 'T-100'],
      oldestReview: 'T-11',
    },
  );
});

test('snapshotValues and downsample', () => {
  const day = flowWindow([row('T-1', 1, 3)], ago(24), NOW);
  const e = efficiencyScore({ nowMs: NOW, crews: null, exhausted: null, previous: null });
  const f = effectivenessScore({
    nowMs: NOW,
    rows: [row('T-1', 1, 3)],
    open: openW({ open: 2, blocked: 1 }),
    targets: DEFAULT_TARGETS,
    previous: null,
  });
  const v = snapshotValues({ efficiency: e, effectiveness: f, day, open: openW({ open: 2, blocked: 1 }) });
  assert.equal(v.efficiency, null);
  assert.equal(v.effectiveness, f.value);
  assert.deepEqual([v.done24h, v.wontDo24h, v.openWork, v.blocked, v.inReview, v.resolveP50, v.testP50], [1, 0, 3, 1, 0, 3 * H, null]);
  assert.equal(snapshotValues({ efficiency: e, effectiveness: f, day, open: null }).openWork, null);
  const pts = Array.from({ length: 100 }, (_, i) => ({ atMs: ago(100 - i), v: i }));
  const d = downsample(pts, ago(100), NOW, 10);
  assert.equal(d.length, 10);
  assert.equal(d[d.length - 1]!.v, 99, 'the last point of the window is kept');
  assert.equal(downsample(pts.slice(0, 5), ago(100), NOW, 10).length, 5);
});

test('fmtDur', () => {
  assert.equal(fmtDur(90 * MIN), '90 min');
  assert.equal(fmtDur(5 * H), '5 h');
  assert.equal(fmtDur(72 * H), '3 d');
});

/* ---------- Findings ---------- */

test('insights: slowest stage, regression, idle capacity, blocked share, review wait and outliers, act first', () => {
  const st = (implement: number, resolve: number) => ({
    start: H,
    report: null,
    implement,
    test: null,
    deliver: null,
    resolve,
    work: null,
  });
  // Current window: 6 done, implement 2 h each, one resolve far slower. Previous window: 3 done, implement 0.5 h.
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row(`T-${i + 1}`, i + 1, 4, { stages: st(2 * H, 4 * H) })),
    row('T-6', 6, 40, { stages: st(2 * H, 40 * H) }),
    ...Array.from({ length: 3 }, (_, i) => row(`T-${i + 20}`, 30 + i, 4, { stages: st(0.5 * H, 4 * H) })),
  ];
  const flow = groupFlow(rows, NOW, 24 * H, null, progs).total;
  const eff = efficiencyScore({
    nowMs: NOW,
    crews: [
      {
        lead: null,
        workers: [
          { id: 'w1', state: 'idle', stateSinceMs: NOW - MIN },
          { id: 'w2', state: 'idle', stateSinceMs: NOW - MIN },
          { id: 'w3', state: 'working', stateSinceMs: NOW },
          { id: 'w4', state: 'idle', stateSinceMs: NOW - MIN },
          { id: 'w5', state: 'idle', stateSinceMs: NOW - MIN },
        ],
        openWork: true,
      },
    ],
    exhausted: new Set(),
    previous: null,
  });
  const out = insights({
    label: 'All',
    windowLabel: '24h',
    flow,
    rows,
    efficiency: eff,
    open: {
      ...openW({ open: 2, inProgress: 1, blocked: 2, inReview: 1, oldestReviewMs: 10 * H }),
      blockedIds: ['T-30', 'T-31'],
      oldestReview: 'T-32',
    },
    targets: DEFAULT_TARGETS,
  });
  assert.deepEqual(
    out.map((x) => [x.kind, x.severity]),
    [
      ['regression', 'act'], // implement 0.5 h -> 2 h: +300 %
      ['idle_capacity', 'act'], // 1 of 5 working: 20
      ['review_wait', 'act'], // 10 h against 2 h: over 4x
      ['blocked_share', 'warn'], // 2 of 6: 33 %
      ['slowest_stage', 'info'],
      ['outlier', 'info'],
    ],
  );
  assert.match(out[0]!.text, /implement median went from 30 min to 2 h \(\+300 %\)/);
  assert.deepEqual(out.find((x) => x.kind === 'review_wait')!.tickets, ['T-32']);
  assert.deepEqual(out.find((x) => x.kind === 'blocked_share')!.tickets, ['T-30', 'T-31']);
  assert.deepEqual(out.find((x) => x.kind === 'outlier')!.tickets, ['T-6']);
  assert.match(out.find((x) => x.kind === 'slowest_stage')!.text, /Slowest stage: implement, median 2 h \(p90 2 h\) over 6 tickets\./);
});

test('insights: an empty window says there is no data and invents nothing', () => {
  const flow = groupFlow([], NOW, 24 * H, null, progs).total;
  const out = insights({
    label: 'Konfersi',
    windowLabel: '24h',
    flow,
    rows: [],
    efficiency: efficiencyScore({ nowMs: NOW, crews: null, exhausted: null, previous: null }),
    open: null,
    targets: DEFAULT_TARGETS,
  });
  assert.deepEqual(
    out.map((x) => x.kind),
    ['no_data'],
  );
});
