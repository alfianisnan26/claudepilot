import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { BTW_ANSWER_MAX, BTW_QUESTION_MAX, BTW_USAGE_KIND, type Actor, type BtwReason, type BtwServerMessage, type ChatBtw, type ChatEvent } from '@portal/contracts';
import { asUser, clearResolvers, emitAccessChange, ownerActor, registerResolver } from '../authz/seam.js';
import { BtwEngine, readBtwConfig, type BtwConfig, type BtwHost } from './btw.js';
import { BtwStore } from './btwStore.js';
import { sessionResolver } from './authz.js';
import { redact } from './redact.js';
import { ChatStore } from './store.js';
import { NO_VALUES, SessionStream, ValueRedactor } from './valueRedact.js';
import { FakeExec, freshStore, line, sleep, until } from './testkit.js';

/* A fake workspace: every btw command gets a FakeExec the test scripts; the host stands in for what the controller gives the engine. */

const user = (id: string): Actor => ({ kind: 'user', userId: id, loginSessionId: 'test', via: 'ui' });
const OWNER = ownerActor();
/** A key-shaped string, built at runtime so no token-shaped literal sits in the repo. */
const FAKE_KEY = ['sk-ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'].join('-');
const A = user('u_a');
const B = user('u_b');

const initLine = (o: Record<string, unknown> = {}) => line({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], model: 'claude-opus-5-5', slash_commands: [], permissionMode: 'default', ...o });
const textDelta = (text: string) => line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const resultLine = (text: string, o: Record<string, unknown> = {}) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.00178,
    usage: { input_tokens: 30, output_tokens: 33, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 30, outputTokens: 33, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0, costUSD: 0.00178 } },
    ...o,
  });

interface Rig {
  store: Awaited<ReturnType<typeof freshStore>>['store'];
  dataDir: string;
  chat: ChatStore;
  btwStore: BtwStore;
  engine: BtwEngine;
  /** The runs the engine started, in order. */
  runs: { command: string[]; exec: FakeExec }[];
  /** Everything the engine told anyone: [userId, session, message]. */
  out: [string, string, BtwServerMessage][];
  usage: { turn: unknown; rows: unknown }[];
  cfg: BtwConfig;
  host: BtwHost & { values: string[]; gateMessage: string | null; credential_: { reason: BtwReason; note?: string } | null; execError: boolean; ownerOf: Map<string, string | null> };
  clock: { t: number };
  session(id?: string, owner?: string | null): string;
  snaps(userId?: string): ChatBtw[];
  deltas(): string;
  done(): Promise<void>;
}

let rigs: Rig[] = [];

