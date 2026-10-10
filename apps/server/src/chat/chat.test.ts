import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ChatController } from './controller.js';
import { allowResponse, denyResponse, errorResponse, interruptRequest, parseLine, requestDetail, requestTitle, userLine } from './protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/* ========================= protocol (pure) ========================= */

test('parseLine: system/init sets model and mode, reports the session id, and stores Ready once', () => {
  const p = parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S', model: 'claude-opus-5-5', permissionMode: 'default', apiKeySource: 'ANTHROPIC_API_KEY' }));
  assert.equal(p.sessionIdSeen, 'S');
  assert.deepEqual(p.sessionPatch, { model: 'claude-opus-5-5', mode: 'default' });
  assert.deepEqual(p.stored.map((e) => e.kind), ['system']);
  assert.equal(p.stored[0]!.text, 'Ready');
});

test('parseLine: system/status requesting goes to working; other statuses are ignored', () => {
  assert.deepEqual(parseLine(JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' })).sessionPatch, { state: 'working' });
  const other = parseLine(JSON.stringify({ type: 'system', subtype: 'status', status: 'cooling' }));
  assert.equal(other.sessionPatch, undefined);
  assert.equal(other.stored.length, 0);
});

test('parseLine: a text_delta stream_event is an ephemeral delta and stores nothing', () => {
  const p = parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, parent_tool_use_id: null }));
  assert.deepEqual(p.delta, { agentLabel: null, text: 'Hi' });
  assert.equal(p.stored.length, 0);
});

test('parseLine: assistant text and tool_use blocks are stored with the agent label', () => {
  const p = parseLine(JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: 'a1', uuid: 'u1' }));
  assert.deepEqual(p.stored.map((e) => e.kind), ['assistant', 'tool_use']);
  assert.equal(p.stored[0]!.text, 'Hello');
  assert.equal(p.stored[0]!.agentLabel, 'a1');
  assert.equal(p.stored[1]!.toolName, 'Bash');
});

test('parseLine: an incoming tool_result is stored; a replayed string user line is ignored', () => {
  const tr = parseLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok', is_error: false }] }, parent_tool_use_id: null }));
  assert.deepEqual(tr.stored.map((e) => e.kind), ['tool_result']);
  assert.equal(tr.stored[0]!.text, 'ok');
  const replay = parseLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi again' }, isReplay: true }));
  assert.equal(replay.stored.length, 0);
});

test('parseLine: a successful result stores the result, goes idle, and carries cost and a turn', () => {
  const p = parseLine(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.0004, num_turns: 2, result: 'done', is_error: false, session_id: 'S' }));
  assert.deepEqual(p.stored.map((e) => e.kind), ['result']);
  assert.equal(p.stored[0]!.costUsd, 0.0004);
  assert.deepEqual(p.sessionPatch, { state: 'idle', turnsDelta: 1, cost: 0.0004 });
  assert.equal(p.sessionIdSeen, 'S');
});

test('parseLine: a failed result also stores an error event', () => {
  const p = parseLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0, is_error: true, result: 'too many turns', session_id: 'S' }));
  assert.deepEqual(p.stored.map((e) => e.kind), ['result', 'error']);
  assert.equal(p.stored[1]!.text, 'too many turns');
});

