// T-547 (D-65): the use-it-or-lose-it score and the "quota left unused at reset" metric, from fixture readings.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JUST_BEFORE_MS, unusedAtReset, useItScore, useItWhy, type WindowSample } from './placement.js';

const NOW = Date.parse('2026-10-14T12:00:00.000Z'); // the helpers take their clock
const at = (m: number) => new Date(NOW + m * 60_000).toISOString();

test('useItScore: room per minute to the reset; less room with a sooner reset scores higher', () => {
  assert.equal(useItScore(60, at(30), NOW), 2);
  assert.ok(useItScore(60, at(30), NOW) > useItScore(90, at(300), NOW), '60 % in 30 min beats 90 % in 300 min');
  assert.equal(useItScore(60, at(30), NOW, 1), 1, 'load divides it');
  assert.equal(useItScore(30, at(0.1), NOW), 30, 'under a minute counts as one minute');
});

test('useItScore: unknown or spent readings score 0, never a guess', () => {
  assert.equal(useItScore(null, at(30), NOW), 0);
  assert.equal(useItScore(60, null, NOW), 0);
  assert.equal(useItScore(60, 'not a date', NOW), 0);
  assert.equal(useItScore(60, at(-5), NOW), 0, 'a reset already past');
  assert.equal(useItScore(0, at(30), NOW), 0);
});

test('useItWhy says the figures', () => {
  assert.equal(useItWhy('Hasyim', 60, at(30), NOW), 'Hasyim: 60 % left, resets in 30 min (use it or lose it)');
  assert.equal(useItWhy('Hasyim', null, null, NOW), 'Hasyim: room by a measured reading');
});

test('unusedAtReset: 100 minus the last reading before each finished reset; none close enough is unavailable', () => {
  const reset1 = NOW - 600 * 60_000;
  const reset2 = NOW - 100 * 60_000;
  const reset3 = NOW + 60 * 60_000; // not finished
  const s = (atMin: number, used: number, reset: number): WindowSample => ({ atMs: NOW + atMin * 60_000, usedPct: used, resetsAtMs: reset });
  const samples = [
    s(-700, 50, reset1),
    s(-612, 72, reset1), // 12 min before reset1: the last one
    s(-590, 1, reset1 + 5 * 3_600_000), // after the reset: the next period
    s(-300, 20, reset2),
    s(-130, 55, reset2 + 20_000), // 30 min before, the reset time wanders by seconds: same period
    s(-40, 3, reset3),
  ];
  const rows = unusedAtReset('c1', 'session', samples, NOW - 24 * 3_600_000, NOW);
  assert.deepEqual(
    rows.map((r) => [r.resetAtMs, r.unusedPct.value, r.unusedPct.basis]),
    [
      [reset1, 28, 'measured'],
      [reset2, 45, 'measured'],
    ],
  );
  assert.equal(rows[0]!.readingAtMs, NOW - 612 * 60_000);

  // The last reading 31 minutes before the reset is not "just before" it: unavailable, never a guess.
  const far = unusedAtReset('c1', 'session', [s(-100 - 31, 40, reset2)], NOW - 24 * 3_600_000, NOW);
  assert.equal(far.length, 1);
  assert.equal(far[0]!.unusedPct.value, null);
  assert.equal(far[0]!.unusedPct.basis, 'unavailable');
  assert.ok(31 * 60_000 > JUST_BEFORE_MS);

  // No samples, no reset time, no period in the window: nothing listed.
  assert.deepEqual(unusedAtReset('c1', 'session', [], 0, NOW), []);
  assert.deepEqual(unusedAtReset('c1', 'session', [{ atMs: NOW - 1000, usedPct: 10, resetsAtMs: null }], 0, NOW), []);
  assert.deepEqual(unusedAtReset('c1', 'session', samples, NOW - 5 * 60_000, NOW), [], 'resets before the window start are left out');
});
