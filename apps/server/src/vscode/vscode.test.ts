import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
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
  type VscodeStatus,
  type VscodeTokenPoll,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { clearResolvers, declaredPolicies, registerResolver } from '../authz/seam.js';
import { PortalTokens } from '../portalmcp/tokens.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { DeviceFlow, PENDING_MAX, cleanClientName } from './device.js';
import { createVscodeApproveRoutes, createVscodeBearerRoutes, createVscodeFlow, createVscodePublicRoutes, type VscodeDeps } from './routes.js';

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
  assert.equal(flow.decide(s.userCode, 'approve'), true);
  assert.equal(flow.pending(s.userCode), null, 'an answered code is not pending any more');
  assert.equal(flow.decide(s.userCode, 'deny'), false, 'and can not be answered twice');
  assert.deepEqual(flow.poll(s.deviceCode), { status: 'approved', client: 'my laptop' });
  assert.deepEqual(flow.poll(s.deviceCode), { status: 'expired' }, 'only once');
});

test('a denied code says denied once; an expired or unknown one says expired', () => {
  let t = 5_000_000;
  const flow = new DeviceFlow(() => t);
  const a = flow.start(undefined, null)!;
  flow.decide(a.userCode, 'deny');
  assert.deepEqual(flow.poll(a.deviceCode), { status: 'denied' });
  assert.deepEqual(flow.poll(a.deviceCode), { status: 'expired' });
  const b = flow.start('x', null)!;
  t += 601_000;
  assert.equal(flow.pending(b.userCode), null);
  assert.deepEqual(flow.poll(b.deviceCode), { status: 'expired' });
  assert.deepEqual(flow.poll('not-a-device-code-at-all-but-long'), { status: 'expired' });
  assert.deepEqual(flow.poll(42), { status: 'expired' });
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
  assert.equal(normalizeUserCode('bcdf-ghjk'), 'BCDFGHJK');
  assert.equal(normalizeUserCode('BCDF-GHJA'), null, 'a vowel is never in a code');
  assert.equal(normalizeUserCode('BCDF'), null);
});

