import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionItem } from '@portal/contracts';
import { deckOf, isLater, keyOutcome, laterOf, nextIndex, startIndex, swipeOutcome, swipeThreshold } from './deck.js';

// Relative to the real clock: nothing depends on a fixed date.
const now = Date.now();
const at = (min: number) => new Date(now + min * 60_000).toISOString();
const item = (id: string, snoozedUntil?: string): AttentionItem => ({
  kind: 'mcp_version',
  id,
  title: `Item ${id}`,
  who: [],
  why: 'third_party_code',
  risk: '',
  since: at(-30),
  link: `/admin/pools?tab=mcp&version=${id}`,
  action: { label: 'Review', method: 'POST', path: '/x' },
  ...(snoozedUntil ? { snoozedUntil } : {}),
});

test('the deck leaves out what is put off until it is due; Later lists the soonest back first', () => {
  const items = [item('a'), item('b', at(50)), item('c', at(10)), item('d', at(-1))];
  assert.deepEqual(deckOf(items, now).map((i) => i.id), ['a', 'd'], 'a snooze that has run out is back in the deck');
  assert.deepEqual(laterOf(items, now).map((i) => i.id), ['c', 'b']);
  assert.equal(isLater(item('x', 'not a date'), now), false);
});

test('the deck opens at the card a link names, else the first; after a card leaves, the next one or the last', () => {
  const deck = [item('a'), item('b'), item('c')];
  assert.equal(startIndex(deck, 'mcp_version:b'), 1);
  assert.equal(startIndex(deck, 'mcp_version:gone'), 0);
  assert.equal(startIndex(deck, null), 0);
  assert.equal(nextIndex(1, 2), 1);
  assert.equal(nextIndex(2, 2), 1);
  assert.equal(nextIndex(0, 0), 0);
});

test('a swipe: right far enough acts, left far enough is later, short or vertical is nothing', () => {
  assert.equal(swipeThreshold(390), 130);
  assert.equal(swipeThreshold(150), 72);
  assert.equal(swipeThreshold(1200), 140);
  assert.equal(swipeOutcome(140, 10, 390), 'act');
  assert.equal(swipeOutcome(-140, 10, 390), 'later');
  assert.equal(swipeOutcome(100, 0, 390), null, 'short: snaps back');
  assert.equal(swipeOutcome(150, 200, 390), null, 'mostly vertical: a scroll');
  assert.equal(keyOutcome('ArrowRight'), 'act');
  assert.equal(keyOutcome('ArrowLeft'), 'later');
  assert.equal(keyOutcome('Enter'), null);
});
