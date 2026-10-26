// T-2589: the portal ran out of heap (exit 139) on one chat of 204k events: every read of a whole transcript parsed every row at once.
// No server read takes a whole transcript any more: `history` returns at most HISTORY_MAX_EVENTS (the newest past it, oldest first), a
// turn is read forward a page at a time, a message the portal just sent is found by its uuid in one row, a Move reads a bounded tail of
// the kinds it uses (and says when older messages were left out), and the Portal MCP session_get lists pending requests from the
// request table and reads at most the events it returns. Fixtures are built here, at run time.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { clearResolvers } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerSessionTools } from '../portalmcp/tools/sessions.js';
import { ChatStore, HISTORY_MAX_EVENTS, TRANSFER_KINDS } from './store.js';
import { freshStore, init, line, liveSession, ok, until, USAGE_API_KEY, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const CAP = HISTORY_MAX_EVENTS;

/** A bare chat row in a fresh store, and a way to append events to it. */
async function bare() {
  const { store, dataDir } = await freshStore();
  const chat = new ChatStore(store);
  const id = `chat-${randomUUID()}`;
  chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Long chat', origin: 'ui' });
  const done = async () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, chat, id, done };
}

/** `n` assistant events, the text of each its number (and `pad` characters more). */
function fill(chat: ChatStore, id: string, n: number, pad = 0) {
  const extra = pad ? ` ${'y'.repeat(pad)}` : '';
  for (let i = 0; i < n; i++) chat.appendEvent(id, { kind: 'assistant', text: `event ${i + 1}${extra}` });
}

/** Counts the JSON.parse calls `fn` makes: one per row it parsed. */
function parsesIn<T>(fn: () => T): { value: T; parses: number } {
  const orig = JSON.parse;
  let parses = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => (parses++, orig(text, reviver))) as typeof JSON.parse;
  try {
    return { value: fn(), parses };
  } finally {
    JSON.parse = orig;
  }
}

test('history: past the cap it returns exactly the newest cap events, oldest first; near the end everything after; a limit never above the cap', async () => {
  const b = await bare();
  try {
    fill(b.chat, b.id, CAP + 50);
    const all = b.chat.history(b.id);
    assert.equal(all.length, CAP);
    assert.equal(all[0]!.seq, 51, 'the newest cap: the 50 oldest are left out');
    assert.equal(all.at(-1)!.seq, CAP + 50);
    assert.ok(
      all.every((e, i) => i === 0 || e.seq === all[i - 1]!.seq + 1),
      'oldest first, no gap',
    );

    const near = b.chat.history(b.id, CAP + 40);
    assert.deepEqual(
      near.map((e) => e.seq),
      Array.from({ length: 10 }, (_, i) => CAP + 41 + i),
      'after a recent seq: all of them',
    );
    assert.deepEqual(b.chat.history(b.id, CAP + 50), [], 'nothing after the newest');

    assert.deepEqual(
      b.chat.history(b.id, 0, 3).map((e) => e.seq),
      [CAP + 48, CAP + 49, CAP + 50],
      'a limit: the newest that many',
    );
    assert.equal(b.chat.history(b.id, 0, CAP * 10).length, CAP, 'a limit above the cap is the cap');
    assert.deepEqual(b.chat.history(b.id, 0, 0), []);

    // Forward pages from a known seq: the oldest after it, so a reader walking forward skips nothing.
    assert.deepEqual(
      b.chat.historyFrom(b.id, 10, 3).map((e) => e.seq),
      [11, 12, 13],
    );
    assert.equal(b.chat.historyFrom(b.id, 0, CAP * 10).length, CAP, 'capped too');
  } finally {
    await b.done();
  }
});

