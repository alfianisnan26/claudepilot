// The chart's axis top (owner, 2026-10-18: "it should show scaling up to the max value"): at or above the highest value, never far above
// it. A peak of $210 used to draw an axis to $500.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { niceMax } from './charts';

test('the axis top is the closest readable number at or above the peak', () => {
  assert.equal(niceMax(210), 250);
  assert.equal(niceMax(200), 200);
  assert.equal(niceMax(201), 250);
  assert.equal(niceMax(315), 400);
  assert.equal(niceMax(392), 400);
  assert.equal(niceMax(110), 120);
  assert.equal(niceMax(0.3), 0.3, 'no floating-point jump to the next step');
  assert.equal(niceMax(7), 8);
  assert.equal(niceMax(1003), 1200);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
});

test('never below the peak, and at most a third above it (the peak fills at least 3/4 of the height)', () => {
  for (let v = 1; v < 100000; v = v * 1.07 + 0.31) {
    const m = niceMax(v);
    assert.ok(m >= v, `${m} >= ${v}`);
    assert.ok(m <= v * (4 / 3) + 1e-9, `${m} within a third of ${v}`);
  }
});
