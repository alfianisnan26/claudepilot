import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { PORTAL_TOKEN_CAP_DEFAULT, PORTAL_TOKEN_CAP_SETTING, PORTAL_TOKEN_LIFETIMES, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import { actorOfPrincipal } from '../authz/seam.js';
import { settingDef } from '../settings/registry.js';
import { Settings } from '../settings/store.js';
import { PORTAL_MCP_POLICIES } from './authz.js';
import { createPortalMcpRoutes } from './routes.js';
import { portalMcpHarness, URL_ } from './testkit.js';

// T-258: short lifetimes for automation, one label one client (refuse, replace or add another), a cap on live admin tokens per
// label, bulk revoke by label with one audit row per token, and only `manage` on the person's tokens mints or revokes.

const MIN = 60_000;
const failure = (fn: () => unknown): { code: string; details: any } | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (!isAppError(e)) throw e;
    return { code: e.code, details: e.details };
  }
};
const revokedRows = (h: Awaited<ReturnType<typeof portalMcpHarness>>) =>
  (h.store.db!.prepare("SELECT token_id, details FROM pmcp_auth_events WHERE kind = 'token_revoked' ORDER BY id").all() as { token_id: string; details: string }[]).map((r) => ({
    id: r.token_id,
    ...(JSON.parse(r.details) as { by?: string; reason?: string }),
  }));

test('lifetimes: 15m, 1h, 1d and the day counts; unknown ones and both fields at once are refused', async () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const h = await portalMcpHarness({ now: () => new Date(now) });
  try {
    const want: Record<string, number> = { '15m': 15 * MIN, '1h': 60 * MIN, '1d': 1440 * MIN, '7d': 7 * 1440 * MIN, '30d': 30 * 1440 * MIN, '90d': 90 * 1440 * MIN, '365d': 365 * 1440 * MIN };
    assert.deepEqual([...PORTAL_TOKEN_LIFETIMES], Object.keys(want));
    for (const life of PORTAL_TOKEN_LIFETIMES) {
      const { token } = h.module.createToken({ label: `life ${life}`, scope: 'read', expiresIn: life }, URL_);
      assert.equal(Date.parse(token.expiresAt) - now, want[life], life);
    }
    for (const days of [7, 30, 90, 365] as const) {
      const { token } = h.module.createToken({ label: `days ${days}`, scope: 'read', expiresInDays: days }, URL_);
      assert.equal(Date.parse(token.expiresAt) - now, days * 1440 * MIN);
    }
    assert.equal(Date.parse(h.module.createToken({ label: 'default', scope: 'read' }, URL_).token.expiresAt) - now, 90 * 1440 * MIN, 'default 90 days');
    for (const bad of ['5m', '2h', '7', 7, '1w', '', null]) assert.equal(failure(() => h.module.createToken({ label: 'bad', scope: 'read', expiresIn: bad as never }, URL_))?.code, 'VALIDATION_FAILED', String(bad));
    for (const bad of [1, 14, 0, -7, '7'] as unknown[]) assert.equal(failure(() => h.module.createToken({ label: 'bad', scope: 'read', expiresInDays: bad as never }, URL_))?.code, 'VALIDATION_FAILED', String(bad));
    assert.equal(failure(() => h.module.createToken({ label: 'bad', scope: 'read', expiresIn: '1h', expiresInDays: 7 }, URL_))?.code, 'VALIDATION_FAILED');
  } finally {
    h.done();
  }
});

test('a 15-minute token works until its fifteenth minute and is refused from then on', async () => {
  let now = Date.now();
  const h = await portalMcpHarness({ now: () => new Date(now) });
  try {
    const { secret } = h.module.createToken({ label: 'ci run', scope: 'read', expiresIn: '15m' }, URL_);
    assert.equal((await h.rpc(secret, 'tools/list')).status, 200);
    now += 15 * MIN - 1000;
    assert.equal((await h.rpc(secret, 'tools/list')).status, 200, 'a second before');
    now += 1000;
    assert.equal((await h.rpc(secret, 'tools/list')).status, 401, 'at fifteen minutes');
    assert.equal(h.module.tokens.liveWithLabel('ci run').length, 0, 'an expired token no longer holds its label');
    h.module.createToken({ label: 'ci run', scope: 'read', expiresIn: '1h' }, URL_);
  } finally {
    h.done();
  }
});

