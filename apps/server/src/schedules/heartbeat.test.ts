// The helpers' heartbeat (T-965 item 1, general-manager PRD §9.2): `POST /api/schedules/heartbeat` with an admin's Portal MCP token puts a
// helper on the Schedules list, stale once it is late by two intervals. Allowed: an operate or admin token. Refused: no token, an unknown
// or revoked one, a cookie, an agent's or a first-party client's token (401); a read token, a token the seam refuses and a portal whose MCP
// is off (404, as if the route did not exist); a bad body (422); too many beats (429). Real tokens from the Portal MCP harness.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { objectRef, type UserId } from '@portal/contracts';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { BEATS_PER_TOKEN_MINUTE, createHeartbeatRoutes } from './heartbeat.js';
import { HelperRegistry } from './helpers.js';
import { registerSchedulesTools } from './portalTools.js';
import { LoopRegistry } from './registry.js';
import { Schedules } from './service.js';

after(() => clearResolvers());

const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, s));
/** A credential-shaped value, built at run time (no token-shaped literal in the repository). */
const fakeToken = () => ['gh', 'p_', 'Z9k'.repeat(12)].join('');

const BEAT = {
  name: 'dev-sessions-supervisor',
  kind: 'supervisor',
  interval: 60,
  owner: 'coordinator',
  description: 'Keeps the dev tracks alive.',
};

async function rig(o: { off?: boolean } = {}) {
  const h = await portalMcpHarness({ registry: new ToolRegistry(), off: o.off });
  const helpers = new HelperRegistry();
  let now = at(0);
  const app = new Hono();
  app.onError((e, c) =>
    isAppError(e)
      ? c.json({ error: { code: e.code, message: e.message } }, e.status as 404)
      : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500),
  );
  app.route(
    '/api/schedules/heartbeat',
    createHeartbeatRoutes({
      tokens: h.module.tokens,
      helpers,
      mcpEnabled: () => h.module.settings.get().enabled,
      clientKey: () => '10.0.0.7',
      now: () => now,
    }),
  );
  const beat = async (secret: string | null, body: unknown = BEAT, headers: Record<string, string> = {}) => {
    const res = await app.request('/api/schedules/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as { data?: { id: string; next_due: string; stale_after: string }; error?: { code: string } },
    };
  };
  const list = () => new Schedules({ loops: new LoopRegistry(), measured: () => [], helpers, now: () => now }).list();
  return { h, helpers, beat, list, setNow: (d: Date) => (now = d) };
}

test('an operate or admin token beats: the helper is listed with its kind, owner and interval, ok, then stale after two missed intervals', async () => {
  const r = await rig();
  try {
    const ok = await r.beat(r.h.token('operate').secret);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data, {
      id: 'helper:dev-sessions-supervisor',
      next_due: at(60).toISOString(),
      stale_after: at(120).toISOString(),
    });
    let row = r.list().find((x) => x.id === 'helper:dev-sessions-supervisor')!;
    assert.deepEqual(
      [row.kind, row.name, row.module, row.owner, row.description, row.interval_ms, row.last_run, row.next_run, row.state, row.enabled],
      [
        'helper',
        'dev-sessions-supervisor',
        'supervisor',
        'coordinator',
        'Keeps the dev tracks alive.',
        60_000,
        at(0).toISOString(),
        at(60).toISOString(),
        'ok',
        null,
      ],
    );
    r.setNow(at(120));
    assert.equal(r.list()[0]!.state, 'ok', 'exactly two intervals late is not stale yet');
    r.setNow(at(121));
    assert.equal(r.list()[0]!.state, 'stale', 'late by more than two intervals');
    const admin = await r.beat(r.h.token('admin').secret, { name: 'dev-sessions-supervisor', kind: 'supervisor', interval: 60 });
    assert.equal(admin.status, 200);
    row = r.list()[0]!;
    assert.deepEqual(
      [row.state, row.last_run, row.owner],
      ['ok', at(121).toISOString(), 'admin-test'],
      "a beat makes it fresh again; no owner: the token's label",
    );
    assert.equal(r.helpers.size, 1, 'the same name is the same helper');
  } finally {
    r.h.done();
  }
});

test("refused without a valid admin token: none, unknown, revoked, a cookie, an agent's and a first-party client's; nothing is recorded", async () => {
  const r = await rig();
  try {
    assert.equal((await r.beat(null)).status, 401);
    assert.equal((await r.beat(fakeToken())).status, 401, 'an unknown token');
    const revoked = r.h.token('operate', 'revoked one');
    r.h.module.revokeToken(revoked.id, 'test');
    assert.equal((await r.beat(revoked.secret)).status, 401, 'a revoked token');
    const withCookie = await r.beat(r.h.token('operate').secret, BEAT, { cookie: 'portal_session=x' });
    assert.deepEqual([withCookie.status, withCookie.body.error?.code], [400, 'BAD_REQUEST'], 'a bearer request never rides a cookie');
    const agent = await r.h.agentToken('docker/api-dev', 's_a');
    assert.ok(agent.secret, 'the harness minted an agent token');
    assert.equal((await r.beat(agent.secret)).status, 401, "an agent's per-session token");
    const vscode = r.h.module.createToken({ label: 'VS Code · laptop', scope: 'operate', addAnother: true }, '', 'ui', {
      client: 'vscode',
      instance: null,
    });
    assert.equal((await r.beat(vscode.secret)).status, 401, "a first-party client's token opens its own API only");
    assert.equal(r.helpers.size, 0);
  } finally {
    r.h.done();
  }
});

