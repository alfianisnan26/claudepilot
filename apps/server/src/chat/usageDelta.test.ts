import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelTotals } from './protocol.js';
import { capToTurnCost, COUNTED_USAGE, mergeBase, modelDelta, SUSPECT_USAGE_KIND } from './usageDelta.js';

const m = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number): ModelTotals => ({ model, input, output, cacheRead, cacheWrite, costUsd });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('T-610: a plain turn is the change in each dimension', () => {
  const d = modelDelta(m('x', 150, 30, 1000, 200, 1.25), m('x', 100, 10, 900, 100, 1));
  assert.deepEqual([d.input, d.output, d.cacheRead, d.cacheWrite], [50, 20, 100, 100]);
  near(d.costUsd, 0.25);
});

test('T-610: a restart or compaction that drops the token totals but keeps a carried cost records no jump', () => {
  // Before: $96 running cost. After the new process: tokens count from zero again, the cost total is restored (96.2).
  const d = modelDelta(m('x', 40, 5, 300, 60, 96.2), m('x', 900_000, 90_000, 9_000_000, 800_000, 96));
  assert.deepEqual([d.input, d.output, d.cacheRead, d.cacheWrite], [40, 5, 300, 60], 'tokens that started again are the turn’s');
  near(d.costUsd, 0.2); // not 96.2: the old code took the whole of `cur` once any dimension was lower
});

test('T-610: a cost total that started again is the turn’s own, a total that stayed is the change', () => {
  near(modelDelta(m('x', 10, 1, 0, 0, 0.03), m('x', 100, 10, 0, 0, 0.62)).costUsd, 0.03);
  near(modelDelta(m('x', 10, 1, 0, 0, 0.62), m('x', 10, 1, 0, 0, 0.62)).costUsd, 0);
});

test('T-610: a model not seen before counts whole (a process that counts from zero), the base remembers a model missing from a result', () => {
  assert.equal(modelDelta(m('new', 5, 1, 0, 0, 0.1), undefined).costUsd, 0.1);
  const base = mergeBase(new Map([['a', m('a', 100, 10, 0, 0, 40)]]), [m('b', 1, 1, 0, 0, 0.1)]);
  // `a` is missing from the next result's models and comes back with its running total: the change since the last time it was seen.
  const next = mergeBase(base, [m('b', 2, 2, 0, 0, 0.2)]);
  assert.equal(next.get('a')!.costUsd, 40, 'a model missing from one result is still known');
  near(modelDelta(m('a', 110, 12, 0, 0, 40.5), next.get('a')).costUsd, 0.5);
});

test('T-610: the models’ costs never add up to more than the turn’s own cost', () => {
  const same = [m('x', 1, 1, 0, 0, 0.3)];
  assert.equal(capToTurnCost(same, 0.25), same, 'within the margin: untouched');
  assert.equal(capToTurnCost(same, undefined), same, 'no known turn cost: untouched');
  const capped = capToTurnCost([m('x', 1, 1, 0, 0, 90), m('y', 1, 1, 0, 0, 6)], 0.4);
  near(
    capped.reduce((t, r) => t + r.costUsd, 0),
    0.4,
  );
  near(capped[0]!.costUsd / capped[1]!.costUsd, 15);
});

test('T-610: a suspect row is the kind readers leave out', () => {
  assert.equal(SUSPECT_USAGE_KIND, 'suspect');
  assert.equal(COUNTED_USAGE, `kind <> 'suspect'`);
});