/* ---------- The routes, put together as app.ts does ---------- */

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

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-vscode-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const tokens = new PortalTokens(store);
  const sessions = new Map<string, ChatSession>([
    ['s1', session('s1', { lead: true, ticketId: 'T-1', ticketKey: 'KONF-1' })],
    ['s2', session('s2', { parentId: 's1', state: 'waiting', waiting: 2 })],
    ['s3', session('s3', { state: 'ended' })],
    ['s4', session('s4', { archivedAt: now() })],
  ]);
  const open = new Map<string, ChatRequest[]>([['s2', [request('r1'), request('r2', { full: 'x'.repeat(10), fullCut: true })]]]);
  const sent: { id: string; text: string; actor?: string }[] = [];
  const answered: { id: string; requestId: string; decision: string; actor?: string }[] = [];
  const audit: { kind: string; actor: string; detail: Record<string, unknown> }[] = [];
  const history: ChatEvent[] = [
    { seq: 1, at: now(), kind: 'user', text: 'hello <b>x</b>', uuid: 'u1' } as ChatEvent,
    { seq: 2, at: now(), kind: 'assistant', text: 'hi', uuid: 'a1' } as ChatEvent,
    { seq: 3, at: now(), kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', text: 'secret-looking tool input' } as ChatEvent,
    { seq: 4, at: now(), kind: 'assistant', text: 'from a sub-agent', agentLabel: 'helper' } as ChatEvent,
  ];
  const deps: VscodeDeps = {
    tokens: {
      create: (req) => tokens.create(req),
      verify: (s, ip) => tokens.verify(s, ip),
      revoke: (id, reason) => tokens.revoke(id, reason),
    },
    chat: {
      list: () => [...sessions.values()],
      get: (id) => sessions.get(id) ?? null,
      resolve: (id) => {
        if (!sessions.has(id)) throw new AppError('NOT_FOUND', 'No such session.');
        return id;
      },
      openRequests: (id) => open.get(id) ?? [],
      history: (_id, after = 0) => history.filter((e) => e.seq > after),
      historyPage: () => ({ events: history }),
      send: async (id, _uuid, text, o) => void sent.push({ id, text, actor: o?.actor }),
      respond: async (id, requestId, decision, o) => void answered.push({ id, requestId, decision, actor: o?.actor }),
    },
    workspaces: { list: async () => [{ id: 'local/ws1', name: 'ws1', label: 'One', target: 'local', image: 'x', status: 'running', createdAt: now() }] },
    usage: {
      report: async () =>
        ({
          claudes: [
            { claudeId: 'cl1', claudeName: 'Main', workspaceId: 'local/ws1', unavailable: null, windows: [{ key: 'session', label: 'Session', usedPct: 42, resetsAt: null, level: 'ok' }, { key: 'week', label: 'Week', usedPct: 61, resetsAt: null, level: 'ok' }] },
          ],
          alerts: [],
          thresholds: { warn: 80, critical: 95 },
          intervalMs: 1,
          now: now(),
        }) as never,
    },
    glance: { snapshot: () => ({ attention: { count: 3 } }) as never },
    audit: (kind, detail, actor) => void audit.push({ kind, detail, actor }),
    clientKey: () => '10.0.0.7',
    origin: () => 'http://127.0.0.1:3400',
  };
  // The same shape as app.ts: one router under /api/vscode; the cookie group stands in for requireSession (cookie `sid=ok` is signed in).
  const flow = createVscodeFlow();
  const requireSession = async (c: Context, next: () => Promise<void>) => {
    if (c.req.header('cookie') !== 'sid=ok') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    c.set('token' as never, 'ok' as never);
    await next();
  };
  const vs = new Hono();
  vs.use('/pending', requireSession);
  vs.use('/approve', requireSession);
  vs.route('/', createVscodePublicRoutes(flow, deps));
  vs.route('/', createVscodeApproveRoutes(flow, deps));
  vs.route('/', createVscodeBearerRoutes(deps) as never);
  const app = new Hono();
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as never);
  });
  app.route('/api/vscode', vs);
  const call = async <T = unknown>(method: string, path: string, o: { body?: unknown; bearer?: string; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.cookie) headers.cookie = o.cookie;
    const res = await app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string } } | null;
    return { status: res.status, data: json?.data as T, error: json?.error, headers: res.headers };
  };
  /** A whole sign-in: start, approve as the person, poll. Returns the token. */
  const signIn = async (client = 'laptop') => {
    const start = await call<VscodeDeviceStart>('POST', '/api/vscode/device', { body: { client } });
    await call('POST', '/api/vscode/approve', { cookie: 'sid=ok', body: { userCode: start.data.userCode, decision: 'approve' } });
    const poll = await call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } });
    assert.equal(poll.data.status, 'ok');
    return (poll.data as Extract<VscodeTokenPoll, { status: 'ok' }>).token;
  };
  return { call, signIn, tokens, sessions, open, sent, answered, audit, done: () => (store.close?.(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('the device flow over HTTP: start, the signed-in person approves, one poll gets an operate token labelled for VS Code', async () => {
  const h = await harness();
  try {
    const v = await h.call<{ api: number }>('GET', '/api/vscode/version');
    assert.equal(v.status, 200);
    assert.equal(v.data.api, 1);
    assert.equal(v.headers.get(VSCODE_API_HEADER), '1', 'every answer says the API version');

    const start = await h.call<VscodeDeviceStart>('POST', '/api/vscode/device', { body: { client: 'dev box' } });
    assert.equal(start.status, 200);
    assert.equal(start.data.verifyUrl, 'http://127.0.0.1:3400/admin/vscode');
    assert.ok(start.data.verifyUrlComplete.endsWith(`?code=${start.data.userCode}`));

    // The code can only be looked at or approved signed in.
    assert.equal((await h.call('GET', `/api/vscode/pending?code=${start.data.userCode}`)).status, 401);
    assert.equal((await h.call('POST', '/api/vscode/approve', { body: { userCode: start.data.userCode, decision: 'approve' } })).status, 401);
    const pending = await h.call<{ client: string; ip: string }>('GET', `/api/vscode/pending?code=${start.data.userCode}`, { cookie: 'sid=ok' });
    assert.equal(pending.data.client, 'dev box');
    assert.equal(pending.data.ip, '10.0.0.7', 'the page shows where the request came from');
    assert.equal((await h.call('GET', '/api/vscode/pending?code=BCDF-GHJK', { cookie: 'sid=ok' })).status, 404, 'a code nobody started');

    assert.equal((await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } })).data.status, 'pending');
    assert.equal((await h.call('POST', '/api/vscode/approve', { cookie: 'sid=ok', body: { userCode: start.data.userCode, decision: 'approve' } })).status, 200);
    const poll = await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } });
    assert.equal(poll.data.status, 'ok');
    const ok = poll.data as Extract<VscodeTokenPoll, { status: 'ok' }>;
    assert.equal(ok.label, `${VSCODE_TOKEN_LABEL_PREFIX}dev box`);
    const stored = h.tokens.get(ok.tokenId)!;
    assert.equal(stored.scope, 'operate', 'minimally scoped: never admin');
    const days = (Date.parse(stored.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30, `30 days, got ${days}`);
    assert.equal((await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } })).data.status, 'expired', 'the token is handed out once');
    assert.ok(h.audit.some((a) => a.kind === 'vscode.approved' && a.actor === 'user:u_owner'));
    assert.ok(h.audit.some((a) => a.kind === 'vscode.token_issued' && a.actor === `portal-mcp:${ok.tokenId}`));
    assert.ok(!JSON.stringify(h.audit).includes(ok.token), 'the token is in no audit row');
    assert.ok(!JSON.stringify(h.audit).includes(start.data.deviceCode), 'nor the device code');

    // Signing in again from the same client replaces its token.
    const again = await h.signIn('dev box');
    assert.notEqual(again, ok.token);
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: ok.token })).status, 401, 'the replaced token is dead');
    assert.equal((await h.call('GET', '/api/vscode/me', { bearer: again })).status, 200);
  } finally {
    h.done();
  }
});

