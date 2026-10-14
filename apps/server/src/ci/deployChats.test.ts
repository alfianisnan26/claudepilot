// T-277 layer 4: the portal's `[deploy-chats]` line while a deploying job runs (what the release step reads), the adapter that lists the
// attached chats, and the read-only count of open control requests over the real chat store.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import type { ChatController } from '../chat/controller.js';
import { pendingControlRequests, PENDING_CONTROL_FRESH_MS } from '../chat/liveControls.js';
import { ChatStore } from '../chat/store.js';
import { freshStore } from '../chat/testkit.js';
import { deployChatsLine, DeployChatsWatch, pendingOf } from './deployChats.js';
import { ChatSessionsAdapter, type CiAttachedChat } from './sessions.js';

const chat = (over: Partial<CiAttachedChat> = {}): CiAttachedChat => ({
  id: '3907db7f-1111-4222-8333-444455556666',
  workspaceId: 'kubernetes/kohi-event',
  claudeId: 'cl_isnan3',
  mode: 'bypassPermissions',
  tail: 'aa11bb22-0000-4000-8000-000000000001',
  pending: 0,
  ...over,
});

test('the line: short ids and facts only, every field cut to a safe alphabet, the open count summed or unknown', () => {
  assert.equal(
    deployChatsLine('rmv7l2jhh6827bf', 'release', [chat(), chat({ id: '5c9fcb5f-x', mode: 'default', pending: 2, workspaceId: 'ws_abc' })]),
    '[deploy-chats] run=rmv7l2jhh6827bf job=release attached=2 pending=2 chats=3907db7f:cl_isnan3:bypassPermissions:aa11bb22:0:kubernetes/kohi-event,5c9fcb5f:cl_isnan3:default:aa11bb22:2:ws_abc',
  );
  assert.equal(deployChatsLine('r1', 'release', []), '[deploy-chats] run=r1 job=release attached=0 pending=0 chats=-');
  // A value that tries to break the line (spaces, a newline, a second tag, a comma or colon) stays one word in its own field.
  const hostile = deployChatsLine('r1', 'release', [chat({ claudeId: 'x y\n[deploy-chats] run=r1 pending=0', mode: 'a,b:c', workspaceId: '' })]);
  assert.equal(hostile.split('\n').length, 1);
  assert.equal((hostile.match(/\[deploy-chats\]/g) ?? []).length, 1);
  assert.match(hostile, / chats=3907db7f:x_y_deploy-chats_run_r1_pending_0:a_b_c:aa11bb22:0:-$/);
  assert.equal(pendingOf([chat(), chat({ pending: null })]), '?', 'one chat the portal can not tell about makes the whole count unknown');
  assert.match(deployChatsLine('r1', 'release', [chat({ pending: null })]), / pending=\? chats=3907db7f:cl_isnan3:bypassPermissions:aa11bb22:\?:/);
});

test('the watch says it when a deploying job is first seen running, again only when the open count changes, never for other jobs', () => {
  const lines: string[] = [];
  let now: CiAttachedChat[] = [chat({ pending: 1 })];
  const w = new DeployChatsWatch(() => now, (l) => lines.push(l));
  const deps = [{ job: 'release' }];
  w.observe('r1', deps, [{ id: 'verify', status: 'running' }, { id: 'release', status: 'waiting' }]);
  // (length, not deepEqual: an asserted `[]` would narrow `lines` to never[] for the rest of the test)
  assert.equal(lines.length, 0, 'a held release says nothing; a running job that deploys nowhere neither');
  w.observe('r1', deps, [{ id: 'release', status: 'running' }]);
  w.observe('r1', deps, [{ id: 'release', status: 'running' }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[deploy-chats\] run=r1 job=release attached=1 pending=1 /);
  now = [chat({ pending: 0 })];
  w.observe('r1', deps, [{ id: 'release', status: 'running' }]);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, / pending=0 /, 'the answer is said, so the release step stops waiting');
  w.observe('r1', deps, [{ id: 'release', status: 'passed' }]);
  w.observe('r1', deps, [{ id: 'release', status: 'running' }]);
  assert.equal(lines.length, 3, 'a job seen running again (a new portal after the restart) is said once more');
  w.forget('r1');

  const fails = (): CiAttachedChat[] => {
    throw new Error('no database');
  };
  const broken = new DeployChatsWatch(fails, (l: string) => void lines.push(l));
  broken.observe('r2', deps, [{ id: 'release', status: 'running' }]);
  broken.observe('r2', deps, [{ id: 'release', status: 'running' }]);
  assert.deepEqual(lines.slice(3), ['[deploy-chats] run=r2 job=release unavailable: no_database'], 'a failure is one line, never a throw');
});

