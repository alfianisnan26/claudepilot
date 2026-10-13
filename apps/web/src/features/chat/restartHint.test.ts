// T-102: the "Tools changed" hint in each state, from the session alone: idle, working, waiting, switching, queued (by the person and by
// itself), held for Bypass, restarting, hidden until the next change, and Restart now after a long turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESTART_LONG_TURN_MS, type ChatSession } from '@portal/contracts';
import { restartHint, stopsNow } from './restartHint';

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 's1',
    state: 'idle',
    process: 'live',
    mode: 'default',
    switching: null,
    configChangedAt: iso(NOW - 60_000),
    configChanged: { at: iso(NOW - 60_000), reasons: ['mcpset', 'portal_tools'] },
    ...over,
  }) as ChatSession;

test('idle: Tools changed, the areas named; nothing inline (the sheet has Restart now)', () => {
  const h = restartHint(session(), NOW)!;
  assert.deepEqual([h.state, h.line, h.inline], ['idle', 'Tools changed', null]);
  assert.deepEqual(h.changes, ['MCP servers', 'Portal tools']);
});

test('working and waiting: the line says why it waits, never a disabled button', () => {
  assert.deepEqual([restartHint(session({ state: 'working', busySince: iso(NOW) }), NOW)!.state, restartHint(session({ state: 'working' }), NOW)!.line], ['busy', 'Tools changed · turn running']);
  assert.equal(restartHint(session({ state: 'waiting' }), NOW)!.line, 'Tools changed · approval waiting');
});

test('switching, ended, or nothing changed: no hint', () => {
  assert.equal(restartHint(session({ switching: { toClaude: 'Work', step: 'handoff' } }), NOW), null);
  assert.equal(restartHint(session({ state: 'ended' }), NOW), null);
  assert.equal(restartHint(session({ configChanged: null, configChangedAt: null }), NOW), null);
  assert.equal(restartHint(null, NOW), null);
});

test('an older server (configChangedAt only) still shows the hint', () => {
  assert.deepEqual(restartHint(session({ configChanged: undefined }), NOW)!.changes, ['Delivered files']);
});

test('queued by the person: Restarts when the turn ends, with Cancel; by itself: Restarts after this turn, Restart now after 30 minutes', () => {
  const q = restartHint(session({ state: 'working', restartQueued: 'person' }), NOW)!;
  assert.deepEqual([q.state, q.line, q.inline], ['queued', 'Restarts when the turn ends', 'cancel']);
  const a = restartHint(session({ state: 'working', restartQueued: 'auto', busySince: iso(NOW - 60_000) }), NOW)!;
  assert.deepEqual([a.state, a.line, a.inline, a.long], ['auto', 'Restarts after this turn', null, false]);
  const long = restartHint(session({ state: 'working', restartQueued: 'auto', busySince: iso(NOW - RESTART_LONG_TURN_MS - 1000) }), NOW)!;
  assert.deepEqual([long.inline, long.long], ['now', true]);
});

test('held for Bypass: the chip says a person restarts it, and Restart now says Bypass turns off', () => {
  const s = session({ state: 'working', mode: 'bypassPermissions', restartHeld: 'bypass' });
  const h = restartHint(s, NOW)!;
  assert.deepEqual([h.state, h.line, h.dropsBypass], ['held', 'Tools changed · restart by hand', true]);
  assert.ok(stopsNow(s, [], h.dropsBypass).some((l) => l.includes('Bypass turns off')));
});

test('restarting reads Restarting…', () => {
  assert.deepEqual([restartHint(session({ restarting: true }), NOW)!.state, restartHint(session({ restarting: true }), NOW)!.line], ['restarting', 'Restarting…']);
});

test('hidden until the next change: hidden for this change, shown for a newer one, and a queued restart keeps its Cancel', () => {
  const at = iso(NOW - 60_000);
  assert.equal(restartHint(session({ configHiddenAt: at }), NOW), null);
  assert.ok(restartHint(session({ configHiddenAt: iso(NOW - 120_000) }), NOW), 'a newer change shows again');
  assert.equal(restartHint(session({ configHiddenAt: at, state: 'working', restartQueued: 'person' }), NOW)!.inline, 'cancel');
});

test('what Restart now stops, in plain words: the turn, an approval, the agents by name; nothing when nothing runs', () => {
  assert.deepEqual(stopsNow(session(), [], false), []);
  assert.deepEqual(stopsNow(session({ state: 'working' }), ['review'], false), ['The turn in flight is interrupted.', 'review stops.']);
  assert.deepEqual(stopsNow(session({ state: 'working', tasksOnly: true }), ['a', 'b'], false), ['2 agents stop: a, b.']);
  assert.deepEqual(stopsNow(session({ state: 'waiting' }), [], false), ['The approval waiting is dropped.']);
});