test('a label with live tokens is refused with 409 and the newest one’s id and expiry, never a secret', async () => {
  const h = await portalMcpHarness();
  try {
    const first = h.module.createToken({ label: 'coordinator', scope: 'admin', expiresIn: '1h' }, URL_);
    const second = h.module.createToken({ label: 'coordinator', scope: 'admin', expiresIn: '1h', addAnother: true }, URL_);
    const refused = failure(() => h.module.createToken({ label: ' coordinator ', scope: 'admin', expiresIn: '1h' }, URL_));
    assert.equal(refused?.code, 'TOKEN_LABEL_IN_USE');
    assert.equal(new AppError('TOKEN_LABEL_IN_USE').status, 409);
    assert.deepEqual(refused?.details, { label: 'coordinator', live: 2, newest: { id: second.token.id, expiresAt: second.token.expiresAt } });
    const text = JSON.stringify(refused);
    for (const s of [first.secret, second.secret]) assert.ok(!text.includes(s) && !text.includes(s.slice(-4)));
    // Another scope with the same label is the same client: refused too.
    assert.equal(failure(() => h.module.createToken({ label: 'coordinator', scope: 'read' }, URL_))?.code, 'TOKEN_LABEL_IN_USE');
    assert.equal(failure(() => h.module.createToken({ label: 'coordinator', scope: 'read', replace: true, addAnother: true }, URL_))?.code, 'VALIDATION_FAILED');
    // Another label is fine; a revoked label is free again.
    h.module.createToken({ label: 'other', scope: 'admin' }, URL_);
    h.module.revokeLabel('other', false, 'user:u_owner');
    h.module.createToken({ label: 'other', scope: 'admin' }, URL_);
  } finally {
    h.done();
  }
});

test('replace revokes the label’s live tokens (one audit row each, with who) and mints the new one', async () => {
  const h = await portalMcpHarness();
  try {
    const a = h.module.createToken({ label: 'relay', scope: 'admin' }, URL_);
    const b = h.module.createToken({ label: 'relay', scope: 'operate', addAnother: true }, URL_);
    const c = h.module.createToken({ label: 'relay', scope: 'admin', expiresIn: '1h', replace: true }, URL_, 'user:u_owner');
    assert.equal((await h.rpc(a.secret, 'tools/list')).status, 401);
    assert.equal((await h.rpc(b.secret, 'tools/list')).status, 401);
    assert.equal((await h.rpc(c.secret, 'tools/list')).status, 200);
    assert.deepEqual(h.module.tokens.liveWithLabel('relay').map((t) => t.id), [c.token.id]);
    const rows = revokedRows(h);
    assert.deepEqual(rows.map((r) => r.id).sort(), [a.token.id, b.token.id].sort());
    for (const r of rows) assert.equal(r.by, 'user:u_owner');
    const created = h.store.db!.prepare("SELECT details FROM pmcp_auth_events WHERE kind = 'token_created' AND token_id = ?").get(c.token.id) as { details: string };
    assert.deepEqual(JSON.parse(created.details), { label: 'relay', scope: 'admin', expiresAt: c.token.expiresAt, by: 'user:u_owner', replaced: 2 });
    assert.ok(!JSON.stringify(rows).includes(c.secret));
  } finally {
    h.done();
  }
});

test('the cap: live admin tokens per label stop at the setting (default 3); other scopes and replace are not capped', async () => {
  let max = PORTAL_TOKEN_CAP_DEFAULT;
  const h = await portalMcpHarness();
  const { PortalMcpModule } = await import('./module.js');
  const m = new PortalMcpModule(h.store, { maxActivePerLabel: () => max });
  try {
    for (let i = 0; i < 3; i++) m.createToken({ label: 'bot', scope: 'admin', addAnother: i > 0 }, URL_);
    const capped = failure(() => m.createToken({ label: 'bot', scope: 'admin', addAnother: true }, URL_));
    assert.equal(capped?.code, 'TOKEN_CAP');
    assert.equal(new AppError('TOKEN_CAP').status, 409);
    assert.equal(capped?.details.live, 3);
    assert.equal(capped?.details.max, 3);
    m.createToken({ label: 'bot', scope: 'read', addAnother: true }, URL_);
    max = 4;
    m.createToken({ label: 'bot', scope: 'admin', addAnother: true }, URL_);
    assert.equal(failure(() => m.createToken({ label: 'bot', scope: 'admin', addAnother: true }, URL_))?.code, 'TOKEN_CAP');
    m.createToken({ label: 'bot', scope: 'admin', replace: true }, URL_);
    assert.equal(m.tokens.liveWithLabel('bot').length, 1);
    // The setting is in the registry with its InfoTip text, and the shared store validates its range.
    const def = settingDef(PORTAL_TOKEN_CAP_SETTING);
    assert.equal(def?.default, 3);
    assert.equal(def?.group, 'mcp');
    assert.match(def?.help ?? '', /1 hour/);
    const settings = new Settings(h.store);
    assert.equal(settings.get<number>(PORTAL_TOKEN_CAP_SETTING), 3);
  } finally {
    h.done();
  }
});

test('agents’ per-session tokens have no label and are not subject to the label rule or the cap', async () => {
  const h = await portalMcpHarness();
  try {
    for (let i = 0; i < 5; i++) assert.ok((await h.agentToken('docker/api', `s${i}`)).secret);
    assert.equal(h.module.agents.liveCounts().get('docker/api'), 5);
    for (let i = 0; i < 3; i++) h.module.createToken({ label: 'bot', scope: 'admin', addAnother: i > 0 }, URL_);
    assert.equal(h.module.revokeLabel('bot', false, 'user:u_owner'), 3);
    assert.equal(h.module.agents.liveCounts().get('docker/api'), 5, 'a label revoke leaves agents alone');
  } finally {
    h.done();
  }
});

const OWNER: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'test', via: 'ui' };

