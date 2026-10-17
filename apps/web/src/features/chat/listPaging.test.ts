// The session list keeps older pages only while the seam under the first page has not moved (T-382 S2 fix); a refused cursor starts over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorExpired, keepsOlder } from './listPaging';

test('a poll that finds the same last row keeps the older pages', () => {
  assert.equal(keepsOlder('cursor-after-row-50', 'cursor-after-row-50'), true);
});

test('a new session moves the seam: the older pages are dropped (the old 50th row would be in neither list)', () => {
  assert.equal(keepsOlder('cursor-after-row-50', 'cursor-after-row-49'), false);
});

test('a session that left the first page moves the seam too', () => {
  assert.equal(keepsOlder('cursor-after-row-50', 'cursor-after-row-51'), false);
});

test('the first page that held everything has no older pages to keep, and one that now has more drops nothing it had', () => {
  assert.equal(keepsOlder(null, null), true);
  assert.equal(keepsOlder(null, 'cursor-after-row-50'), false);
  assert.equal(keepsOlder(undefined, 'x'), false, 'no first page was loaded yet');
});

test('a 400 means the cursor is gone; other failures keep the button', () => {
  assert.equal(cursorExpired(Object.assign(new Error('bad cursor'), { status: 400 })), true);
  assert.equal(cursorExpired(Object.assign(new Error('down'), { status: 500 })), false);
  assert.equal(cursorExpired(Object.assign(new Error('offline'), { status: 0 })), false);
  assert.equal(cursorExpired(new Error('plain')), false);
  assert.equal(cursorExpired(null), false);
});
