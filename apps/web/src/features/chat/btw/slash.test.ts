import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSlash, slashMatches } from './slash';

test('slash suggestions appear for "/" and a partial command word only', () => {
  assert.deepEqual(slashMatches('/').map((c) => c.name), ['btw']);
  assert.deepEqual(slashMatches('/bt').map((c) => c.name), ['btw']);
  assert.deepEqual(slashMatches('/x'), []);
  assert.deepEqual(slashMatches('/btw hi'), []);
  assert.deepEqual(slashMatches('hello /'), []);
});

test('parseSlash splits the command and its text', () => {
  assert.deepEqual(parseSlash('/btw  why this?\nmore'), { name: 'btw', rest: 'why this?\nmore' });
  assert.deepEqual(parseSlash('/btw'), { name: 'btw', rest: '' });
  assert.equal(parseSlash('/usr/bin is a path'), null);
  assert.equal(parseSlash('plain'), null);
});
