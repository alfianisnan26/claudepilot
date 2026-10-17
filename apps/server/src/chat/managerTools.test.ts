// `approvals_list` and `crew_limits_get` over the real Portal MCP endpoint (T-968 S2a, general-manager PRD §9.1). Allowed: a read token sees
// its own sessions' open requests of any age and a lead's limits and slots. Denied: another user's session answers exactly like a missing
// one (NOT_FOUND, same bytes) and its rows never show; an agent's token never reaches either tool. Redaction: an agent's text comes back
// labelled untrusted with credential shapes masked.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { FOUNDING_USER_ID, objectRef, type ChatSession, type UserId } from '@portal/contracts';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { CHAT_MANAGER_TOOL_POLICIES } from './authz.js';
import { registerChatManagerTools } from './managerTools.js';

const U_B = 'u_b' as UserId;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
/** A credential-shaped value, built at run time (no token-shaped literal in the repository). */
const fakeToken = () => ['cp', 'at_', 'Q7x'.repeat(10)].join('');

/** Sessions by id and who owns each; an id not listed does not exist. */
function owners(rows: Record<string, UserId>) {
  registerResolver({ type: 'session', resolve: (id) => (rows[id] ? { ref: objectRef('session', id), owner: { kind: 'user', id: rows[id]! }, attrs: { workspaceId: 'docker/dev' } } : null) });
}
after(() => clearResolvers());

const session = (id: string, o: Partial<ChatSession> = {}): ChatSession => ({ id, title: `Session ${id}`, state: 'working', parentId: null, createdAt: ago(30), ...o }) as ChatSession;

