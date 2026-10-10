import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CHAT_MAX_IMAGE_BYTES, CHAT_SOCKET_PATH, type ChatServerMessage, type ChatTask } from '@portal/contracts';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { decodeAttachments, readBlob, saveBlob } from './blobs.js';
import { ChatController } from './controller.js';
import {
  allowResponse,
  controlRequest,
  denyResponse,
  errorResponse,
  flagSettings,
  interruptRequest,
  parseLine,
  pickApplied,
  pickModels,
  requestDetail,
  requestTitle,
  userLine,
} from './protocol.js';
import { createChatRoutes } from './routes.js';
import { attachChat } from './socket.js';
import { ChatStore } from './store.js';

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

/* ---------- C2/C3 protocol: lifecycle, tasks, control replies, images ---------- */

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** A Claude Code success reply to one of the portal's control requests (body optional). */
const ok = (requestId: string, response?: unknown) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, ...(response === undefined ? {} : { response }) } });
const fail = (requestId: string, error: string) => line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error, error_code: 'invalid' } });
/** The 8-byte PNG signature plus a little body: enough for the type check. */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-not-really')]);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const SECRET = 'sk-ant-api03-DO-NOT-STORE';

test('parseLine: command_lifecycle moves a sent line by its client uuid; unknown states are ignored', () => {
  assert.deepEqual(parseLine(line({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' })).inputs, [{ uuid: 'u1', state: 'queued' }]);
  assert.deepEqual(parseLine(line({ type: 'command_lifecycle', command_uuid: 'u1', state: 'completed' })).inputs, [{ uuid: 'u1', state: 'completed' }]);
  assert.equal(parseLine(line({ type: 'command_lifecycle', command_uuid: 'u1', state: 'exploded' })).inputs, undefined);
  assert.equal(parseLine(line({ type: 'command_lifecycle', state: 'queued' })).inputs, undefined);
  assert.equal(parseLine(line({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' })).stored.length, 0);
});

test('parseLine: a status line carries the mode in effect, and requesting names the messages it reads', () => {
  assert.deepEqual(parseLine(line({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })).sessionPatch, { mode: 'acceptEdits' });
  const p = parseLine(line({ type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: ['u1', 'u2'] }));
  assert.deepEqual(p.sessionPatch, { state: 'working' });
  assert.deepEqual(p.inputs, [
    { uuid: 'u1', state: 'started' },
    { uuid: 'u2', state: 'started' },
  ]);
});

test('parseLine: task_* and background_tasks_changed become task patches, never with the prompt', () => {
  const started = parseLine(
    line({
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      run_id: 'r1',
      tool_use_id: 'toolu_task',
      description: 'Probe helper',
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: 'local_agent',
      prompt: 'TOP SECRET PROMPT',
    }),
  );
  assert.deepEqual(started.tasks, [
    { taskId: 't1', started: true, status: 'running', toolUseId: 'toolu_task', description: 'Probe helper', subagentType: 'general-purpose', taskType: 'local_agent', background: true },
  ]);
  assert.ok(!JSON.stringify(started).includes('TOP SECRET PROMPT'), 'the prompt is never kept');
  const updated = parseLine(line({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed', end_time: 1_790_000_000_000 } }));
  assert.deepEqual(updated.tasks, [{ taskId: 't1', status: 'completed', endedAtMs: 1_790_000_000_000 }]);
  const note = parseLine(
    line({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_task', status: 'completed', summary: 'All good', usage: { total_tokens: 16, tool_uses: 0, duration_ms: 383 } }),
  );
  assert.deepEqual(note.tasks, [{ taskId: 't1', toolUseId: 'toolu_task', status: 'completed', summary: 'All good', tokens: 16, toolUses: 0, durationMs: 383 }]);
  const set = parseLine(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't2', run_id: 'r2', task_type: 'local_agent', subagent_type: 'Explore', description: 'Scan' }, { nope: 1 }] }));
  assert.deepEqual(set.tasks, [{ taskId: 't2', background: true, description: 'Scan', subagentType: 'Explore', taskType: 'local_agent' }]);
});

test('parseLine: control_response replies route by request_id — success with or without a body, or an error', () => {
  assert.deepEqual(parseLine(ok('R1', { mode: 'acceptEdits' })).controlResponse, { requestId: 'R1', ok: true, response: { mode: 'acceptEdits' } });
  assert.deepEqual(parseLine(ok('R2')).controlResponse, { requestId: 'R2', ok: true, response: {} });
  assert.deepEqual(parseLine(fail('R3', 'Unable to validate model: x')).controlResponse, { requestId: 'R3', ok: false, error: 'Unable to validate model: x' });
  assert.equal(parseLine(line({ type: 'control_response', response: { subtype: 'success' } })).controlResponse, undefined);
  assert.equal(parseLine(ok('R1', { cancelled: true })).stored.length, 0);
});

test('parseLine: a tool_result image comes out as base64 for the blob store, never in the text; echoes are ignored', () => {
  const data = PNG_BYTES.toString('base64');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
  const nested = parseLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'Read image' }, image] }] }, parent_tool_use_id: null }));
  assert.equal(nested.stored.length, 1);
  assert.equal(nested.stored[0]!.text, 'Read image');
  assert.deepEqual(nested.stored[0]!.rawImages, [{ mediaType: 'image/png', dataBase64: data }]);
  // An image block beside the tool result is that tool's too.
  const beside = parseLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, image] } }));
  assert.equal(beside.stored[0]!.text, 'ok');
  assert.deepEqual(beside.stored[0]!.rawImages, [{ mediaType: 'image/png', dataBase64: data }]);
  // Other content blocks are named, never dumped (they may carry base64 too).
  const doc = parseLine(line({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'document', source: { type: 'base64', data: 'JVBERi0xLjQ=' } }] }] } }));
  assert.equal(doc.stored[0]!.text, '[document]');
  // Our own message echoed back (a replay, or no tool result at all) stores nothing.
  assert.equal(parseLine(line({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'look' }, image] } })).stored.length, 0);
  assert.equal(parseLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, image] } })).stored.length, 0);
});