async function routes() {
  const h = await portalMcpHarness();
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
  const call = async (who: Actor, method: string, path: string, body?: unknown) => {
    as = who;
    const res = await app.request(`http://portal.test${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { data?: any; error?: { code: string; details?: any } } | null;
    return { status: res.status, data: json?.data, error: json?.error };
  };
  return { h, call };
}

test('bulk revoke by label: "Revoke older" keeps the newest live one, "all" leaves none; one audit row per token, with who', async () => {
  const { h, call } = await routes();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await call(OWNER, 'POST', '/api/portal-mcp/tokens', { label: 'coordinator', scope: 'admin', expiresIn: '1h', addAnother: i > 0 })).data.token.id);
    const dup = await call(OWNER, 'POST', '/api/portal-mcp/tokens', { label: 'coordinator', scope: 'admin', expiresIn: '1h' });
    assert.equal(dup.status, 409);
    assert.equal(dup.error?.code, 'TOKEN_LABEL_IN_USE');
    assert.equal(dup.error?.details.live, 3);
    const newest = h.module.tokens.liveWithLabel('coordinator')[0]!.id;
    const older = await call(OWNER, 'POST', '/api/portal-mcp/tokens/revoke-label', { label: 'coordinator', keepNewest: true });
    assert.deepEqual(older.data, { revoked: 2 });
    assert.deepEqual(h.module.tokens.liveWithLabel('coordinator').map((t) => t.id), [newest]);
    assert.deepEqual((await call(OWNER, 'POST', '/api/portal-mcp/tokens/revoke-label', { label: 'coordinator', keepNewest: true })).data, { revoked: 0 });
    assert.deepEqual((await call(OWNER, 'POST', '/api/portal-mcp/tokens/revoke-label', { label: 'coordinator' })).data, { revoked: 1 });
    const rows = revokedRows(h);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.id).sort(), [...ids].sort());
    for (const r of rows) assert.equal(r.by, 'user:u_owner');
    assert.equal((await call(OWNER, 'POST', '/api/portal-mcp/tokens/revoke-label', {})).status, 422);
    assert.equal((await call(OWNER, 'POST', '/api/portal-mcp/tokens/revoke-label', { label: 'x', keepNewest: 'yes' })).status, 422);
    // The single revoke says who too.
    const one = (await call(OWNER, 'POST', '/api/portal-mcp/tokens', { label: 'single', scope: 'read' })).data.token.id;
    assert.equal((await call(OWNER, 'DELETE', `/api/portal-mcp/tokens/${one}`)).status, 200);
    assert.equal(revokedRows(h).at(-1)?.by, 'user:u_owner');
    assert.equal(revokedRows(h).at(-1)?.id, one);
  } finally {
    h.done();
  }
});

test('authz: only manage on the person’s tokens mints or revokes; read, operate and agent tokens are refused', async () => {
  const { h, call } = await routes();
  try {
    const id = (await call(OWNER, 'POST', '/api/portal-mcp/tokens', { label: 'kept', scope: 'read' })).data.token.id;
    const admin = actorOfPrincipal({ kind: 'user', tokenId: 'ptk_admin', scope: 'admin', workspaceId: null, sessionId: null });
    const refused: [string, Actor][] = [
      ['read token', actorOfPrincipal({ kind: 'user', tokenId: 'ptk_r', scope: 'read', workspaceId: null, sessionId: null })],
      ['operate token', actorOfPrincipal({ kind: 'user', tokenId: 'ptk_o', scope: 'operate', workspaceId: null, sessionId: null })],
      ['agent token', actorOfPrincipal({ kind: 'agent', tokenId: 'pst_a', scope: 'agent', workspaceId: 'docker/api', sessionId: 'sa' })],
      ['nobody', { kind: 'anonymous' } as Actor],
    ];
    for (const [who, actor] of refused) {
      const mint = await call(actor, 'POST', '/api/portal-mcp/tokens', { label: `by ${who}`, scope: 'admin' });
      assert.ok([401, 403, 404].includes(mint.status), `${who} mints: ${mint.status}`);
      assert.ok([401, 403, 404].includes((await call(actor, 'DELETE', `/api/portal-mcp/tokens/${id}`)).status), `${who} revokes`);
      assert.ok([401, 403, 404].includes((await call(actor, 'POST', '/api/portal-mcp/tokens/revoke-label', { label: 'kept' })).status), `${who} revokes a label`);
    }
    assert.equal(h.module.tokens.liveWithLabel('kept').length, 1, 'nothing was revoked');
    assert.equal(h.module.tokens.list().length, 1, 'nothing was minted');
    // An admin-scope token's actor holds manage; the routes are declared.
    assert.equal((await call(admin, 'POST', '/api/portal-mcp/tokens', { label: 'by admin', scope: 'read' })).status, 201);
    for (const key of ['POST /api/portal-mcp/tokens', 'POST /api/portal-mcp/tokens/revoke-label', 'DELETE /api/portal-mcp/tokens/:id'] as const) assert.ok(PORTAL_MCP_POLICIES[key], key);
  } finally {
    h.done();
  }
});
