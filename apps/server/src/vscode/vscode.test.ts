import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError } from '@isnanme/core';
import {
  VSCODE_API_HEADER,
  VSCODE_TOKEN_LABEL_PREFIX,
  normalizeUserCode,
  type ChatEvent,
  type ChatRequest,
  type ChatSession,
  type VscodeAgent,
  type VscodeApproval,
  type VscodeDeviceStart,
  type VscodeEvents,
  type VscodePending,
  type VscodeStatus,
  type VscodeTokenPoll,
} from '@portal/contracts';
import type { Hono } from 'hono';
import { createApp } from '../app.js';
import { clearResolvers, declaredPolicies, registerResolver } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { DeviceFlow, PENDING_MAX, cleanClientName } from './device.js';

afterEach(() => clearResolvers());

/* ---------- The device flow ---------- */

test('a code is approved once: the poll after the approval says so, and the code is gone after it', () => {
  let t = 1_000_000;
  const flow = new DeviceFlow(() => t);
  const s = flow.start('my laptop', '10.0.0.1')!;
  assert.match(s.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.ok(s.deviceCode.length >= 40, 'a 256-bit device code');
  assert.deepEqual(flow.poll(s.deviceCode), { status: 'pending' });
  t += 1000;
  assert.equal(flow.poll(s.deviceCode).status, 'slow_down', 'polled sooner than the interval');
  assert.equal(flow.pending(s.userCode.toLowerCase().replace('-', ' '))?.client, 'my laptop', 'the person may type it in any case, with a space');
  const issued = { token: 'secret-made-at-run-time', tokenId: 'ptk_1', expiresAt: 'later', label: 'VS Code · my laptop' };
  assert.deepEqual(flow.approve(s.userCode, (who) => (assert.deepEqual(who, { client: 'my laptop', instance: null }), issued)), issued);
  assert.equal(flow.pending(s.userCode), null, 'an answered code is not pending any more');
  assert.equal(flow.deny(s.userCode), false, 'and can not be answered twice');
  assert.deepEqual(flow.poll(s.deviceCode), { status: 'approved', issued });
  assert.deepEqual(flow.poll(s.deviceCode), { status: 'expired' }, 'only once');
});

test('a denied code says denied once; an expired or unknown one says expired', () => {
  let t = 5_000_000;
  const flow = new DeviceFlow(() => t);
  const a = flow.start(undefined, null)!;
  flow.deny(a.userCode);
  assert.deepEqual(flow.poll(a.deviceCode), { status: 'denied' });
  assert.deepEqual(flow.poll(a.deviceCode), { status: 'expired' });
  const b = flow.start('x', null)!;
  t += 601_000;
  assert.equal(flow.pending(b.userCode), null);
  assert.deepEqual(flow.poll(b.deviceCode), { status: 'expired' });
  assert.deepEqual(flow.poll('not-a-device-code-at-all-but-long'), { status: 'expired' });
  assert.deepEqual(flow.poll(42), { status: 'expired' });
});

test('an approval whose token can not be made leaves the code pending (retry); a token nobody picked up is revoked at expiry', () => {
  let t = 9_000_000;
  const unclaimed: string[] = [];
  const flow = new DeviceFlow(() => t, (i) => void unclaimed.push(i.tokenId));
  const s = flow.start('box', null, 'inst-0001')!;
  assert.throws(() => flow.approve(s.userCode, () => { throw new Error('read-only'); }));
  assert.ok(flow.pending(s.userCode), 'still pending after a failed issue');
  flow.approve(s.userCode, (who) => (assert.equal(who.instance, 'inst-0001'), { token: 'x', tokenId: 'ptk_2', expiresAt: '', label: '' }));
  t += 601_000;
  assert.equal(flow.size, 0);
  assert.deepEqual(unclaimed, ['ptk_2']);
  assert.deepEqual(flow.poll(s.deviceCode), { status: 'expired' });
});

test('at most PENDING_MAX codes wait at once', () => {
  const flow = new DeviceFlow();
  for (let i = 0; i < PENDING_MAX; i++) assert.ok(flow.start(`c${i}`, null));
  assert.equal(flow.start('one more', null), null);
});

test('a client name is one line of plain text, with a default', () => {
  assert.equal(cleanClientName('  a\nb <c> "d"  '), 'a b c d');
  assert.equal(cleanClientName(''), 'VS Code');
  assert.equal(cleanClientName(42), 'VS Code');
  assert.equal(cleanClientName('x'.repeat(100)).length, 40);
  // Bidi overrides, zero-width and other invisible characters can't make a name read as another (review m3).
  const rlo = String.fromCodePoint(0x202e);
  const zw = String.fromCodePoint(0x200b);
  const soft = String.fromCodePoint(0xad);
  assert.equal(cleanClientName(`lap${rlo}top${zw}${soft} X`), 'lap top X');
  assert.equal(normalizeUserCode('bcdf-ghjk'), 'BCDFGHJK');
  assert.equal(normalizeUserCode('BCDF-GHJA'), null, 'a vowel is never in a code');
  assert.equal(normalizeUserCode('BCDF'), null);
});

/* ---------- Through createApp: the routes as the portal mounts them (review R5) ---------- */

const now = () => new Date().toISOString();
const session = (id: string, o: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    workspaceId: 'local/ws1',
    cwd: '/home/node/work',
    title: `title ${id}`,
    state: 'idle',
    origin: 'portal',
    model: 'claude-opus-5-5',
    mode: 'default',
    effort: null,
    costUsd: 0.5,
    turns: 1,
    lastSeq: 3,
    waiting: 0,
    waitingFor: null,
    createdAt: now(),
    lastActivityAt: now(),
    endedReason: null,
    claudeId: 'cl1',
    claudeName: 'Main',
    archivedAt: null,
    pinnedAt: null,
    ticketId: null,
    parentId: null,
    ...o,
  }) as ChatSession;