test('history is memory-bounded: on 3x the cap of large events it parses and returns at most the cap', async () => {
  const b = await bare();
  try {
    fill(b.chat, b.id, CAP * 3, 4_000);
    const whole = parsesIn(() => b.chat.history(b.id));
    assert.equal(whole.value.length, CAP);
    assert.ok(whole.parses <= CAP, `rows parsed: ${whole.parses}`);
    assert.equal(whole.value.at(-1)!.text!.startsWith(`event ${CAP * 3} `), true);
    const tail = parsesIn(() => b.chat.historyTail(b.id, { kinds: TRANSFER_KINDS, maxEvents: 100 }));
    assert.equal(tail.value.events.length, 100);
    assert.ok(tail.parses <= 100, `rows parsed: ${tail.parses}`);
    assert.equal(tail.value.cut, true);
  } finally {
    await b.done();
  }
});

test('userEvent: the message the portal sent, by its uuid, in one row however long the chat; null when there is none', async () => {
  const b = await bare();
  try {
    const uuid = randomUUID();
    b.chat.appendEvent(b.id, { kind: 'user', uuid, text: 'the first message' });
    fill(b.chat, b.id, CAP + 10);
    const found = parsesIn(() => b.chat.userEvent(b.id, uuid));
    assert.equal(found.value?.seq, 1, 'found past the cap');
    assert.equal(found.value?.text, 'the first message');
    assert.equal(found.parses, 1, 'one row read');
    assert.equal(b.chat.userEvent(b.id, randomUUID()), null);
  } finally {
    await b.done();
  }
});

test('historyTail: only the kinds asked, the newest first read back, bounded in rows and characters, a tool call without its input, cut when older ones are left', async () => {
  const b = await bare();
  try {
    b.chat.appendEvent(b.id, { kind: 'user', text: 'old ask' });
    b.chat.appendEvent(b.id, { kind: 'tool_result', text: 'z'.repeat(1_000) });
    b.chat.appendEvent(b.id, {
      kind: 'tool_use',
      toolName: 'Write',
      text: 'notes.md',
      toolInput: { file_path: 'notes.md', content: 'w'.repeat(5_000) },
    });
    b.chat.appendEvent(b.id, { kind: 'assistant', text: 'new answer' });
    b.chat.appendEvent(b.id, { kind: 'result' });

    const whole = b.chat.historyTail(b.id, { kinds: TRANSFER_KINDS, maxEvents: 100, withoutToolInput: true });
    assert.equal(whole.cut, false);
    assert.deepEqual(
      whole.events.map((e) => e.kind),
      ['user', 'tool_use', 'assistant', 'result'],
      'no tool_result',
    );
    const call = whole.events.find((e) => e.kind === 'tool_use')!;
    assert.equal(call.toolName, 'Write');
    assert.equal(call.text, 'notes.md');
    assert.equal(call.toolInput, undefined, 'its input is left out');
    assert.ok(b.chat.historyTail(b.id, { kinds: ['tool_use'], maxEvents: 1 }).events[0]!.toolInput, 'kept unless asked');

    const two = b.chat.historyTail(b.id, { kinds: TRANSFER_KINDS, maxEvents: 2 });
    assert.deepEqual(
      two.events.map((e) => e.kind),
      ['assistant', 'result'],
    );
    assert.equal(two.cut, true);
    const after = b.chat.historyTail(b.id, { kinds: TRANSFER_KINDS, after: 3, maxEvents: 2 });
    assert.deepEqual(
      after.events.map((e) => e.seq),
      [4, 5],
    );
    assert.equal(after.cut, false, 'nothing of those kinds after 3 was left');

    fill(b.chat, b.id, 1_200, 100);
    const small = b.chat.historyTail(b.id, { kinds: TRANSFER_KINDS, maxEvents: 5_000, maxChars: 10_000 });
    assert.ok(small.events.length < 1_200, `stopped by the characters: ${small.events.length}`);
    assert.equal(small.cut, true);
    assert.equal(small.events.at(-1)!.text!.startsWith('event 1200 '), true, 'the newest kept');
  } finally {
    await b.done();
  }
});

