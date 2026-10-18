// T-1083 S1b-1 (D-84): the job-run Mac door. Its `cpjr_` tokens (hashed, admin-minted, one workspace each), the door's guards (only its own
// token, can() on the workspace as the minting admin, the same 404 for every refusal, a body cap, rate limits), and the wiring in createApp
// (minting only through the cookie under /api; the door outside /api; a door token is nothing to /mcp or /api, and no other token is
// anything to the door). Every token is minted at run time; no literal is token-shaped.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { JOBRUN_DOOR_LIMITS, platformRef, type Actor, type JobRunMacRun } from '@portal/contracts';
import { Hono } from 'hono';
import { createApp } from '../app.js';
import { can, singleOwner, useAuthz } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { createJobRunDoor, type MacRunner } from './routes.js';
import { JobRunTokens } from './tokens.js';

const WS = 'connect-mac/runner';
const rnd = (n = 6) => randomBytes(n).toString('hex');
type Status = { status: string };

async function setup(o: { status?: string; runner?: MacRunner; clock?: { t: number } } = {}) {
  const h = await portalMcpHarness();
  const clock = o.clock ?? { t: Date.parse('2026-10-18T06:00:00Z') };
  const tokens = new JobRunTokens(h.store, () => new Date(clock.t));
  const ws: Status = { status: o.status ?? 'running' };
  const lookups: { id: string; actor: Actor }[] = [];
  const workspace = async (id: string, actor: Actor) => {
    lookups.push({ id, actor });
    return id === WS ? { id, status: ws.status } : null;
  };
  const addr = { value: '10.1.2.3' };
  const door = createJobRunDoor({ tokens, workspace, runner: o.runner, clientAddress: () => addr.value, now: () => clock.t });
  const app = new Hono();
  app.route('/jobrun/mac', door);
  const call = (path: string, secret: string | null, init: RequestInit = {}) =>
    app.request(`http://portal.test/jobrun/mac${path}`, { ...init, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(init.headers as Record<string, string>) } });
  const mint = (workspaceId = WS) => tokens.mint({ userId: 'u_owner', workspaceId, label: `mac ${rnd(2)}` })!;
  return { h, tokens, ws, lookups, addr, call, mint, clock, done: () => h.done() };
}

const NOT_FOUND = JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });

test('a door token: cpjr_, stored only as a hash, shown as a hint; refused once revoked and from the moment it expires', async () => {
  const s = await setup();
  try {
    const { token, secret } = s.mint();
    assert.match(secret, /^cpjr_[A-Za-z0-9_-]{43}$/);
    assert.equal(token.hint, `cpjr_…${secret.slice(-4)}`);
    assert.equal(token.workspaceId, WS);
    const rows = JSON.stringify(s.h.store.db!.prepare('SELECT * FROM jobrun_tokens').all());
    assert.ok(!rows.includes(secret) && !rows.includes(secret.slice(5)), 'the secret is not stored');
    assert.ok(!JSON.stringify(s.tokens.list()).includes(secret.slice(5, -4)), 'nor listed');

    assert.deepEqual(s.tokens.verify(secret), { ok: true, tokenId: token.id, userId: 'u_owner', workspaceId: WS, label: token.label });
    const end = Date.parse(token.expiresAt);
    assert.equal(end - s.clock.t, 30 * 86_400_000, '30 days');
    s.clock.t = end - 1;
    assert.equal(s.tokens.verify(secret).ok, true);
    s.clock.t = end;
    assert.deepEqual(s.tokens.verify(secret), { ok: false, reason: 'expired', tokenId: token.id });

    const other = s.mint();
    assert.equal(s.tokens.revoke(other.token.id, 'test'), true);
    assert.deepEqual(s.tokens.verify(other.secret), { ok: false, reason: 'revoked', tokenId: other.token.id });
    assert.equal(s.tokens.revoke(other.token.id, 'again'), false);
    // Another kind of token, or junk, is unknown here.
    const admin = s.h.token('admin');
    assert.deepEqual(s.tokens.verify(admin.secret), { ok: false, reason: 'unknown' });
    assert.deepEqual(s.tokens.verify(`cpjr_${rnd(16)}`), { ok: false, reason: 'unknown' });
    assert.deepEqual(s.tokens.verify(''), { ok: false, reason: 'unknown' });
  } finally {
    s.done();
  }
});

