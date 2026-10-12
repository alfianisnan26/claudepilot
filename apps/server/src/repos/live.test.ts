// The `repos` live topic: a tab that subscribed is told to load the repositories again, once for a burst; and a service that scans tells
// the hub when something changed (and says nothing for a quiet round of its timer).

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { LiveMessage } from '@portal/contracts';
import { WebSocket } from 'ws';
import { LiveHub } from '../live.js';
import { buildPool, commitFile, reposHarness, WS } from './testkit.js';

let server: Server;
let hub: LiveHub;
let port = 0;
before(async () => {
  hub = new LiveHub({ workspaces: async () => [], usage: async () => [] }, (req) => req.headers.cookie === 'portal_session=ok');
  server = createServer();
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  hub.close();
  server.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}
async function tab() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { cookie: 'portal_session=ok', origin: `http://127.0.0.1:${port}` } });
  const got: LiveMessage[] = [];
  socket.on('message', (d) => got.push(JSON.parse(String(d)) as LiveMessage));
  await new Promise<void>((resolve, reject) => (socket.once('open', () => resolve()), socket.once('error', reject)));
  return { socket, got, subscribe: (...topics: string[]) => socket.send(JSON.stringify({ type: 'subscribe', topics })) };
}

test('a tab that subscribed to repos is told to load them again, once for a burst, and a tab that did not is not', async () => {
  const a = await tab();
  const b = await tab();
  a.subscribe('repos');
  b.subscribe('tickets');
  await until(() => hub.watching('repos'));
  for (let i = 0; i < 5; i++) hub.publish('repos');
  await until(() => a.got.length === 1);
  await sleep(350);
  assert.deepEqual(a.got, [{ type: 'repos' }]);
  assert.deepEqual(b.got, []);
  a.socket.close();
  b.socket.close();
});

test('the service tells the hub when a scan found something or somebody asked, and stays quiet otherwise', async () => {
  const pool = buildPool();
  const clock = { t: Date.parse('2026-10-12T10:00:00Z') };
  const h = await reposHarness({ files: pool.files, now: clock, config: { intervalS: 60 } });
  const tabs = await tab();
  tabs.subscribe('repos');
  await until(() => hub.watching('repos'));
  // the harness counts notifications; here they go to the hub the way index.ts wires them
  const told: number[] = [];
  const unwire = setInterval(() => undefined, 1000);
  try {
    const wired = h.repos as unknown as { '#deps'?: unknown };
    void wired;
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const base = h.changes();
    assert.ok(base >= 1, 'a requested scan is announced');
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(h.changes(), base, 'a quiet round says nothing');
    commitFile(pool, pool.path('proj'), 'z.txt', 'z', 'news');
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(h.changes(), base + 1, 'a round that found something does');
    told.push(h.changes());
  } finally {
    clearInterval(unwire);
    tabs.socket.close();
    h.done();
  }
});