async function rig(over: Partial<BtwConfig> = {}): Promise<Rig> {
  const { store, dataDir } = await freshStore();
  const chat = new ChatStore(store);
  const btwStore = new BtwStore(store);
  const runs: Rig['runs'] = [];
  const out: Rig['out'] = [];
  const usage: Rig['usage'] = [];
  const clock = { t: Date.parse('2026-10-12T06:00:00Z') };
  const cfg: BtwConfig = { enabled: true, limit: 6, windowMs: 10 * 60_000, timeoutMs: 5_000, contextChars: 60_000, model: '', maxCostUsd: 0.5, ...over };
  const ownerOf = new Map<string, string | null>();
  const host = {
    values: [] as string[],
    gateMessage: null as string | null,
    credential_: null as { reason: BtwReason; note?: string } | null,
    execError: false,
    ownerOf,
    session: (id: string) => {
      const r = chat.row(id);
      return r ? { id: r.id, workspaceId: r.workspace_id, claudeId: r.claude_id ?? '', claudeDir: r.claude_id ? 'claudes/0123456789abcdef' : '', cwd: r.cwd, model: r.model } : null;
    },
    events: (id: string) => chat.history(id, 0),
    exec: async (_ws: string, command: string[]) => {
      if (host.execError) throw new Error('workspace is down');
      const exec = new FakeExec();
      runs.push({ command, exec });
      return exec;
    },
    scrub: (_ws: string, text: string) => redact(new ValueRedactor(host.values).redact(text)),
    scrubStream: () => new SessionStream(new ValueRedactor(host.values)),
    credential: async () => host.credential_,
    gate: () => host.gateMessage,
    append: (id: string, ev: Parameters<BtwHost['append']>[1]) => {
      chat.appendEvent(id, ev);
      return chat.lastEvent(id);
    },
    audit: (e: Parameters<BtwHost['audit']>[0]) => chat.addAudit(e),
    sideUsage: (turn: unknown, rows: unknown) => void usage.push({ turn, rows }),
  };
  const engine = new BtwEngine({ store: btwStore, host, config: () => cfg, now: () => new Date(clock.t) });
  engine.onMessage((u, s, m) => void out.push([u, s, m]));
  engine.start();
  let n = 0;
  const r: Rig = {
    store,
    dataDir,
    chat,
    btwStore,
    engine,
    runs,
    out,
    usage,
    cfg,
    host,
    clock,
    session: (id = `sess-${++n}`, owner: string | null = null) => {
      chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node/proj', title: 'Test', origin: 'ui' });
      ownerOf.set(id, owner);
      return id;
    },
    snaps: (userId = 'u_owner') => out.filter(([u, , m]) => u === userId && m.type === 'btw').map(([, , m]) => (m as Extract<BtwServerMessage, { type: 'btw' }>).item),
    deltas: () => out.flatMap(([, , m]) => (m.type === 'btw_delta' ? [m.text] : [])).join(''),
    done: async () => {
      await engine.shutdown();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  // The one resolver every handler reads a session through: the facts come from the rig, the owner from its map (the founding user by default).
  registerResolver(sessionResolver((id) => (chat.row(id) ? { id: chat.row(id)!.id, workspaceId: 'docker/ws1', ownerId: ownerOf.get(chat.row(id)!.id) ?? null } : null)));
  rigs.push(r);
  return r;
}

beforeEach(() => {
  rigs = [];
});
afterEach(async () => {
  clearResolvers();
  for (const r of rigs) await r.done();
});
after(() => clearResolvers());

const ID = (n: number) => `btw-test-${String(n).padStart(4, '0')}`;
const last = (r: Rig, userId = 'u_owner') => r.snaps(userId).at(-1)!;
const writtenBy = (run: Rig['runs'][number]) => run.exec.written;
const userLineOf = (run: Rig['runs'][number]) => JSON.parse(run.exec.written.split('\n')[0]!) as { type: string; message: { content: { text: string }[] } };
const text = (run: Rig['runs'][number]) => userLineOf(run).message.content[0]!.text;
async function started(r: Rig, n = 1) {
  await until(() => r.runs.length >= n && r.runs[n - 1]!.exec.written.length > 0);
  return r.runs[n - 1]!;
}
const failedWith = async (r: Rig, reason: BtwReason) => {
  await until(() => r.snaps().at(-1)?.status === 'failed');
  assert.equal(last(r).reason, reason);
};

test('a question is answered by a separate run, streamed, then settled with the estimate of what it used', async () => {
  const r = await rig();
  const s = r.session();
  const before = r.chat.row(s)!;
  r.chat.appendEvent(s, { kind: 'user', text: 'fix the build' });
  r.chat.appendEvent(s, { kind: 'assistant', text: 'The build failed on a missing import.' });
  await r.engine.ask(OWNER, s, ID(1), '  what failed?  ');

  // The card starts at once, running, with a size estimate and no cost.
  const first = r.snaps()[0]!;
  assert.equal(first.status, 'running');
  assert.equal(first.question, 'what failed?');
  assert.equal(first.usage?.basis, 'estimated');
  assert.equal(first.usage?.costUsd, null);
  assert.equal(first.context?.messages, 2);
  assert.equal(first.context?.truncated, false);

  const run = await started(r);
  // The run: its flags, its one stdin line with the transcript as data and the question outside it.
  const args = run.command.slice(run.command.indexOf('claude'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--safe-mode') && args.includes('--no-session-persistence'));
  assert.match(text(run), /<session_transcript [^>]*messages="2"/);
  assert.match(text(run), /### You\n\nfix the build/);
  assert.match(text(run), /### Claude\n\nThe build failed on a missing import\./);
  assert.match(text(run), /<side_question>\nwhat failed\?\n<\/side_question>/);

  run.exec.push(initLine());
  run.exec.push(textDelta('A missing '));
  run.exec.push(textDelta('import.'));
  run.exec.push(resultLine('A missing import.'));
  await r.engine.idle();

  const done = last(r);
  assert.equal(done.status, 'answered');
  assert.equal(done.answer, 'A missing import.');
  assert.equal(r.deltas(), 'A missing import.', 'the same text, streamed');
  assert.deepEqual(done.usage, { input: 30, output: 33, cacheRead: 5000, cacheWrite: 0, costUsd: 0.00178, estimate: true, basis: 'reported' });
  assert.equal(done.model, 'claude-opus-5-5');
  assert.ok(done.settledAt);

  // The session is exactly as it was: no event, no counter, no state change.
  const after = r.chat.row(s)!;
  for (const k of ['state', 'turns', 'cost_est_usd', 'last_seq', 'byte_offset', 'process', 'segment', 'model', 'mode'] as const) assert.equal(after[k], k === 'last_seq' ? 2 : before[k], k);
  assert.equal(r.chat.history(s, 0).length, 2, 'no event was written for the side question');
});

test('the usage is one row among the turns\' with kind side and the btw as its ref, announced on its own hook', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(resultLine('ok'));
  await r.engine.idle();
  const rows = r.store.db!.prepare('SELECT session_id, workspace_id, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, requests, agents, kind, ref FROM chat_usage').all();
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ session_id: s, workspace_id: 'docker/ws1', model: 'claude-opus-5-5', input_tokens: 30, output_tokens: 33, cache_read_tokens: 5000, cost_usd: 0.00178, requests: 1, agents: 0, kind: BTW_USAGE_KIND, ref: ID(1) }]);
  // Every total that adds usage rows up counts it (the report reads usageSince).
  assert.equal(r.chat.usageSince(0).length, 1);
  assert.equal(r.usage.length, 1);
  assert.deepEqual((r.usage[0]!.turn as { sessionId: string }).sessionId, s);
});

test('the audit trail names the actor, the outcome and the numbers, never the question or the answer', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'what is the secret question text?');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(resultLine('the secret answer text'));
  await r.engine.idle();
  const audit = r.chat.audit({ kind: 'btw' });
  assert.equal(audit.length, 1);
  const a = audit[0]!;
  assert.equal(a.kind, 'btw.ask');
  assert.equal(a.actor, 'user:u_owner');
  assert.equal(a.sessionId, s);
  assert.equal(a.detail.outcome, 'answered');
  assert.equal(a.detail.btw, ID(1));
  assert.equal(a.detail.input, 30);
  const raw = JSON.stringify(a);
  assert.ok(!raw.includes('secret question') && !raw.includes('secret answer'));
});

