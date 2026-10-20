import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrewFigure, CrewProgramScore, CrewTarget, CrewWindowScore } from '@portal/contracts';
import { barOf, d65Rows, detailSections, fmtAge, fmtFigure, fmtPerHour, qaOpusLine, REVIEW_WARN_MS, tiles, UNAVAILABLE } from './scorecardModel';

const fig = (value: number | null, basis: CrewFigure['basis'] = 'measured', reason?: CrewFigure['reason']): CrewFigure => ({ value, basis, source: 'a source', reason });
const gone = (reason: CrewFigure['reason'] = 'no_samples'): CrewFigure => fig(null, 'unavailable', reason);

function windowScore(o: { done?: CrewFigure; cost?: CrewFigure; share?: CrewFigure; backlog?: CrewFigure; ages?: number[] } = {}): CrewWindowScore {
  return {
    fromMs: 0,
    toMs: 1,
    effectiveness: {
      done: fig(2),
      donePerHour: o.done ?? fig(0.5),
      reopened: fig(0),
      wontDo: fig(0),
      byType: [],
      reviewBacklog: o.backlog ?? fig((o.ages ?? []).length),
      review: (o.ages ?? []).map((ageMs, i) => ({ ticket: `T-${i}`, type: 'task', ageMs, waitsFor: null, waitsBasis: null })),
      ciRuns: fig(0),
      ci: [],
      deploysCount: fig(0),
      deploys: [],
    },
    cost: { total: fig(10, 'estimate'), lead: fig(4, 'estimate'), workers: fig(6, 'estimate'), leadShare: o.share ?? fig(40, 'estimate'), perDoneAllIn: o.cost ?? fig(5, 'estimate'), perDoneWorkers: fig(3, 'estimate') },
    efficiency: {} as CrewWindowScore['efficiency'],
    health: {} as CrewWindowScore['health'],
  };
}

const target = (state: CrewTarget['state'], id: CrewTarget['id'] = 'live_workers'): CrewTarget => ({ id, decision: 'D-61', rule: 'r', state, figure: fig(0), offenders: [] });
const program = (o: Partial<CrewProgramScore> = {}): CrewProgramScore => ({ program: 'p', title: 'P', workspaceId: null, leads: ['p'], workers: 2, current: windowScore(), previous: null, targets: [target('ok')], ...o });
const by = (p: CrewProgramScore, key: string) => tiles(p).find((t) => t.key === key)!;

test('five numbers, in the order of the card', () => {
  assert.deepEqual(tiles(program()).map((t) => t.key), ['donePerHour', 'costPerDone', 'leadShare', 'reviewBacklog', 'breaches']);
});

test('measured and estimate figures are labelled MEASURED and ESTIMATE, with the source in the tip', () => {
  const p = program();
  assert.equal(by(p, 'donePerHour').basis, 'MEASURED');
  assert.equal(by(p, 'costPerDone').basis, 'ESTIMATE');
  assert.equal(by(p, 'leadShare').basis, 'ESTIMATE');
  assert.match(by(p, 'costPerDone').tip, /ESTIMATE\. Source: a source/);
  assert.equal(by(p, 'leadShare').value, '40 %');
  assert.equal(by(p, 'costPerDone').value, '$5');
});

test('unavailable is a state with its reason, never 0 or a guess', () => {
  const p = program({ current: windowScore({ cost: gone('no_samples'), done: gone('no_source') }) });
  const cost = by(p, 'costPerDone');
  assert.equal(cost.value, UNAVAILABLE);
  assert.equal(cost.state, 'unavailable');
  assert.equal(cost.basis, 'UNAVAILABLE');
  assert.match(cost.tip, /Unavailable: nothing to divide by/);
  assert.match(by(p, 'donePerHour').tip, /no table/);
  assert.equal(fmtFigure(fig(null), String), UNAVAILABLE);
  assert.equal(fmtFigure(fig(0), String), '0');
});