async function build(sessions: ChatSession[] = []) {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const reached = { get: 0 };
  registerChatManagerTools(
    {
      db: () => h.store.db,
      chat: { get: (id) => (reached.get++, sessions.find((s) => s.id === id) ?? null), list: (f) => sessions.filter((s) => !f?.parentId || s.parentId === f.parentId) },
      caps: () => ({ maxDepth: 1, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 60 }),
      now: () => NOW,
    },
    registry,
  );
  const db = h.store.db!;
  const row = (id: string, title = `Session ${id}`) =>
    db.prepare("INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at) VALUES (?, 'docker/dev', ?, 'waiting', ?, ?, ?)").run(id, title, ago(60), ago(60), ago(1));
  const live = () => db.exec("UPDATE chat_sessions SET process = 'live'");
  const request = (s: string, id: string, min: number, o: { title?: string; agent?: string; answered?: boolean } = {}) =>
    db
      .prepare('INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, agent_label, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s, id, 'tool', 'Bash', o.title ?? 'Run a command', 'ls', o.agent ?? null, ago(min), o.answered ? ago(0) : null);
  return { h, row, live, request, reached };
}

type Called = Awaited<ReturnType<Awaited<ReturnType<typeof portalMcpHarness>>['call']>>;
const refused = (c: Called) => c.result?.isError === true || !!c.error;

test('approvals_list: every open request of the caller\'s sessions, any age, oldest first; answered ones and other users\' never', async () => {
  const { h, row, live, request } = await build();
  try {
    owners({ s_mine: FOUNDING_USER_ID, s_theirs: U_B });
    row('s_mine');
    row('s_theirs');
    live();
    request('s_mine', 'q_new', 1);
    request('s_mine', 'q_old', 20);
    request('s_mine', 'q_done', 5, { answered: true });
    request('s_theirs', 'q_b', 3);
    const read = h.token('read').secret;
    const r = await h.call(read, 'approvals_list', {});
    assert.equal(r.result?.isError, undefined, JSON.stringify(r.raw));
    const rows = r.result!.structuredContent.approvals as { session_id: string; request_id: string; age_s: number; tool: string; link: string }[];
    assert.deepEqual(rows.map((x) => `${x.session_id}/${x.request_id}`), ['s_mine/q_old', 's_mine/q_new'], 'a fresh one too, and nothing of another user');
    assert.equal(rows[1]!.age_s, 60);
    assert.equal(rows[0]!.tool, 'Bash');
    assert.equal(rows[0]!.link, '/admin/sessions/s_mine');
    assert.equal(r.result!.structuredContent.total, 2);
    const one = await h.call(read, 'approvals_list', { session_id: 's_mine', limit: 1 });
    assert.deepEqual((one.result!.structuredContent.approvals as { request_id: string }[]).map((x) => x.request_id), ['q_old']);
    assert.match(one.result!.structuredContent.summary, /2 open requests, 1 shown/);
  } finally {
    h.done();
    clearResolvers();
  }
});

test('approvals_list denied: another user\'s session reads exactly like a missing one; an agent never reaches it', async () => {
  const { h, row, live, request } = await build();
  try {
    owners({ s_theirs: U_B });
    row('s_theirs');
    live();
    request('s_theirs', 'q_b', 3);
    const read = h.token('read').secret;
    const theirs = await h.call(read, 'approvals_list', { session_id: 's_theirs' });
    assert.equal(theirs.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.deepEqual(theirs.result, (await h.call(read, 'approvals_list', { session_id: 's_nosuch' })).result);
    assert.deepEqual((await h.call(read, 'approvals_list', {})).result!.structuredContent.approvals, []);
    const agent = await h.agentToken('docker/dev', 's_theirs');
    assert.ok(refused(await h.call(agent.secret, 'approvals_list', {})), 'an agent token is refused');
  } finally {
    h.done();
    clearResolvers();
  }
});

test('approvals_list redaction: the summary, the session title and the agent label are untrusted and masked', async () => {
  const { h, row, live, request } = await build();
  try {
    owners({ s_mine: FOUNDING_USER_ID });
    const secret = fakeToken();
    row('s_mine', `deploy ${secret}`);
    live();
    request('s_mine', 'q_1', 2, { title: `curl -H "x: ${secret}"`, agent: `qa ${secret}` });
    const r = await h.call(h.token('read').secret, 'approvals_list', {});
    const a = r.result!.structuredContent.approvals[0];
    for (const f of [a.summary, a.session_title, a.agent]) {
      assert.equal(f.source, 'agent');
      assert.match(f.untrusted_text, /\[redacted\]/);
    }
    assert.ok(!JSON.stringify(r.raw).includes(secret), 'the value is in no part of the answer');
  } finally {
    h.done();
    clearResolvers();
  }
});

test('crew_limits_get: the lead\'s own limit under the global one, the slots in use and free, its running workers; no queue is guessed', async () => {
  const sessions = [
    session('s_lead', { maxWorkers: 3, subagents: false }),
    session('w_1', { parentId: 's_lead', agent: 'implementer' }),
    session('w_2', { parentId: 's_lead', state: 'ended' }),
    session('w_x', { parentId: 's_other' }),
  ];
  const { h } = await build(sessions);
  try {
    owners({ s_lead: FOUNDING_USER_ID });
    const r = await h.call(h.token('read').secret, 'crew_limits_get', { session_id: 's_lead' });
    assert.equal(r.result?.isError, undefined, JSON.stringify(r.raw));
    const c = r.result!.structuredContent;
    assert.deepEqual([c.own_max_workers, c.max_workers, c.in_use, c.free, c.subagents, c.queue], [3, 3, 1, 2, false, 'unavailable']);
    assert.deepEqual(c.global, { max_depth: 1, max_children: 5, spawns_per_hour: 20, messages_per_hour: 60 });
    assert.deepEqual(c.workers.map((w: { id: string; agent: string }) => [w.id, w.agent]), [['w_1', 'implementer']]);
  } finally {
    h.done();
    clearResolvers();
  }
});

test('crew_limits_get denied: another user\'s lead reads exactly like a missing one and the handler never runs; an agent never reaches it', async () => {
  const { h, reached } = await build([session('s_theirs', { maxWorkers: 2 })]);
  try {
    owners({ s_theirs: U_B });
    const read = h.token('read').secret;
    const theirs = await h.call(read, 'crew_limits_get', { session_id: 's_theirs' });
    assert.equal(theirs.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.deepEqual(theirs.result, (await h.call(read, 'crew_limits_get', { session_id: 's_nosuch' })).result);
    assert.equal(reached.get, 0, 'the handler never saw a refused call');
    const agent = await h.agentToken('docker/dev', 's_theirs');
    assert.ok(refused(await h.call(agent.secret, 'crew_limits_get', { session_id: 's_theirs' })));
  } finally {
    h.done();
    clearResolvers();
  }
});

test('crew_limits_get redaction: a worker\'s title is untrusted and masked', async () => {
  const secret = fakeToken();
  const { h } = await build([session('s_lead'), session('w_1', { parentId: 's_lead', title: `fix ${secret}` })]);
  try {
    owners({ s_lead: FOUNDING_USER_ID });
    const r = await h.call(h.token('read').secret, 'crew_limits_get', { session_id: 's_lead' });
    assert.equal(r.result!.structuredContent.workers[0].title.source, 'agent');
    assert.match(r.result!.structuredContent.workers[0].title.untrusted_text, /\[redacted\]/);
    assert.ok(!JSON.stringify(r.raw).includes(secret));
  } finally {
    h.done();
    clearResolvers();
  }
});

test('declared through the seam: view on the session, the same text as a missing one', () => {
  assert.deepEqual(CHAT_MANAGER_TOOL_POLICIES, {
    approvals_list: { kind: 'objects', checks: [{ type: 'session', verb: 'view', arg: 'session_id', optional: true, notFound: 'No such session.' }], filter: 'session' },
    crew_limits_get: { kind: 'objects', checks: [{ type: 'session', verb: 'view', arg: 'session_id', notFound: 'No such session.' }] },
  });
});
