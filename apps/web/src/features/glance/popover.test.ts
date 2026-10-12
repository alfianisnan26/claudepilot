import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placePopover } from './Popover.js';

// A 1280 x 860 window and the popover's 344 px width, 12 px margin and 8 px gap, computed by hand.
const WIN = { w: 1280, h: 860 };

test('below a chip on the left half: left-aligned with it, 8 px under it, as tall as the room under it allows', () => {
  const p = placePopover({ left: 344, right: 450, top: 92, bottom: 132 }, 'below', WIN);
  assert.deepEqual(p, { left: 344, top: 140, width: 344, maxHeight: 860 - 132 - 8 - 12 });
});

test('below a chip on the right half: its right edge lines up with the chip’s, so it never leaves the screen', () => {
  const p = placePopover({ left: 1100, right: 1200, top: 100, bottom: 140 }, 'below', WIN);
  assert.equal(p.left, 1200 - 344);
});

test('on a phone-wide window it is the window minus the margins, and a chip near the edge is clamped to the margin', () => {
  const p = placePopover({ left: 280, right: 340, top: 10, bottom: 50 }, 'below', { w: 390, h: 844 });
  assert.equal(p.width, 344, '390 minus 24 is 366: the 344 cap holds');
  assert.equal(p.left, 12, '340 - 344 would be -4: clamped to the margin');
  assert.equal(placePopover({ left: 0, right: 10, top: 0, bottom: 5 }, 'below', { w: 300, h: 600 }).width, 276, '300 - 24');
});

test('above a chip: its bottom is 8 px over the chip, and it may be as tall as the room above', () => {
  const p = placePopover({ left: 700, right: 760, top: 720, bottom: 760 }, 'above', WIN);
  assert.equal(p.bottom, 860 - 720 + 8);
  assert.equal(p.maxHeight, 720 - 8 - 12);
});

test('beside a rail at the right edge: to its left, level with the chip, kept above the bottom', () => {
  const p = placePopover({ left: 1228, right: 1276, top: 388, bottom: 440 }, 'left', WIN);
  assert.equal(p.right, 1280 - 1228 + 8);
  assert.equal(p.top, 388);
  assert.equal(placePopover({ left: 1228, right: 1276, top: 800, bottom: 850 }, 'left', WIN).top, 860 - 160, 'a chip near the bottom does not push it off');
});

test('beside the sidebar: 8 px right of the sidebar’s edge (not the chip’s), its bottom level with the chip', () => {
  const p = placePopover({ left: 100, right: 160, top: 720, bottom: 764 }, 'right', WIN, 256);
  assert.equal(p.left, 264);
  assert.equal(p.bottom, 860 - 764);
  assert.equal(p.maxHeight, 764 - 12);
});
