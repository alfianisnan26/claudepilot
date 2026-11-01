// The windowed full-page list's math (lib/windowed.ts; owner, 2026-11-01: "no unbounded page growth").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnsFor, fillHeight, lineAt, linesOf, moveTo, offsetsOf, rangeOf, wantsMore } from './windowed';

test('offsets: measured lines count as measured, the rest as the estimate', () => {
  assert.deepEqual(offsetsOf([10, undefined, 30], 20), [0, 10, 30, 60]);
  assert.deepEqual(offsetsOf([], 20), [0]);
});

test('lineAt: the line under a y', () => {
  const o = offsetsOf([10, 20, 30], 0); // 0 10 30 60
  assert.equal(lineAt(o, 0), 0);
  assert.equal(lineAt(o, 9.9), 0);
  assert.equal(lineAt(o, 10), 1);
  assert.equal(lineAt(o, 59), 2);
  assert.equal(lineAt(o, 500), 2, 'past the end: the last line');
});

test('range: only what is in view plus the overscan, 200 lines never all drawn', () => {
  const o = offsetsOf(new Array(200).fill(undefined), 50); // 10 000 px
  assert.deepEqual(rangeOf(o, 0, 800, 0), { start: 0, end: 16 });
  assert.deepEqual(rangeOf(o, 0, 800, 5), { start: 0, end: 21 });
  assert.deepEqual(rangeOf(o, 5000, 800, 2), { start: 98, end: 118 });
  assert.deepEqual(rangeOf(o, 9800, 800, 2), { start: 194, end: 200 }, 'clamped at the end');
  assert.deepEqual(rangeOf(o, -300, 800, 0), { start: 0, end: 10 }, 'the list starts below the top of the view');
  assert.deepEqual(rangeOf([0], 0, 800), { start: 0, end: 0 }, 'empty');
});

test('lines: items grouped by columns; columns from the width', () => {
  assert.deepEqual(linesOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(linesOf([1, 2], 0), [[1], [2]], 'never fewer than one column');
  assert.equal(columnsFor(390, 448, 8), 1);
  assert.equal(columnsFor(1000, 448, 8), 2);
  assert.equal(columnsFor(1400, 448, 8), 3);
  assert.equal(columnsFor(1400, undefined, 8), 1);
});

test('load more: near the end, only when there is more and nothing loads', () => {
  assert.equal(wantsMore({ end: 96, lines: 100, hasMore: true, loading: false }), true);
  assert.equal(wantsMore({ end: 50, lines: 100, hasMore: true, loading: false }), false);
  assert.equal(wantsMore({ end: 100, lines: 100, hasMore: false, loading: false }), false);
  assert.equal(wantsMore({ end: 100, lines: 100, hasMore: true, loading: true }), false);
});

test('keys: arrows, Home, End and pages, clamped', () => {
  assert.equal(moveTo('ArrowDown', 0, 10, 5), 1);
  assert.equal(moveTo('ArrowDown', 9, 10, 5), 9);
  assert.equal(moveTo('ArrowUp', 0, 10, 5), 0);
  assert.equal(moveTo('Home', 7, 10, 5), 0);
  assert.equal(moveTo('End', 2, 10, 5), 9);
  assert.equal(moveTo('PageDown', 2, 10, 5), 7);
  assert.equal(moveTo('PageUp', 2, 10, 5), 0);
  assert.equal(moveTo('Enter', 2, 10, 5), null);
  assert.equal(moveTo('ArrowDown', 0, 0, 5), null);
});

test('fill: what is left of the pane under the list, never under the minimum', () => {
  assert.equal(fillHeight({ paneHeight: 900, topInPane: 200, below: 16, min: 240 }), 684);
  assert.equal(fillHeight({ paneHeight: 500, topInPane: 400, below: 16, min: 240 }), 240);
});
