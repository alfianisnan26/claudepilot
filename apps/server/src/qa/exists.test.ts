// QA-032: a made-up workspace id leaves nothing behind. Creating a session for one is refused before a row exists (it used to end with a
// raw Docker error), and a GET of its Claudes does not make a Default Claude for it (a GET that wrote, for any string, for good).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { ChatController } from '../chat/controller.js';
import { FakeWorkspaces } from '../chat/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import type { Workspaces } from '../workspaces/manager.js';

async function setup() {
  const store = await Store.open({ dataDir: tempDirectory('qa-exists-'), secretKey: parseSecretKey(generateSecretKey()) });
  const controller = new ChatController(store, new FakeWorkspaces() as unknown as Workspaces);
  const real = new Set(['docker/ws-1']);
  controller.workspaceExists = async (id) => real.has(id);
  return { store, controller, real };
}
const count = (store: Store, sql: string, ...args: string[]) => (store.db!.prepare(sql).get(...args) as { n: number }).n;
const claudes = (store: Store, id: string) => count(store, 'SELECT count(*) AS n FROM workspace_claudes WHERE workspace_id = ?', id);
const sessions = (store: Store) => count(store, 'SELECT count(*) AS n FROM chat_sessions');

test('a session is not made for a workspace that does not exist, and nothing is left behind', async () => {
  const { store, controller } = await setup();
  try {
    for (const id of ['docker/typo', 'docker/x%2f..%2f..%2fcontainers', 'docker/x?force=true']) {
      await assert.rejects(controller.create({ workspaceId: id }), (e: unknown) => isAppError(e) && e.status === 422 && /doesn’t exist/.test(e.message), id);
    }
    assert.equal(sessions(store), 0);
    assert.equal(claudes(store, 'docker/typo'), 0, 'no Default Claude either');
  } finally {
    controller.stop();
    store.close();
  }
});

test('listing the Claudes of a workspace that does not exist makes no row; one that exists gets its Default; history stays listable', async () => {
  const { store, controller, real } = await setup();
  try {
    assert.deepEqual(await controller.claudesOf('docker/made-up'), []);
    assert.deepEqual(await controller.claudesOf('docker/x%2f..%2fy'), []);
    assert.equal(claudes(store, 'docker/made-up'), 0);

    const [first] = await controller.claudesOf('docker/ws-1');
    assert.equal(first?.name, 'Default');
    assert.equal(claudes(store, 'docker/ws-1'), 1);

    // The workspace is removed later: its Claudes (and so its sessions' history) are still listed, and nothing new is made.
    real.delete('docker/ws-1');
    assert.equal((await controller.claudesOf('docker/ws-1')).length, 1);

    // One id with no `/` is still a bad request, not an empty list.
    await assert.rejects(controller.claudesOf('nowhere'), (e: unknown) => isAppError(e) && e.status === 422);
    // A read-only lookup by id never makes a Default.
    assert.equal(controller.claudeOf('docker/made-up', 'd_0000000000000000'), null);
    assert.equal(claudes(store, 'docker/made-up'), 0);
  } finally {
    controller.stop();
    store.close();
  }
});

test('the reconciler ignores an id that is not a workspace: no row, no runtime asked; a real id still gets its row', async () => {
  const { Reconciler } = await import('../delivery/reconciler.js');
  const store = await Store.open({ dataDir: tempDirectory('qa-recon-'), secretKey: parseSecretKey(generateSecretKey()) });
  const asked: string[] = [];
  try {
    const reconciler = new Reconciler(store, (target) => (asked.push(target), undefined), () => [], []);
    for (const id of ['docker/x%2f..%2f..%2fcontainers', '../x', 'docker/x?force=true', 'docker/a b', 'nowhere', '']) await reconciler.request(id, 'qa');
    assert.deepEqual(asked, [], 'no runtime was asked');
    assert.equal(count(store, 'SELECT count(*) AS n FROM workspace_delivery'), 0);
    await reconciler.request('docker/ws-1', 'qa');
    assert.equal(count(store, 'SELECT count(*) AS n FROM workspace_delivery'), 1);
  } finally {
    store.close();
  }
});