const request = (id: string, o: Partial<ChatRequest> = {}): ChatRequest => ({
  requestId: id,
  kind: 'tool',
  toolName: 'Bash',
  agentLabel: null,
  title: 'Run a command',
  detail: 'npm test',
  full: 'npm test -- --watch=false',
  createdAt: now(),
  ...o,
});

/** Anything createApp asks of a dependency the test does not care about: a callable that answers itself. */
const stub = (): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub()),
    apply: () => stub(),
    construct: () => stub(),
    set: () => true,
  });
/** A dependency with some real methods; the rest stubbed. */
const partly = <T extends object>(real: T): T => new Proxy(real, { get: (t, p) => (p in t ? (t as Record<string | symbol, unknown>)[p] : stub()) }) as T;

const CODE = '13572468';
const HOST = 'localhost:3000';

async function harness() {
  const mcp = await portalMcpHarness();
  mcp.module.settings.update({ enabled: true, sessionControl: true });
  const portal = new Portal(CODE, 60_000);
  const cookie = `portal_session=${portal.signIn(CODE)}`;
  const sessions = new Map<string, ChatSession>([
    ['s1', session('s1', { lead: true, ticketId: 'T-1', ticketKey: 'KONF-1' })],
    ['s2', session('s2', { parentId: 's1', state: 'waiting', waiting: 2 })],
    ['s3', session('s3', { state: 'ended' })],
    ['s4', session('s4', { archivedAt: now() })],
  ]);
  const open = new Map<string, ChatRequest[]>([['s2', [request('r1'), request('r2', { full: 'x'.repeat(10), fullCut: true })]]]);
  const sent: { id: string; text: string; actor?: string; actorLabel?: string }[] = [];
  const answered: { id: string; requestId: string; decision: string; actor?: string }[] = [];
  const audit: { kind: string; actor: string; detail: Record<string, unknown> }[] = [];
  const history: ChatEvent[] = [
    { seq: 1, at: now(), kind: 'user', text: 'hello <b>x</b>', uuid: 'u1' } as ChatEvent,
    { seq: 2, at: now(), kind: 'assistant', text: 'hi', uuid: 'a1' } as ChatEvent,
    { seq: 3, at: now(), kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', text: 'tool input' } as ChatEvent,
    { seq: 4, at: now(), kind: 'assistant', text: 'from a sub-agent', agentLabel: 'helper' } as ChatEvent,
  ];
  const chat = partly({
    list: () => [...sessions.values()],
    get: (id: string) => sessions.get(id) ?? null,
    resolve: (id: string) => {
      if (!sessions.has(id)) throw new AppError('NOT_FOUND', 'No such session.');
      return id;
    },
    openRequests: (id: string) => open.get(id) ?? [],
    history: (_id: string, after = 0) => history.filter((e) => e.seq > after),
    historyPage: () => ({ events: history }),
    send: async (id: string, _uuid: string, text: string, o?: { actor?: string; actorLabel?: string }) => void sent.push({ id, text, actor: o?.actor, actorLabel: o?.actorLabel }),
    respond: async (id: string, requestId: string, decision: string, o?: { actor?: string }) => void answered.push({ id, requestId, decision, actor: o?.actor }),
  });
  const workspaces = partly({ list: async () => [{ id: 'local/ws1', name: 'ws1', label: 'One', target: 'local', image: 'x', status: 'running', createdAt: now() }] });
  const claudeUsage = partly({
    report: async () => ({
      claudes: [{ claudeId: 'cl1', claudeName: 'Main', workspaceId: 'local/ws1', unavailable: null, windows: [{ key: 'session', label: 'Session', usedPct: 42, resetsAt: null, level: 'ok' }, { key: 'week', label: 'Week', usedPct: 61, resetsAt: null, level: 'ok' }] }],
      alerts: [],
      thresholds: { warn: 80, critical: 95 },
      intervalMs: 1,
      now: now(),
    }),
  });
  const glance = partly({ snapshot: () => ({ attention: { count: 3 } }) });
  const platform = partly({ audit: { record: (e: { kind: string; actor: string; detail?: Record<string, unknown> }) => void audit.push({ kind: e.kind, actor: e.actor, detail: e.detail ?? {} }) }, routes: () => [], hooks: stub() });
  const make = createApp as unknown as (...args: unknown[]) => Hono;
  const app = make(portal, workspaces, mcp.store, stub(), stub(), stub(), stub(), chat, { serveWeb: false, poolService: stub(), portalMcp: mcp.module, claudeUsage, glance, platform });
  const env = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };
  const call = async <T = unknown>(method: string, path: string, o: { body?: unknown; raw?: string; bearer?: string; cookie?: boolean; origin?: string } = {}) => {
    const headers: Record<string, string> = { host: HOST };
    if (o.body !== undefined || o.raw !== undefined) headers['content-type'] = 'application/json';
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.cookie) headers.cookie = cookie;
    if (o.origin) headers.origin = o.origin;
    const res = await app.request(`http://${HOST}${path}`, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }, env);
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string } } | null;
    return { status: res.status, data: json?.data as T, error: json?.error, headers: res.headers };
  };
  const same = `http://${HOST}`;
  /** A whole sign-in: start, the person approves (same origin, signed in), one poll. */
  const signIn = async (client = 'laptop', instance?: string) => {
    const start = await call<VscodeDeviceStart>('POST', '/api/vscode/device', { body: { client, ...(instance ? { instance } : {}) } });
    assert.equal(start.status, 200, JSON.stringify(start.error));
    const ok = await call('POST', '/api/vscode/approve', { cookie: true, origin: same, body: { userCode: start.data.userCode, decision: 'approve' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.error));
    const poll = await call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } });
    assert.equal(poll.data.status, 'ok');
    return poll.data as Extract<VscodeTokenPoll, { status: 'ok' }>;
  };
  return { call, signIn, same, mcp, sessions, sent, answered, audit, done: () => mcp.done() };
}

