import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GlanceAgent, GlanceSnapshot } from '@portal/contracts';
import { agentLevel, agentsCompact, agentSubline, stopCall, stopLabel } from './model.js';

const snapshot = (agents: Partial<GlanceSnapshot['agents']>): GlanceSnapshot => ({
  at: '2026-10-12T12:00:00.000Z',
  sessions: { ok: true, running: 0, waiting: 0, open: 0, items: [] },
  agents: { ok: true, running: 0, waiting: 0, rows: [], more: 0, ...agents },
  attention: { count: 0, approvals: { ok: true, count: 0, items: [] }, tickets: { ok: true, count: 0, items: [] }, ci: { ok: true, count: 0, items: [] } },
});
const ok = { failed: false, stale: false };
const NOW = Date.parse('2026-10-12T12:00:00Z');

test('the chip counts working agents; amber while one waits for an answer; grey when none', () => {
  assert.deepEqual(agentsCompact({ data: snapshot({ running: 4, waiting: 1 }), ...ok }), { value: '4', level: 'warn', title: 'Agents: 4 running and 1 waiting for you', stale: false });
  assert.deepEqual(agentsCompact({ data: snapshot({ running: 2 }), ...ok }), { value: '2', level: 'ok', title: 'Agents: 2 running', stale: false });
  assert.deepEqual(agentsCompact({ data: snapshot({}), ...ok }), { value: '0', level: 'idle', title: 'Agents: none running', stale: false });
  assert.deepEqual(agentsCompact({ data: null, failed: false, stale: false }), { value: null, level: 'unknown', title: 'Agents: loading', loading: true });
  assert.deepEqual(agentsCompact({ data: snapshot({ ok: false }), failed: false, stale: false }), { value: '-', level: 'unknown', title: 'Agents: could not be read', stale: false });
});

const row = (over: Partial<GlanceAgent>): GlanceAgent => ({ key: 'k', depth: 0, kind: 'worker', sessionId: 's1', taskId: null, title: 'Fix tests', role: null, state: 'working', since: null, stoppable: true, ...over });

test('a row: dot by state, and a second line that says what it is', () => {
  assert.deepEqual((['running', 'working', 'starting', 'waiting', 'idle', 'interrupted'] as const).map((state) => agentLevel(row({ state }))), ['ok', 'ok', 'ok', 'warn', 'idle', 'idle']);
  const since = new Date(NOW - 4 * 60_000).toISOString();
  assert.equal(agentSubline(row({ kind: 'task', role: 'Explore', since, state: 'running', taskId: 't1' }), NOW), 'Explore · 4m');
  assert.equal(agentSubline(row({ kind: 'task', role: null, since, state: 'running', taskId: 't1' }), NOW), 'Task · 4m');
  assert.equal(agentSubline(row({ kind: 'task', role: 'Explore', since: new Date(NOW - 5_000).toISOString(), state: 'running', taskId: 't1' }), NOW), 'Explore · <1m');
  assert.equal(agentSubline(row({ kind: 'worker', state: 'waiting' }), NOW), 'Worker · Needs you');
  assert.equal(agentSubline(row({ kind: 'worker', state: 'working' }), NOW), 'Worker · Working');
  assert.equal(agentSubline(row({ kind: 'session', state: 'idle' }), NOW), 'Idle');
});

test('Stop: a task is stopped by its id, a working session by interrupting its turn, anything else has no Stop', () => {
  assert.deepEqual(stopCall(row({ kind: 'task', taskId: 't9', sessionId: 's2', state: 'running' })), { kind: 'task', sessionId: 's2', taskId: 't9' });
  assert.deepEqual(stopCall(row({ kind: 'worker', sessionId: 'w1' })), { kind: 'turn', sessionId: 'w1' });
  assert.deepEqual(stopCall(row({ kind: 'session', sessionId: 'p' })), { kind: 'turn', sessionId: 'p' });
  assert.equal(stopCall(row({ stoppable: false, state: 'waiting' })), null, 'a waiting worker is answered, not stopped');
  assert.equal(stopCall(row({ kind: 'task', taskId: null })), null, 'a task without an id cannot be stopped');
  assert.equal(stopLabel(row({ kind: 'task', title: 'Map the auth module' })), 'Stop Map the auth module');
  assert.equal(stopLabel(row({ kind: 'worker', title: 'Fix tests' })), 'Stop the turn of Fix tests');
});