test('parseLine: a Task tool_use names its sub-agent for labels (the prompt stays out)', () => {
  const p = parseLine(
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'Probe helper', prompt: 'do the things', subagent_type: 'general-purpose' } }] }, parent_tool_use_id: null }),
  );
  assert.deepEqual(p.agents, [{ toolUseId: 'toolu_task', description: 'Probe helper' }]);
  assert.deepEqual(p.stored.map((e) => e.toolName), ['Task']);
  assert.ok(!JSON.stringify(p.stored).includes('do the things'));
});

test('parseLine: a tool_use and its tool_result both carry the call id, so the result can be named', () => {
  const call = parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: null }));
  assert.equal(call.stored[0]!.toolUseId, 'toolu_1');
  const result = parseLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, parent_tool_use_id: null }));
  assert.equal(result.stored[0]!.toolUseId, 'toolu_1');
  assert.equal(result.stored[0]!.toolName, undefined, 'the controller names it');
});

test('builders: user lines carry the client uuid, priority and image blocks; settings are allowlisted; replies are reduced', () => {
  assert.deepEqual(JSON.parse(userLine('hi', { uuid: 'u1', priority: 'next' })), { type: 'user', uuid: 'u1', priority: 'next', message: { role: 'user', content: 'hi' } });
  assert.ok(!('priority' in (JSON.parse(userLine('hi', { uuid: 'u1' })) as object)), 'no priority unless asked');
  const img = { mediaType: 'image/png', dataBase64: 'AAAA' };
  const withImage = JSON.parse(userLine('look', { uuid: 'u2', images: [img] })) as { message: { content: unknown } };
  assert.deepEqual(withImage.message.content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]);
  const imageOnly = JSON.parse(userLine('  ', { images: [img] })) as { message: { content: { type: string }[] } };
  assert.deepEqual(imageOnly.message.content.map((b) => b.type), ['image'], 'no empty text block');
  assert.deepEqual(JSON.parse(controlRequest('R', 'set_model', { model: 'sonnet' })), { type: 'control_request', request_id: 'R', request: { model: 'sonnet', subtype: 'set_model' } });
  const raw = { effort: 'high', ultracode: true, env: { ANTHROPIC_API_KEY: SECRET }, permissions: { allow: ['Bash'] } };
  assert.deepEqual(flagSettings(raw), { effortLevel: 'high', ultracode: true });
  assert.deepEqual(flagSettings({ effort: 3, ultracode: 'yes' }), {});
  assert.deepEqual(
    pickApplied({
      effective: { env: { ANTHROPIC_API_KEY: SECRET } },
      sources: [{ source: 'env' }],
      applied: { model: 'claude-sonnet-5-5', effort: 'medium', advisor: null, ultracode: false, ultracodeRequested: false, ultracodeAvailable: true },
    }),
    { model: 'claude-sonnet-5-5', effort: 'medium', ultracode: false, ultracodeAvailable: true },
  );
  assert.deepEqual(pickApplied({ applied: { effort: null } }), { effort: null });
  assert.equal(pickApplied({ effective: {} }), null);
  assert.deepEqual(
    pickModels({
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Best', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
        { value: 'haiku' },
        { nope: 1 },
      ],
    }),
    [
      { value: 'default', displayName: 'Default (recommended)', description: 'Best', resolvedModel: 'claude-opus-5-5', effortLevels: ['low', 'high'] },
      { value: 'haiku', displayName: 'haiku', description: null, resolvedModel: null, effortLevels: [] },
    ],
  );
});

