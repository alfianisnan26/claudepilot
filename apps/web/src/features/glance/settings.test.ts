import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSettings, cleanThresholds, DEFAULT_SETTINGS, moveInOrder, orderWidgets } from './settings.js';
import { currentUserId, glanceKey, OWNER_ID } from './user.js';

const W = [{ id: 'quota' }, { id: 'sessions' }, { id: 'agents' }, { id: 'attention' }, { id: 'shortcuts' }];

test('nothing stored is the defaults, with the portal alert levels as thresholds', () => {
  assert.deepEqual(cleanSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(cleanSettings('garbage'), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS.thresholds, { warn: 80, critical: 95 });
});

test('malformed fields fall back one by one and the good ones are kept', () => {
  const s = cleanSettings({ order: ['b', 3, 'a', 'b'], hidden: 'no', places: { header: false, dock: 'yes' }, quotaMode: 'all', thresholds: { warn: 70, critical: 90 }, dockOpen: true, appBadge: false });
  assert.deepEqual(s.order, ['b', 'a'], 'non-strings and duplicates drop');
  assert.deepEqual(s.hidden, []);
  assert.equal(s.places.header, false);
  assert.equal(s.places.dock, DEFAULT_SETTINGS.places.dock, 'a non-boolean place is its default');
  assert.equal(s.places.list, true);
  assert.equal(s.quotaMode, 'all');
  assert.deepEqual(s.thresholds, { warn: 70, critical: 90 });
  assert.equal(s.dockOpen, true);
  assert.equal(s.appBadge, false);
});

test('thresholds: whole percents with warn below critical, else the default pair', () => {
  assert.deepEqual(cleanThresholds({ warn: 50, critical: 51 }), { warn: 50, critical: 51 });
  for (const bad of [{ warn: 95, critical: 80 }, { warn: 80, critical: 80 }, { warn: 0, critical: 90 }, { warn: 60, critical: 101 }, { warn: 70.5, critical: 90 }, { warn: 'x', critical: 90 }, null, 5])
    assert.deepEqual(cleanThresholds(bad), { warn: 80, critical: 95 });
});

test('order: the person’s order first, new widgets after in registry order, hidden ones dropped unless asked', () => {
  assert.deepEqual(orderWidgets(W, { order: [], hidden: [] }).map((w) => w.id), ['quota', 'sessions', 'agents', 'attention', 'shortcuts']);
  assert.deepEqual(orderWidgets(W, { order: ['attention', 'quota', 'gone'], hidden: [] }).map((w) => w.id), ['attention', 'quota', 'sessions', 'agents', 'shortcuts'], 'an id the registry no longer has is ignored');
  assert.deepEqual(orderWidgets(W, { order: ['attention'], hidden: ['agents', 'quota'] }).map((w) => w.id), ['attention', 'sessions', 'shortcuts']);
  assert.deepEqual(orderWidgets(W, { order: [], hidden: ['agents'] }, true).map((w) => w.id), ['quota', 'sessions', 'agents', 'attention', 'shortcuts'], 'Settings lists the switched-off ones too');
});

test('moving a widget up or down swaps it with its neighbour and stops at the ends', () => {
  const ids = W.map((w) => w.id);
  assert.deepEqual(moveInOrder(ids, 'sessions', -1), ['sessions', 'quota', 'agents', 'attention', 'shortcuts']);
  assert.deepEqual(moveInOrder(ids, 'sessions', 1), ['quota', 'agents', 'sessions', 'attention', 'shortcuts']);
  assert.deepEqual(moveInOrder(ids, 'quota', -1), ids);
  assert.deepEqual(moveInOrder(ids, 'shortcuts', 1), ids);
  assert.deepEqual(moveInOrder(ids, 'nope', 1), ids);
});

test('the settings key carries the user id, so two people on one browser keep their own; today everyone is the one owner', () => {
  assert.equal(OWNER_ID, 'u_owner');
  assert.equal(currentUserId(), 'u_owner');
  assert.equal(glanceKey('u_owner'), 'claudepilot.glance.u_owner');
  assert.notEqual(glanceKey('u_ana'), glanceKey('u_ben'));
});