test('the adapter lists only chats attached to a live process, with their open control requests (or unknown without the count)', () => {
  const sessions = [
    { id: 'live-1', state: 'working', process: 'live', workspaceId: 'kubernetes/kohi-event', claudeId: 'c1', mode: 'bypassPermissions', claudeSessionId: 'cs-1' },
    { id: 'asleep', state: 'idle', process: 'asleep', workspaceId: 'w', claudeId: 'c1', mode: 'default', claudeSessionId: 'cs-2' },
    { id: 'ended', state: 'ended', process: 'live', workspaceId: 'w', claudeId: 'c1', mode: 'default', claudeSessionId: 'cs-3' },
    { id: 'live-2', state: 'idle', process: 'live', workspaceId: 'w', claudeId: 'c2', mode: 'plan', claudeSessionId: 'cs-4' },
  ];
  const controller = { list: () => sessions } as unknown as ChatController;
  let asked: string[] = [];
  const a = new ChatSessionsAdapter(controller, (ids) => ((asked = ids), new Map([['live-2', 3]])));
  assert.deepEqual(a.attached(), [
    { id: 'live-1', workspaceId: 'kubernetes/kohi-event', claudeId: 'c1', mode: 'bypassPermissions', tail: 'cs-1', pending: 0 },
    { id: 'live-2', workspaceId: 'w', claudeId: 'c2', mode: 'plan', tail: 'cs-4', pending: 3 },
  ]);
  assert.deepEqual(asked, ['live-1', 'live-2']);
  assert.deepEqual(
    new ChatSessionsAdapter(controller, () => null).attached().map((c) => c.pending),
    [null, null],
  );
  assert.deepEqual(
    new ChatSessionsAdapter(controller).attached().map((c) => c.pending),
    [null, null],
  );
});

test('open control requests: the portal\'s asked lines still sending and fresh, per session; answers, finished, old or other sessions do not count', async () => {
  const { store, dataDir } = await freshStore();
  try {
    let at = new Date('2026-10-14T05:00:00.000Z');
    const cs = new ChatStore(store, () => at);
    for (const id of ['s1', 's2', 's3']) cs.create({ id, workspaceId: 'docker/test', cwd: '/home/node', title: id, origin: 'ui' });
    cs.addControl('s1', 'req/old'); // asked long ago, never answered: does not hold a release
    at = new Date(at.getTime() + PENDING_CONTROL_FRESH_MS + 5_000);
    cs.addControl('s1', 'req/a');
    cs.addControl('s1', 'req/b');
    cs.addControl('s1', 'req/done');
    cs.setControlState('s1', 'req/done', 'completed');
    cs.addControl('s1', 'req/lost');
    cs.setControlState('s1', 'req/lost', 'failed');
    cs.addControl('s1', 'ans/c'); // an answer the portal gives, not a request it waits on
    cs.addControl('s2', 'req/x');
    cs.addControl('s3', 'req/y');
    const now = new Date(at.getTime() + 1_000);
    assert.deepEqual([...pendingControlRequests(store.db, ['s1', 's2'], now)!.entries()].sort(), [['s1', 2], ['s2', 1]]);
    assert.deepEqual([...pendingControlRequests(store.db, ['s1'], new Date(at.getTime() + PENDING_CONTROL_FRESH_MS + 1))!.entries()], [], 'stale ones age out');
    assert.equal(pendingControlRequests(store.db, [], now)!.size, 0);
    assert.equal(pendingControlRequests(null, ['s1'], now), null, 'no database: unknown, never zero');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
