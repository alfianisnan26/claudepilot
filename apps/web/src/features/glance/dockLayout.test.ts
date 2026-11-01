// The side dock auto-hides (owner, 2026-11-01): a handle until it is shown, then over the page; pinned, a column of its own where there is
// room, never over the content.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_DELAY_MS, dockForm, OPEN_DELAY_MS } from './dockLayout';

const base = { wide: true, roomy: true, widgets: 3, pinned: false, shown: false };

test('nothing on a narrow screen or without widgets', () => {
  assert.equal(dockForm({ ...base, wide: false }), 'none');
  assert.equal(dockForm({ ...base, widgets: 0, pinned: true }), 'none');
});

test('unpinned: the handle, and the panel over the page while shown', () => {
  assert.equal(dockForm(base), 'handle');
  assert.equal(dockForm({ ...base, shown: true }), 'overlay');
});

test('pinned: its own column where there is room; without room it auto-hides like unpinned', () => {
  assert.equal(dockForm({ ...base, pinned: true }), 'column');
  assert.equal(dockForm({ ...base, pinned: true, shown: true }), 'column');
  assert.equal(dockForm({ ...base, pinned: true, roomy: false }), 'handle');
  assert.equal(dockForm({ ...base, pinned: true, roomy: false, shown: true }), 'overlay');
});

test('a short delay before a hover opens it; longer before it closes', () => {
  assert.ok(OPEN_DELAY_MS >= 150 && OPEN_DELAY_MS <= 400);
  assert.equal(CLOSE_DELAY_MS, 600);
});
