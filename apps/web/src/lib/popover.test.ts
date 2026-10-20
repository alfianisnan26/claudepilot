// T-102: where a popover goes: inside the visible viewport and the safe areas, never over the composer or under the header, text width capped.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeBeside, placePopover } from './popover';

const view = { top: 0, left: 0, width: 390, height: 844 };
const safe = { top: 47, right: 0, bottom: 34, left: 0 };

test('a control right above the composer opens its note above it, never over the composer', () => {
  const anchor = { top: 640, bottom: 684, left: 300, right: 344 };
  const p = placePopover({ anchor, width: 256, height: 120, view, safe, floor: 690 });
  assert.equal(p.side, 'above');
  assert.ok(p.top + 120 <= anchor.top, 'all of it above the control');
});

test('kept inside the right edge (and the left), and never wider than what is visible', () => {
  const p = placePopover({ anchor: { top: 300, bottom: 344, left: 360, right: 390 }, width: 256, height: 80, view, safe });
  assert.ok(p.left + p.width <= 390 - 12, `right edge: ${p.left + p.width}`);
  const narrow = placePopover({ anchor: { top: 300, bottom: 344, left: 0, right: 40 }, width: 500, height: 80, view: { ...view, width: 320 }, safe });
  assert.ok(narrow.left >= 12 && narrow.width <= 320 - 24);
});

test('the keyboard: the visual viewport is shorter and moved; the note stays inside it', () => {
  const kb = { top: 200, left: 0, width: 390, height: 400 };
  const p = placePopover({ anchor: { top: 520, bottom: 564, left: 100, right: 144 }, width: 256, height: 150, view: kb, safe: { ...safe, bottom: 0 } });
  assert.equal(p.side, 'above');
  assert.ok(p.top >= kb.top + 12);
});

test('under the header, below the control; too tall for either side, the roomier one, cut to fit', () => {
  const p = placePopover({ anchor: { top: 60, bottom: 100, left: 100, right: 144 }, width: 256, height: 100, view, safe, ceiling: 104, prefer: 'above' });
  assert.equal(p.side, 'below', 'no room above under the header');
  const tall = placePopover({ anchor: { top: 400, bottom: 444, left: 100, right: 144 }, width: 256, height: 2000, view, safe });
  assert.ok(tall.maxHeight !== null && tall.maxHeight > 0);
  assert.ok(tall.top >= 47 + 12 && tall.top + tall.maxHeight! <= 844 - 34 - 12 + 0.5);
});

test('T-1825: beside an element: on its right when there is room, else its left, else none (the caller falls back)', () => {
  const desk = { top: 0, left: 0, width: 1280, height: 800 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const lead = { top: 150, bottom: 320, left: 460, right: 812 };
  const r = placeBeside({ target: lead, width: 360, height: 160, view: desk, safe: none });
  assert.equal(r?.side, 'right');
  assert.equal(r?.left, 812 + 12);
  assert.equal(r?.top, 150, 'lined up with the element, not over its row');
  const l = placeBeside({ target: { ...lead, left: 700, right: 1100 }, width: 360, height: 180, view: desk, safe: none });
  assert.equal(l?.side, 'left');
  assert.ok(l!.left + 360 <= 700 - 12);
  assert.equal(placeBeside({ target: { top: 150, bottom: 320, left: 16, right: 374 }, width: 360, height: 180, view, safe }), null, 'a phone: no room');
});

test('T-1825: beside an element near the bottom: kept inside the visible height; too tall, it scrolls', () => {
  const desk = { top: 0, left: 0, width: 1280, height: 600 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const p = placeBeside({ target: { top: 520, bottom: 700, left: 100, right: 400 }, width: 360, height: 200, view: desk, safe: none });
  assert.ok(p && p.top + 200 <= 600 - 12);
  const tall = placeBeside({ target: { top: 50, bottom: 200, left: 100, right: 400 }, width: 360, height: 2000, view: desk, safe: none });
  assert.equal(tall?.maxHeight, 600 - 24);
});

test('T-1825 QA: taller than the element beside it, it grows upwards: its bottom on the element\'s, never over what is below', () => {
  const desk = { top: 0, left: 0, width: 1280, height: 900 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const lead = { top: 300, bottom: 395, left: 460, right: 812 };
  const p = placeBeside({ target: lead, width: 360, height: 137, view: desk, safe: none });
  assert.equal(p?.top, 395 - 137);
  assert.equal(p!.top + 137, lead.bottom);
  const nearTop = placeBeside({ target: { ...lead, top: 40, bottom: 135 }, width: 360, height: 137, view: desk, safe: none });
  assert.equal(nearTop?.top, 12, 'kept inside the view at the top');
});