test('parseLine: can_use_tool becomes a tool request with a built title/detail and goes waiting', () => {
  const p = parseLine(JSON.stringify({ type: 'control_request', request_id: 'R', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' }, description: 'cmd', tool_use_id: 'toolu_w' } }));
  assert.equal(p.request?.requestId, 'R');
  assert.equal(p.request?.kind, 'tool');
  assert.equal(p.request?.toolName, 'Bash');
  assert.equal(p.request?.title, 'Run a command');
  assert.equal(p.request?.detail, 'rm -rf /tmp/x');
  assert.equal(p.request?.toolUseId, 'toolu_w');
  assert.deepEqual(p.sessionPatch, { state: 'waiting' });
});

test('parseLine: an unsupported control_request surfaces its id as a controlError and stores nothing', () => {
  const p = parseLine(JSON.stringify({ type: 'control_request', request_id: 'R2', request: { subtype: 'mcp_message' } }));
  assert.equal(p.controlError, 'R2');
  assert.equal(p.stored.length, 0);
});

test('parseLine: api_retry is stored as a retry; malformed and unknown lines are ignored', () => {
  assert.deepEqual(parseLine(JSON.stringify({ type: 'api_retry', attempt: 1 })).stored.map((e) => e.kind), ['retry']);
  assert.deepEqual(parseLine('not json').stored, []);
  assert.deepEqual(parseLine(JSON.stringify({ type: 'whatever' })).stored, []);
});

test('builders: each is one JSON line ending in a newline, and allow omits updatedInput', () => {
  for (const line of [userLine('hi'), allowResponse('R'), denyResponse('R', 'no'), errorResponse('R', 'unsupported'), interruptRequest('u')]) {
    assert.ok(line.endsWith('\n'), 'ends in a newline');
    assert.doesNotThrow(() => JSON.parse(line));
  }
  const allow = JSON.parse(allowResponse('R')) as { response: { request_id: string; response: Record<string, unknown> } };
  assert.equal(allow.response.response.behavior, 'allow');
  assert.ok(!('updatedInput' in allow.response.response), 'no updatedInput, so the CLI runs the input it holds');
  assert.equal((JSON.parse(userLine('hi there')) as { message: { content: string } }).message.content, 'hi there');
  assert.equal((JSON.parse(denyResponse('R', 'because')) as { response: { response: { message: string } } }).response.response.message, 'because');
  assert.equal((JSON.parse(interruptRequest('u')) as { request: { subtype: string } }).request.subtype, 'interrupt');
});

test('helpers: titles and redacted, truncated details', () => {
  assert.equal(requestTitle('Bash'), 'Run a command');
  assert.equal(requestTitle('Write'), 'Write a file');
  assert.equal(requestTitle('Weird'), 'Use Weird');
  assert.equal(requestTitle(null), 'Use a tool');
  assert.equal(requestDetail('Write', { file_path: '/a/b.txt' }), '/a/b.txt');
  assert.equal(requestDetail('Unknown', { foo: 'bar' }), null);
  assert.equal(requestDetail('Bash', {})?.length ?? null, null);
  assert.equal(requestDetail('Bash', { command: 'x'.repeat(500) })?.length, 200);
});

/* ========================= controller (fake workspaces) ========================= */

/** A controllable stand-in for one `workspaces.exec` call. */
class FakeExec implements ExecSession {
  readonly #data: ((b: Buffer) => void)[] = [];
  readonly #exit: ((code: number | null) => void)[] = [];
  written = '';
  closed = false;
  write(d: string): void {
    this.written += d;
  }
  close(): void {
    this.closed = true;
  }
  onData(fn: (b: Buffer) => void): void {
    this.#data.push(fn);
  }
  onExit(fn: (code: number | null) => void): void {
    this.#exit.push(fn);
  }
  push(line: string): void {
    const b = Buffer.from(line);
    for (const fn of this.#data) fn(b);
  }
  exit(code: number | null = 0): void {
    for (const fn of this.#exit) fn(code);
  }
}

/** A fake Workspaces whose `exec` simulates cp-session: start/status/stop reply, tail stays open, send records. */
class FakeWorkspaces {
  readonly tails: FakeExec[] = [];
  readonly sends: { args: string[]; line: string }[] = [];
  starts = 0;
  stops = 0;
  runtimeFor(target: string): object | undefined {
    return target === 'docker' ? {} : undefined; // only the docker target exists
  }
  async exec(_target: string, _name: string, command: string[]): Promise<ExecSession> {
    const exec = new FakeExec();
    const cmd = command[2]; // ['sh', <script>, <cmd>, ...]
    if (cmd === 'start') {
      this.starts++;
      setTimeout(() => {
        exec.push('4242 2026-10-10T12:00:00Z\n');
        exec.exit(0);
      }, 0);
    } else if (cmd === 'tail') {
      this.tails.push(exec); // kept open; the test pushes lines
    } else if (cmd === 'send') {
      setTimeout(() => {
        this.sends.push({ args: command.slice(2), line: exec.written });
        exec.exit(0);
      }, 0);
    } else if (cmd === 'status') {
      setTimeout(() => {
        exec.push('live 4242\n');
        exec.exit(0);
      }, 0);
    } else if (cmd === 'stop') {
      this.stops++;
      setTimeout(() => exec.exit(0), 0);
    } else {
      setTimeout(() => exec.exit(0), 0);
    }
    return exec;
  }
}

async function freshStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-chat-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  return { store, dataDir };
}

test('controller: create launches a reader, stores the transcript, sends, resolves a request, and ends', async () => {
  const { store, dataDir } = await freshStore();
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  const deltas: { agentLabel: string | null; text: string }[] = [];
  controller.onEvent((_id, msg) => {
    if (msg.type === 'delta') deltas.push({ agentLabel: msg.agentLabel, text: msg.text });
  });

  try {
    const session = controller.create({ workspaceId: 'docker/ws1' });
    assert.equal(session.state, 'starting');
    const id = session.id;

    // The start exec runs and the reader follows the segment.
    await until(() => ws.tails.length === 1);
    await until(() => controller.get(id)?.state === 'idle');
    await sleep(20); // let the tail attach its data handler
    const tail = ws.tails[0]!;

    // A turn: init, a live delta, a finished block, and a result.
    tail.push(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'claude-opus-5-5', permissionMode: 'default' })}\n`);
    tail.push(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }, parent_tool_use_id: null })}\n`);
    tail.push(`${JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, parent_tool_use_id: null, uuid: 'u1' })}\n`);
    tail.push(`${JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.0004, num_turns: 1, result: 'done', is_error: false, session_id: id })}\n`);

    await until(() => controller.history(id).length >= 3);
    const hist = controller.history(id);
    assert.deepEqual(hist.map((e) => e.kind), ['system', 'assistant', 'result']);
    assert.deepEqual(hist.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(deltas, [{ agentLabel: null, text: 'Hel' }], 'the delta was dispatched, not stored');
    const afterResult = controller.get(id)!;
    assert.equal(afterResult.state, 'idle');
    assert.equal(afterResult.costUsd, 0.0004);
    assert.equal(afterResult.turns, 1);
    assert.equal(afterResult.model, 'claude-opus-5-5');

    // Send a message: the user event is stored and a user line is written to the host.
    await controller.send(id, 'c-uuid-1', 'please run it');
    await until(() => ws.sends.some((s) => s.line.includes('please run it')));
    const userLines = controller.history(id).filter((e) => e.kind === 'user');
    assert.equal(userLines.length, 1);
    assert.equal(userLines[0]!.text, 'please run it');
    assert.equal(controller.get(id)!.state, 'working');
    const sent = ws.sends.find((s) => s.line.includes('please run it'))!;
    assert.equal((JSON.parse(sent.line) as { type: string; message: { content: string } }).type, 'user');
    assert.equal(sent.args[0], 'send');

    // A permission request from the agent: one open request, state waiting.
    tail.push(`${JSON.stringify({ type: 'control_request', request_id: 'R1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, description: 'list', tool_use_id: 'toolu_1' } })}\n`);
    await until(() => controller.get(id)!.waiting === 1);
    assert.equal(controller.get(id)!.state, 'waiting');
    assert.ok(controller.history(id).some((e) => e.kind === 'request' && e.request?.title === 'Run a command'));

    // Allow it: a control_response is written and the request is answered.
    await controller.respond(id, 'R1', 'allow');
    await until(() => controller.get(id)!.waiting === 0);
    const allowSend = ws.sends.find((s) => {
      try {
        const o = JSON.parse(s.line) as { type?: string; response?: { request_id?: string; response?: { behavior?: string } } };
        return o.type === 'control_response' && o.response?.request_id === 'R1' && o.response?.response?.behavior === 'allow';
      } catch {
        return false;
      }
    });
    assert.ok(allowSend, 'an allow control_response was written');
    const resolved = controller.history(id).filter((e) => e.kind === 'resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.outcome, 'allowed_once');
    assert.equal(controller.get(id)!.state, 'working');

    // End it.
    await controller.end(id);
    assert.equal(controller.get(id)!.state, 'ended');
    assert.equal(controller.get(id)!.endedReason, 'closed by operator');
    assert.ok(tail.closed, 'the reader was stopped');
    assert.ok(ws.stops >= 1, 'the host was asked to stop');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('controller: the host install hook runs before start and its failure ends the session', async () => {
  const { store, dataDir } = await freshStore();
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  controller.installHost = async () => {
    throw new Error('cannot write the host script');
  };
  try {
    const session = controller.create({ workspaceId: 'docker/ws1' });
    await until(() => controller.get(session.id)?.state === 'ended');
    assert.equal(controller.get(session.id)!.endedReason, 'cannot write the host script');
    assert.equal(ws.starts, 0, 'start was never reached');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('controller: create rejects a missing workspace and an unknown target', async () => {
  const { store, dataDir } = await freshStore();
  const controller = new ChatController(store, new FakeWorkspaces() as unknown as Workspaces);
  try {
    assert.throws(() => controller.create({}), /Pick a workspace/);
    assert.throws(() => controller.create({ workspaceId: 'nope/x' }), /No target/);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
