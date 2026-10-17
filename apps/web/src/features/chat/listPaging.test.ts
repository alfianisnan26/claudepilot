// The session list keeps older pages only while the seam under the first page has not moved (T-382 S2 fix); a refused cursor starts over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorExpired, keepsOlder, ListPager } from './listPaging';

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

// The pager is what the Sessions and CI hooks call: these tests go red when the seam rule or the expired-cursor rule is taken out of it (T-382 S4).
const row = (id: string) => ({ id });
const page = (ids: string[], next: string | null) => ({ items: ids.map(row), next });

test('pager: a poll that moves the seam drops the older pages (removing the keepsOlder check makes this red)', () => {
  const p = new ListPager<{ id: string }>();
  p.applyHead(page(['a', 'b'], 'c1'));
  const t = p.beginMore()!;
  assert.equal(t.cursor, 'c1');
  assert.equal(p.finishMore(t, page(['c', 'd'], 'c2')), true);
  assert.deepEqual(p.items!.map((x) => x.id), ['a', 'b', 'c', 'd']);
  p.applyHead(page(['z', 'a'], 'c9')); // a new row arrived: the seam moved
  assert.deepEqual(p.items!.map((x) => x.id), ['z', 'a'], 'the older rows are gone');
  assert.equal(p.next, 'c9');
});

test('pager: a poll that finds the same seam keeps the older pages', () => {
  const p = new ListPager<{ id: string }>();
  p.applyHead(page(['a', 'b'], 'c1'));
  p.finishMore(p.beginMore()!, page(['c'], null));
  p.applyHead(page(['a', 'b'], 'c1'));
  assert.deepEqual(p.items!.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(p.next, null);
});

test('pager: a refused cursor means start over (removing the cursorExpired check makes this red); other failures retry', () => {
  const p = new ListPager<{ id: string }>();
  p.applyHead(page(['a'], 'c1'));
  const t = p.beginMore()!;
  assert.equal(p.failMore(t, Object.assign(new Error('bad cursor'), { status: 400 })), 'restart');
  assert.equal(p.failMore(t, Object.assign(new Error('down'), { status: 500 })), 'retry');
  assert.equal(p.failMore(t, new Error('offline')), 'retry');
});

test('pager: a load-more that lands after a poll dropped the older pages is not appended (stale generation)', () => {
  const p = new ListPager<{ id: string }>();
  p.applyHead(page(['a', 'b'], 'c1'));
  const slow = p.beginMore()!; // in flight
  p.applyHead(page(['z', 'a'], 'c9')); // the poll moves the seam while it runs
  assert.equal(p.finishMore(slow, page(['c', 'd'], 'c2')), false);
  assert.deepEqual(p.items!.map((x) => x.id), ['z', 'a']);
  assert.equal(p.next, 'c9', 'the next cursor is still the new seam, not the stale page');
  assert.equal(p.failMore(slow, Object.assign(new Error('x'), { status: 400 })), 'stale', 'its error is ignored too');
});

test('pager: a filter change (restart) drops the older pages and refuses a page still in flight', () => {
  const p = new ListPager<{ id: string }>();
  p.applyHead(page(['a'], 'c1'));
  const slow = p.beginMore()!;
  p.restart();
  p.applyHead(page(['x'], 'c1'));
  assert.equal(p.finishMore(slow, page(['c'], null)), false);
  assert.deepEqual(p.items!.map((x) => x.id), ['x']);
});

test('pager: at the end there is nothing to load', () => {
  const p = new ListPager<{ id: string }>();
  assert.equal(p.beginMore(), null);
  p.applyHead(page(['a'], null));
  assert.equal(p.beginMore(), null);
});
