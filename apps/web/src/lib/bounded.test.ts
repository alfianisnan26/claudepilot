// A growing list in a card scrolls inside itself (desktop) or is cut with "Show all" (phone), with a fade only where there is more behind
// an edge (owner, 2026-11-01; docs/prd/ui-layout.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { edgesOf } from './bounded';

test('content that fits: no cut, no fade', () => {
  assert.deepEqual(edgesOf({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }), { cut: false, top: false, bottom: false });
  assert.deepEqual(edgesOf({ scrollTop: 0, scrollHeight: 300.6, clientHeight: 300 }), { cut: false, top: false, bottom: false }, 'sub-pixel slack');
});

test('more below at the top, more on both sides mid-way, more above at the end', () => {
  assert.deepEqual(edgesOf({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 }), { cut: true, top: false, bottom: true });
  assert.deepEqual(edgesOf({ scrollTop: 200, scrollHeight: 900, clientHeight: 300 }), { cut: true, top: true, bottom: true });
  assert.deepEqual(edgesOf({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 }), { cut: true, top: true, bottom: false });
});
