import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_MAX_WORKERS_MAX, type ChatSession, type SettingView } from '@portal/contracts';
import { limitsNote, nextPending, roleOf, stepWorkers, workersCap, workersView, WORKERS_SETTING } from './crewLimits';

const setting = (key: string, value: SettingView['value']) => ({ key, value }) as SettingView;

test('the global cap comes from the settings list, else null (the stepper then shows the number only)', () => {
  assert.equal(workersCap({ settings: [setting('sessions.idleMinutes', 30), setting(WORKERS_SETTING, 5)] }), 5);
  assert.equal(workersCap({ settings: [setting('sessions.idleMinutes', 30)] }), null, 'not in the list');
  assert.equal(workersCap(null), null, 'the list could not be read');
  for (const odd of [0, 2.5, CHAT_MAX_WORKERS_MAX + 1, '5', true]) assert.equal(workersCap({ settings: [setting(WORKERS_SETTING, odd)] }), null, String(odd));
});

test('the stepper: None, 1 … up to the cap, where it reads Default; never past either end', () => {
  // From Default (the cap, 5): down to 4, up is the top already.
  assert.equal(stepWorkers(null, -1, 5), 4);
  assert.equal(stepWorkers(undefined, -1, 5), 4, 'a row from before the field reads as Default');
  assert.equal(stepWorkers(null, 1, 5), undefined);
  // Up to the cap turns into Default (it follows the setting), not a stored 5.
  assert.equal(stepWorkers(4, 1, 5), null);
  assert.equal(stepWorkers(1, -1, 5), 0, 'down to None');
  assert.equal(stepWorkers(0, -1, 5), undefined, 'None is the bottom');
  assert.equal(stepWorkers(0, 1, 5), 1);
  // A stored value above the cap counts as the cap (as on the server): down from there is the cap less one, up is Default.
  assert.equal(stepWorkers(12, -1, 5), 4);
  assert.equal(stepWorkers(12, 1, 5), null);
  // A cap of 1: None or Default.
  assert.equal(stepWorkers(null, -1, 1), 0);
  assert.equal(stepWorkers(0, 1, 1), null);
});

test('the stepper without the cap: the same rule up to the highest value a session may store', () => {
  assert.equal(stepWorkers(null, -1, null), CHAT_MAX_WORKERS_MAX - 1);
  assert.equal(stepWorkers(null, 1, null), undefined);
  assert.equal(stepWorkers(CHAT_MAX_WORKERS_MAX - 1, 1, null), null);
  assert.equal(stepWorkers(3, -1, null), 2);
});

test('what the stepper shows, and which way it can go', () => {
  assert.deepEqual(workersView(null, 5), { text: 'Default (5)', label: 'Workers at once: the global setting, 5', canLess: true, canMore: false });
  assert.deepEqual(workersView(null, null), { text: 'Default', label: 'Workers at once: the global setting', canLess: true, canMore: false });
  assert.deepEqual(workersView(0, 5), { text: 'None', label: 'Workers at once: none, it may not start workers', canLess: false, canMore: true });
  assert.deepEqual(workersView(3, 5), { text: '3', label: 'Workers at once: 3', canLess: true, canMore: true });
  assert.equal(workersView(12, 5).text, '5', 'above the cap shows what applies');
  assert.equal(workersView(12, null).text, '12', 'without the cap, the number only');
});

test('a sub-agents change waits for a restart only while the live process runs with the other setting', () => {
  // Off while live: pending until a restart.
  const off = nextPending(null, { before: true, after: false, restartNeeded: true });
  assert.deepEqual(off, { launched: true, now: false });
  // A change of workers alone (sub-agents the same) leaves it pending.
  assert.deepEqual(nextPending(off, { before: false, after: false, restartNeeded: false }), off);
  // Back on: the process was launched with them on, so nothing waits (the server says restartNeeded, comparing stored values only).
  assert.equal(nextPending(off, { before: false, after: true, restartNeeded: true }), null);
  // Nothing runs: the next start takes it by itself.
  assert.equal(nextPending(off, { before: false, after: true, restartNeeded: false }), null);
  assert.equal(nextPending(null, { before: true, after: false, restartNeeded: false }), null);
});

test('which note shows for a pending change: the Restart action, the queued restart, or none', () => {
  const live = { state: 'idle', process: 'live', restarting: false, restartQueued: null } as Pick<ChatSession, 'state' | 'process' | 'restarting' | 'restartQueued'>;
  const off = { launched: true, now: false };
  assert.deepEqual(limitsNote(off, live), { line: 'Sub-agents off from the next restart.', restart: true });
  assert.deepEqual(limitsNote({ launched: false, now: true }, { ...live, state: 'working' }), { line: 'Sub-agents on from the next restart.', restart: true });
  assert.deepEqual(limitsNote(off, { ...live, restartQueued: 'person' }), { line: 'Sub-agents off at the queued restart.', restart: false });
  assert.equal(limitsNote(off, { ...live, restarting: true }), null, 'a restart under way takes it');
  assert.equal(limitsNote(off, { ...live, process: 'asleep' }), null, 'it wakes with it');
  assert.equal(limitsNote(off, { ...live, state: 'ended' }), null);
  assert.equal(limitsNote(null, live), null);
});

test('the role: the agent a session runs as, only when set', () => {
  assert.equal(roleOf({ agent: 'qa-verifier' }), 'qa-verifier');
  assert.equal(roleOf({ agent: null }), null);
  assert.equal(roleOf({}), null, 'a row from before the field');
  assert.equal(roleOf({ agent: '  ' }), null);
  assert.equal(roleOf(null), null);
});