test('the device flow through the portal: start, the person approves (the token is made then, by them), one poll hands it over', async () => {
  const h = await harness();
  try {
    const v = await h.call<{ api: number }>('GET', '/api/vscode/version');
    assert.equal(v.data.api, 1);
    assert.equal(v.headers.get(VSCODE_API_HEADER), '1');
    const start = await h.call<VscodeDeviceStart>('POST', '/api/vscode/device', { body: { client: 'dev box' } });
    assert.ok(start.data.verifyUrl.endsWith('/admin/vscode'));
    // Signed in only.
    assert.equal((await h.call('GET', `/api/vscode/pending?code=${start.data.userCode}`)).status, 401);
    const pending = await h.call<VscodePending>('GET', `/api/vscode/pending?code=${start.data.userCode}`, { cookie: true });
    assert.equal(pending.data.client, 'dev box');
    assert.equal(pending.data.ip, '10.0.0.7');
    assert.equal(pending.data.viewerIp, '10.0.0.7');
    assert.equal(pending.data.sameAddress, true);
    assert.equal((await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } })).data.status, 'pending');
    assert.equal((await h.call('POST', '/api/vscode/approve', { cookie: true, origin: h.same, body: { userCode: start.data.userCode, decision: 'approve' } })).status, 200);
    const approved = h.audit.find((a) => a.kind === 'vscode.approved')!;
    assert.equal(approved.actor, 'user:u_owner', 'the approver is recorded');
    assert.match(String(approved.detail.tokenId), /^ptk_/, 'and the token it made');
    const poll = await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } });
    const ok = poll.data as Extract<VscodeTokenPoll, { status: 'ok' }>;
    assert.equal(ok.tokenId, approved.detail.tokenId);
    assert.equal(ok.label, `${VSCODE_TOKEN_LABEL_PREFIX}dev box`);
    const stored = h.mcp.module.tokens.get(ok.tokenId)!;
    assert.equal(stored.scope, 'operate');
    assert.equal(stored.client, 'vscode');
    assert.equal((await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } })).data.status, 'expired', 'once');
    assert.ok(!JSON.stringify(h.audit).includes(ok.token), 'no token in the audit');
    assert.ok(!JSON.stringify(h.audit).includes(start.data.deviceCode), 'no device code either');
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: ok.token })).status, 200);
  } finally {
    h.done();
  }
});