test('attachments: at most four PNG/JPEG/GIF/WebP images of valid base64 within the size cap, bytes matching the type', () => {
  const png = { name: 'a.png', mediaType: 'image/png', dataBase64: PNG_BYTES.toString('base64') };
  const [decoded] = decodeAttachments([png]);
  assert.ok(decoded!.bytes.equals(PNG_BYTES));
  assert.equal(decoded!.name, 'a.png');
  assert.deepEqual(decodeAttachments(undefined), []);
  assert.throws(() => decodeAttachments([png, png, png, png, png]), /at most 4 images/);
  assert.throws(() => decodeAttachments('nope'), /list of images/);
  assert.throws(() => decodeAttachments([{ ...png, mediaType: 'image/svg+xml' }]), /“a.png” isn't a supported image/);
  assert.throws(() => decodeAttachments([{ ...png, dataBase64: 'not base64!' }]), /couldn't be read/);
  assert.throws(() => decodeAttachments([{ ...png, dataBase64: '' }]), /couldn't be read/);
  assert.throws(() => decodeAttachments([{ ...png, mediaType: 'image/jpeg' }]), /isn't a valid JPEG image/);
  assert.throws(() => decodeAttachments([{ mediaType: 'image/png', dataBase64: 'AAAA' }]), /“Image 1” isn't a valid PNG image/);
  const big = Buffer.alloc(CHAT_MAX_IMAGE_BYTES + 1);
  PNG_BYTES.copy(big);
  assert.throws(() => decodeAttachments([{ ...png, dataBase64: big.toString('base64') }]), /too large/);
  const max = Buffer.alloc(CHAT_MAX_IMAGE_BYTES);
  PNG_BYTES.copy(max);
  assert.equal(decodeAttachments([{ ...png, dataBase64: max.toString('base64') }])[0]!.bytes.length, CHAT_MAX_IMAGE_BYTES);
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
  readonly startArgs: string[][] = [];
  starts = 0;
  stops = 0;
  /** What `status` reports, and the exit code `send` returns. */
  alive = true;
  sendCode = 0;
  runtimeFor(target: string): object | undefined {
    return target === 'docker' ? {} : undefined; // only the docker target exists
  }
  async exec(_target: string, _name: string, command: string[]): Promise<ExecSession> {
    const exec = new FakeExec();
    const cmd = command[2]; // ['sh', <script>, <cmd>, ...]
    if (cmd === 'start') {
      this.starts++;
      this.startArgs.push(command.slice(2));
      setTimeout(() => {
        exec.push('4242 2026-10-10T12:00:00Z\n');
        exec.exit(0);
      }, 0);
    } else if (cmd === 'tail') {
      this.tails.push(exec); // kept open; the test pushes lines
    } else if (cmd === 'send') {
      setTimeout(() => {
        if (this.sendCode === 0) this.sends.push({ args: command.slice(2), line: exec.written });
        exec.exit(this.sendCode);
      }, 0);
    } else if (cmd === 'status') {
      setTimeout(() => {
        exec.push(this.alive ? 'live 4242\n' : 'gone\n');
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

/* ========================= C2/C3 controller (fake workspaces) ========================= */

type Control = { id: string; request: Record<string, unknown> };

/** The control requests the controller wrote, in order. */
function controls(ws: FakeWorkspaces): Control[] {
  const out: Control[] = [];
  for (const s of ws.sends) {
    try {
      const o = JSON.parse(s.line) as { type?: string; request_id?: string; request?: Record<string, unknown> };
      if (o.type === 'control_request' && o.request_id && o.request) out.push({ id: o.request_id, request: o.request });
    } catch {
      // not JSON: not a control request
    }
  }
  return out;
}

/** A started session with its reader attached, a log of everything dispatched, and a way to take each
 *  new control request of a subtype as the controller writes it. */
async function liveSession() {
  const { store, dataDir } = await freshStore();
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  const messages: ChatServerMessage[] = [];
  controller.onEvent((_id, msg) => messages.push(msg));
  const id = controller.create({ workspaceId: 'docker/ws1' }).id;
  await until(() => ws.tails.length === 1);
  await until(() => controller.get(id)?.state === 'idle');
  await sleep(20); // let the tail attach its data handler
  const seen = new Set<string>();
  const take = async (subtype: string): Promise<Control> => {
    let found: Control | undefined;
    await until(() => !!(found = controls(ws).find((c) => c.request.subtype === subtype && !seen.has(c.id))));
    seen.add(found!.id);
    return found!;
  };
  const inputs = (uuid: string) => messages.flatMap((m) => (m.type === 'input' && m.uuid === uuid ? [m.state] : []));
  const lastTasks = (): ChatTask[] | undefined => messages.findLast((m): m is Extract<ChatServerMessage, { type: 'tasks' }> => m.type === 'tasks')?.tasks;
  const done = async () => {
    await controller.end(id).catch(() => undefined);
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, dataDir, ws, controller, messages, id, tail: ws.tails[0]!, take, inputs, lastTasks, done };
}

test('controller: control(model) writes set_model, resolves on its control_response, then keeps only get_settings.applied', async () => {
  const s = await liveSession();
  try {
    const pending = s.controller.control(s.id, 'model', { model: 'sonnet' });
    const setModel = await s.take('set_model');
    assert.equal(setModel.request.model, 'sonnet');
    s.tail.push(ok(setModel.id));
    const get = await s.take('get_settings');
    s.tail.push(
      ok(get.id, {
        effective: { model: 'sonnet', env: { ANTHROPIC_API_KEY: SECRET } },
        sources: [{ source: 'env', settings: { env: { ANTHROPIC_API_KEY: SECRET } } }],
        applied: { model: 'claude-sonnet-5-5', effort: 'medium', advisor: null, ultracode: false, ultracodeRequested: false, ultracodeAvailable: true },
      }),
    );
    await pending;
    const session = s.controller.get(s.id)!;
    assert.equal(session.model, 'claude-sonnet-5-5');
    assert.equal(session.effort, 'medium');
    assert.equal(session.ultracode, false);
    assert.equal(session.ultracodeAvailable, true);
    assert.ok(s.messages.some((m) => m.type === 'session' && m.session.model === 'claude-sonnet-5-5'), 'the applied values were emitted');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && e.text === 'Model: claude-sonnet-5-5'), 'the change is a system row');
    // No trace of `effective` or `sources` in any stored row, or in anything sent to the tabs.
    const rows = JSON.stringify(['chat_sessions', 'chat_events', 'chat_inputs'].map((t) => s.store.db!.prepare(`SELECT * FROM ${t}`).all()));
    const sent = JSON.stringify(s.messages);
    for (const needle of [SECRET, 'ANTHROPIC_API_KEY', 'effective', 'sources', 'ultracodeRequested']) {
      assert.ok(!rows.includes(needle), `no ${needle} in the database`);
      assert.ok(!sent.includes(needle), `no ${needle} sent to tabs`);
    }
  } finally {
    await s.done();
  }
});

test('controller: a refused set_model surfaces Claude Code’s message and reads no settings', async () => {
  const s = await liveSession();
  try {
    const pending = s.controller.control(s.id, 'model', { model: 'claude-nope' });
    const req = await s.take('set_model');
    s.tail.push(fail(req.id, 'Unable to validate model: claude-nope'));
    await assert.rejects(pending, /Unable to validate model: claude-nope/);
    await sleep(20);
    assert.ok(!controls(s.ws).some((c) => c.request.subtype === 'get_settings'));
    await assert.rejects(s.controller.control(s.id, 'model', { model: 'has space' }), /Pick a model/);
  } finally {
    await s.done();
  }
});

test('controller: mode refuses Bypass without writing anything; other modes apply from the reply and status lines', async () => {
  const s = await liveSession();
  try {
    const before = s.ws.sends.length;
    await assert.rejects(s.controller.control(s.id, 'mode', { mode: 'bypassPermissions' }), /Bypass is off for chat sessions/);
    await assert.rejects(s.controller.control(s.id, 'mode', { mode: 'yolo' as never }), /Pick a permission mode/);
    await sleep(20);
    assert.equal(s.ws.sends.length, before, 'nothing was written');

    const pending = s.controller.control(s.id, 'mode', { mode: 'acceptEdits' });
    const req = await s.take('set_permission_mode');
    assert.equal(req.request.mode, 'acceptEdits');
    s.tail.push(ok(req.id, { mode: 'acceptEdits' }));
    await pending;
    assert.equal(s.controller.get(s.id)!.mode, 'acceptEdits');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && e.text === 'Mode: Auto-accept edits'), 'the UI’s name for the mode');

    // Any status line carries the mode in effect (e.g. after the agent leaves plan mode).
    s.tail.push(line({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' }));
    await until(() => s.controller.get(s.id)!.mode === 'plan');
  } finally {
    await s.done();
  }
});

test('controller: a stream line reporting Bypass permissions ends the session for integrity', async () => {
  const s = await liveSession();
  try {
    s.tail.push(line({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypassPermissions' }));
    await until(() => s.controller.get(s.id)!.state === 'ended');
    assert.match(s.controller.get(s.id)!.endedReason ?? '', /^integrity: .*Bypass/);
    assert.notEqual(s.controller.get(s.id)!.mode, 'bypassPermissions');
    assert.ok(s.ws.stops >= 1, 'the process was stopped');
  } finally {
    await s.done();
  }
});

test('controller: effort and ultracode send apply_flag_settings built only from allowlisted keys', async () => {
  const s = await liveSession();
  try {
    const effort = s.controller.control(s.id, 'effort', { effort: 'high', model: 'opus', env: { X: '1' } } as never);
    const req = await s.take('apply_flag_settings');
    assert.deepEqual(req.request, { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
    s.tail.push(ok(req.id));
    s.tail.push(ok((await s.take('get_settings')).id, { applied: { model: 'claude-opus-5-5', effort: 'high', ultracode: false, ultracodeAvailable: true } }));
    await effort;
    assert.equal(s.controller.get(s.id)!.effort, 'high');

    const ultracode = s.controller.control(s.id, 'ultracode', { ultracode: true });
    const req2 = await s.take('apply_flag_settings');
    assert.deepEqual(req2.request, { subtype: 'apply_flag_settings', settings: { ultracode: true } });
    s.tail.push(ok(req2.id));
    s.tail.push(ok((await s.take('get_settings')).id, { applied: { model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true, ultracodeAvailable: true } }));
    await ultracode;
    assert.equal(s.controller.get(s.id)!.ultracode, true);
    assert.equal(s.controller.get(s.id)!.effort, 'xhigh');
    assert.deepEqual(
      s.controller.history(s.id).flatMap((e) => (e.kind === 'system' ? [e.text] : [])),
      ['Effort: high', 'Ultracode on'],
    );

    await assert.rejects(s.controller.control(s.id, 'effort', { effort: 'HIGH; rm -rf /' }), /Pick an effort level/);
    await assert.rejects(s.controller.control(s.id, 'ultracode', { ultracode: 'yes' as never }), /on or off/);
    await assert.rejects(s.controller.control(s.id, 'teleport' as never), /Unknown control/);
  } finally {
    await s.done();
  }
});

test('controller: cancel_queued writes cancel_async_message for a queued message and marks it cancelled once', async () => {
  const s = await liveSession();
  try {
    const uuid = randomUUID();
    await s.controller.send(s.id, uuid, 'after this', { priority: 'later' });
    const sent = JSON.parse(s.ws.sends.find((x) => x.line.includes('after this'))!.line) as { uuid: string; priority: string };
    assert.equal(sent.uuid, uuid);
    assert.equal(sent.priority, 'later');
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' }));
    await until(() => s.inputs(uuid).includes('queued'));

    const pending = s.controller.control(s.id, 'cancel_queued', { inputUuid: uuid });
    const req = await s.take('cancel_async_message');
    assert.equal(req.request.message_uuid, uuid);
    s.tail.push(ok(req.id, { cancelled: true }));
    await pending;
    // Claude Code's own report of the same cancel changes nothing more.
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' }));
    await sleep(30);
    assert.deepEqual(s.inputs(uuid), ['queued', 'cancelled']);
    assert.deepEqual(s.controller.inputStates(s.id), [{ uuid, state: 'cancelled' }]);

    await s.controller.control(s.id, 'cancel_queued', { inputUuid: uuid }); // a retry is a no-op
    await assert.rejects(s.controller.control(s.id, 'cancel_queued', { inputUuid: 'nope' }), /No such message/);
  } finally {
    await s.done();
  }
});

test('controller: command_lifecycle moves a sent message forward only, and emits each change once', async () => {
  const s = await liveSession();
  try {
    const uuid = randomUUID();
    await s.controller.send(s.id, uuid, 'steer this', { priority: 'next' });
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' }));
    s.tail.push(line({ type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: [uuid] }));
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })); // already started
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }));
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' })); // stale: never moves back
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: 'never-sent', state: 'queued' }));
    await until(() => s.inputs(uuid).includes('completed'));
    await sleep(20);
    assert.deepEqual(s.inputs(uuid), ['queued', 'started', 'completed']);
    assert.ok(!s.messages.some((m) => m.type === 'input' && m.uuid === 'never-sent'));
  } finally {
    await s.done();
  }
});

test('controller: a send that never reaches Claude Code reads failed and leaves the session as it was', async () => {
  const s = await liveSession();
  try {
    s.ws.sendCode = 5;
    const uuid = randomUUID();
    await assert.rejects(s.controller.send(s.id, uuid, 'hello?'), /rejected the line/);
    assert.deepEqual(s.inputs(uuid), ['failed']);
    assert.equal(s.controller.get(s.id)!.state, 'idle');
    assert.deepEqual(s.controller.inputStates(s.id), [{ uuid, state: 'failed' }]);
  } finally {
    s.ws.sendCode = 0;
    await s.done();
  }
});

test('controller: send with an image keeps it as a private blob, stores its reference, and writes an image block with the client uuid', async () => {
  const s = await liveSession();
  try {
    const uuid = randomUUID();
    const data = PNG_BYTES.toString('base64');
    await s.controller.send(s.id, uuid, 'what is this?', { attachments: [{ name: 'shot.png', mediaType: 'image/png', dataBase64: data }] });
    const sent = JSON.parse(s.ws.sends.find((x) => x.line.includes(uuid))!.line) as { uuid: string; message: { content: unknown } };
    assert.equal(sent.uuid, uuid);
    assert.deepEqual(sent.message.content, [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ]);

    const blobId = sha256(PNG_BYTES);
    const user = s.controller.history(s.id).find((e) => e.kind === 'user')!;
    assert.equal(user.uuid, uuid);
    assert.deepEqual(user.images, [{ blobId, mediaType: 'image/png', name: 'shot.png' }]);
    assert.equal(statSync(join(s.dataDir, 'chat-blobs')).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.dataDir, 'chat-blobs', blobId)).mode & 0o777, 0o600);
    const payloads = JSON.stringify(s.store.db!.prepare('SELECT payload FROM chat_events').all());
    assert.ok(!payloads.includes(data), 'no base64 in event payloads');
    assert.deepEqual(s.controller.blob(s.id, blobId), { bytes: PNG_BYTES, mediaType: 'image/png' });

    // Checks happen before anything is stored or sent.
    const before = s.ws.sends.length;
    const events = s.controller.history(s.id).length;
    await assert.rejects(
      s.controller.send(s.id, randomUUID(), 'x', { attachments: [{ name: 'evil.svg', mediaType: 'image/svg+xml', dataBase64: data }] }),
      /“evil.svg” isn't a supported image/,
    );
    await assert.rejects(s.controller.send(s.id, randomUUID(), '   '), /Type a message/);
    await assert.rejects(s.controller.send(s.id, uuid, 'again'), /already sent/);
    assert.equal(s.ws.sends.length, before);
    assert.equal(s.controller.history(s.id).length, events);
  } finally {
    await s.done();
  }
});

test('controller: an image a tool returns becomes a blob on its tool_result, never base64 in the row', async () => {
  const s = await liveSession();
  try {
    const data = PNG_BYTES.toString('base64');
    const toolImage = (d: string) =>
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } }] }] }, parent_tool_use_id: null });
    s.tail.push(toolImage(data));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'tool_result'));
    const blobId = sha256(PNG_BYTES);
    assert.deepEqual(s.controller.history(s.id).find((e) => e.kind === 'tool_result')!.images, [{ blobId, mediaType: 'image/png' }]);
    assert.equal(readBlob(s.store, s.id, blobId)?.mediaType, 'image/png');
    assert.equal((s.store.db!.prepare("SELECT kind FROM chat_files WHERE blob_sha256 = ?").get(blobId) as { kind: string }).kind, 'tool_image');
    // A "PNG" that isn't one is left out; the row still reads.
    s.tail.push(toolImage(Buffer.from('<html>not an image</html>').toString('base64')));
    await until(() => s.controller.history(s.id).filter((e) => e.kind === 'tool_result').length === 2);
    assert.equal(s.controller.history(s.id).filter((e) => e.kind === 'tool_result')[1]!.images, undefined);
    assert.ok(!JSON.stringify(s.store.db!.prepare('SELECT * FROM chat_events').all()).includes(data));
  } finally {
    await s.done();
  }
});

