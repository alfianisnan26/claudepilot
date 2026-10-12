import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBadge, badgeSupported, badgeTotal } from './badge.js';

test('the badge is the sum of the widgets’ whole, non-negative counts; unknown until every one has reported', () => {
  assert.equal(badgeTotal([2, 3]), 5);
  assert.equal(badgeTotal([]), 0, 'no badge widget: nothing to show');
  assert.equal(badgeTotal([2, null]), null, 'one still loading: do not touch the icon');
  assert.equal(badgeTotal([2, undefined]), null);
  assert.equal(badgeTotal([1.9, -4, NaN]), 1, 'fractions floor, negatives and NaN count as nothing');
});

test('setting the badge: a number above 0 sets it, 0 clears it, a missing or refusing API is a quiet false', async () => {
  const calls: string[] = [];
  const nav = { setAppBadge: async (n?: number) => void calls.push(`set ${n}`), clearAppBadge: async () => void calls.push('clear') } as unknown as Navigator;
  assert.equal(badgeSupported(nav), true);
  assert.equal(await applyBadge(3, nav), true);
  assert.equal(await applyBadge(0, nav), true);
  assert.deepEqual(calls, ['set 3', 'clear']);
  assert.equal(badgeSupported({} as Navigator), false);
  assert.equal(await applyBadge(3, {} as Navigator), false);
  const refusing = { setAppBadge: async () => Promise.reject(new Error('NotAllowedError')) } as unknown as Navigator;
  assert.equal(await applyBadge(3, refusing), false);
  // No clearAppBadge: setting 0 clears it.
  const onlySet = { setAppBadge: async (n?: number) => void calls.push(`only ${n}`) } as unknown as Navigator;
  assert.equal(await applyBadge(0, onlySet), true);
  assert.equal(calls.at(-1), 'only 0');
});
