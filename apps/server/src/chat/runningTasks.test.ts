// T-2368: the portal read a session's whole task history (and re-prepared its SQL) where only the running tasks or one task were needed,
// and the session list ran 3 queries per row. These pin that the narrower reads answer exactly what the wide ones did.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatTask } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { glanceSources } from '../glance/authz.js';
import { buildSnapshot } from '../glance/build.js';
import { fakeCi } from '../glance/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { ChatStore } from './store.js';

async function open() {
  const key = generateSecretKey();
  const store = await Store.open({ dataDir: tempDirectory('cp-t2368-'), secretKey: parseSecretKey(key) });
  return { store, key, chat: new ChatStore(store) };
}

/** A task row as it may sit in the table: any status, NULL and ones this portal does not know included (upsertTask only writes known ones). */
function rawTask(store: Store, sessionId: string, taskId: string, status: string | null, startedAt: string | null) {
  store
    .db!.prepare('INSERT INTO chat_tasks (session_id, task_id, label, status, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, taskId, `task ${taskId}`, status, startedAt);
}

const STATUSES = ['running', 'completed', 'failed', 'killed', null, 'paused', 'RUNNING', ''] as const;

test('runningTasks is tasks() filtered to running, in the same order: NULL and unknown statuses read as running', async () => {
  const { store, chat } = await open();
  chat.create({ id: 'S', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'S', origin: 'ui' });
  chat.create({ id: 'O', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'O', origin: 'ui' });
  let n = 0;
  for (const status of STATUSES)
    for (const started of ['2026-10-25T10:00:00.000Z', null, '2026-10-25T09:00:00.000Z'])
      rawTask(store, 'S', `t${String(n++).padStart(2, '0')}`, status, started);
  rawTask(store, 'O', 'other', 'running', '2026-10-25T08:00:00.000Z'); // another session's never shows
  chat.upsertTask('S', { taskId: 'up1', started: true, status: 'running', description: 'via upsert' });
  chat.upsertTask('S', { taskId: 'up2', started: true, status: 'completed', description: 'done via upsert' });

  const all = chat.tasks('S');
  const want = all.filter((t) => t.status === 'running');
  assert.ok(want.length > 0 && want.length < all.length, 'the fixture has both running and finished tasks');
  assert.deepEqual(chat.runningTasks('S'), want);
  // Running reads: running, NULL and three unknown spellings (paused, RUNNING, empty), x3 each, plus the upserted one.
  assert.equal(want.length, 3 * 5 + 1);
  assert.deepEqual(chat.runningTasks('nobody'), []);
});

test('task(session, id) is tasks().find, and null for another session’s task or none', async () => {
  const { store, chat } = await open();
  chat.create({ id: 'S', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'S', origin: 'ui' });
  chat.create({ id: 'O', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'O', origin: 'ui' });
  rawTask(store, 'S', 'a', null, null);
  rawTask(store, 'S', 'b', 'paused', '2026-10-25T10:00:00.000Z');
  chat.upsertTask('S', { taskId: 'c', started: true, status: 'failed', description: 'c' });
  rawTask(store, 'O', 'x', 'running', null);
  for (const id of ['a', 'b', 'c'])
    assert.deepEqual(
      chat.task('S', id),
      chat.tasks('S').find((t: ChatTask) => t.taskId === id),
    );
  assert.equal(chat.task('S', 'x'), null);
  assert.equal(chat.task('S', 'missing'), null);
});

test('the running-task reads use the (session_id, status) index', async () => {
  const { store } = await open();
  const db = store.db!;
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'chat_tasks_session_status'").get());
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('S') as { detail: string }[]).map((r) => r.detail).join(' | ');
  assert.match(
    plan(`SELECT count(*) FROM chat_tasks WHERE session_id = ? AND (status IS NULL OR status = 'running')`),
    /chat_tasks_session_status/,
  );
});

