import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableOrder } from './stable.js';

const key = (r: { id: string }) => r.id;
const row = (id: string, pct = 0) => ({ id, pct });

test('rows keep the places they had, whatever the sort now says', () => {
  // Sorted by percent the new answer is c (90), a (60), b (10); the screen showed a, b, c.
  const next = [row('c', 90), row('a', 60), row('b', 10)];
  assert.deepEqual(stableOrder(next, key, ['a', 'b', 'c']).map(key), ['a', 'b', 'c']);
});

test('a new row goes after the rows already shown, in the order it came', () => {
  const next = [row('d', 95), row('a'), row('e', 80), row('b')];
  assert.deepEqual(stableOrder(next, key, ['a', 'b', 'c']).map(key), ['a', 'b', 'd', 'e']);
});

test('a row that went is simply gone; nothing before the first load, so the sort stands', () => {
  assert.deepEqual(stableOrder([row('b'), row('a')], key, ['a', 'x', 'b']).map(key), ['a', 'b']);
  assert.deepEqual(stableOrder([row('b'), row('a')], key, []).map(key), ['b', 'a']);
  assert.deepEqual(stableOrder([], key, ['a']), []);
});