test('the door takes its own token only: none, a portal MCP admin token, an agent token, a revoked or expired one all get the same 404', async () => {
  const s = await setup();
  try {
    const good = s.mint();
    const revoked = s.mint();
    s.tokens.revoke(revoked.token.id, 'test');
    const admin = s.h.token('admin');
    const agent = await s.h.agentToken('docker/api', `s-${rnd()}`);
    assert.ok(agent.secret, 'the harness minted an agent token');
    for (const [what, secret] of [
      ['no token', null],
      ['a cpat_ admin token', admin.secret],
      ['an agent token', agent.secret],
      ['a revoked door token', revoked.secret],
      ['an unknown door token', `cpjr_${rnd(32)}`],
    ] as const) {
      for (const [path, method] of [
        ['/slot', 'GET'],
        ['/runs', 'GET'],
        ['/runs', 'POST'],
        ['/runs/r1/log', 'GET'],
        ['/runs/r1', 'DELETE'],
      ] as const) {
        s.addr.value = `10.9.${rnd(1)}.1`; // a fresh address each time: this test is not about the refusal bucket
        const r = await s.call(path, secret, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
        assert.deepEqual([r.status, await r.text()], [404, NOT_FOUND], `${what}: ${method} ${path}`);
      }
    }
    const ok = await s.call('/slot', good.secret);
    assert.equal(ok.status, 200);
  } finally {
    s.done();
  }
});

test('the door acts as the admin who minted the token, and asks can(operate) on its workspace on every call: a denial is the same 404', async () => {
  const s = await setup();
  const denied = new Set<string>();
  const was = useAuthz({
    ...singleOwner,
    can: (actor, verb, object) =>
      object.type === 'workspace' && denied.has(object.id) ? { allow: false, reason: 'not_found', level: 'none' } : singleOwner.can(actor, verb, object),
  });
  try {
    const { token, secret } = s.mint();
    const r = await s.call('/slot', secret);
    assert.equal(r.status, 200);
    assert.deepEqual(s.lookups.at(-1)?.actor, { kind: 'job', userId: 'u_owner', job: `jobrun:${token.id}` });
    denied.add(WS);
    const n = s.lookups.length;
    const d = await s.call('/slot', secret);
    assert.deepEqual([d.status, await d.text()], [404, NOT_FOUND]);
    assert.equal(s.lookups.length, n, 'refused before anything is looked up');
  } finally {
    useAuthz(was);
    s.done();
  }
});

test('the slot: the Mac workspace must be running; no runtime yet (S1b-1) says so; a full Mac says so; a free slot counts what is left', async () => {
  let live = 0;
  const runner: MacRunner = {
    liveCount: () => live,
    list: () => [],
    start: async () => assert.fail('not called'),
    log: async () => null,
    stop: async () => false,
  };
  const none = await setup();
  const withRunner = await setup({ runner });
  try {
    const slot = async (s: typeof none, secret: string) => ((await (await s.call('/slot', secret)).json()) as { data: unknown }).data;
    const a = none.mint().secret;
    assert.deepEqual(await slot(none, a), { slot: false, reason: 'no-runtime' });
    none.ws.status = 'stopped';
    assert.deepEqual(await slot(none, a), { slot: false, reason: 'mac-not-running' });
    // A token minted for a workspace that is gone: not running.
    assert.deepEqual(await slot(none, none.mint(`connect-mac/${rnd(3)}`).secret), { slot: false, reason: 'mac-not-running' });

    const b = withRunner.mint().secret;
    assert.deepEqual(await slot(withRunner, b), { slot: true, free: 2 });
    live = 1;
    assert.deepEqual(await slot(withRunner, b), { slot: true, free: 1 });
    live = 2;
    assert.deepEqual(await slot(withRunner, b), { slot: false, reason: 'mac-full' });
  } finally {
    none.done();
    withRunner.done();
  }
});

test('a run is seen, read and stopped only by the token that started it; the list is that token’s own; no runtime: a start is 503', async () => {
  const seen: string[] = [];
  const run = (id: string): JobRunMacRun => ({ id, where: 'mac', chat: null, state: 'running', startedAt: '2026-10-18T06:00:00Z' });
  const owned = new Map<string, string>();
  const runner: MacRunner = {
    liveCount: () => owned.size,
    list: (tokenId) => {
      seen.push(tokenId);
      return [...owned].filter(([, t]) => t === tokenId).map(([id]) => run(id));
    },
    start: async (tokenId) => {
      const id = `jr${rnd(4)}`;
      owned.set(id, tokenId);
      return run(id);
    },
    log: async (tokenId, id) => (owned.get(id) === tokenId ? new Response('log line\n') : null),
    stop: async (tokenId, id) => owned.get(id) === tokenId && owned.delete(id),
  };
  const s = await setup({ runner });
  const bare = await setup();
  try {
    const a = s.mint();
    const b = s.mint();
    const started = await s.call('/runs', a.secret, { method: 'POST', body: JSON.stringify({ repo: 'claudepilot' }) });
    assert.equal(started.status, 201);
    const id = ((await started.json()) as { data: JobRunMacRun }).data.id;
    assert.deepEqual(((await (await s.call('/runs', a.secret)).json()) as { data: { items: JobRunMacRun[] } }).data.items.map((r) => [r.id, r.where]), [[id, 'mac']]);
    assert.deepEqual(((await (await s.call('/runs', b.secret)).json()) as { data: { items: unknown[] } }).data.items, []);
    assert.deepEqual(seen, [a.token.id, b.token.id]);

    const other = await s.call(`/runs/${id}/log`, b.secret);
    assert.deepEqual([other.status, await other.text()], [404, NOT_FOUND], 'another token’s run is not found');
    assert.equal((await s.call(`/runs/${id}`, b.secret, { method: 'DELETE' })).status, 404);
    assert.equal(await (await s.call(`/runs/${id}/log`, a.secret)).text(), 'log line\n');
    assert.equal((await s.call(`/runs/${id}`, a.secret, { method: 'DELETE' })).status, 200);
    assert.equal((await s.call(`/runs/${id}`, a.secret, { method: 'DELETE' })).status, 404, 'gone');
    assert.equal((await s.call('/runs/..%2Fx/log', a.secret)).status, 404);

    const bad = await s.call('/runs', a.secret, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);
    const noRuntime = await bare.call('/runs', bare.mint().secret, { method: 'POST', body: '{}' });
    assert.equal(noRuntime.status, 503);
  } finally {
    s.done();
    bare.done();
  }
});

test('the door’s guards: a body over 64 KiB is 413 before the token is read; 120 calls a minute per token; 30 refusals a minute per address block it', async () => {
  const s = await setup();
  try {
    const { secret } = s.mint();
    const big = 'x'.repeat(JOBRUN_DOOR_LIMITS.bodyMaxBytes + 1);
    const r = await s.call('/runs', secret, { method: 'POST', body: big });
    assert.equal(r.status, 413);
    assert.equal((await s.call('/runs', null, { method: 'POST', body: big })).status, 413, 'no token: still 413, nothing else is read');

    for (let i = 0; i < JOBRUN_DOOR_LIMITS.tokenMinute; i++) assert.equal((await s.call('/runs', secret)).status, 200, `call ${i + 1}`);
    const limited = await s.call('/runs', secret);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    s.clock.t += 60_000;
    assert.equal((await s.call('/runs', secret)).status, 200, 'a new minute');

    // Refusals are charged to the address: after 30, even a good token from that address waits; another address does not.
    s.addr.value = '10.7.7.7';
    for (let i = 0; i < JOBRUN_DOOR_LIMITS.refusedMinute; i++) assert.equal((await s.call('/slot', `cpjr_${rnd(32)}`)).status, 404);
    assert.equal((await s.call('/slot', secret)).status, 429);
    s.addr.value = '10.7.7.8';
    assert.equal((await s.call('/slot', secret)).status, 200);
  } finally {
    s.done();
  }
});

test('who may mint: the seam gives `manage` on the targets area to the signed-in admin only; an agent and a read or operate token are refused', () => {
  const targets = platformRef('targets');
  const person: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'l1', via: 'ui' };
  assert.equal(can(person, 'manage', targets).allow, true);
  const agent: Actor = { kind: 'agent', userId: 'u_owner', tokenId: 'agt_1', sessionId: 'S1', workspaceId: WS };
  assert.equal(can(agent, 'manage', targets).allow, false);
  for (const scope of ['read', 'operate'] as const) assert.equal(can({ kind: 'token', userId: 'u_owner', tokenId: 'ptk_1', scope }, 'manage', targets).allow, false, scope);
});

