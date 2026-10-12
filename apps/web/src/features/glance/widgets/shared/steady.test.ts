import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameIds, steady, type SteadyRow } from './steady.js';

interface R {
  id: string;
  v: number;
}
const key = (r: R) => r.id;
const row = (id: string, v = 0): R => ({ id, v });
const drawn = (...ids: string[]): SteadyRow<R>[] => ids.map((id) => ({ row: row(id), gone: false }));
const ids = (rows: SteadyRow<R>[]) => rows.map((r) => `${r.row.id}${r.gone ? '*' : ''}`);

test('not engaged: the list as it is now, in the order it has', () => {
  assert.deepEqual(ids(steady(drawn('a', 'b', 'c'), [row('c'), row('a'), row('d')], key, false)), ['c', 'a', 'd']);
  assert.deepEqual(steady([], [], key, false), []);
});

test('engaged: rows keep their places, a row that left stays where it was as gone, a new row goes to the end', () => {
  // the person is over b; the server now says c, new d, b, a
  const out = steady(drawn('a', 'b', 'c'), [row('c'), row('d'), row('b')], key, true);
  assert.deepEqual(ids(out), ['a*', 'b', 'c', 'd']);
});

test('engaged: a row still in the list is updated in place, with its new data', () => {
  const out = steady(drawn('a', 'b'), [row('b', 7), row('a', 5)], key, true);
  assert.deepEqual(out.map((r) => [r.row.id, r.row.v, r.gone]), [['a', 5, false], ['b', 7, false]]);
});

test('engaged: a gone row that comes back takes its place again', () => {
  const first = steady(drawn('a', 'b', 'c'), [row('a'), row('c')], key, true);
  assert.deepEqual(ids(first), ['a', 'b*', 'c']);
  assert.deepEqual(ids(steady(first, [row('c'), row('b'), row('a')], key, true)), ['a', 'b', 'c']);
});

test('engaged with defer (a tree): new rows wait until the person lets go; with nothing drawn yet they show', () => {
  assert.deepEqual(ids(steady(drawn('a', 'b'), [row('a'), row('x'), row('b')], key, true, true)), ['a', 'b']);
  assert.deepEqual(ids(steady([], [row('x')], key, true, true)), ['x']);
  // and as soon as they let go the list is the list
  assert.deepEqual(ids(steady(drawn('a', 'b'), [row('a'), row('x'), row('b')], key, false, true)), ['a', 'x', 'b']);
});

test('letting go drops the gone rows and takes the fresh order', () => {
  const held = steady(drawn('a', 'b', 'c'), [row('c'), row('d')], key, true);
  assert.deepEqual(ids(held), ['a*', 'b*', 'c', 'd']);
  assert.deepEqual(ids(steady(held, [row('c'), row('d')], key, false)), ['c', 'd']);
});

test('the neighbours of a change do not move: a row removed above the pointer leaves a gone row of its own height, nothing below shifts', () => {
  // five rows; the pointer is on d; a, b and c are answered elsewhere and e is added
  const out = steady(drawn('a', 'b', 'c', 'd'), [row('d'), row('e')], key, true);
  assert.deepEqual(ids(out), ['a*', 'b*', 'c*', 'd', 'e']);
  assert.equal(out.findIndex((r) => r.row.id === 'd'), 3, 'd is still the fourth row');
});

test('same ids in the same order', () => {
  assert.equal(sameIds(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameIds(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameIds(['a'], ['a', 'b']), false);
  assert.equal(sameIds([], []), true);
});