test('secret values the workspace was given never reach the run, and never leave it: not in the context, not in a delta split across two pieces, not in the answer', async () => {
  const r = await rig();
  r.host.values = ['hunter2hunter2'];
  const s = r.session();
  r.chat.appendEvent(s, { kind: 'user', text: `the db password is hunter2hunter2 and the key is ${FAKE_KEY}` });
  await r.engine.ask(OWNER, s, ID(1), 'is hunter2hunter2 the password?');
  const run = await started(r);
  const sent = writtenBy(run);
  assert.ok(!sent.includes('hunter2hunter2'), 'the value is out of the context and the question');
  assert.ok(!sent.includes(FAKE_KEY.slice(0, 16)), 'so is the credential shape');
  assert.ok(sent.includes('[redacted]'));
  assert.ok(!last(r).question.includes('hunter2hunter2'));

  run.exec.push(initLine());
  run.exec.push(textDelta('It is hunter'));
  run.exec.push(textDelta('2hunter2, yes.'));
  run.exec.push(resultLine('It is hunter2hunter2, yes.'));
  await r.engine.idle();
  assert.ok(!r.deltas().includes('hunter2hunter2'));
  assert.ok(!r.deltas().includes('hunter'), 'a tail that could become the value is held, then blanked');
  assert.ok(!last(r).answer.includes('hunter2hunter2'));
  assert.match(last(r).answer, /\[redacted\]/);
});

test('the run is stopped before it answers when it reports a tool or an MCP server, and nothing it said is shown', async () => {
  for (const bad of [{ tools: ['Bash', 'Read'] }, { mcp_servers: [{ name: 'x', status: 'connected' }] }, { tools: undefined }]) {
    const r = await rig();
    const s = r.session();
    await r.engine.ask(OWNER, s, ID(1), 'run ls');
    const run = await started(r);
    run.exec.push(initLine(bad));
    run.exec.push(textDelta('I ran it'));
    run.exec.push(resultLine('I ran it'));
    await r.engine.idle();
    assert.equal(last(r).status, 'failed');
    assert.equal(last(r).reason, 'unsafe', JSON.stringify(bad));
    assert.equal(last(r).answer, '');
    assert.equal(r.deltas(), '');
    assert.equal(r.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get()!.n, 0, 'nothing was spent that we know of');
    assert.ok(run.exec.written.includes('"interrupt"'), 'the request in flight is interrupted');
    await sleep(350);
    assert.equal(run.exec.closed, true);
    await r.done();
    rigs = [];
  }
});

test('an answer before the proof, or a tool call from the model, fails the same way', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  const run = await started(r);
  run.exec.push(textDelta('no init yet'));
  await r.engine.idle();
  assert.equal(last(r).reason, 'unsafe');

  await r.engine.ask(OWNER, s, ID(2), 'q2');
  const run2 = await started(r, 2);
  run2.exec.push(initLine());
  run2.exec.push(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }));
  await r.engine.idle();
  assert.equal(last(r).reason, 'unsafe');
});

