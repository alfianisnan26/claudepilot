import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packColumns, spread } from './masonry.js';

test('the owner\'s screenshot: a short Needs you beside a tall Sessions no longer leaves a hole', () => {
  // Needs you 200, Sessions 570, Quota 1400, Workspaces 480: a row grid put Quota under Needs you with a 370 px hole. Now the tall Quota
  // gets a column of its own and the three others stack beside it.
  assert.deepEqual(packColumns([200, 570, 1400, 480], 2), [[0, 1, 3], [2]]);
  const five = [200, 570, 300, 480, 250];
  assert.ok(spread(five, packColumns(five, 2)) <= 120);
});

test('one column keeps the order; unknown heights fall back to round robin; ties go left', () => {
  assert.deepEqual(packColumns([1, 2, 3], 1), [[0, 1, 2]]);
  assert.deepEqual(packColumns([0, 10, 10, 10], 2), [[0, 2], [1, 3]]);
  assert.deepEqual(packColumns([100, 100, 100], 3), [[0], [1], [2]]);
});

test('QA 2026-10-18: three columns end close together where "shortest so far" left them 350 px apart', () => {
  // Ten cards: greedy leaves a ragged end; the best order-keeping assignment closes it.
  const h = [200, 900, 1100, 300, 260, 420, 380, 240, 300, 500];
  const cols = packColumns(h, 3);
  assert.equal(cols.flat().length, 10);
  for (const c of cols) assert.deepEqual(c, [...c].sort((a, b) => a - b), 'each column keeps the order');
  assert.ok(spread(h, cols) <= 120, `spread ${spread(h, cols)}`);
});

test('the result depends on the heights only (the same input packs the same way)', () => {
  const h = [200, 570, 1400, 480, 300, 260];
  assert.deepEqual(packColumns(h, 3), packColumns([...h], 3));
});