test('controller: task events are stored without the prompt, emitted as the full list, and label sub-agent lines', async () => {
  const s = await liveSession();
  try {
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'Probe helper', prompt: 'SECRET PROMPT' } }] }, parent_tool_use_id: null, uuid: 'a1' }));
    s.tail.push(
      line({ type: 'system', subtype: 'task_started', task_id: 't1', run_id: 'r1', tool_use_id: 'toolu_task', description: 'Probe helper', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent', prompt: 'SECRET PROMPT' }),
    );
    await until(() => !!s.lastTasks()?.length);
    const [started] = s.lastTasks()!;
    assert.equal(started!.taskId, 't1');
    assert.equal(started!.toolUseId, 'toolu_task');
    assert.equal(started!.description, 'Probe helper');
    assert.equal(started!.subagentType, 'general-purpose');
    assert.equal(started!.status, 'running');
    assert.equal(started!.endedAt, null);

    // The sub-agent's lines carry its description as their label.
    s.tail.push(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pro' } }, parent_tool_use_id: 'toolu_task' }));
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'probing' }] }, parent_tool_use_id: 'toolu_task', uuid: 'a2' }));
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'stray' }] }, parent_tool_use_id: 'toolu_unknown', uuid: 'a3' }));
    await until(() => s.controller.history(s.id).some((e) => e.text === 'stray'));
    assert.equal(s.controller.history(s.id).find((e) => e.text === 'probing')!.agentLabel, 'Probe helper');
    assert.equal(s.controller.history(s.id).find((e) => e.text === 'stray')!.agentLabel, 'toolu_unknown', 'unknown agents keep the raw id');
    assert.ok(s.messages.some((m) => m.type === 'delta' && m.agentLabel === 'Probe helper' && m.text === 'pro'));

    s.tail.push(
      line({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_task', status: 'completed', summary: 'Found it', usage: { total_tokens: 16, tool_uses: 0, duration_ms: 383 } }),
    );
    await until(() => s.lastTasks()?.[0]?.status === 'completed');
    const done = s.lastTasks()![0]!;
    assert.equal(done.summary, 'Found it');
    assert.equal(done.tokens, 16);
    assert.equal(done.toolUses, 0);
    assert.equal(done.durationMs, 383);
    assert.ok(done.endedAt);
    s.tail.push(line({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed', end_time: 1_790_000_000_000 } }));
    await until(() => s.lastTasks()?.[0]?.endedAt === new Date(1_790_000_000_000).toISOString());
    // A later running set doesn't revive it.
    s.tail.push(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', description: 'Probe helper' }, { task_id: 't2', description: 'Second', subagent_type: 'Explore' }] }));
    await until(() => s.lastTasks()?.length === 2);
    assert.deepEqual(s.lastTasks()!.map((t) => [t.taskId, t.status]), [
      ['t1', 'completed'],
      ['t2', 'running'],
    ]);
    assert.deepEqual(s.controller.tasks(s.id), s.lastTasks());

    const dump = JSON.stringify(['chat_tasks', 'chat_events'].map((t) => s.store.db!.prepare(`SELECT * FROM ${t}`).all()));
    assert.ok(!dump.includes('SECRET PROMPT'), 'the prompt is never stored');
  } finally {
    await s.done();
  }
});

test('controller: each tool_result is named from its own call, even when parallel calls finish out of order', async () => {
  const s = await liveSession();
  try {
    const result = (id: string, content: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null });
    s.tail.push(
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/x' } }] },
        parent_tool_use_id: null,
        uuid: 'a1',
      }),
    );
    s.tail.push(result('toolu_b', 'file body'));
    s.tail.push(result('toolu_a', 'a b c'));
    s.tail.push(result('toolu_zzz', '?'));
    s.tail.push(result('toolu_a', 'again')); // no call in flight any more: named from the stored call
    await until(() => s.controller.history(s.id).filter((e) => e.kind === 'tool_result').length === 4);
    const named = s.controller.history(s.id).flatMap((e) => (e.kind === 'tool_result' ? [[e.text, e.toolName]] : []));
    assert.deepEqual(named, [
      ['file body', 'Read'],
      ['a b c', 'Bash'],
      ['?', undefined],
      ['again', 'Bash'],
    ]);
    assert.ok(!JSON.stringify(s.controller.history(s.id)).includes('toolu_a'), 'the call id is kept for naming only, never shown');
    assert.equal(new ChatStore(s.store).toolName(s.id, 'toolu_b'), 'Read');
  } finally {
    await s.done();
  }
});