test('a denied code gives no token', async () => {
  const h = await harness();
  try {
    const start = await h.call<VscodeDeviceStart>('POST', '/api/vscode/device', { body: {} });
    await h.call('POST', '/api/vscode/approve', { cookie: 'sid=ok', body: { userCode: start.data.userCode, decision: 'deny' } });
    assert.equal((await h.call<VscodeTokenPoll>('POST', '/api/vscode/token', { body: { deviceCode: start.data.deviceCode } })).data.status, 'denied');
    assert.equal(h.tokens.list().length, 0);
  } finally {
    h.done();
  }
});

test('the bearer door: no token, a wrong one, a token not from the device flow, a cookie beside it and a revoked one are refused', async () => {
  const h = await harness();
  try {
    const none = await h.call('GET', '/api/vscode/agents');
    assert.equal(none.status, 401);
    assert.equal(none.headers.get(VSCODE_API_HEADER), '1', 'a refusal says the API version too');
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: `cpat_${'A'.repeat(43)}` })).status, 401);
    // A Portal MCP token made in Access → MCP (another label) does not open these routes, even with the admin scope.
    const other = h.tokens.create({ label: 'some script', scope: 'admin' });
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: other.secret })).status, 401);
    const token = await h.signIn();
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: token, cookie: 'sid=ok' })).status, 400, 'never a cookie with a bearer');
    const me = await h.call<{ scope: string }>('GET', '/api/vscode/me', { bearer: token });
    assert.equal(me.data.scope, 'operate');
    assert.equal((await h.call('POST', '/api/vscode/logout', { bearer: token })).status, 200);
    assert.equal((await h.call('GET', '/api/vscode/agents', { bearer: token })).status, 401, 'signed out: the token is revoked');
    // The public routes never ran the token check.
    assert.equal((await h.call('GET', '/api/vscode/version')).status, 200);
  } finally {
    h.done();
  }
});

test('agents, workspaces, tickets and status: what the person may see, in the shapes the extension reads', async () => {
  const h = await harness();
  try {
    const token = await h.signIn();
    const agents = await h.call<VscodeAgent[]>('GET', '/api/vscode/agents', { bearer: token });
    assert.deepEqual(agents.data.map((a) => a.id), ['s2', 's1'], 'live and not archived, the waiting one first');
    const lead = agents.data.find((a) => a.id === 's1')!;
    assert.equal(lead.ticketKey, 'KONF-1');
    assert.equal(lead.lead, true);
    assert.equal(lead.costUsd, 0.5);
    assert.equal(lead.url, '/admin/sessions/s1');
    assert.equal(agents.data.find((a) => a.id === 's2')!.parentId, 's1');

    const ws = await h.call<{ name: string }[]>('GET', '/api/vscode/workspaces', { bearer: token });
    assert.deepEqual(ws.data.map((w) => w.name), ['One']);
    const tickets = await h.call<unknown[]>('GET', '/api/vscode/tickets', { bearer: token });
    assert.deepEqual(tickets.data, [], 'no tickets module: an empty list');

    const status = await h.call<VscodeStatus>('GET', '/api/vscode/status', { bearer: token });
    assert.deepEqual(status.data.quota, { claudeId: 'cl1', claudeName: 'Main', label: 'Week', usedPct: 61, resetsAt: null }, 'the active Claude, its tightest window');
    assert.equal(status.data.attention, 3);
    assert.equal(status.data.approvals, 2);
  } finally {
    h.done();
  }
});

test('a session the person may not see is the same 404 as a missing one, and is not listed (the seam decides)', async () => {
  const h = await harness();
  try {
    const token = await h.signIn();
    // Default deny through a resolver: s2 belongs to another user.
    registerResolver({
      type: 'session',
      resolve: (id) => (h.sessions.has(id) ? { ref: { type: 'session', id }, owner: { kind: 'user', id: id === 's2' ? 'u_b' : 'u_owner' } } : null),
    });
    const agents = await h.call<VscodeAgent[]>('GET', '/api/vscode/agents', { bearer: token });
    assert.deepEqual(agents.data.map((a) => a.id), ['s1']);
    const hidden = await h.call('GET', '/api/vscode/sessions/s2/events', { bearer: token });
    const missing = await h.call('GET', '/api/vscode/sessions/nope/events', { bearer: token });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.error, missing.error, 'nothing tells them apart');
    assert.deepEqual((await h.call<VscodeApproval[]>('GET', '/api/vscode/approvals', { bearer: token })).data, []);
    assert.equal((await h.call('POST', '/api/vscode/sessions/s2/respond', { bearer: token, body: { requestId: 'r1', decision: 'deny' } })).status, 404);
    assert.equal(h.answered.length, 0);
  } finally {
    h.done();
  }
});