test('as mounted in createApp: a token is minted only with the cookie under /api; a door token is nothing to /mcp or /api; no other token opens the door', async () => {
  const h = await portalMcpHarness();
  const stub: object = new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub,
    set: () => true,
  });
  const workspaces = new Proxy(stub, {
    get: (_t, p) =>
      p === 'get'
        ? async (id: string) => {
            if (id !== WS) throw Object.assign(new Error('Not found.'), { status: 404 });
            return { id, status: 'running' };
          }
        : p === 'then'
          ? undefined
          : stub,
  });
  const make = createApp as unknown as (...args: unknown[]) => Hono;
  const portal = new Portal(undefined, 60_000);
  try {
    const app = make(portal, workspaces, h.store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, portalMcp: h.module });
    const cookie = `portal_session=${portal.openSession()}`;
    const body = JSON.stringify({ label: 'mac runner', workspaceId: WS });
    const mint = (headers: Record<string, string>) => app.request('http://localhost:3000/api/jobrun/tokens', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

    const admin = h.token('admin');
    const agent = await h.agentToken('docker/api', `s-${rnd()}`);
    for (const [what, headers] of [
      ['nothing', {}],
      ['a cpat_ admin token', { authorization: `Bearer ${admin.secret}` }],
      ['an agent token', { authorization: `Bearer ${agent.secret}` }],
    ] as const) {
      const r = await mint(headers);
      assert.equal(r.status, 401, `${what} cannot mint`);
    }
    assert.equal((await app.request('http://localhost:3000/api/jobrun/tokens', { headers: { authorization: `Bearer ${admin.secret}` } })).status, 401, 'nor list');

    const made = await mint({ cookie });
    assert.equal(made.status, 201);
    const { token, secret } = ((await made.json()) as { data: { token: { id: string }; secret: string } }).data;
    assert.match(secret, /^cpjr_/);
    const listed = await app.request('http://localhost:3000/api/jobrun/tokens', { headers: { cookie } });
    assert.ok(!(await listed.text()).includes(secret.slice(5, -4)), 'the list never carries the secret');

    // The door: outside /api, no cookie, its own token.
    const slot = await app.request('http://localhost:3000/jobrun/mac/slot', { headers: { authorization: `Bearer ${secret}` } });
    assert.deepEqual([slot.status, ((await slot.json()) as { data: unknown }).data], [200, { slot: false, reason: 'no-runtime' }]);
    for (const headers of [{ cookie }, { authorization: `Bearer ${admin.secret}` }, { authorization: `Bearer ${agent.secret}` }])
      assert.equal((await app.request('http://localhost:3000/jobrun/mac/slot', { headers })).status, 404, JSON.stringify(Object.keys(headers)));

    // A door token is nothing to /api or /mcp.
    assert.equal((await app.request('http://localhost:3000/api/jobrun/tokens', { headers: { authorization: `Bearer ${secret}` } })).status, 401);
    const mcp = await h.rpc(secret, 'tools/list');
    assert.equal(mcp.status, 401);

    // A workspace the admin cannot reach is refused at mint; a revoke ends the door at once.
    const gone = await app.request('http://localhost:3000/api/jobrun/tokens', {
      method: 'POST',
      body: JSON.stringify({ label: 'x', workspaceId: 'connect-mac/gone' }),
      headers: { 'content-type': 'application/json', cookie },
    });
    assert.equal(gone.status, 422);
    assert.equal((await app.request(`http://localhost:3000/api/jobrun/tokens/${token.id}`, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.equal((await app.request('http://localhost:3000/jobrun/mac/slot', { headers: { authorization: `Bearer ${secret}` } })).status, 404);
  } finally {
    h.done();
  }
});