test('controller: the first system/init of a process reads the applied settings, once', async () => {
  const s = await liveSession();
  try {
    const init = line({ type: 'system', subtype: 'init', session_id: s.id, model: 'claude-opus-5-5', permissionMode: 'default' });
    s.tail.push(init);
    const get = await s.take('get_settings');
    s.tail.push(ok(get.id, { applied: { model: 'claude-opus-5-5', effort: 'max', ultracode: false, ultracodeAvailable: false } }));
    await until(() => s.controller.get(s.id)!.effort === 'max');
    s.tail.push(init); // the next turn's init: nothing more to read
    await sleep(30);
    assert.equal(controls(s.ws).filter((c) => c.request.subtype === 'get_settings').length, 1);
    assert.deepEqual(s.controller.history(s.id).map((e) => e.text), ['Ready'], 'Ready is stored once');
  } finally {
    await s.done();
  }
});

test('controller: a control request with no answer times out; a reply nobody asked for is ignored', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 50;
    await assert.rejects(s.controller.control(s.id, 'model', { model: 'sonnet' }), /answer in time/);
    s.tail.push(ok('not-ours', { mode: 'plan' }));
    s.tail.push(ok(controls(s.ws)[0]!.id)); // late: its request already gave up
    await sleep(20);
    assert.equal(s.controller.get(s.id)!.state, 'idle');
  } finally {
    await s.done();
  }
});