test('one at a time per session: a second ask while one runs is refused as busy, without a record, and the slot comes back', async () => {
  const r = await rig();
  const s = r.session();
  await Promise.all([r.engine.ask(OWNER, s, ID(1), 'first'), r.engine.ask(OWNER, s, ID(2), 'second at the same moment')]);
  assert.equal(r.runs.length, 1, 'only one run');
  const busy = r.snaps().find((x) => x.id === ID(2))!;
  assert.equal(busy.status, 'failed');
  assert.equal(busy.reason, 'busy');
  assert.equal(r.btwStore.get('u_owner', s, ID(2)), null, 'a refusal is not stored');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(resultLine('one'));
  await r.engine.idle();
  await r.engine.ask(OWNER, s, ID(3), 'third');
  assert.equal(r.runs.length, 2);
  // Another session is not blocked by this one.
  const other = r.session();
  await r.engine.ask(OWNER, other, ID(4), 'elsewhere');
  assert.equal(r.runs.length, 3);
});

test('the rate limit: N starts per window per session, the wait is named, refusals do not count, and the window slides', async () => {
  const r = await rig({ limit: 2 });
  const s = r.session();
  for (const n of [1, 2]) {
    await r.engine.ask(OWNER, s, ID(n), `q${n}`);
    const run = await started(r, n);
    run.exec.push(initLine());
    run.exec.push(resultLine('ok'));
    await r.engine.idle();
    r.clock.t += 60_000;
  }
  await r.engine.ask(OWNER, s, ID(3), 'q3');
  const limited = r.snaps().find((x) => x.id === ID(3))!;
  assert.equal(limited.reason, 'rate_limit');
  // The first started 2 minutes ago: it leaves the 10-minute window in 8.
  assert.equal(limited.retryAfterMs, 8 * 60_000);
  assert.equal(r.runs.length, 2);
  await r.engine.ask(OWNER, s, ID(5), 'again');
  assert.equal(r.snaps().filter((x) => x.reason === 'rate_limit').length, 2, 'asking again while limited is limited again, not counted');
  // Other sessions have their own count.
  const other = r.session();
  await r.engine.ask(OWNER, other, ID(6), 'other');
  assert.equal(r.runs.length, 3);
  // The window slides: after the first one leaves it, one more may start.
  r.clock.t += 9 * 60_000;
  await r.engine.ask(OWNER, s, ID(7), 'later');
  assert.equal(r.runs.length, 4);
});

test('the limit counts people together: a session has one allowance, whoever asks', async () => {
  const r = await rig({ limit: 1 });
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'mine');
  (await started(r)).exec.push(initLine());
  r.runs[0]!.exec.push(resultLine('ok'));
  await r.engine.idle();
  await r.engine.ask(OWNER, s, ID(2), 'again');
  assert.equal(last(r).reason, 'rate_limit');
});

test('cancel stops the process at once (an interrupt, then the connection closes), keeps what was said, frees the session and books no usage', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'long one');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(textDelta('Partial answer so'));
  await until(() => r.deltas().length > 0);
  r.engine.cancel(OWNER, s, ID(1));
  await r.engine.idle();
  assert.equal(last(r).status, 'cancelled');
  assert.equal(last(r).reason, undefined);
  assert.match(last(r).answer, /Partial answer/);
  assert.match(run.exec.written, /"subtype":"interrupt"/);
  await until(() => run.exec.closed, 1500);
  assert.equal(r.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get()!.n, 0);
  // A late result from the dying process changes nothing.
  run.exec.push(resultLine('late'));
  assert.equal(last(r).status, 'cancelled');
  // The slot is free.
  await r.engine.ask(OWNER, s, ID(2), 'next');
  assert.equal(r.runs.length, 2);
});

test('cancel before the process has started is a clean cancel: nothing is left running', async () => {
  const r = await rig();
  const s = r.session();
  const slow = new Promise<void>((resolve) => setTimeout(resolve, 60));
  const exec = r.host.exec;
  r.host.exec = async (ws, command) => {
    await slow;
    return exec(ws, command);
  };
  await r.engine.ask(OWNER, s, ID(1), 'q');
  r.engine.cancel(OWNER, s, ID(1));
  await r.engine.idle();
  assert.equal(last(r).status, 'cancelled');
  await sleep(120);
  assert.equal(r.runs[0]!.exec.closed, true, 'the late exec was closed, never given the question');
  assert.equal(r.runs[0]!.exec.written, '');
});