test('T-549 (D-65): six rows in a fixed order, each with its state, offenders and rule; a row the server did not send is unavailable', () => {
  const t = (id: CrewTarget['id'], state: CrewTarget['state'], value: number | null, offenders: string[] = []): CrewTarget => ({
    id,
    decision: 'D-65',
    rule: `rule of ${id}`,
    state,
    figure: value === null ? gone('no_source') : fig(value),
    offenders,
  });
  const p = program({ targets: [t('wasted_tool_calls', 'breach', 4.25, ['S1', 'S2']), t('cost_per_done', 'warn', 6.5, ['T-1']), t('quota_unused', 'unavailable', null)] });
  const rows = d65Rows(p);
  assert.deepEqual(rows.map((r) => r.id), ['cost_per_done', 'lead_share', 'qa_opus_share', 'done_rate', 'quota_unused', 'wasted_tool_calls']);
  const row = (id: string) => rows.find((r) => r.id === id)!;
  assert.deepEqual([row('cost_per_done').value, row('cost_per_done').state, row('cost_per_done').offenders], ['$6.5', 'warn', ['T-1']]);
  assert.deepEqual([row('wasted_tool_calls').value, row('wasted_tool_calls').state, row('wasted_tool_calls').offenders], ['4.3 %', 'breach', ['S1', 'S2']]);
  assert.match(row('wasted_tool_calls').tip, /rule of wasted_tool_calls/);
  assert.deepEqual([row('quota_unused').value, row('quota_unused').state, row('quota_unused').basis], [UNAVAILABLE, 'unavailable', 'UNAVAILABLE']);
  assert.match(row('quota_unused').tip, /Unavailable: the portal has no table/);
  assert.deepEqual([row('lead_share').value, row('lead_share').state], [UNAVAILABLE, 'unavailable']); // not sent: never 0
  assert.ok(rows.every((r) => r.label.split(' ').filter((w) => w !== '/').length <= 2), 'titles of one or two words');
});

test('breaches: the count of breached targets, the state is the worst', () => {
  const b = (ts: CrewTarget[]) => by(program({ targets: ts }), 'breaches');
  assert.deepEqual([b([target('ok')]).state, b([target('ok')]).value], ['ok', '0']);
  const warned = b([target('ok'), target('warn'), target('warn', 'owner_queue')]);
  assert.deepEqual([warned.state, warned.value], ['warn', '2 warn']);
  assert.equal(b([target('breach'), target('warn', 'owner_queue')]).value, '1');
  const bad = b([target('breach'), target('breach', 'owner_queue'), target('ok', 'lead_subagents')]);
  assert.deepEqual([bad.state, bad.value], ['breach', '2']);
  const none = b([target('unavailable'), target('unavailable', 'owner_queue')]);
  assert.deepEqual([none.state, none.value, none.basis], ['unavailable', UNAVAILABLE, 'UNAVAILABLE']);
  assert.equal(b([]).state, 'unavailable');
});

test('review backlog warns when one has waited more than a day', () => {
  assert.equal(by(program({ current: windowScore({ ages: [3_600_000] }) }), 'reviewBacklog').state, 'ok');
  const old = by(program({ current: windowScore({ ages: [3_600_000, REVIEW_WARN_MS + 1] }) }), 'reviewBacklog');
  assert.deepEqual([old.state, old.value], ['warn', '2']);
});

test('compare: "was" shows the previous window, and nothing when it is unavailable or not asked', () => {
  const p = program({ previous: windowScore({ done: fig(1.25), cost: gone() }) });
  assert.equal(by(p, 'donePerHour').was, '1.25');
  assert.equal(by(p, 'costPerDone').was, null);
  assert.equal(by(program(), 'donePerHour').was, null);
});

test('T-490 (D-63): the opus share of QA and review workers as one line; none in the window is unavailable, never 0 %', () => {
  const withQa = (q: CrewWindowScore['efficiency']['qaReviewOpus']) => {
    const w = windowScore();
    return program({ current: { ...w, efficiency: { ...w.efficiency, qaReviewOpus: q } } });
  };
  assert.equal(qaOpusLine(withQa({ sessions: 4, opus: 1, opusWithWhy: 1, share: fig(25) })), 'QA/review on opus: 25 % (1 of 4, 1 with a why)');
  assert.equal(qaOpusLine(withQa({ sessions: 3, opus: 0, opusWithWhy: 0, share: fig(0) })), 'QA/review on opus: 0 % (0 of 3)');
  assert.equal(qaOpusLine(withQa({ sessions: 0, opus: 0, opusWithWhy: 0, share: gone('no_samples') })), `QA/review on opus: ${UNAVAILABLE} (nothing to divide by in this window)`);
});