test('controller: list_models maps the model list; a control on a gone process resumes it first', async () => {
  const s = await liveSession();
  try {
    const models = s.controller.models(s.id);
    const req = await s.take('list_models');
    s.tail.push(ok(req.id, { models: [{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus', supportedEffortLevels: ['low', 'max'] }] }));
    assert.deepEqual(await models, [{ value: 'default', displayName: 'Default (recommended)', description: 'Opus', resolvedModel: 'claude-opus-5-5', effortLevels: ['low', 'max'] }]);

    // The process dies: the reader marks the session interrupted.
    s.ws.alive = false;
    s.tail.exit(0);
    await until(() => s.controller.get(s.id)!.state === 'interrupted');
    s.ws.alive = true;

    const effort = s.controller.control(s.id, 'effort', { effort: 'low' });
    await until(() => s.ws.starts === 2 && s.ws.tails.length === 2);
    assert.ok(s.ws.startArgs[1]!.includes('--resume'), 'resumed, not started fresh');
    assert.equal(s.ws.startArgs[1]![2], '2', 'on the next segment');
    const flags = await s.take('apply_flag_settings');
    await sleep(10);
    const tail2 = s.ws.tails[1]!;
    tail2.push(ok(flags.id));
    tail2.push(ok((await s.take('get_settings')).id, { applied: { effort: 'low' } }));
    await effort;
    assert.equal(s.controller.get(s.id)!.effort, 'low');
  } finally {
    await s.done();
  }
});

test('controller: a line split across chunks, and several lines in one chunk, are each read once with the offset kept', async () => {
  const s = await liveSession();
  try {
    const a = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] }, parent_tool_use_id: null, uuid: 'a1' });
    const b = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] }, parent_tool_use_id: null, uuid: 'a2' });
    const c = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'third' }] }, parent_tool_use_id: null, uuid: 'a3' });
    s.tail.push(a.slice(0, 10));
    s.tail.push(a.slice(10, 25));
    await sleep(20);
    assert.equal(s.controller.history(s.id).length, 0, 'nothing until the newline');
    s.tail.push(a.slice(25) + b + c.slice(0, 5));
    s.tail.push(c.slice(5));
    await until(() => s.controller.history(s.id).length === 3);
    assert.deepEqual(s.controller.history(s.id).map((e) => e.text), ['first', 'second', 'third']);
    assert.equal(new ChatStore(s.store).row(s.id)!.byte_offset, Buffer.byteLength(a + b + c));
  } finally {
    await s.done();
  }
});

