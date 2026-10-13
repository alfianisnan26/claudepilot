import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNoSheetDrag, SHEET_DRAG_ZONES, startsSheetDrag } from './sheetDrag';
import { pinnedToViewport } from './viewport';

const inside = { closest: (s: string) => (s === SHEET_DRAG_ZONES ? {} : null) };
const outside = { closest: () => null };

test('only a pointerdown inside the header or the grab bar of a sheet counts', () => {
  assert.equal(startsSheetDrag(inside), true);
  assert.equal(startsSheetDrag(outside), false);
  assert.equal(startsSheetDrag(null), false);
  assert.equal(startsSheetDrag({}), false);
  assert.match(SHEET_DRAG_ZONES, /header\.touch-none/);
  assert.match(SHEET_DRAG_ZONES, /touch-none\.cursor-grab/);
});

test('the listener runs first (capture) and stops those events and no others', () => {
  const added: { type: string; capture: unknown; fn: (e: Event) => void }[] = [];
  const doc = {
    addEventListener: (type: string, fn: (e: Event) => void, capture: unknown) => added.push({ type, fn, capture }),
    removeEventListener: (type: string, fn: (e: Event) => void) => void added.splice(added.findIndex((a) => a.type === type && a.fn === fn), 1),
  } as unknown as Document;
  const off = installNoSheetDrag(doc);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.type, 'pointerdown');
  assert.equal(added[0]!.capture, true);
  let stopped = 0;
  added[0]!.fn({ target: inside, stopPropagation: () => stopped++ } as unknown as Event);
  added[0]!.fn({ target: outside, stopPropagation: () => stopped++ } as unknown as Event);
  assert.equal(stopped, 1);
  off();
  assert.equal(added.length, 0);
});

test('a full-screen page follows the visual viewport only while the keyboard is up', () => {
  assert.equal(pinnedToViewport(null), undefined);
  assert.deepEqual(pinnedToViewport({ height: 700, top: 0, keyboard: false }), { height: 700 });
  // A rubber-band offset without the keyboard must not move the page.
  assert.deepEqual(pinnedToViewport({ height: 700, top: 38, keyboard: false }), { height: 700 });
  assert.deepEqual(pinnedToViewport({ height: 420, top: 120, keyboard: true }), { height: 420, transform: 'translateY(120px)' });
});
