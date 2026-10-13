import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GlanceSession, GlanceSnapshot } from '@portal/contracts';
import { sessionLevel, sessionSubline, sessionsCompact, sessionTitle } from './model.js';

const snapshot = (sessions: Partial<GlanceSnapshot['sessions']>): GlanceSnapshot => ({
  at: '2026-10-12T12:00:00.000Z',
  sessions: { ok: true, running: 0, waiting: 0, open: 0, interrupted: 0, items: [], recent: [], ...sessions },
  agents: { ok: true, running: 0, waiting: 0, rows: [], more: 0 },
  attention: { count: 0, approvals: { ok: true, count: 0, items: [] }, tickets: { ok: true, count: 0, items: [] }, ci: { ok: true, count: 0, items: [] }, deploys: { ok: true, count: 0, items: [] } },
});
const ok = { failed: false, stale: false };

test('the chip counts the running sessions; its dot is amber when one waits for you, green when some run, grey when none', () => {
  assert.deepEqual(sessionsCompact({ data: snapshot({ running: 3, waiting: 1, open: 8 }), ...ok }), {
    value: '3',
    level: 'warn',
    title: 'Sessions: 3 running and 1 waiting for you, 8 open',
    stale: false,
  });
  assert.deepEqual(sessionsCompact({ data: snapshot({ running: 2, open: 2 }), ...ok }), { value: '2', level: 'ok', title: 'Sessions: 2 running, 2 open', stale: false });
  assert.deepEqual(sessionsCompact({ data: snapshot({ running: 0, open: 5 }), ...ok }), { value: '0', level: 'idle', title: 'Sessions: none running, 5 open', stale: false });
  // a waiting session with none running still warns: the number is running sessions, the dot is what needs a person
  assert.equal(sessionsCompact({ data: snapshot({ running: 0, waiting: 1, open: 1 }), ...ok }).level, 'warn');
  assert.equal(sessionsCompact({ data: snapshot({ running: 120, open: 120 }), ...ok }).value, '99+');
});

test('before the data arrives it is loading; with nothing to show it is "-" and not a number; an unreadable source is not zero', () => {
  assert.deepEqual(sessionsCompact({ data: null, failed: false, stale: false }), { value: null, level: 'unknown', title: 'Sessions: loading', loading: true });
  assert.deepEqual(sessionsCompact({ data: null, failed: true, stale: false }), { value: '-', level: 'unknown', title: 'Sessions: not available', stale: true });
  assert.deepEqual(sessionsCompact({ data: snapshot({ ok: false }), failed: false, stale: true }), { value: '-', level: 'unknown', title: 'Sessions: could not be read', stale: true });
  assert.equal(sessionsCompact({ data: snapshot({ running: 1, open: 1 }), failed: false, stale: true }).stale, true, 'old data is dimmed, not hidden');
});

const row = (over: Partial<GlanceSession>): GlanceSession => ({
  id: 's1',
  title: 'Refactor auth',
  state: 'working',
  workspaceId: 'docker/api-dev',
  claudeId: 'c1',
  claudeName: 'Satria',
  lastActivityAt: '2026-10-12T11:59:00.000Z',
  waiting: 0,
  waitingFor: null,
  pinned: false,
  branch: null,
  agents: 0,
  ...over,
});

test('a row: the state in words, then where it runs; a waiting session says what it asks instead', () => {
  assert.deepEqual(sessionSubline(row({})), { state: 'Working', rest: 'Satria · api-dev' });
  assert.deepEqual(sessionSubline(row({ claudeName: null })), { state: 'Working', rest: 'api-dev' });
  assert.deepEqual(sessionSubline(row({ state: 'waiting', waiting: 1, waitingFor: 'Run a command: npm test' })), { state: 'Needs you', rest: 'Run a command: npm test' });
  assert.deepEqual(sessionSubline(row({ state: 'waiting', waiting: 0, waitingFor: null })), { state: 'Needs you', rest: 'Satria · api-dev' });
  assert.deepEqual(sessionSubline(row({ state: 'ended' })), { state: 'Ended', rest: 'Satria · api-dev' });
});

test('a row\'s dot: waiting and interrupted ask for you, working and starting are going, idle and ended are quiet', () => {
  assert.deepEqual(
    (['waiting', 'interrupted', 'working', 'starting', 'idle', 'ended'] as const).map(sessionLevel),
    ['warn', 'warn', 'ok', 'ok', 'idle', 'idle'],
  );
});

test('a row\'s accessible sentence names the state and any requests waiting', () => {
  assert.equal(sessionTitle(row({})), 'Refactor auth: working');
  assert.equal(sessionTitle(row({ state: 'waiting', waiting: 2 })), 'Refactor auth: needs you, 2 requests waiting');
  assert.equal(sessionTitle(row({ state: 'waiting', waiting: 1 })), 'Refactor auth: needs you, 1 request waiting');
});
