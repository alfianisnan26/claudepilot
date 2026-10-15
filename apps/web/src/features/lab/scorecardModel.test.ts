import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrewFigure, CrewProgramScore, CrewTarget, CrewWindowScore } from '@portal/contracts';
import { fmtAge, fmtFigure, fmtPerHour, REVIEW_WARN_MS, tiles, UNAVAILABLE } from './scorecardModel';

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
const program = (o: Partial<CrewProgramScore> = {}): CrewProgramScore => ({ program: 'p', title: 'P', leads: ['p'], workers: 2, current: windowScore(), previous: null, targets: [target('ok')], ...o });
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
  assert.equal(by(p, 'costPerDone').value, '$5.00');
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

test('breaches: the count of breached targets, the state is the worst', () => {
  const b = (ts: CrewTarget[]) => by(program({ targets: ts }), 'breaches');
  assert.deepEqual([b([target('ok')]).state, b([target('ok')]).value], ['ok', '0']);
  assert.equal(b([target('ok'), target('warn')]).state, 'warn');
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

test('number formats', () => {
  assert.equal(fmtPerHour(0.5), '0.50');
  assert.equal(fmtPerHour(12.34), '12.3');
  assert.equal(fmtAge(30 * 60_000), '30 min');
  assert.equal(fmtAge(5 * 3_600_000), '5 h');
  assert.equal(fmtAge(72 * 3_600_000), '3 d');
});
