import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatKeepGoing, KeepGoingChat, KeepGoingList } from '@portal/contracts';
import { autonomyCompact, autonomyView } from './model.js';

const kg = (over: Partial<ChatKeepGoing> = {}): ChatKeepGoing => ({
  enabled: true,
  nudgeAfterMin: 4,
  prompt: null,
  statusFile: null,
  maxNudgesPerDay: 60,
  maxWakesPerDay: 20,
  nudgesToday: 2,
  wakesToday: 1,
  last: { at: '2026-10-14T04:00:00.000Z', kind: 'nudged', cause: null, reason: 'Idle for 4 min: told to continue.' },
  paused: false,
  standing: [],
  ...over,
});
const chat = (id: string, over: Partial<KeepGoingChat> = {}, k: Partial<ChatKeepGoing> = {}): KeepGoingChat => ({ sessionId: id, title: `Chat ${id}`, workspaceId: 'kubernetes/kohi-event', state: 'working', mode: 'default', keepGoing: kg(k), ...over });
const list = (chats: KeepGoingChat[], paused = false): KeepGoingList => ({ paused, chats });

test('the figures come from the list: watched, left down, reported, and the nudges and wakes of the last 24 hours', () => {
  const v = autonomyView(list([chat('a', { state: 'ended' }, { standing: ['down'] }), chat('b', { state: 'waiting' }, { standing: ['approval'] }), chat('c')]));
  assert.deepEqual([v.watched, v.down, v.reported, v.actions], [3, 1, 1, 9]);
  assert.deepEqual(
    v.rows.map((r) => [r.id, r.state, r.level, r.what, r.workspace]),
    [
      ['a', 'Ended', 'critical', 'left down', 'kohi-event'],
      ['b', 'Waiting', 'warn', 'a tool approval waits', 'kohi-event'],
      ['c', 'Working', 'ok', 'Idle for 4 min: told to continue.', 'kohi-event'],
    ],
  );
  assert.deepEqual(autonomyCompact(v, false), { value: '3', level: 'critical', title: 'Autonomy: 3 chats kept going, 1 left down and 1 reported' });
});

test('nothing watched is idle, the pause is a warning, and loading and failed are states (never a guessed zero)', () => {
  assert.deepEqual(autonomyCompact(autonomyView(list([])), false), { value: '0', level: 'idle', title: 'Autonomy: no chats kept going' });
  const paused = autonomyCompact(autonomyView(list([chat('a', { state: 'idle' }, { last: null, nudgesToday: 0, wakesToday: 0 })], true)), false);
  assert.deepEqual([paused.level, paused.title], ['warn', 'Autonomy: 1 chat kept going, paused']);
  assert.equal(autonomyView(list([chat('a', { state: 'idle' }, { last: null })])).rows[0]!.what, null);
  assert.equal(autonomyCompact(null, false).loading, true);
  assert.deepEqual(autonomyCompact(null, true), { value: '-', level: 'unknown', title: 'Autonomy: not available', stale: true });
});

test('the pauses (slice 3): listed with the held chats, and the chip says which programs are paused', () => {
  const pause = { program: 'konfersi', reason: 'Focus on ClaudePilot', since: '2026-10-14T05:00:00.000Z', by: 'user:u_owner' };
  const v = autonomyView({ paused: false, pauses: [pause], chats: [chat('a', {}, { paused: true, pause }), chat('b')] });
  assert.deepEqual(v.pauses, [pause]);
  assert.equal(v.held, 1);
  const c = autonomyCompact(v, false);
  assert.equal(c.level, 'warn');
  assert.match(c.title, /paused: konfersi/);
  assert.deepEqual(autonomyView(list([])).pauses, [], 'an older server without pauses reads as none');
});
