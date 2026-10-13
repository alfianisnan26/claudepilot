import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AXIS_LOCK, SWIPE_MAX, SWIPE_THRESHOLD, swipeMove, swipeOutcome, swipeStart, swipeTravel } from './swipe';

test('the first clear movement decides the axis; a vertical drag never moves the row', () => {
  let s = swipeStart(1, 100, 100);
  s = swipeMove(s, 100 + AXIS_LOCK - 1, 100);
  assert.equal(s.axis, 'none', 'too short to tell');
  s = swipeMove(s, 103, 100 + AXIS_LOCK + 4);
  assert.equal(s.axis, 'y');
  s = swipeMove(s, 300, 140);
  assert.equal(s.dx, 0, 'locked to scrolling: the row stays');
  assert.equal(swipeOutcome(s), null);
});

test('a horizontal drag moves the row, with resistance past the threshold and a hard stop', () => {
  let s = swipeMove(swipeStart(1, 100, 100), 100 + AXIS_LOCK + 2, 101);
  assert.equal(s.axis, 'x');
  s = swipeMove(s, 140, 102);
  assert.equal(s.dx, 40);
  s = swipeMove(s, 100 + SWIPE_THRESHOLD + 40, 102);
  assert.equal(s.dx, SWIPE_THRESHOLD + 10, 'a quarter of what is past the threshold');
  s = swipeMove(s, 2000, 102);
  assert.equal(s.dx, SWIPE_MAX);
  assert.equal(swipeTravel(-SWIPE_THRESHOLD), -SWIPE_THRESHOLD);
});

test('the release acts only past the threshold: right is pin, left is archive, short snaps back', () => {
  const at = (x: number) => swipeMove(swipeMove(swipeStart(1, 100, 100), 100 + AXIS_LOCK + 2, 100), x, 100);
  assert.equal(swipeOutcome(at(100 + SWIPE_THRESHOLD)), 'right');
  assert.equal(swipeOutcome(at(100 - SWIPE_THRESHOLD)), 'left');
  assert.equal(swipeOutcome(at(100 + SWIPE_THRESHOLD - 1)), null);
  assert.equal(swipeOutcome(at(100 - SWIPE_THRESHOLD + 1)), null);
});
