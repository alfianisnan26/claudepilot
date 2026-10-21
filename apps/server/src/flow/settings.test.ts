// The Flow settings (T-1966): `flow.programs` is checked on save: every program must read, and a merge gate must be a lead of its group.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { FLOW_SETTING_KEYS, TICKET_SETTING_KEYS } from '@portal/contracts';
import { freshStore } from '../notify/testkit.js';
import { Settings } from '../settings/store.js';
import { programsProblem } from './settings.js';
import { LEAD_A, LEAD_B, LEAD_C } from './testkit.js';

const GROUPS = `${LEAD_A},${LEAD_B};${LEAD_C},${LEAD_C.replace('c', 'd')}`;

test('programsProblem: malformed programs and a merge gate outside its group are refused', () => {
  assert.equal(programsProblem('konfersi|konfersi-migration||', GROUPS), null);
  assert.equal(programsProblem('', GROUPS), null);
  assert.equal(programsProblem(`konfersi|konfersi-migration|1|${LEAD_B}`, GROUPS), null);
  assert.equal(programsProblem(`konfersi|konfersi-migration||${LEAD_C}`, GROUPS), null); // any group when the group is left empty
  assert.match(programsProblem(`konfersi|konfersi-migration|1|${LEAD_C}`, GROUPS)!, /not a lead of its group/);
  assert.match(programsProblem(`konfersi|konfersi-migration|3|${LEAD_A}`, GROUPS)!, /not a lead of its group/);
  assert.match(programsProblem('konfersi|konfersi-migration;Bad|x', GROUPS)!, /name\|tag/);
});

test('the settings store refuses a bad flow.programs on save and keeps the old value', async () => {
  const { store } = await freshStore();
  await import('../tickets/settings.js');
  const settings = new Settings(store);
  settings.set(TICKET_SETTING_KEYS.leadPeerGroups, GROUPS, { actor: 'ui' });
  assert.throws(
    () => settings.set(FLOW_SETTING_KEYS.programs, `konfersi|konfersi-migration|1|${LEAD_C}`, { actor: 'ui' }),
    (e) => isAppError(e) && e.code === 'VALIDATION_FAILED',
  );
  assert.equal(settings.get(FLOW_SETTING_KEYS.programs), 'konfersi|konfersi-migration||');
  settings.set(FLOW_SETTING_KEYS.programs, `konfersi|konfersi-migration|1|${LEAD_B}`, { actor: 'ui' });
  assert.equal(settings.get(FLOW_SETTING_KEYS.programs), `konfersi|konfersi-migration|1|${LEAD_B}`);
  store.close();
});