test('close stops a running one, hides the card from a tab that subscribes later, and tells the other tabs', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  const run = await started(r);
  run.exec.push(initLine());
  assert.equal(r.engine.open(OWNER, s).length, 1);
  r.engine.close(OWNER, s, ID(1));
  await r.engine.idle();
  assert.equal(last(r).closed, true);
  assert.equal(last(r).status, 'cancelled');
  assert.equal(r.engine.open(OWNER, s).length, 0);
  // Closing again is nothing; a card that was never stored (a refusal every tab got) is closed on every tab by a bare closed snapshot.
  const sent = r.out.length;
  r.engine.close(OWNER, s, ID(1));
  assert.equal(r.out.length, sent);
  r.engine.close(OWNER, s, ID(99));
  const bare = r.snaps().at(-1)!;
  assert.deepEqual([bare.id, bare.closed], [ID(99), true]);
  assert.equal(r.btwStore.get('u_owner', s, ID(99)), null, 'nothing was stored for it');
});

test('the time limit ends a run that does not answer, with the reason and the process stopped', async () => {
  const r = await rig({ timeoutMs: 120 });
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  const run = await started(r);
  run.exec.push(initLine());
  await failedWith(r, 'timeout');
  assert.match(run.exec.written, /"subtype":"interrupt"/);
  // The command carries a backstop a little over the limit, inside the workspace.
  assert.equal(run.command[run.command.indexOf('timeout') + 1], '6');
});

test('every failure is a reason code with one safe sentence, never the API\'s own words', async () => {
  const cases: { name: string; script: (e: FakeExec) => void; reason: BtwReason }[] = [
    { name: '401 retry', script: (e) => (e.push(initLine()), e.push(line({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 401, error: 'authentication_failed' }))), reason: 'signed_out' },
    { name: '429 retry', script: (e) => (e.push(initLine()), e.push(line({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 429, error: 'rate_limit' }))), reason: 'api_limit' },
    { name: '529 twice', script: (e) => (e.push(initLine()), e.push(line({ type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529 })), e.push(line({ type: 'system', subtype: 'api_retry', attempt: 2, error_status: 529 }))), reason: 'overloaded' },
    { name: 'plan limit rejected', script: (e) => (e.push(initLine()), e.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))), reason: 'no_quota' },
    { name: 'overloaded result', script: (e) => (e.push(initLine()), e.push(line({ type: 'assistant', is_api_error_message: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: Repeated 529 Overloaded errors. check your inference gateway (127.0.0.1:41919)' }] } })), e.push(resultLine('API Error: Repeated 529 Overloaded errors. check your inference gateway (127.0.0.1:41919)', { is_error: true, terminal_reason: 'api_error', api_error_status: 529, modelUsage: {}, usage: undefined }))), reason: 'overloaded' },
    { name: 'usage limit result', script: (e) => (e.push(initLine()), e.push(resultLine('Claude usage limit reached. Your limit will reset at 3pm.', { is_error: true, api_error_status: 429, modelUsage: {} }))), reason: 'no_quota' },
    { name: 'no answer', script: (e) => (e.push(initLine()), e.push(resultLine('   '))), reason: 'empty' },
    { name: 'claude missing', script: (e) => e.exit(127), reason: 'workspace' },
    { name: 'killed by timeout', script: (e) => e.exit(124), reason: 'timeout' },
    { name: 'died', script: (e) => e.exit(1), reason: 'error' },
    { name: 'cost cap', script: (e) => (e.push(initLine()), e.push(resultLine('', { is_error: true, subtype: 'error_max_budget_usd', modelUsage: {} }))), reason: 'error' },
  ];
  for (const c of cases) {
    const r = await rig();
    const s = r.session();
    await r.engine.ask(OWNER, s, ID(1), 'q');
    const run = await started(r);
    c.script(run.exec);
    await r.engine.idle();
    const snap = last(r);
    assert.equal(snap.status, 'failed', c.name);
    assert.equal(snap.reason, c.reason, c.name);
    assert.ok(!JSON.stringify(snap).includes('127.0.0.1'), `${c.name}: no raw API text`);
    assert.ok(!JSON.stringify(snap).includes('inference gateway'), c.name);
    await r.done();
    rigs = [];
  }
});

test('refusals before any run: switch off, spending gate, sign-in, workspace, removed Claude; each creates no process', async () => {
  const r = await rig();
  const s = r.session();
  r.cfg.enabled = false;
  await r.engine.ask(OWNER, s, ID(1), 'q');
  assert.equal(last(r).reason, 'disabled');
  r.cfg.enabled = true;

  r.host.gateMessage = 'The daily budget is used up.';
  await r.engine.ask(OWNER, s, ID(2), 'q');
  assert.equal(last(r).reason, 'no_quota');
  assert.equal(last(r).note, 'The daily budget is used up.');
  r.host.gateMessage = null;

  r.host.credential_ = { reason: 'signed_out', note: 'This Claude isn’t signed in.' };
  await r.engine.ask(OWNER, s, ID(3), 'q');
  assert.equal(last(r).reason, 'signed_out');
  r.host.credential_ = null;

  r.host.execError = true;
  await r.engine.ask(OWNER, s, ID(4), 'q');
  await r.engine.idle();
  assert.equal(last(r).reason, 'workspace');
  r.host.execError = false;

  assert.equal(r.runs.length, 0);
  // None of those was stored, except the one that reached the exec.
  assert.equal(r.btwStore.get('u_owner', s, ID(1)), null);
  assert.equal(r.btwStore.get('u_owner', s, ID(3)), null);
  assert.equal(r.btwStore.get('u_owner', s, ID(4))?.status, 'failed');
  // And a failure before the API used nothing: no numbers on the card, no usage row.
  assert.equal(last(r).usage, undefined);
  assert.equal(r.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get()!.n, 0);
});

test('a question must be there, short enough, and have a well-formed id; a session must exist', async () => {
  const r = await rig();
  const s = r.session();
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : 'other';
    }
    return 'none';
  };
  assert.equal(await code(r.engine.ask(OWNER, s, ID(1), '   ')), 'VALIDATION_FAILED');
  assert.equal(await code(r.engine.ask(OWNER, s, ID(1), 'x'.repeat(BTW_QUESTION_MAX + 1))), 'VALIDATION_FAILED');
  assert.equal(await code(r.engine.ask(OWNER, s, 'x', 'q')), 'VALIDATION_FAILED');
  assert.equal(await code(r.engine.ask(OWNER, s, 'bad id with spaces', 'q')), 'VALIDATION_FAILED');
  assert.equal(await code(r.engine.ask(OWNER, 'no-such-session', ID(1), 'q')), 'NOT_FOUND');
  assert.equal(r.runs.length, 0);
  assert.equal(await code(r.engine.ask(OWNER, s, ID(1), 'x'.repeat(BTW_QUESTION_MAX))), 'none');
});

test('the same ask twice at once (a double tap) is one run, and the second is not answered as busy', async () => {
  const r = await rig();
  const s = r.session();
  await Promise.all([r.engine.ask(OWNER, s, ID(1), 'once'), r.engine.ask(OWNER, s, ID(1), 'once')]);
  assert.equal(r.runs.length, 1);
  assert.ok(r.snaps().every((x) => x.reason === undefined), 'no refusal was sent for it');
  assert.equal(r.snaps().filter((x) => x.status === 'running').length, 1);
});

test('asking twice with the same id is one ask: the state is sent again, no second run', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  await r.engine.ask(OWNER, s, ID(1), 'q');
  assert.equal(r.runs.length, 1);
  assert.equal(r.snaps().length, 2);
  assert.equal(r.snaps().every((x) => x.id === ID(1)), true);
});

