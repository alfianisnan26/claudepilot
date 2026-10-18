import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packColumns, spread } from './masonry.js';

test('the owner\'s screenshot: a short Needs you beside a tall Sessions no longer leaves a hole', () => {
  // Needs you 200, Sessions 570, Quota 1400, Workspaces 480: a row grid puts Quota under Needs you with a 370 px hole.
  const h = [200, 570, 1400, 480];
  const cols = packColumns(h, 2);
  assert.deepEqual(cols, [[0, 2], [1, 3]]);
  // Five cards: the fifth goes under the shorter stack, not row by row.
  assert.deepEqual(packColumns([200, 570, 300, 480, 250], 2), [[0, 2, 3], [1, 4]]);
  assert.ok(spread([200, 570, 300, 480, 250], packColumns([200, 570, 300, 480, 250], 2)) <= 250);
});

test('one column keeps the order; unknown heights fall back to round robin; ties go left', () => {
  assert.deepEqual(packColumns([1, 2, 3], 1), [[0, 1, 2]]);
  assert.deepEqual(packColumns([0, 10, 10, 10], 2), [[0, 2], [1, 3]]);
  assert.deepEqual(packColumns([100, 100, 100], 3), [[0], [1], [2]]);
});