test('number formats', () => {
  assert.equal(fmtPerHour(0.5), '0.50');
  assert.equal(fmtPerHour(12.34), '12.3');
  assert.equal(fmtAge(30 * 60_000), '30 min');
  assert.equal(fmtAge(5 * 3_600_000), '5 h');
  assert.equal(fmtAge(72 * 3_600_000), '3 d');
});

test('T-1852: Details as compact rows: titles of one or two words, numbers on the right, a bar where there is something to scale by', () => {
  const cur = windowScore({ ages: [REVIEW_WARN_MS + 1] });
  cur.effectiveness.byType = [
    { type: 'feature', done: 4, perHour: 0.5, noStart: 1, costAllInUsd: 12, costWorkersUsd: 8, perTicketAllInUsd: 3, perTicketWorkersUsd: 2 } as (typeof cur.effectiveness.byType)[number],
    { type: 'bug', done: 2, perHour: 0.25, noStart: 0, costAllInUsd: 4, costWorkersUsd: 2, perTicketAllInUsd: 2, perTicketWorkersUsd: 1 } as (typeof cur.effectiveness.byType)[number],
  ];
  cur.effectiveness.ci = [{ pipeline: 'gate', passed: 3, failed: 1, cancelled: 0 }];
  cur.effectiveness.deploys = [{ runNumber: 7, pipeline: 'deploy', environment: 'prod', approval: 'auto', outcome: 'success', at: '' }];
  const p = program({ current: cur, targets: [target('breach'), { ...target('ok', 'cost_per_done'), decision: 'D-65' }] });
  const sec = detailSections(p);
  assert.deepEqual(sec.map((x) => x.title), ['Done', 'In review', 'CI', 'Deploys', 'Targets', 'Cost']);
  assert.ok(sec.every((x) => x.title.split(' ').length <= 2));
  const [feature, bug] = sec[0]!.rows;
  assert.deepEqual([feature!.label, feature!.value, feature!.sub, feature!.bar], ['feature', '4', '0.50 / h · $3 each · 1 no start', 1]);
  assert.equal(bug!.bar, 0.5);
  assert.deepEqual([sec[1]!.rows[0]!.value, sec[1]!.rows[0]!.state], ['24 h', 'warn']);
  assert.deepEqual([sec[2]!.rows[0]!.value, sec[2]!.rows[0]!.sub, sec[2]!.rows[0]!.state, sec[2]!.rows[0]!.bar], ['3 / 4', '1 failed', 'warn', 0.75]);
  assert.deepEqual([sec[3]!.rows[0]!.label, sec[3]!.rows[0]!.value, sec[3]!.rows[0]!.sub], ['#7 deploy', 'success', '→ prod · auto']);
  assert.deepEqual(sec[4]!.rows.map((r) => [r.label, r.value, r.state]), [['D-61 live workers', 'breach', 'breach']], 'D-65 targets have their own rows');
  assert.deepEqual(sec[5]!.rows.map((r) => [r.label, r.value, r.bar]), [['Total', '$10', null], ['Lead', '$4', 0.4], ['Workers', '$6', 0.6]]);
});

test('T-1852: an unavailable cost has no bar and reads the word; bars never divide by zero', () => {
  const cur = windowScore();
  cur.cost.total = gone('no_source');
  cur.cost.lead = gone('no_source');
  const cost = detailSections(program({ current: cur })).at(-1)!.rows;
  assert.deepEqual(cost.map((r) => [r.value, r.bar]), [[UNAVAILABLE, null], [UNAVAILABLE, null], ['$6', null]]);
  assert.equal(barOf(1, 0), null);
  assert.equal(barOf(5, 4), 1);
});

test('T-1852: the QA opus counts ride in the D-65 QA opus tip, not on a line of their own', () => {
  const p = program({ targets: [{ id: 'qa_opus_share', decision: 'D-65', rule: 'r', state: 'ok', figure: fig(0), offenders: [] }] });
  assert.match(d65Rows(p).find((r) => r.id === 'qa_opus_share')!.tip, /QA\/review on opus: unavailable/);
  assert.doesNotMatch(d65Rows(p).find((r) => r.id === 'cost_per_done')!.tip, /QA\/review/);
});