test('list() and listPage() show each session exactly as get() does: waiting, waitingFor and agentsRunning', async () => {
  const { store, chat } = await open();
  const ids = ['A', 'B', 'C', 'D', 'E'];
  for (const id of ids) chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: id, origin: 'ui' });
  // A: two open asks (the oldest is the one shown) and one answered; tasks of every kind.
  chat.addRequest('A', {
    requestId: 'r1',
    kind: 'tool',
    toolName: 'Bash',
    agentLabel: null,
    title: 'Run a command',
    detail: 'ls   -la\n /tmp',
    createdAt: '',
  });
  chat.addRequest('A', { requestId: 'r2', kind: 'tool', toolName: 'Bash', agentLabel: null, title: 'Second', detail: null, createdAt: '' });
  chat.addRequest('A', {
    requestId: 'r0',
    kind: 'tool',
    toolName: 'Bash',
    agentLabel: null,
    title: 'Answered',
    detail: null,
    createdAt: '',
  });
  chat.answerRequest('A', 'r0', 'allow', 'ui');
  for (const [i, s] of STATUSES.entries()) rawTask(store, 'A', `a${i}`, s, null);
  // B: one ask with a long detail (cut at 80), no tasks.
  chat.addRequest('B', {
    requestId: 'q',
    kind: 'tool',
    toolName: 'Bash',
    agentLabel: null,
    title: 'Long',
    detail: 'x'.repeat(200),
    createdAt: '',
  });
  // C: only finished tasks; D: one running; E: nothing at all.
  chat.upsertTask('C', { taskId: 'c1', started: true, status: 'completed', description: 'c1' });
  chat.upsertTask('D', { taskId: 'd1', started: true, status: 'running', description: 'd1' });

  const listed = chat.list();
  assert.deepEqual(listed.map((s) => s.id).sort(), [...ids].sort());
  for (const s of listed) assert.deepEqual(s, chat.get(s.id), `list row ${s.id}`);
  const paged = chat.listPage({}, { limit: 2 });
  for (const s of paged.items) assert.deepEqual(s, chat.get(s.id), `page row ${s.id}`);

  const by = new Map(listed.map((s) => [s.id, s]));
  assert.deepEqual([by.get('A')!.waiting, by.get('A')!.waitingFor], [2, 'Run a command: ls -la /tmp']);
  assert.deepEqual([by.get('B')!.waiting, by.get('B')!.waitingFor], [1, `Long: ${'x'.repeat(79)}…`]);
  assert.deepEqual([by.get('E')!.waiting, by.get('E')!.waitingFor], [0, null]);
  // agentsRunning counts NULL and 'running' only (what it always counted), not unknown statuses.
  assert.deepEqual(
    ids.map((id) => by.get(id)!.agentsRunning),
    [2, 0, 0, 1, 0],
  );
});

test('the store answers the same after its database is reopened (prepared statements do not outlive their database)', async () => {
  const { store, key, chat } = await open();
  chat.create({ id: 'S', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'S', origin: 'ui' });
  chat.upsertTask('S', { taskId: 't', started: true, status: 'running', description: 't' });
  assert.equal(chat.runningTasks('S').length, 1);
  assert.equal(chat.list().length, 1);
  // The same SQL, many times: one prepared statement serves them all and they all see the newest rows.
  for (let i = 0; i < 50; i++)
    chat.upsertTask('S', { taskId: `n${i}`, started: true, status: i % 2 ? 'running' : 'completed', description: `n${i}` });
  assert.equal(chat.runningTasks('S').length, 26);
  assert.equal(chat.get('S')!.agentsRunning, 26);
  store.close();
  const again = await Store.open({ dataDir: store.dataDir, secretKey: parseSecretKey(key) });
  assert.ok(again.db && again.db !== store.db);
  const chat2 = new ChatStore(again);
  assert.equal(chat2.runningTasks('S').length, 26);
  assert.equal(chat2.list()[0]!.agentsRunning, 26);
  again.close();
});

test('the glance snapshot is the same from the running tasks as it was from the whole history', async () => {
  const { store, chat } = await open();
  // A lead with a long history and a few running, a live worker with tasks, an asleep session whose stale rows are never read, an ended one.
  const make = (id: string, parentId: string | null = null) =>
    chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: id, origin: 'ui', parentId });
  make('lead');
  chat.patchSession('lead', { process: 'live', state: 'working' });
  make('w1', 'lead');
  chat.patchSession('w1', { process: 'live', state: 'idle' });
  make('nap');
  chat.patchSession('nap', { process: 'asleep', state: 'idle' });
  make('old');
  chat.patchSession('old', { process: 'gone', state: 'ended' });
  let n = 0;
  for (const id of ['lead', 'w1', 'nap', 'old'])
    for (const status of STATUSES) rawTask(store, id, `${id}-${n++}`, status, `2026-10-25T10:${String(n % 60).padStart(2, '0')}:00.000Z`);
  for (let i = 0; i < 200; i++) rawTask(store, 'lead', `hist${i}`, 'completed', '2026-10-24T10:00:00.000Z');
  chat.addRequest('w1', { requestId: 'r', kind: 'tool', toolName: 'Bash', agentLabel: null, title: 'Run', detail: 'ls', createdAt: '' });

  const reads = (runningTasks: (id: string) => ChatTask[]) =>
    glanceSources({
      chat: { list: () => chat.list(), openRequests: (id) => chat.openRequests(id), runningTasks },
      tickets: { list: () => ({ items: [], total: 0, counts: { byStatus: {} as never, needsYou: 0, unassigned: 0, total: 0 } }) },
      ci: fakeCi([]),
    });
  const now = Date.parse('2026-10-25T12:00:00.000Z');
  const before = buildSnapshot(
    reads((id) => chat.tasks(id)),
    ownerActor(),
    now,
  ); // what it was handed until T-2368
  const after = buildSnapshot(
    reads((id) => chat.runningTasks(id)),
    ownerActor(),
    now,
  );
  assert.deepEqual(after, before);
  assert.ok(after.agents.running > 0 && after.sessions.items.some((s) => s.agents > 0), 'the fixture has agents to count');
});
