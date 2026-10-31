// T-2591: a reader more than HISTORY_MAX_EVENTS behind gets only the newest of them (T-2589). The store says so (`historyAfter().gap`),
// the socket's subscribe backlog carries `gap: true`, and the REST `?after=` answer sets the X-Chat-History-Gap header, so a tab re-seeds
// from the newest page instead of showing a silent hole. A reader that is not that far behind, or one at the very start, gets no flag.
// Fixtures are built here, at run time.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { CHAT_HISTORY_GAP_HEADER, CHAT_SOCKET_PATH, type ChatEvent, type ChatServerMessage } from '@portal/contracts';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { clearResolvers } from '../authz/seam.js';
import type { Workspaces } from '../workspaces/manager.js';
import { registerChatAuthz } from './authz.js';
import { ChatController } from './controller.js';
import { createChatRoutes } from './routes.js';
import { attachChat } from './socket.js';
import { ChatStore, HISTORY_MAX_EVENTS } from './store.js';
import { FakeWorkspaces, freshStore, until } from './testkit.js';

const CAP = HISTORY_MAX_EVENTS;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  clearResolvers();
  for (const c of cleanups.splice(0)) await c();
});

/** A store with one chat of `n` assistant events, a controller over it, the chat routes and a socket server. */
async function rig(n: number) {
  const { store, dataDir } = await freshStore();
  const chat = new ChatStore(store);
  const id = `chat-${randomUUID()}`;
  chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Long chat', origin: 'ui' });
  for (let i = 0; i < n; i++) chat.appendEvent(id, { kind: 'assistant', text: `event ${i + 1}` });
  const controller = new ChatController(store, new FakeWorkspaces() as unknown as Workspaces, {});
  registerChatAuthz((sid) => controller.sessionFacts(sid));
  const server: Server = createServer();
  attachChat(server, controller, () => true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const s of sockets) await new Promise((r) => (s.readyState === s.CLOSED ? r(null) : (s.once('close', r), s.close())));
    server.close();
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  /** A tab that subscribes after `afterSeq` and collects what it is sent. */
  const subscribe = async (afterSeq: number) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${CHAT_SOCKET_PATH}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const got: ChatServerMessage[] = [];
    sock.on('message', (d) => got.push(JSON.parse(String(d)) as ChatServerMessage));
    await new Promise((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });
    sockets.push(sock);
    sock.send(JSON.stringify({ type: 'subscribe', session: id, afterSeq }));
    await until(() => got.some((m) => m.type === 'tasks'));
    return got.filter((m): m is Extract<ChatServerMessage, { type: 'events' }> => m.type === 'events');
  };
  const app = new Hono();
  app.use(async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
    (c as unknown as { set(k: string, v: unknown): void }).set('actor', { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui' });
    await next();
  });
  app.route('/', createChatRoutes(controller));
  return { chat, id, subscribe, app };
}

test('store: historyAfter flags the gap only when events between `after` and the first returned were left out', async () => {
  const r = await rig(CAP + 50);
  const far = r.chat.historyAfter(r.id, 10);
  assert.equal(far.items.length, CAP);
  assert.equal(far.items[0]!.seq, 51, 'the newest cap');
  assert.equal(far.gap, true, '11..50 were left out');
  assert.equal(r.chat.historyAfter(r.id, 0).gap, true, 'from the very start, 1..50 were left out');
  const edge = r.chat.historyAfter(r.id, 50);
  assert.deepEqual([edge.items.length, edge.items[0]!.seq, edge.gap], [CAP, 51, false], 'exactly the cap behind: nothing left out');
  const near = r.chat.historyAfter(r.id, CAP + 40);
  assert.deepEqual([near.items.length, near.gap], [10, false]);
  assert.deepEqual(r.chat.historyAfter(r.id, CAP + 50), { items: [], gap: false });
});

test('store: a chat no longer than the cap never reports a gap', async () => {
  const r = await rig(30);
  assert.deepEqual([r.chat.historyAfter(r.id, 0).items.length, r.chat.historyAfter(r.id, 0).gap], [30, false]);
  assert.equal(r.chat.historyAfter(r.id, 5).gap, false);
});

test('socket: a tab more than the cap behind gets the newest events with gap: true; one that is not gets no flag', async () => {
  const r = await rig(CAP + 50);
  const far = await r.subscribe(10);
  assert.equal(far.length, 1);
  assert.equal(far[0]!.items.length, CAP);
  assert.equal(far[0]!.items[0]!.seq, 51);
  assert.equal(far[0]!.gap, true);

  const near = await r.subscribe(CAP + 40);
  assert.equal(near.length, 1);
  assert.equal(near[0]!.items.length, 10);
  assert.equal('gap' in near[0]!, false, 'no flag when nothing was left out');
});

test('REST: ?after= past the cap sets the gap header, the body stays the plain list; near the end no header', async () => {
  const r = await rig(CAP + 50);
  const far = await r.app.request(`/${r.id}/events?after=10`);
  assert.equal(far.status, 200);
  assert.equal(far.headers.get(CHAT_HISTORY_GAP_HEADER), '1');
  const items = ((await far.json()) as { data: ChatEvent[] }).data;
  assert.ok(Array.isArray(items));
  assert.deepEqual([items.length, items[0]!.seq], [CAP, 51]);

  const near = await r.app.request(`/${r.id}/events?after=${CAP + 40}`);
  assert.equal(near.status, 200);
  assert.equal(near.headers.get(CHAT_HISTORY_GAP_HEADER), null);
  assert.equal(((await near.json()) as { data: ChatEvent[] }).data.length, 10);
});