test('a cross-site approve is refused (403) and approves nothing', async () => {
  const h = await harness();
  try {
    const start = await h.call<VscodeDeviceStart>('POST', '/api/vscode/device', { body: {} });
    const res = await h.call('POST', '/api/vscode/approve', { cookie: true, origin: 'https://evil.example', body: { userCode: start.data.userCode, decision: 'approve' } });
    assert.equal(res.status, 403);
    assert.equal((await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } })).data.status, 'pending');
  } finally {
    h.done();
  }
});

test('the device flow\'s public calls take 4 KiB at most', async () => {
  const h = await harness();
  try {
    const big = JSON.stringify({ client: 'x'.repeat(5000) });
    assert.equal((await h.call('POST', '/api/vscode/device', { raw: big })).status, 413);
    assert.equal((await h.call('POST', '/api/vscode/token', { raw: JSON.stringify({ deviceCode: 'y'.repeat(5000) }) })).status, 413);
    assert.equal((await h.call('POST', '/api/vscode/device', { raw: JSON.stringify({ client: 'x'.repeat(3000) }) })).status, 200, 'under the limit');
  } finally {
    h.done();
  }
});

test('R1: a VS Code token is refused by /mcp like an unknown one, and a label alone does not open /api/vscode', async () => {
  const h = await harness();
  try {
    const t = await h.signIn();
    const viaMcp = await h.mcp.rpc(t.token, 'tools/list');
    const unknown = await h.mcp.rpc(`cpat_${'B'.repeat(43)}`, 'tools/list');
    assert.equal(viaMcp.status, 401);
    assert.equal(viaMcp.status, unknown.status);
    assert.deepEqual(viaMcp.body, unknown.body, 'the same answer as an unknown token');
    // A token made in Access -> MCP with the VS Code label is still not a VS Code token.
    const lookalike = h.mcp.module.createToken({ label: `${VSCODE_TOKEN_LABEL_PREFIX}laptop`, scope: 'operate', addAnother: true }, 'http://x/mcp');
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: lookalike.secret })).status, 401);
    assert.notEqual((await h.mcp.rpc(lookalike.secret, 'tools/list')).status, 401, 'and it still works on /mcp');
  } finally {
    h.done();
  }
});

test('m2: a new sign-in replaces only the same installation\'s token, not another client of the same name', async () => {
  const h = await harness();
  try {
    const a1 = await h.signIn('Visual Studio Code', 'install-aaaa');
    const b = await h.signIn('Visual Studio Code', 'install-bbbb');
    const a2 = await h.signIn('Visual Studio Code', 'install-aaaa');
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: a1.token })).status, 401, 'the same installation: replaced');
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: b.token })).status, 200, 'another installation with the same name: kept');
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: a2.token })).status, 200);
  } finally {
    h.done();
  }
});