test('blobs: an image is read only by a session that links it', async () => {
  const { store, dataDir } = await freshStore();
  try {
    const chat = new ChatStore(store);
    for (const id of ['A', 'B']) chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: id, origin: 'ui' });
    const image = saveBlob(store, 'A', 'upload', 'a.png', 'image/png', PNG_BYTES);
    assert.deepEqual(image, { blobId: sha256(PNG_BYTES), mediaType: 'image/png', name: 'a.png' });
    assert.ok(readBlob(store, 'A', image.blobId)?.bytes.equals(PNG_BYTES));
    assert.equal(readBlob(store, 'B', image.blobId), null, 'another session never reads it');
    assert.equal(readBlob(store, 'A', '../portal.db'), null);
    assert.equal(readBlob(store, 'A', image.blobId.toUpperCase()), null);
    // Saving the same bytes again (another session) reuses the file and links it there too.
    saveBlob(store, 'B', 'tool_image', null, 'image/png', PNG_BYTES);
    assert.ok(readBlob(store, 'B', image.blobId));
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('routes: models, tasks and blobs — a blob is served inline with safe headers, and 404 outside its session', async () => {
  const { store, dataDir } = await freshStore();
  const controller = new ChatController(store, new FakeWorkspaces() as unknown as Workspaces);
  const app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, (isAppError(e) ? e.status : 500) as 404));
  app.route('/', createChatRoutes(controller));
  try {
    const chat = new ChatStore(store);
    for (const id of ['A', 'B']) chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: id, origin: 'ui' });
    const { blobId } = saveBlob(store, 'A', 'upload', 'a.png', 'image/png', PNG_BYTES);

    const res = await app.request(`/A/blobs/${blobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('content-disposition'), 'inline');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES));
    assert.equal((await app.request(`/B/blobs/${blobId}`)).status, 404);
    assert.equal((await app.request('/A/blobs/not-a-blob')).status, 404);

    const tasks = await app.request('/A/tasks');
    assert.equal(tasks.status, 200);
    assert.deepEqual(await tasks.json(), { data: [] });
    assert.equal((await app.request('/nope/tasks')).status, 404);
    assert.equal((await app.request('/nope/models')).status, 404);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('socket: subscribe replays tasks and queued messages; control acks are keyed by the client uuid; task changes stream live', async () => {
  const s = await liveSession();
  const server = createServer();
  attachChat(server, s.controller, () => true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sock = new WebSocket(`ws://127.0.0.1:${port}${CHAT_SOCKET_PATH}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const got: ChatServerMessage[] = [];
  sock.on('message', (d) => got.push(JSON.parse(String(d)) as ChatServerMessage));
  await new Promise((resolve, reject) => {
    sock.once('open', resolve);
    sock.once('error', reject);
  });
  try {
    // A message queued before the tab connects: its state is replayed on subscribe.
    const queued = randomUUID();
    await s.controller.send(s.id, queued, 'later please', { priority: 'later' });
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: queued, state: 'queued' }));
    await until(() => s.inputs(queued).includes('queued'));

    sock.send(JSON.stringify({ type: 'subscribe', session: s.id }));
    await until(() => got.some((m) => m.type === 'tasks') && got.some((m) => m.type === 'input'));
    assert.deepEqual(got.find((m) => m.type === 'tasks'), { type: 'tasks', session: s.id, tasks: [] });
    assert.deepEqual(got.find((m) => m.type === 'input'), { type: 'input', session: s.id, uuid: queued, state: 'queued' });
    assert.ok(got.some((m) => m.type === 'events' && m.items.some((e) => e.kind === 'user' && e.uuid === queued)), 'the backlog carries the message with its uuid');

    sock.send(JSON.stringify({ type: 'control', session: s.id, op: 'mode', uuid: 'c-1', args: { mode: 'bypassPermissions' } }));
    sock.send(JSON.stringify({ type: 'control', session: s.id, op: 'cancel_queued', args: { inputUuid: 'nope' } }));
    await until(() => got.some((m) => m.type === 'ack' && m.uuid === 'c-1') && got.some((m) => m.type === 'ack' && m.uuid === 'cancel_queued'));
    const ack = got.find((m): m is Extract<ChatServerMessage, { type: 'ack' }> => m.type === 'ack' && m.uuid === 'c-1')!;
    assert.equal(ack.ok, false);
    assert.match(ack.error ?? '', /Bypass is off/);

    s.tail.push(line({ type: 'system', subtype: 'task_started', task_id: 't9', tool_use_id: 'toolu_9', description: 'Live one', task_type: 'local_agent' }));
    await until(() => got.some((m) => m.type === 'tasks' && m.tasks.length === 1));
  } finally {
    await new Promise((r) => {
      sock.once('close', r);
      sock.close();
    });
    server.close();
    await s.done();
  }
});