/* ---------- The Move reads a bounded tail and says when older messages were left out ---------- */

const assistantText = (text: string) =>
  line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID() });
const resultLine = (sessionId: string, total = 0.01) =>
  line({
    type: 'result',
    subtype: 'success',
    total_cost_usd: total,
    duration_ms: 100,
    usage: { input_tokens: 1, output_tokens: 1 },
    is_error: false,
    session_id: sessionId,
  });
const csid = (s: Live) => s.controller.get(s.id)!.claudeSessionId;

async function acknowledge(s: Live) {
  await until(() => s.ws.tails.length >= 2 && csid(s) !== s.id);
  const id = csid(s);
  const tail = s.ws.tails.at(-1)!;
  await until(() => s.ws.sends.some((x) => x.args[1] === id && x.line.includes('transferred_context')));
  tail.push(init(id));
  tail.push(assistantText('Got it.'));
  tail.push(resultLine(id, 0.02));
  tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
}

test('Move: a tail read that was cut marks the conversation truncated: the file and the opening say older messages were left out', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const chat = new ChatStore(s.store);
    for (let i = 1; i <= 6; i++) {
      chat.appendEvent(s.id, { kind: 'user', text: `ask number ${i}` });
      chat.appendEvent(s.id, { kind: 'assistant', text: `answer number ${i}` });
    }
    s.controller.moveTail = { events: 4, chars: 1_000_000 };
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const moving = s.controller.switchClaude(s.id, work.id, { handoff: 'skip' });
    await acknowledge(s);
    await moving;

    const opening = s.controller.history(s.id).find((e) => e.kind === 'user' && e.transfer)!;
    assert.equal(opening.transfer!.truncated, true, 'the move says older messages were left out');
    assert.match(opening.text!, /older ones were left out/);
    assert.ok(opening.text!.includes('answer number 6') && opening.text!.includes('ask number 5'), 'the newest are carried');
    assert.ok(!opening.text!.includes('ask number 1'), 'the oldest were not read');
    const file = s.ws.shells.find((x) => x.args.some((a) => a.includes('/.claudepilot/transfer/')) && x.exec.written)!.exec.written;
    assert.match(file, /older ones were left out/);
    assert.ok(!file.includes('ask number 1'));
  } finally {
    await s.done();
  }
});

/* ---------- Portal MCP session_get on a chat longer than the cap ---------- */

test('MCP session_get: a request older than the newest cap events is still listed, and the events returned are the newest max, never more than the cap', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  try {
    registerSessionTools({ store: s.store, chat: s.controller }, registry);
    const chat = new ChatStore(s.store);
    const request = chat.addRequest(s.id, {
      requestId: `req-${randomUUID()}`,
      kind: 'tool',
      toolName: 'Bash',
      agentLabel: null,
      title: 'Run a command',
      detail: 'ls',
      createdAt: new Date().toISOString(),
    });
    chat.appendEvent(s.id, { kind: 'request', requestId: request.requestId, request });
    fill(chat, s.id, CAP + 100);
    const last = s.controller.get(s.id)!.lastSeq;

    const admin = h.token('admin');
    const got = await h.call(admin.secret, 'session_get', { id: s.id, max_events: 100 });
    assert.equal(got.result?.isError, undefined, JSON.stringify(got.raw));
    const out = got.result!.structuredContent;
    assert.deepEqual(
      out.pending_requests.map((r: { request_id: string }) => r.request_id),
      [request.requestId],
    );
    assert.ok(out.events.length <= 100 && out.events.length > 0, `events: ${out.events.length}`);
    assert.equal(out.next_seq, last, 'the newest');
    const after = (await h.call(admin.secret, 'session_get', { id: s.id, max_events: 100, after_seq: last - 3 })).result!.structuredContent;
    assert.deepEqual(
      after.events.map((e: { seq: number }) => e.seq),
      [last - 2, last - 1, last],
    );
  } finally {
    h.done();
    await s.done();
  }
});