test('the bearer door: no token, a cookie beside it, signed out; the Portal MCP switch off refuses every bearer route', async () => {
  const h = await harness();
  try {
    const none = await h.call('GET', '/api/vscode/agents');
    assert.equal(none.status, 401);
    assert.equal(none.headers.get(VSCODE_API_HEADER), '1');
    const t = await h.signIn();
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: t.token, cookie: true })).status, 400);
    h.mcp.module.settings.update({ enabled: false });
    for (const path of ['/api/vscode/me', '/api/vscode/agents', '/api/vscode/tickets', '/api/vscode/workspaces', '/api/vscode/status', '/api/vscode/approvals', '/api/vscode/sessions/s1/events'])
      assert.equal((await h.call('GET', path, { bearer: t.token })).status, 403, path);
    assert.equal((await h.call('POST', '/api/vscode/sessions/s1/send', { bearer: t.token, body: { text: 'hi' } })).status, 403);
    h.mcp.module.settings.update({ enabled: true, sessionControl: false });
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: t.token })).status, 200, 'on again: reads work');
    assert.equal((await h.call('POST', '/api/vscode/sessions/s1/send', { bearer: t.token, body: { text: 'hi' } })).status, 403, 'session control off: no send');
    assert.equal((await h.call('POST', '/api/vscode/sessions/s2/respond', { bearer: t.token, body: { requestId: 'r1', decision: 'deny' } })).status, 403, 'nor deny');
    assert.equal(h.sent.length + h.answered.length, 0);
    h.mcp.module.settings.update({ sessionControl: true });
    const out = await h.call('POST', '/api/vscode/logout', { bearer: t.token, body: {} });
    assert.equal(out.status, 200, JSON.stringify(out.error));
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: t.token })).status, 401, 'signed out: revoked');
  } finally {
    h.done();
  }
});

test('agents, workspaces, tickets and status in the shapes the extension reads', async () => {
  const h = await harness();
  try {
    const t = await h.signIn();
    const agents = await h.call<VscodeAgent[]>('GET', '/api/vscode/agents', { bearer: t.token });
    assert.deepEqual(agents.data.map((a) => a.id), ['s2', 's1']);
    const lead = agents.data.find((a) => a.id === 's1')!;
    assert.equal(lead.ticketKey, 'KONF-1');
    assert.equal(lead.lead, true);
    assert.equal(agents.data.find((a) => a.id === 's2')!.parentId, 's1');
    assert.deepEqual((await h.call<{ name: string }[]>('GET', '/api/vscode/workspaces', { bearer: t.token })).data.map((w) => w.name), ['One']);
    assert.deepEqual((await h.call<unknown[]>('GET', '/api/vscode/tickets', { bearer: t.token })).data, []);
    const status = await h.call<VscodeStatus>('GET', '/api/vscode/status', { bearer: t.token });
    assert.deepEqual(status.data.quota, { claudeId: 'cl1', claudeName: 'Main', label: 'Week', usedPct: 61, resetsAt: null });
    assert.equal(status.data.attention, 3);
    assert.equal(status.data.approvals, 2);
  } finally {
    h.done();
  }
});

test('a session the person may not see is the same 404 as a missing one, and is not listed', async () => {
  const h = await harness();
  try {
    const t = await h.signIn();
    registerResolver({
      type: 'session',
      resolve: (id) => (h.sessions.has(id) ? { ref: { type: 'session', id }, owner: { kind: 'user', id: id === 's2' ? 'u_b' : 'u_owner' } } : null),
    });
    assert.deepEqual((await h.call<VscodeAgent[]>('GET', '/api/vscode/agents', { bearer: t.token })).data.map((a) => a.id), ['s1']);
    const hidden = await h.call('GET', '/api/vscode/sessions/s2/events', { bearer: t.token });
    const missing = await h.call('GET', '/api/vscode/sessions/nope/events', { bearer: t.token });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.error, missing.error);
    assert.deepEqual((await h.call<VscodeApproval[]>('GET', '/api/vscode/approvals', { bearer: t.token })).data, []);
    assert.equal((await h.call('POST', '/api/vscode/sessions/s2/respond', { bearer: t.token, body: { requestId: 'r1', decision: 'deny' } })).status, 404);
  } finally {
    h.done();
  }
});

