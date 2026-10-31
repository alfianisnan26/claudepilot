import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { LiveMessage, Workspace } from '@portal/contracts';
import { WebSocket } from 'ws';
import { LiveHub } from './live.js';

const ws = (name: string, status: Workspace['status'] = 'running') =>
  ({ id: `docker/${name}`, name, target: 'docker', image: '', status, detail: '', createdAt: '2026-10-10T00:00:00Z' }) as Workspace;

let current: Workspace[] = [ws('alpha')];
let listings = 0;
let server: Server;
let hub: LiveHub;
let port = 0;
before(async () => {
  hub = new LiveHub(
    {
      workspaces: async () => (listings++, current),
      usage: async () => [],
    },
    (req) => req.headers.cookie === 'portal_session=ok',
  );
  server = createServer();
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  hub.close();
  server.close();
});

/** A signed-in tab: collects every message. */
async function tab(cookie = 'portal_session=ok', origin = `http://127.0.0.1:${port}`) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { cookie, origin } });
  const got: LiveMessage[] = [];
  socket.on('message', (d) => got.push(JSON.parse(String(d)) as LiveMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    socket.once('error', reject);
  });
  const subscribe = (...topics: string[]) => socket.send(JSON.stringify({ type: 'subscribe', topics }));
  return { socket, got, subscribe };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

test('only signed-in tabs from this origin can connect', async () => {
  await assert.rejects(tab('portal_session=nope'), /401/);
  await assert.rejects(tab('portal_session=ok', 'https://evil.example'), /403/);
});

test('a tab gets the list when it subscribes, then only changes, coalesced', async () => {
  const a = await tab();
  a.subscribe('workspaces');
  await until(() => a.got.length === 1);
  assert.deepEqual(a.got[0], { type: 'workspaces', data: [ws('alpha')] });

  // Nothing changed: a publish lists again but pushes nothing.
  hub.publish('workspaces');
  await sleep(400);
  assert.equal(a.got.length, 1);

  // A burst of changes: one listing, one push.
  const before = listings;
  current = [ws('alpha'), ws('beta', 'starting')];
  for (let i = 0; i < 10; i++) hub.publish('workspaces');
  await until(() => a.got.length === 2);
  assert.equal(listings - before, 1);
  assert.deepEqual((a.got[1] as { data: Workspace[] }).data.map((w) => w.name), ['alpha', 'beta']);

  // A second tab gets the current list at once, without waiting for a change.
  const b = await tab();
  b.subscribe('workspaces');
  await until(() => b.got.length === 1);
  assert.equal((b.got[0] as { data: Workspace[] }).data.length, 2);
  a.socket.close();
  b.socket.close();
});

test('invalidations reach only tabs that subscribed to them', async () => {
  const a = await tab();
  const b = await tab();
  a.subscribe('accounts');
  b.subscribe('system');
  await sleep(50);
  hub.publish('accounts');
  hub.publish('accounts');
  await until(() => a.got.length === 1);
  await sleep(350);
  assert.deepEqual(a.got, [{ type: 'accounts' }]);
  assert.deepEqual(b.got, []);
  a.socket.close();
  b.socket.close();
  await until(() => hub.clients === 0);
});

test('glance: a tab that subscribed is told to load the snapshot again, once for a burst, and `watching` says whether anybody listens', async () => {
  assert.equal(hub.watching('glance'), false);
  const a = await tab();
  const b = await tab();
  a.subscribe('glance');
  b.subscribe('tickets');
  await until(() => hub.watching('glance'));
  assert.equal(hub.watching('ci'), false, 'only the topics that were asked for');
  for (let i = 0; i < 5; i++) hub.publish('glance');
  await until(() => a.got.length === 1);
  await sleep(350);
  assert.deepEqual(a.got, [{ type: 'glance' }]);
  assert.deepEqual(b.got, []);
  a.socket.close();
  b.socket.close();
  await until(() => hub.clients === 0);
  assert.equal(hub.watching('glance'), false, 'and nobody once the tab is gone');
});

test('organizations slice 0: each tab keeps the person its cookie names, read once at the handshake', async () => {
  const { useSocketActor } = await import('./authz/seam.js');
  const was = useSocketActor((req) => (req.headers.cookie === 'portal_session=ok' ? { kind: 'user', userId: 'u_Second-admin', loginSessionId: 'legacy', via: 'ui' } : null));
  try {
    const t = await tab();
    await until(() => hub.actors().some((a) => a.kind === 'user' && a.userId === 'u_Second-admin'));
    t.socket.close();
  } finally {
    useSocketActor(was);
  }
});