test('a read token, a token the seam refuses, and a portal whose MCP is off are told the route does not exist', async () => {
  const r = await rig();
  try {
    const read = await r.beat(r.h.token('read').secret);
    assert.deepEqual([read.status, read.body.error?.code], [404, 'NOT_FOUND'], 'operate is needed: a read token is capped at view');
    const operate = r.h.token('operate').secret;
    registerResolver({
      type: 'platform',
      resolve: (id) => ({ ref: objectRef('platform', id), owner: { kind: 'user', id: 'u_someone_else' as UserId } }),
    });
    try {
      const denied = await r.beat(operate);
      assert.deepEqual(
        [denied.status, denied.body.error?.code],
        [404, 'NOT_FOUND'],
        "the seam decides: the platform is not this token's user's",
      );
    } finally {
      clearResolvers();
    }
    r.h.module.settings.update({ enabled: false });
    assert.equal((await r.beat(operate)).status, 404, 'Access, MCP off: off for this door too');
    assert.equal(r.helpers.size, 0);
  } finally {
    r.h.done();
  }
});

test('a bad body is refused field by field; text is cleaned of escapes and credentials and cut; a full list refuses a new live helper', async () => {
  const r = await rig();
  try {
    const t = r.h.token('operate').secret;
    for (const body of [
      { ...BEAT, name: 'Has Spaces' },
      { ...BEAT, name: '' },
      { ...BEAT, name: 'x'.repeat(65) },
      { ...BEAT, kind: '../etc' },
      { ...BEAT, interval: 5 },
      { ...BEAT, interval: 604_801 },
      { ...BEAT, interval: 60.5 },
      { ...BEAT, interval: '60' },
      { ...BEAT, owner: 42 },
    ]) {
      const res = await r.beat(t, body);
      assert.deepEqual([res.status, res.body.error?.code], [422, 'VALIDATION_FAILED'], JSON.stringify(body));
    }
    assert.equal((await r.beat(t, '[1,2]')).status, 400);
    assert.equal((await r.beat(t, '{nope')).status, 400);
    const big = await r.beat(t, { ...BEAT, description: 'y'.repeat(5000) });
    assert.equal(big.status, 413, 'more than 4 KiB');
    const ok = await r.beat(t, { ...BEAT, owner: `ops\u001b[31m ${fakeToken()}`, description: `uses ${fakeToken()} ${'z'.repeat(400)}` });
    assert.equal(ok.status, 200);
    const row = r.list()[0]!;
    assert.ok(!JSON.stringify(row).includes(fakeToken()), 'credential-shaped text never comes back');
    assert.ok(!row.owner!.includes('\u001b'), 'escapes are stripped');
    assert.ok(row.description!.length <= 200 && row.owner!.length <= 80);

    const full = new HelperRegistry();
    const from = { tokenId: 'tok_1', label: 'x' };
    for (let i = 0; i < 100; i++) full.beat({ name: `h-${i}`, kind: 'job', interval: 60 }, from, at(0));
    assert.throws(
      () => full.beat({ name: 'h-new', kind: 'job', interval: 60 }, from, at(1)),
      (e: unknown) => isAppError(e) && e.code === 'RATE_LIMITED',
    );
    full.beat({ name: 'h-new', kind: 'job', interval: 60 }, from, new Date(at(0).getTime() + 121_000));
    assert.equal(full.size, 100, 'a stale helper made room for the new one');
  } finally {
    r.h.done();
  }
});

test('a token beating too often is slowed down', async () => {
  const r = await rig();
  try {
    const t = r.h.token('operate').secret;
    for (let i = 0; i < BEATS_PER_TOKEN_MINUTE; i++) assert.equal((await r.beat(t)).status, 200);
    const late = await r.beat(t);
    assert.deepEqual([late.status, late.body.error?.code], [429, 'RATE_LIMITED']);
  } finally {
    r.h.done();
  }
});

test("schedules_list returns a helper's own words as untrusted text", async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const helpers = new HelperRegistry();
  helpers.beat(BEAT, { tokenId: 'tok_1', label: 'x' }, at(0));
  registerSchedulesTools(new Schedules({ loops: new LoopRegistry(), measured: () => [], helpers, now: () => at(1) }), registry);
  try {
    const res = await h.call(h.token('read').secret, 'schedules_list', { kind: 'helper' });
    assert.equal(res.result?.isError, undefined, JSON.stringify(res.raw));
    const [row] = res.result!.structuredContent.schedules as Record<string, unknown>[];
    assert.deepEqual(row!.name, { untrusted_text: 'dev-sessions-supervisor', source: 'helper' });
    assert.deepEqual(row!.owner, { untrusted_text: 'coordinator', source: 'helper' });
    assert.deepEqual(row!.description, { untrusted_text: 'Keeps the dev tracks alive.', source: 'helper' });
    assert.deepEqual(row!.module, { untrusted_text: 'supervisor', source: 'helper' });
  } finally {
    h.done();
  }
});