test('R2: approvals carry the whole text; VS Code can deny, never allow', async () => {
  const h = await harness();
  try {
    const t = await h.signIn();
    const list = await h.call<VscodeApproval[]>('GET', '/api/vscode/approvals', { bearer: t.token });
    assert.equal(list.data[0]!.full, 'npm test -- --watch=false');
    assert.equal(list.data[1]!.fullCut, true);
    assert.ok(!('fullSha256' in list.data[0]!) && !('allowable' in list.data[0]!), 'no Allow path left');
    const respond = (body: unknown) => h.call('POST', '/api/vscode/sessions/s2/respond', { bearer: t.token, body });
    const allow = await respond({ requestId: 'r1', decision: 'allow' });
    assert.equal(allow.status, 403);
    assert.match(allow.error!.message, /in the portal/);
    assert.equal((await respond({ requestId: 'gone', decision: 'deny' })).status, 409);
    assert.equal((await respond({ requestId: 'r1', decision: 'deny', note: 'no' })).status, 200);
    assert.deepEqual(h.answered, [{ id: 's2', requestId: 'r1', decision: 'deny', actor: `portal-mcp:${t.tokenId}` }]);
  } finally {
    h.done();
  }
});

test('R3: the chat shows the token as the sender (portal framing), not the person; slash rule; main thread only', async () => {
  const h = await harness();
  try {
    const t = await h.signIn();
    const ev = await h.call<VscodeEvents>('GET', '/api/vscode/sessions/s1/events', { bearer: t.token });
    assert.deepEqual(ev.data.events.map((e) => e.kind), ['user', 'assistant', 'tool_use']);
    assert.equal(ev.data.events[0]!.text, 'hello <b>x</b>');
    assert.equal(ev.data.events[2]!.text, null);
    assert.deepEqual((await h.call<VscodeEvents>('GET', '/api/vscode/sessions/s1/events?after=2', { bearer: t.token })).data.events.map((e) => e.seq), [3]);
    const send = (text: string) => h.call('POST', '/api/vscode/sessions/s1/send', { bearer: t.token, body: { text } });
    assert.equal((await send('   ')).status, 422);
    assert.equal((await send('/clear')).status, 403);
    assert.equal((await send('run the tests')).status, 200);
    assert.deepEqual(h.sent, [{ id: 's1', text: 'run the tests', actor: `portal-mcp:${t.tokenId}`, actorLabel: `${VSCODE_TOKEN_LABEL_PREFIX}laptop` }]);
    const audited = h.audit.filter((a) => a.kind === 'vscode.sent');
    assert.equal(audited.length, 1);
    assert.ok(!JSON.stringify(audited).includes('run the tests'));
  } finally {
    h.done();
  }
});

test('every route is declared, the bearer ones as bearer', async () => {
  const h = await harness();
  try {
    const keys = [...declaredPolicies().keys()].filter((k) => k.includes('/api/vscode/'));
    assert.equal(keys.length, 15);
    for (const k of keys) assert.equal(declaredPolicies().get(k)!.bearer === true, !/(version|device|token|pending|approve)$/.test(k), k);
  } finally {
    h.done();
  }
});

void normalizeUserCode;

test('migration 49: tokens carry their client (NULL before and for Access -> MCP tokens), and only a known client', async () => {
  const h = await harness();
  try {
    const cols = (h.mcp.store.db!.prepare('PRAGMA table_info(pmcp_tokens)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('client') && cols.includes('client_instance'));
    const plain = h.mcp.module.createToken({ label: 'a script', scope: 'read' }, 'http://x/mcp');
    assert.equal(h.mcp.module.tokens.get(plain.token.id)!.client, null);
    assert.throws(() => h.mcp.store.db!.prepare("UPDATE pmcp_tokens SET client = 'other' WHERE id = ?").run(plain.token.id), /CHECK/);
  } finally {
    h.done();
  }
});