/* ---------- Across users ---------- */

test('another user cannot ask, cancel, close, pin or even see a side question of a session they do not own', async () => {
  const r = await rig();
  const s = r.session('sess-a', 'u_a');
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return isAppError(e) ? `${e.code}/${e.status}` : 'other';
    }
    return 'none';
  };
  await r.engine.ask(A, s, ID(1), 'my private question');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(resultLine('A private answer.'));
  await r.engine.idle();

  const asyncCode = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? `${e.code}/${e.status}` : 'other';
    }
    return 'none';
  };
  // B has no right on A's session: the answer is the same as for a session that does not exist.
  assert.equal(await asyncCode(r.engine.ask(B, s, ID(2), 'let me in')), 'NOT_FOUND/404');
  assert.equal(code(() => r.engine.cancel(B, s, ID(1))), 'NOT_FOUND/404');
  assert.equal(code(() => r.engine.close(B, s, ID(1))), 'NOT_FOUND/404');
  assert.equal(code(() => r.engine.pin(B, s, ID(1))), 'NOT_FOUND/404');
  assert.deepEqual(r.engine.open(B, s), []);
  assert.equal(await asyncCode(r.engine.ask(B, 'sess-nope', ID(2), 'x')), 'NOT_FOUND/404', 'same as a session that does not exist');
  // Nobody signed in is refused, an agent of another session is refused.
  assert.equal(await asyncCode(r.engine.ask({ kind: 'anonymous' }, s, ID(3), 'x')), 'UNAUTHORIZED/401');
  assert.equal(await asyncCode(r.engine.ask({ kind: 'agent', userId: 'u_a', tokenId: 't', sessionId: 'other', workspaceId: 'docker/ws1' }, s, ID(3), 'x')), 'FORBIDDEN/403');
  // A's card was never sent to B, and is still there for A.
  assert.equal(r.snaps('u_b').length, 0);
  assert.equal(r.engine.open(A, s).length, 1);
  assert.equal(r.btwStore.get('u_a', s, ID(1))?.status, 'answered');
});

