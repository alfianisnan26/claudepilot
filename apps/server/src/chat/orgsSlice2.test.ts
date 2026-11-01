// Organizations slice 2 (docs/prd/organizations.md §13 P5): the chat socket asks the one `can()` for every message that names a session.
// Two people: a tab of `u_a` may watch and drive its own chat, and gets, for `u_b`'s, exactly what a session that does not exist gets
// (`removed` for a subscribe, NOT_FOUND for a send, an answer or a control). A right taken away stops what an open tab watches at once.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { CHAT_SOCKET_PATH, sessionRef, type Actor, type ChatServerMessage } from '@portal/contracts';
import { WebSocket } from 'ws';
import { clearResolvers, emitAccessChange, useSocketActor } from '../authz/seam.js';
import type { Workspaces } from '../workspaces/manager.js';
import { registerChatAuthz } from './authz.js';
import { ChatController } from './controller.js';
import { attachChat } from './socket.js';
import { ChatStore } from './store.js';
import { FakeWorkspaces, freshStore, until } from './testkit.js';

const A = 'u_Alice_000001';
const B = 'u_Bob_00000001';
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'x', via: 'ui' });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  clearResolvers();
  for (const c of cleanups.splice(0)) await c();
});

async function rig() {
  const { store, dataDir } = await freshStore();
  const controller = new ChatController(store, new FakeWorkspaces() as unknown as Workspaces, {});
  const chat = new ChatStore(store);
  chat.create({ id: 'alices', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Alice’s plan', origin: 'ui' });
  chat.create({ id: 'bobs', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Bob’s secret plan', origin: 'ui' });
  chat.appendEvent('bobs', { kind: 'assistant', text: 'bob private text' });
  const owners: Record<string, string> = { alices: A, bobs: B };
  registerChatAuthz((id) => {
    const f = controller.sessionFacts(id);
    return f ? { ...f, ownerId: owners[f.id] ?? null } : null;
  });
  const was = useSocketActor((req) => (req.headers.cookie === 's=a' ? person(A) : req.headers.cookie === 's=b' ? person(B) : null));
  const server: Server = createServer();
  attachChat(server, controller, () => true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const connect = async (cookie: string) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${CHAT_SOCKET_PATH}`, { headers: { origin: `http://127.0.0.1:${port}`, cookie } });
    const got: ChatServerMessage[] = [];
    sock.on('message', (d) => got.push(JSON.parse(String(d)) as ChatServerMessage));
    await new Promise((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });
    sockets.push(sock);
    const ack = async (uuid: string) => {
      await until(() => got.some((m) => m.type === 'ack' && m.uuid === uuid));
      return got.find((m) => m.type === 'ack' && m.uuid === uuid) as Extract<ChatServerMessage, { type: 'ack' }>;
    };
    return { got, ack, send: (m: unknown) => sock.send(JSON.stringify(m)) };
  };
  cleanups.push(async () => {
    for (const s of sockets) await new Promise((r) => (s.readyState === s.CLOSED ? r(null) : (s.once('close', r), s.close())));
    server.close();
    useSocketActor(was);
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { controller, connect, owners };
}

test('X: a tab watches its own chat; another person’s chat answers `removed`, exactly like one that does not exist, and nothing of it leaks', async () => {
  const t = await rig();
  const a = await t.connect('s=a');
  a.send({ type: 'subscribe', session: 'alices' });
  await until(() => a.got.some((m) => m.type === 'session'));
  a.send({ type: 'subscribe', session: 'bobs' });
  a.send({ type: 'subscribe', session: 'no-such-chat' });
  await until(() => a.got.filter((m) => m.type === 'removed').length === 2);
  const removed = a.got.filter((m): m is Extract<ChatServerMessage, { type: 'removed' }> => m.type === 'removed').map((m) => m.session);
  assert.deepEqual(removed.sort(), ['bobs', 'no-such-chat']);
  const text = JSON.stringify(a.got);
  assert.ok(!text.includes('bob private text') && !text.includes('Bob’s secret plan'), 'no event, title or state of B’s chat');
  // B's own tab watches it as ever.
  const b = await t.connect('s=b');
  b.send({ type: 'subscribe', session: 'bobs' });
  await until(() => b.got.some((m) => m.type === 'session'));
});

test('X: send, respond and control on another person’s chat are refused NOT_FOUND, the same as on a chat that does not exist', async () => {
  const t = await rig();
  const a = await t.connect('s=a');
  const answers: Record<string, string | undefined> = {};
  for (const session of ['bobs', 'no-such-chat']) {
    a.send({ type: 'send', session, uuid: `send-${session}`, text: 'do something' });
    a.send({ type: 'respond', session, requestId: `req-${session}`, decision: { behavior: 'allow' } });
    a.send({ type: 'control', session, op: 'interrupt', uuid: `ctl-${session}` });
    answers[`send-${session}`] = (await a.ack(`send-${session}`)).code;
    answers[`req-${session}`] = (await a.ack(`req-${session}`)).code;
    answers[`ctl-${session}`] = (await a.ack(`ctl-${session}`)).code;
  }
  for (const verb of ['send', 'req', 'ctl']) {
    assert.equal(answers[`${verb}-bobs`], 'NOT_FOUND', `${verb} on B’s chat`);
    assert.equal(answers[`${verb}-bobs`], answers[`${verb}-no-such-chat`], `${verb}: no existence leak`);
  }
});

test('X: a right taken away stops an open tab watching at once (`removed`)', async () => {
  const t = await rig();
  const a = await t.connect('s=a');
  a.send({ type: 'subscribe', session: 'alices' });
  await until(() => a.got.some((m) => m.type === 'session'));
  t.owners.alices = B; // the chat changed hands
  emitAccessChange({ userId: A, ref: sessionRef('alices'), why: 'owner_changed' });
  await until(() => a.got.some((m) => m.type === 'removed' && m.session === 'alices'));
});
