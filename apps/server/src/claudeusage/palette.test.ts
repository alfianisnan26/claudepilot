// The palette (docs/prd/claude-usage.md §20.6): a stable slot per Claude and per model, given on first sight.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Palette, RECYCLE_AFTER_MS } from './palette.js';
import { usageHarness } from './fixtures.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12);
const slotsOf = (m: Map<string, number | null>) => Object.fromEntries(m);

test('the lowest free slot in order of first sight (then of the key), kept and the same in any later order', async () => {
  const h = await usageHarness();
  try {
    const p = new Palette(h.store, () => T0);
    // b was seen at 2, a and c at 1: a (1, "a") then c (1, "c") then b (2).
    assert.deepEqual(slotsOf(p.slots('claude', [{ key: 'b', seenMs: 2 }, { key: 'c', seenMs: 1 }, { key: 'a', seenMs: 1 }])), { a: 0, c: 1, b: 2 });
    assert.deepEqual(slotsOf(p.slots('claude', [{ key: 'c', seenMs: 99 }, { key: 'a', seenMs: 50 }])), { a: 0, c: 1 }, 'a later report, another order: the same colours');
    assert.deepEqual(slotsOf(p.slots('claude', [{ key: 'd', seenMs: 0 }])), { d: 3 }, 'a newcomer takes the next free slot, never a taken one');
    assert.deepEqual(p.all().claudes, { a: 0, c: 1, b: 2, d: 3 });
    // A model and a Claude of the same name are different keys of different kinds, each with its own eight slots.
    assert.deepEqual(slotsOf(p.slots('model', [{ key: 'a', seenMs: 0 }])), { a: 0 });
    assert.deepEqual(p.all().models, { a: 0 });
    assert.equal(p.all().slots, 8);
  } finally {
    h.done();
  }
});

test('nine keys: eight slots, the ninth is grey (null) and is not kept, so it can take a slot that frees up', async () => {
  const h = await usageHarness();
  try {
    const t = { now: T0 };
    const p = new Palette(h.store, () => t.now);
    const keys = 'abcdefghi'.split('').map((key, i) => ({ key, seenMs: i }));
    const got = slotsOf(p.slots('model', keys));
    assert.deepEqual(got, { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7, i: null });
    assert.equal(Object.keys(p.all().models).length, 8, 'the ninth is not recorded');
    // Thirty days later the first eight but `a` are seen again (their "last seen" moves); `a` is not. At 46 days a is older than 45: its slot goes to `i`.
    t.now = T0 + 30 * DAY;
    p.slots('model', keys.slice(1, 8));
    t.now = T0 + 46 * DAY;
    assert.ok(t.now - T0 > RECYCLE_AFTER_MS);
    assert.deepEqual(slotsOf(p.slots('model', [{ key: 'i', seenMs: 0 }])), { i: 0 }, 'the slot of the key not seen for over 45 days');
    assert.deepEqual(p.all().models, { b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7, i: 0 });
    // And nobody who is being shown is ever taken from.
    t.now = T0 + 47 * DAY;
    assert.deepEqual(slotsOf(p.slots('model', [{ key: 'j', seenMs: 0 }])), { j: null }, 'every other key was seen within 45 days');
  } finally {
    h.done();
  }
});

test('a store that cannot be written still answers, with slots worked out in the same way and not kept', () => {
  const store = { db: null, writable: false } as never;
  const p = new Palette(store, () => T0);
  assert.deepEqual(slotsOf(p.slots('claude', [{ key: 'x', seenMs: 2 }, { key: 'y', seenMs: 1 }])), { y: 0, x: 1 });
  assert.deepEqual(p.all(), { slots: 8, claudes: {}, models: {} });
});
