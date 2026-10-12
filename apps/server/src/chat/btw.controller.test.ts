import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { sessionRef, type ChatServerMessage } from '@portal/contracts';
import { can, clearResolvers, declaredPolicies, ownerActor } from '../authz/seam.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { CHAT_SOCKET_POLICY_KEY, registerChatAuthz } from './authz.js';
import { ChatController } from './controller.js';
import { ChatStore } from './store.js';
import { FakeExec, FakeWorkspaces, freshStore, line, until } from './testkit.js';

/** The fake workspace host, plus a run of the btw command (the `sh -c` script that starts a tool-free claude) it hands the test to script. */
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
const result = (t: string) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: t, total_cost_usd: 0.002, usage: { input_tokens: 40, output_tokens: 20 }, modelUsage: { 'claude-opus-5-5': { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, costUSD: 0.002 } } });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  clearResolvers();
  for (const c of cleanups.splice(0)) await c();
});

async function make(opts: { secrets?: string[] } = {}) {
  const { store, dataDir } = await freshStore();
  const ws = new Workspaces2();
  const controller = new ChatController(store, ws as unknown as Workspaces, {});
  controller.secretValues = () => opts.secrets ?? [];
  const chat = new ChatStore(store);
  const sid = 'sess-controller-1';
  chat.create({ id: sid, workspaceId: 'docker/ws1', cwd: '/home/node/proj', title: 'T', origin: 'ui' });
  controller.btw.start();
  registerChatAuthz((id) => controller.sessionFacts(id));
  const messages: ChatServerMessage[] = [];
  controller.onEvent((_id, msg) => messages.push(msg));
  const btwOut: ChatServerMessage[] = [];
  controller.btw.onMessage((_u, _s, m) => btwOut.push(m));
  cleanups.push(async () => {
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { store, controller, ws, chat, sid, messages, btwOut };
}

test('through the controller: a run in the workspace, nothing written to the session\'s process, no event, no turn', async () => {
  const t = await make();
  t.chat.appendEvent(t.sid, { kind: 'user', text: 'refactor the parser' });
  t.chat.appendEvent(t.sid, { kind: 'assistant', text: 'Done: the parser is split in two files.' });
  const opsBefore = [...t.ws.ops];
  const turns: unknown[] = [];
  const sides: unknown[] = [];
  t.controller.onUsage = (turn) => void turns.push(turn);
  t.controller.onSideUsage = (turn) => void sides.push(turn);

  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0001', 'how many files now?');
  await until(() => t.ws.btwRuns.length === 1 && t.ws.btwRuns[0]!.exec.written.length > 0);
  const run = t.ws.btwRuns[0]!;
  assert.ok(run.command.includes('--tools'));
  assert.equal(run.command[run.command.indexOf('--tools') + 1], '');
  assert.match(run.exec.written, /split in two files/);
  run.exec.push(init);
  run.exec.push(delta('Two.'));
  run.exec.push(result('Two.'));
  await t.controller.btw.idle();

  const snap = t.btwOut.findLast((m) => m.type === 'btw');
  assert.equal(snap?.type === 'btw' && snap.item.status, 'answered');
  // The session's own machinery heard nothing: no process command, no FIFO line, no event, no turn hook.
  // The only host command a side question runs is the read-only account check a start makes too (`authcheck`): no start, send, stop or status.
  assert.deepEqual(t.ws.ops.filter((o) => o !== 'authcheck'), opsBefore, 'no start, send, stop or status');
  assert.equal(t.ws.sends.length, 0);
  assert.equal(t.chat.history(t.sid, 0).length, 2);
  assert.equal(turns.length, 0, 'onUsage (a turn finished) never fires for a side question');
  assert.equal(sides.length, 1, 'onSideUsage does');
  assert.equal(t.messages.filter((m) => m.type === 'events' || m.type === 'session').length, 0, 'no events or session updates went to the session\'s tabs');
  const row = t.chat.row(t.sid)!;
  assert.equal(row.turns, 0);
  assert.equal(row.cost_est_usd, 0);
  assert.equal(row.state, 'starting', 'the state the session had');
  assert.equal(t.chat.usageSince(0).length, 1);
});

test('through the controller: the workspace\'s secret values are taken out of the context, the question and the answer', async () => {
  const t = await make({ secrets: ['correct-horse-battery'] });
  t.chat.appendEvent(t.sid, { kind: 'user', text: 'password is correct-horse-battery' });
  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0002', 'repeat correct-horse-battery');
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  const run = t.ws.btwRuns[0]!;
  assert.ok(!run.exec.written.includes('correct-horse-battery'));
  run.exec.push(init);
  run.exec.push(delta('It is correct-horse'));
  run.exec.push(delta('-battery.'));
  run.exec.push(result('It is correct-horse-battery.'));
  await t.controller.btw.idle();
  const all = JSON.stringify(t.btwOut);
  assert.ok(!all.includes('correct-horse-battery'));
  assert.ok(!all.includes('correct-horse'));
});

test('through the controller: the spending gate and the sign-in check a start makes apply to a side question too', async () => {
  const t = await make();
  t.controller.sendGate = () => new AppError('FORBIDDEN', 'The daily budget is used up.');
  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0003', 'q');
  assert.deepEqual(t.btwOut.findLast((m) => m.type === 'btw') && (t.btwOut.findLast((m) => m.type === 'btw') as { item: { reason?: string } }).item.reason, 'no_quota');
  t.controller.sendGate = undefined;
  // A workspace on a Claude's own sign-in (no pool): that Claude must be signed in, as for a start.
  t.controller.pooled = () => false;
  t.controller.signedIn = async () => false;
  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0004', 'q');
  assert.equal((t.btwOut.findLast((m) => m.type === 'btw') as { item: { reason?: string } }).item.reason, 'signed_out');
  assert.equal(t.ws.btwRuns.length, 0);
});

test('through the controller: the limit comes from the shared settings', async () => {
  const t = await make();
  t.controller.btwSettings = (key) => (key === 'chat.btw.limit' ? 1 : undefined);
  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0005', 'first');
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  t.ws.btwRuns[0]!.exec.push(init);
  t.ws.btwRuns[0]!.exec.push(result('ok'));
  await t.controller.btw.idle();
  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0006', 'second');
  assert.equal((t.btwOut.findLast((m) => m.type === 'btw') as { item: { reason?: string } }).item.reason, 'rate_limit');
});

test('pin through the controller: the card is a stored event every tab of the session receives, and it reads back whole', async () => {
  const t = await make();
  await t.controller.btw.ask(ownerActor(), t.sid, 'btw-ctrl-0007', 'summarize');
  await until(() => !!t.ws.btwRuns[0]?.exec.written.length);
  t.ws.btwRuns[0]!.exec.push(init);
  t.ws.btwRuns[0]!.exec.push(result('A short summary.'));
  await t.controller.btw.idle();
  const ev = t.controller.btw.pin(ownerActor(), t.sid, 'btw-ctrl-0007');
  const broadcast = t.messages.find((m) => m.type === 'events');
  assert.ok(broadcast && broadcast.type === 'events');
  assert.equal(broadcast.items[0]!.btw?.answer, 'A short summary.');
  assert.equal(t.controller.history(t.sid, 0).at(-1)!.seq, ev.seq);
  assert.equal(t.controller.history(t.sid, 0).at(-1)!.btw?.question, 'summarize');
});

test('the session is read through one resolver: the owner may operate it, another user may not, and the chat socket is declared', async () => {
  const t = await make();
  assert.equal(can(ownerActor(), 'operate', sessionRef(t.sid)).allow, true);
  const other = can({ kind: 'user', userId: 'u_b', loginSessionId: 'x', via: 'ui' }, 'view', sessionRef(t.sid));
  assert.equal(other.allow, false);
  assert.equal(other.allow === false && other.reason, 'not_found', 'the same answer as a session that does not exist');
  assert.equal(can(ownerActor(), 'operate', sessionRef('no-such')).allow, false);
  assert.deepEqual(declaredPolicies().get(CHAT_SOCKET_POLICY_KEY), { kind: 'signed-in' });
  assert.equal(CHAT_SOCKET_POLICY_KEY, 'ALL /api/chat/live');
  // A folded session's old id resolves to the chat that took it in.
  t.store.db!.prepare('INSERT INTO chat_session_aliases (alias_id, session_id) VALUES (?, ?)').run('old-id', t.sid);
  assert.equal(t.controller.sessionFacts('old-id')?.id, t.sid);
});
