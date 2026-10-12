import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { CHAT_SOCKET_PATH, type ChatServerMessage } from '@portal/contracts';
import { WebSocket } from 'ws';
import { clearResolvers } from '../authz/seam.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { registerChatAuthz } from './authz.js';
import { ChatController } from './controller.js';
import { attachChat } from './socket.js';
import { ChatStore } from './store.js';
import { FakeExec, FakeWorkspaces, freshStore, line, until } from './testkit.js';

class Workspaces2 extends FakeWorkspaces {
  readonly btwRuns: { command: string[]; exec: FakeExec }[] = [];
  override async exec(target: string, name: string, command: string[]): Promise<ExecSession> {
    if (command[1] === '-c' && command.includes('--safe-mode')) {
      const exec = new FakeExec();
      this.btwRuns.push({ command, exec });
      return exec;
    }
    return super.exec(target, name, command);
  }
}

const init = line({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'claude-opus-5-5', slash_commands: [] });
const delta = (t: string) => line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const result = (t: string) => line({ type: 'result', subtype: 'success', is_error: false, result: t, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {} });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  clearResolvers();
  for (const c of cleanups.splice(0)) await c();
});

async function rig() {
  const { store, dataDir } = await freshStore();
  const ws = new Workspaces2();
  const controller = new ChatController(store, ws as unknown as Workspaces, {});
  const chat = new ChatStore(store);
  chat.create({ id: 'mine', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Mine', origin: 'ui' });
  chat.create({ id: 'theirs', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Theirs', origin: 'ui' });
  // `theirs` belongs to another user.
  registerChatAuthz((id) => {
    const f = controller.sessionFacts(id);
    return f ? { ...f, ownerId: f.id === 'theirs' ? 'u_a' : null } : null;
  });
  controller.btw.start();
  const server: Server = createServer();
  attachChat(server, controller, () => true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${CHAT_SOCKET_PATH}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const got: ChatServerMessage[] = [];
    sock.on('message', (d) => got.push(JSON.parse(String(d)) as ChatServerMessage));
    await new Promise((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });
    sockets.push(sock);
    return { sock, got, send: (m: unknown) => sock.send(JSON.stringify(m)) };
  };
  cleanups.push(async () => {
    for (const s of sockets) await new Promise((r) => (s.readyState === s.CLOSED ? r(null) : (s.once('close', r), s.close())));
    server.close();
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { controller, ws, chat, connect, store };
}

const snapsOf = (got: ChatServerMessage[]) => got.flatMap((m) => (m.type === 'btw' ? [m.item] : []));

test('socket: btw_ask answers on the asking person\'s tabs that watch the session, and on no tab that does not', async () => {
  const t = await rig();
  const a = await t.connect();
  const sameUser = await t.connect();
  const elsewhere = await t.connect();
  a.send({ type: 'subscribe', session: 'mine' });
  sameUser.send({ type: 'subscribe', session: 'mine' });
  elsewhere.send({ type: 'subscribe', session: 'theirs' });
  await until(() => [a, sameUser].every((c) => c.got.some((m) => m.type === 'tasks')));

  const id = randomUUID();
  a.send({ type: 'btw_ask', session: 'mine', btw: id, question: 'what is going on?' });
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  t.ws.btwRuns[0]!.exec.push(init);
  t.ws.btwRuns[0]!.exec.push(delta('Not much.'));
  t.ws.btwRuns[0]!.exec.push(result('Not much.'));
  await until(() => snapsOf(a.got).some((s) => s.status === 'answered'));
  await until(() => snapsOf(sameUser.got).some((s) => s.status === 'answered'));

  assert.equal(snapsOf(a.got)[0]!.status, 'running');
  assert.ok(a.got.some((m) => m.type === 'btw_delta' && m.btw === id && m.text === 'Not much.' && m.seq === 1));
  assert.equal(snapsOf(a.got).at(-1)!.answer, 'Not much.');
  assert.equal(snapsOf(elsewhere.got).length, 0, 'a tab that does not watch the session hears nothing');
  assert.equal(elsewhere.got.some((m) => m.type === 'btw_delta'), false);
});

test('socket: a refusal that makes no btw is an ack with its code, keyed by the btw id; another user\'s session is not found', async () => {
  const t = await rig();
  const a = await t.connect();
  a.send({ type: 'btw_ask', session: 'mine', btw: 'btw-bad-0001', question: '   ' });
  await until(() => a.got.some((m) => m.type === 'ack' && m.uuid === 'btw-bad-0001'));
  const bad = a.got.find((m): m is Extract<ChatServerMessage, { type: 'ack' }> => m.type === 'ack' && m.uuid === 'btw-bad-0001')!;
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'VALIDATION_FAILED');

  a.send({ type: 'btw_ask', session: 'theirs', btw: 'btw-bad-0002', question: 'let me see' });
  await until(() => a.got.some((m) => m.type === 'ack' && m.uuid === 'btw-bad-0002'));
  const denied = a.got.find((m): m is Extract<ChatServerMessage, { type: 'ack' }> => m.type === 'ack' && m.uuid === 'btw-bad-0002')!;
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'NOT_FOUND');
  assert.equal(t.ws.btwRuns.length, 0);

  a.send({ type: 'btw_ask', session: 'no-such-session', btw: 'btw-bad-0003', question: 'x' });
  await until(() => a.got.some((m) => m.type === 'ack' && m.uuid === 'btw-bad-0003'));
  assert.equal((a.got.find((m) => m.type === 'ack' && m.uuid === 'btw-bad-0003') as { code?: string }).code, 'NOT_FOUND', 'the same answer as a session of someone else\'s');
});

test('socket: another user\'s side question on a session is never sent to a tab of someone else, even one watching that session', async () => {
  const t = await rig();
  const watcher = await t.connect();
  watcher.send({ type: 'subscribe', session: 'theirs' });
  await until(() => watcher.got.some((m) => m.type === 'tasks'));
  // u_a asks on their own session while the owner's tab watches it.
  const A = { kind: 'user', userId: 'u_a', loginSessionId: 'x', via: 'ui' } as const;
  await t.controller.btw.ask(A, 'theirs', 'btw-theirs-0001', 'a private question');
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  t.ws.btwRuns[0]!.exec.push(init);
  t.ws.btwRuns[0]!.exec.push(delta('a private answer'));
  t.ws.btwRuns[0]!.exec.push(result('a private answer'));
  await t.controller.btw.idle();
  assert.equal(snapsOf(watcher.got).length, 0);
  assert.equal(watcher.got.some((m) => m.type === 'btw_delta'), false);
  assert.ok(!JSON.stringify(watcher.got).includes('private'));
  // And a reconnecting tab of the owner does not get it replayed either.
  const again = await t.connect();
  again.send({ type: 'subscribe', session: 'theirs' });
  await until(() => again.got.some((m) => m.type === 'tasks'));
  assert.equal(snapsOf(again.got).length, 0);
});

test('socket: a tab that subscribes after the answer gets the open card again; close stops it coming back; pin acks by its uuid and the card arrives as an event', async () => {
  const t = await rig();
  const a = await t.connect();
  a.send({ type: 'subscribe', session: 'mine' });
  await until(() => a.got.some((m) => m.type === 'tasks'));
  a.send({ type: 'btw_ask', session: 'mine', btw: 'btw-keep-0001', question: 'remember this' });
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  t.ws.btwRuns[0]!.exec.push(init);
  t.ws.btwRuns[0]!.exec.push(result('Remembered.'));
  await until(() => snapsOf(a.got).some((s) => s.status === 'answered'));

  const b = await t.connect();
  b.send({ type: 'subscribe', session: 'mine' });
  await until(() => snapsOf(b.got).length > 0);
  assert.deepEqual(snapsOf(b.got).map((s) => [s.id, s.status, s.answer]), [['btw-keep-0001', 'answered', 'Remembered.']]);

  b.send({ type: 'btw_pin', session: 'mine', btw: 'btw-keep-0001', uuid: 'pin-1' });
  await until(() => b.got.some((m) => m.type === 'ack' && m.uuid === 'pin-1'));
  assert.equal((b.got.find((m) => m.type === 'ack' && m.uuid === 'pin-1') as { ok: boolean }).ok, true);
  await until(() => a.got.some((m) => m.type === 'events' && m.items.some((e) => e.btw?.id === 'btw-keep-0001')));
  b.send({ type: 'btw_pin', session: 'mine', btw: 'btw-keep-0001', uuid: 'pin-2' });
  await until(() => b.got.some((m) => m.type === 'ack' && m.uuid === 'pin-2'));
  assert.equal((b.got.find((m) => m.type === 'ack' && m.uuid === 'pin-2') as { ok: boolean; code?: string }).code, 'CONFLICT');

  b.send({ type: 'btw_close', session: 'mine', btw: 'btw-keep-0001' });
  await until(() => snapsOf(a.got).some((s) => s.closed));
  const c = await t.connect();
  c.send({ type: 'subscribe', session: 'mine' });
  await until(() => c.got.some((m) => m.type === 'tasks'));
  assert.equal(snapsOf(c.got).length, 0, 'a closed card is not replayed');
});

test('socket: cancel from a tab stops the run', async () => {
  const t = await rig();
  const a = await t.connect();
  a.send({ type: 'subscribe', session: 'mine' });
  await until(() => a.got.some((m) => m.type === 'tasks'));
  a.send({ type: 'btw_ask', session: 'mine', btw: 'btw-stop-0001', question: 'slow' });
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  t.ws.btwRuns[0]!.exec.push(init);
  a.send({ type: 'btw_cancel', session: 'mine', btw: 'btw-stop-0001' });
  await until(() => snapsOf(a.got).some((s) => s.status === 'cancelled'));
  assert.match(t.ws.btwRuns[0]!.exec.written, /"subtype":"interrupt"/);
});
