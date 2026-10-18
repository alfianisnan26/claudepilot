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

test('QA pass 2: a big swing of one card does not flip the layout back and forth; a packing still good is kept', () => {
  const base = [200, 570, 1100, 480, 300, 260, 420, 380, 240, 500];
  let cur = packColumns(base, 3);
  let moved = 0;
  for (const sessions of [570, 180, 570, 180, 570, 300, 570]) {
    const h = base.slice();
    h[1] = sessions;
    const next = packColumns(h, 3, 16, cur);
    const was = new Map(cur.flatMap((c, ci) => c.map((i) => [i, ci] as const)));
    moved += next.flatMap((c, ci) => c.filter((i) => was.get(i) !== ci)).length;
    // Never far from the best for these heights.
    const best = packColumns(h, 3);
    const tallest = (cols: number[][]) => Math.max(...cols.map((c) => c.reduce((a, i) => a + h[i]! + 16, 0)));
    assert.ok(tallest(next) <= tallest(best) + 120, `within 120 px of the best`);
    cur = next;
  }
  assert.ok(moved <= 10, `cards moved over 7 swings: ${moved}`); // the bare optimum moves 24 here
});

test('a previous packing that is still good comes back unchanged', () => {
  const h = [200, 570, 1400, 480];
  const cur = packColumns(h, 2);
  assert.deepEqual(packColumns(h.map((x) => x + 3), 2, 16, cur), cur);
});