test('the same btw id from two people does not collide, and one person\'s id never reaches the other\'s record', async () => {
  const r = await rig();
  const s = r.session('sess-shared', 'u_a');
  // B is given the right by the way the seam works for an owner-less pass: here, only A owns it, so B asks on its own session instead.
  const sb = r.session('sess-b', 'u_b');
  await r.engine.ask(A, s, ID(1), 'a asks');
  await r.engine.ask(B, sb, ID(1), 'b asks with the same id');
  assert.equal(r.runs.length, 2);
  const a = r.btwStore.get('u_a', s, ID(1))!;
  const b = r.btwStore.get('u_b', sb, ID(1))!;
  assert.equal(a.question, 'a asks');
  assert.equal(b.question, 'b asks with the same id');
  assert.equal(r.btwStore.get('u_a', sb, ID(1)), null);
  assert.equal(r.btwStore.get('u_b', s, ID(1)), null);
  assert.equal(r.snaps('u_a').every((x) => x.question === 'a asks'), true);
  assert.equal(r.snaps('u_b').every((x) => x.question === 'b asks with the same id'), true);
});

test('a revoked right ends the person\'s running side questions (an access change)', async () => {
  const r = await rig();
  const s = r.session('sess-a', 'u_a');
  const t = r.session('sess-b', 'u_b');
  await r.engine.ask(A, s, ID(1), 'q');
  await r.engine.ask(B, t, ID(1), 'q');
  await started(r, 2);
  emitAccessChange({ userId: 'u_a', ref: { type: 'session', id: s }, why: 'share_ended' });
  await until(() => r.snaps('u_a').at(-1)?.status === 'cancelled');
  assert.equal(r.snaps('u_b').at(-1)?.status, 'running', 'someone else\'s run is untouched');
  emitAccessChange({ userId: 'u_b', ref: null, why: 'user_disabled' });
  await until(() => r.snaps('u_b').at(-1)?.status === 'cancelled');
});

/* ---------- Pin ---------- */

test('pin appends ONE card from the portal\'s own copy, once, only for an answered btw of the asker; Claude never sees it', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'what did we decide?');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(resultLine('We decided to ship on Friday.'));
  await r.engine.idle();

  const before = r.chat.history(s, 0).length;
  const ev = r.engine.pin(OWNER, s, ID(1));
  assert.equal(ev.kind, 'system');
  assert.equal(ev.btw?.question, 'what did we decide?');
  assert.equal(ev.btw?.answer, 'We decided to ship on Friday.');
  assert.equal(ev.btw?.askedBy, 'user:u_owner');
  assert.equal(ev.btw?.usage?.estimate, true);
  assert.match(ev.text ?? '', /^btw: what did we decide\?\n\nWe decided/);
  assert.equal(r.chat.history(s, 0).length, before + 1);
  // It comes back from the store whole.
  const stored = r.chat.history(s, 0).at(-1)!;
  assert.deepEqual(stored.btw, ev.btw);
  assert.equal(last(r).pinnedSeq, ev.seq);
  assert.equal(r.chat.audit({ kind: 'btw.pin' }).length, 1);
  // Once.
  assert.throws(() => r.engine.pin(OWNER, s, ID(1)), (e) => isAppError(e) && e.code === 'CONFLICT');
  // Not an unfinished one, not a failed one, not one that does not exist.
  await r.engine.ask(OWNER, s, ID(2), 'q2');
  assert.throws(() => r.engine.pin(OWNER, s, ID(2)), (e) => isAppError(e) && e.code === 'CONFLICT');
  assert.throws(() => r.engine.pin(OWNER, s, ID(9)), (e) => isAppError(e) && e.code === 'NOT_FOUND');
  // A later side question's context leaves the pinned card out.
  r.engine.cancel(OWNER, s, ID(2));
  await r.engine.idle();
  await r.engine.ask(OWNER, s, ID(3), 'q3');
  const run3 = await started(r, 3);
  assert.ok(!text(run3).includes('We decided to ship on Friday.'), 'a pinned card is the person\'s record, not Claude\'s context');
});

/* ---------- Replay, recovery ---------- */

test('a tab that subscribes gets the person\'s open side questions of the last hour, the live answer so far for a running one', async () => {
  const r = await rig();
  const s = r.session();
  for (const n of [1, 2]) {
    await r.engine.ask(OWNER, s, ID(n), `q${n}`);
    const run = await started(r, n);
    run.exec.push(initLine());
    if (n === 2) run.exec.push(textDelta('so far'));
    else run.exec.push(resultLine('answer one'));
    r.clock.t += 1000;
  }
  await until(() => r.deltas() === 'so far');
  const open = r.engine.open(OWNER, s);
  assert.deepEqual(open.map((x) => [x.id, x.status, x.answer]), [
    [ID(2), 'running', 'so far'],
    [ID(1), 'answered', 'answer one'],
  ]);
  r.clock.t += 61 * 60_000;
  assert.deepEqual(r.engine.open(OWNER, s), [], 'older than an hour is not replayed');
  r.engine.cancel(OWNER, s, ID(2));
});

