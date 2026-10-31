import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { PORTAL_TOKEN_PREFIX, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import { actorOfPrincipal } from '../authz/seam.js';
import { createPortalMcpRoutes } from './routes.js';
import { portalMcpHarness } from './testkit.js';

// T-258 item 5: the automation helpers (tools/coordinator/portal.mjs, docs/dev-sessions/supervisor.mjs) hold ONE 1-hour admin token per
// run through tools/coordinator/tokenLease.mjs, reuse it while it is valid, renew with replace and revoke it at the end. Run here
// against the real token routes and the real MCP endpoint.

type Lease = { get(): Promise<string>; revoke(): Promise<void>; readonly id: string | null };
type LeaseFactory = (o: { api: (m: string, p: string, b?: unknown) => Promise<{ status: number; data?: any; error?: any }>; label: string; now?: () => number }) => Lease;
const leaseUrl = new URL('../../../../tools/coordinator/tokenLease.mjs', import.meta.url).href;
const { tokenLease } = (await import(leaseUrl)) as { tokenLease: LeaseFactory };

const MIN = 60_000;
const OWNER: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'test', via: 'ui' };

async function setup() {
  let now = Date.now();
  const h = await portalMcpHarness({ now: () => new Date(now) });
  const app = new Hono<{ Variables: { actor: Actor } }>();
  let as: Actor = OWNER;
  app.use('*', async (c, next) => {
    c.set('actor', as);
    await next();
  });
  app.route('/api/portal-mcp', createPortalMcpRoutes(h.module));
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', (e as Error).message);
    return c.json(err.toJSON(), err.status as 500);
  });
  const calls: string[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}`);
    const res = await app.request(`http://portal.test${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { data?: any; error?: any } | null;
    return { status: res.status, data: json?.data, error: json?.error };
  };
  return {
    h,
    api,
    calls,
    clock: { now: () => now, advance: (ms: number) => (now += ms) },
    actAs: (a: Actor) => (as = a),
    mints: () => calls.filter((c) => c === 'POST /api/portal-mcp/tokens').length,
  };
}

test('the lease mints one 1-hour admin token and reuses it while valid; the token list never shows the secret again', async () => {
  const s = await setup();
  try {
    const lease = tokenLease({ api: s.api, label: 'coordinator', now: s.clock.now });
    const first = await lease.get();
    const token = s.h.module.tokens.get(lease.id!)!;
    assert.equal(token.scope, 'admin');
    assert.equal(Date.parse(token.expiresAt) - s.clock.now(), 60 * MIN, 'one hour, not seven days');
    assert.equal((await s.h.rpc(first, 'tools/list')).status, 200);
    for (let i = 0; i < 5; i++) {
      s.clock.advance(10 * MIN);
      assert.equal(await lease.get(), first, `call ${i + 2} reuses the token`);
    }
    assert.equal(s.mints(), 1, 'one mint for six calls');
    assert.equal(s.h.module.tokens.liveWithLabel('coordinator').length, 1);
    const listed = JSON.stringify((await s.api('GET', '/api/portal-mcp')).data);
    assert.ok(listed.includes(lease.id!), 'the list shows the token');
    assert.ok(!listed.includes(first) && !listed.includes(first.slice(PORTAL_TOKEN_PREFIX.length, -4)), 'but never its secret');
  } finally {
    s.h.done();
  }
});

test('near expiry the lease renews with replace: the old token is revoked, one live token per label, never a 409', async () => {
  const s = await setup();
  try {
    // A crashed run left a 7-day token behind with this label: the first mint replaces it instead of meeting TOKEN_LABEL_IN_USE.
    const leftover = s.h.module.createToken({ label: 'dev-sessions-supervisor', scope: 'admin', expiresInDays: 7 }, 'http://portal.test/mcp');
    const lease = tokenLease({ api: s.api, label: 'dev-sessions-supervisor', now: s.clock.now });
    const first = await lease.get();
    assert.equal((await s.h.rpc(leftover.secret, 'tools/list')).status, 401, 'the leftover is revoked');
    const firstId = lease.id;
    s.clock.advance(56 * MIN); // 4 minutes left: under the 5-minute margin
    const second = await lease.get();
    assert.notEqual(second, first);
    assert.notEqual(lease.id, firstId);
    assert.equal((await s.h.rpc(first, 'tools/list')).status, 401, 'the renewed-away token is revoked');
    assert.equal((await s.h.rpc(second, 'tools/list')).status, 200);
    assert.deepEqual(s.h.module.tokens.liveWithLabel('dev-sessions-supervisor').map((t) => t.id), [lease.id]);
    assert.equal(s.mints(), 2);
  } finally {
    s.h.done();
  }
});

test('revoke at the end of the run: the token stops working and nothing of the label stays live', async () => {
  const s = await setup();
  try {
    const lease = tokenLease({ api: s.api, label: 'coordinator', now: s.clock.now });
    const secret = await lease.get();
    const id = lease.id!;
    await lease.revoke();
    assert.equal(lease.id, null);
    assert.equal((await s.h.rpc(secret, 'tools/list')).status, 401);
    assert.equal(s.h.module.tokens.liveWithLabel('coordinator').length, 0);
    assert.ok(s.h.module.tokens.get(id)?.revokedAt);
    await lease.revoke(); // twice is harmless
    assert.equal(s.calls.filter((c) => c.startsWith('DELETE')).length, 1);
  } finally {
    s.h.done();
  }
});

test('negative twin: an expired, a revoked and an unknown token get the same 401 answer', async () => {
  const s = await setup();
  try {
    const expiring = tokenLease({ api: s.api, label: 'expires', now: s.clock.now });
    const expired = await expiring.get();
    const revoking = tokenLease({ api: s.api, label: 'revoked', now: s.clock.now });
    const revoked = await revoking.get();
    await revoking.revoke();
    s.clock.advance(60 * MIN);
    const unknown = `${PORTAL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`; // built at runtime: no token-shaped literal
    const answers = await Promise.all([expired, revoked, unknown].map((t) => s.h.rpc(t, 'tools/list')));
    for (const a of answers) assert.equal(a.status, 401);
    assert.deepEqual(answers[0]!.body, answers[2]!.body, 'expired reads like unknown');
    assert.deepEqual(answers[1]!.body, answers[2]!.body, 'revoked reads like unknown');
  } finally {
    s.h.done();
  }
});

test('negative twin: a refused mint throws with the code and no token, and mints nothing', async () => {
  const s = await setup();
  try {
    s.actAs(actorOfPrincipal({ kind: 'user', userId: 'u_owner', tokenId: 'ptk_r', scope: 'read', workspaceId: null, sessionId: null }));
    const lease = tokenLease({ api: s.api, label: 'coordinator', now: s.clock.now });
    await assert.rejects(lease.get(), (e: Error) => /^no Portal MCP token for "coordinator": \S+/.test(e.message) && !e.message.includes(PORTAL_TOKEN_PREFIX));
    assert.equal(lease.id, null);
    assert.equal(s.h.module.tokens.list().length, 0);
    await lease.revoke(); // nothing held: no call
    assert.equal(s.calls.filter((c) => c.startsWith('DELETE')).length, 0);
  } finally {
    s.h.done();
  }
});