test('approvals carry the whole text; Allow needs the hash of what was shown, a cut request can only be denied', async () => {
  const h = await harness();
  try {
    const token = await h.signIn();
    const list = await h.call<VscodeApproval[]>('GET', '/api/vscode/approvals', { bearer: token });
    const [whole, cut] = list.data;
    assert.equal(whole!.full, 'npm test -- --watch=false');
    assert.equal(whole!.allowable, true);
    assert.equal(whole!.fullSha256, createHash('sha256').update('npm test -- --watch=false').digest('hex'));
    assert.equal(cut!.allowable, false);
    assert.equal(cut!.note, 'Too long to show in full.');

    const respond = (body: unknown) => h.call('POST', '/api/vscode/sessions/s2/respond', { bearer: token, body });
    assert.equal((await respond({ requestId: 'r1', decision: 'allow' })).status, 409, 'no hash: refused');
    assert.equal((await respond({ requestId: 'r1', decision: 'allow', fullSha256: '0'.repeat(64) })).status, 409, 'another text: refused');
    assert.equal((await respond({ requestId: 'r2', decision: 'allow', fullSha256: cut!.fullSha256 })).status, 409, 'cut: never allowed');
    assert.equal((await respond({ requestId: 'gone', decision: 'deny' })).status, 409, 'not open');
    assert.equal(h.answered.length, 0);
    assert.equal((await respond({ requestId: 'r1', decision: 'allow', fullSha256: whole!.fullSha256 })).status, 200);
    assert.equal((await respond({ requestId: 'r2', decision: 'deny', note: 'too long' })).status, 200);
    assert.deepEqual(
      h.answered.map((a) => [a.requestId, a.decision, a.actor]),
      [
        ['r1', 'allow', 'ui'],
        ['r2', 'deny', 'ui'],
      ],
      'through the controller, as the person (its own rules hold too)',
    );
    assert.ok(h.audit.some((a) => a.kind === 'vscode.answered' && a.detail.decision === 'allow'));
  } finally {
    h.done();
  }
});

test('the chat: the main thread as plain records (no tool input, no sub-agent lines), and send with the slash rule of a token', async () => {
  const h = await harness();
  try {
    const token = await h.signIn();
    const ev = await h.call<VscodeEvents>('GET', '/api/vscode/sessions/s1/events', { bearer: token });
    assert.deepEqual(ev.data.events.map((e) => e.kind), ['user', 'assistant', 'tool_use']);
    assert.equal(ev.data.events[0]!.text, 'hello <b>x</b>', 'text as it is: the extension escapes it');
    assert.equal(ev.data.events[2]!.text, null, 'a tool use is its name only');
    assert.ok(!JSON.stringify(ev.data).includes('sub-agent'));
    const after = await h.call<VscodeEvents>('GET', '/api/vscode/sessions/s1/events?after=2', { bearer: token });
    assert.deepEqual(after.data.events.map((e) => e.seq), [3]);

    const send = (text: string) => h.call('POST', '/api/vscode/sessions/s1/send', { bearer: token, body: { text } });
    assert.equal((await send('   ')).status, 422);
    assert.equal((await send('/clear')).status, 403, 'a slash command a token may not send');
    assert.equal((await send('/compact')).status, 200);
    assert.equal((await send('run the tests')).status, 200);
    assert.deepEqual(h.sent.map((s) => [s.id, s.text, s.actor]), [
      ['s1', '/compact', 'ui'],
      ['s1', 'run the tests', 'ui'],
    ]);
    const audited = h.audit.filter((a) => a.kind === 'vscode.sent');
    assert.equal(audited.length, 2);
    assert.ok(!JSON.stringify(audited).includes('run the tests'), 'the audit keeps a count, never the text');
  } finally {
    h.done();
  }
});

test('every route is declared, the bearer ones as bearer', async () => {
  const h = await harness();
  try {
    const keys = [...declaredPolicies().keys()].filter((k) => k.includes('/api/vscode/'));
    assert.equal(keys.length, 15);
    for (const k of keys) {
      const p = declaredPolicies().get(k)!;
      const isBearer = !/(version|device|token|pending|approve)$/.test(k);
      assert.equal(p.bearer === true, isBearer, k);
    }
  } finally {
    h.done();
  }
});
