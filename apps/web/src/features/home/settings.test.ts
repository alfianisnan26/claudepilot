import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveInOrder } from '../glance/settings.js';
import { cleanHome, DEFAULT_HOME, HOME_DEFAULT_ORDER, homeKey, orderCards } from './settings.js';

// The registry's order (quota, sessions, attention, then the Home widgets), as the page gets it.
const cards = ['quota', 'sessions', 'attention', 'workspaces', 'tickets', 'ci', 'usage'].map((id) => ({ id }));

test('nothing stored: every card in the default order, what needs you first', () => {
  assert.deepEqual(cleanHome(null), DEFAULT_HOME);
  assert.deepEqual(cleanHome('junk'), DEFAULT_HOME);
  assert.deepEqual(orderCards(cards, DEFAULT_HOME).map((c) => c.id), [...HOME_DEFAULT_ORDER]);
  assert.deepEqual(HOME_DEFAULT_ORDER.slice(0, 3), ['attention', 'sessions', 'quota']);
});

test('the person\'s order first, the rest in the default order; hidden cards drop out but the Arrange list keeps them', () => {
  const s = cleanHome({ order: ['ci', 'quota', 'gone', 'ci', 7], hidden: ['usage', 'tickets'] });
  assert.deepEqual(s, { order: ['ci', 'quota', 'gone'], hidden: ['usage', 'tickets'] });
  assert.deepEqual(orderCards(cards, s).map((c) => c.id), ['ci', 'quota', 'attention', 'sessions', 'workspaces']);
  assert.deepEqual(orderCards(cards, s, true).map((c) => c.id), ['ci', 'quota', 'attention', 'sessions', 'workspaces', 'tickets', 'usage']);
  // a card the default order does not know goes last
  assert.deepEqual(orderCards([...cards, { id: 'later' }], DEFAULT_HOME).map((c) => c.id).at(-1), 'later');
});

test('moving a card one place, as the Arrange list does, and the key per person', () => {
  const ids = orderCards(cards, DEFAULT_HOME, true).map((c) => c.id);
  assert.deepEqual(moveInOrder(ids, 'quota', -1).slice(0, 3), ['attention', 'quota', 'sessions']);
  assert.deepEqual(orderCards(cards, { order: moveInOrder(ids, 'quota', -1), hidden: [] }).map((c) => c.id).slice(0, 3), ['attention', 'quota', 'sessions']);
  assert.equal(homeKey('u_owner'), 'claudepilot.home.u_owner');
});