test('a side question left running by a restart can never finish: it ends as failed', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  await started(r);
  // A restart: a new engine on the same database.
  const again = new BtwEngine({ store: r.btwStore, host: r.host, config: () => r.cfg });
  again.start();
  const rec = r.btwStore.get('u_owner', s, ID(1))!;
  assert.equal(rec.status, 'failed');
  assert.equal(rec.reason, 'error');
  assert.match(rec.note ?? '', /restart/);
  await again.shutdown();
});

test('deleting the session deletes its side questions, and the usage rows stay like every usage row', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'q');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(resultLine('ok'));
  await r.engine.idle();
  assert.equal(r.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_btw').get()!.n, 1);
  r.chat.deleteSession(s);
  assert.equal(r.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_btw').get()!.n, 0);
  assert.equal(r.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get()!.n, 1);
});

test('the answer is bounded: a very long one is cut with a mark, on the stream and in the result', async () => {
  const r = await rig();
  const s = r.session();
  await r.engine.ask(OWNER, s, ID(1), 'write a lot');
  const run = await started(r);
  run.exec.push(initLine());
  run.exec.push(textDelta('lorem ipsum '.repeat(2000)));
  run.exec.push(resultLine('lorem ipsum '.repeat(2000)));
  await r.engine.idle();
  assert.ok(r.deltas().length <= BTW_ANSWER_MAX);
  assert.ok(last(r).answer.length <= BTW_ANSWER_MAX + 20);
  assert.ok(last(r).answer.endsWith('… (cut)'));
});

test('the settings become the engine\'s config, a bad value is the default', () => {
  const c = readBtwConfig((k) => ({ 'chat.btw.limit': 3, 'chat.btw.windowMin': 5, 'chat.btw.timeoutSec': 30, 'chat.btw.contextChars': 1000, 'chat.btw.model': ' sonnet ', 'chat.btw.maxCostUsd': 0.2, 'chat.btw.enabled': false })[k]);
  assert.deepEqual(c, { enabled: false, limit: 3, windowMs: 300_000, timeoutMs: 30_000, contextChars: 4_000, model: 'sonnet', maxCostUsd: 0.2 });
  assert.deepEqual(readBtwConfig(() => undefined), { enabled: true, limit: 6, windowMs: 600_000, timeoutMs: 60_000, contextChars: 60_000, model: '', maxCostUsd: 0.5 });
  // A string where a number belongs is the default; the model is a string setting, so it is kept as given.
  assert.deepEqual(readBtwConfig(() => 'junk'), { enabled: true, limit: 6, windowMs: 600_000, timeoutMs: 60_000, contextChars: 60_000, model: 'junk', maxCostUsd: 0.5 });
});

test('the model asked is the session\'s own, a setting overrides it, and an unsafe name never reaches the command line', async () => {
  const r = await rig({ model: 'sonnet' });
  const s = r.session();
  r.store.db!.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run('claude-opus-5-5', s);
  await r.engine.ask(OWNER, s, ID(1), 'q');
  const run = await started(r);
  assert.equal(run.command[run.command.indexOf('--model') + 1], 'sonnet');
  r.engine.cancel(OWNER, s, ID(1));
  await r.engine.idle();
  r.cfg.model = '';
  await r.engine.ask(OWNER, s, ID(2), 'q');
  const run2 = await started(r, 2);
  assert.equal(run2.command[run2.command.indexOf('--model') + 1], 'claude-opus-5-5');
  r.engine.cancel(OWNER, s, ID(2));
  await r.engine.idle();
  r.store.db!.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run('x; reboot', s);
  await r.engine.ask(OWNER, s, ID(3), 'q');
  const run3 = await started(r, 3);
  assert.ok(!run3.command.includes('--model'));
  assert.ok(!run3.command.some((a) => a.includes('reboot')));
});

test('a job acting for the owner may use the engine like the owner; the same job for another user may not', async () => {
  const r = await rig();
  const s = r.session('sess-o', null);
  await r.engine.ask(asUser('u_owner', 'test-job'), s, ID(1), 'q');
  assert.equal(r.runs.length, 1);
  await assert.rejects(() => r.engine.ask(asUser('u_b', 'test-job'), s, ID(2), 'q'), (e) => e instanceof AppError && e.status === 404);
});
