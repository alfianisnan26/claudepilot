// The platform skeleton: the bus (validation, fan-out, a throwing listener skipped), the audit (own rows, an admin's all), module
// registration, and the mount through the real app (session guard, Origin check, /hooks outside /api).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { declarePolicies } from '../authz/seam.js';
import { createBus } from '../notify/bus.js';
import { FakeChat, freshStore } from '../notify/testkit.js';
import { Portal } from '../portal.js';
import { PlatformAudit } from './audit.js';
import { createPlatform } from './index.js';
import { Hono } from 'hono';

test('bus: validates, assigns an id and a time, fans out, skips a throwing listener, never throws', () => {
  const bus = createBus(() => new Date('2026-10-12T10:00:00Z'));
  const got: string[] = [];
  bus.on('ci_failed', () => {
    throw new Error('boom');
  });
  bus.on('ci_failed', (e) => got.push(`kind:${e.id}`));
  bus.on('*', (e) => got.push(`all:${e.kind}`));
  const e = bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: 'r1' }, facts: { repo: 'api', number: 14, ok: false, none: null } });
  assert.ok(e);
  assert.match(e.id, /^evt_[0-9a-f]{16}$/);
  assert.equal(e.at, '2026-10-12T10:00:00.000Z');
  assert.deepEqual(got, [`kind:${e.id}`, 'all:ci_failed']);
  // facts: one line, no hidden characters, clipped at 80
  const long = bus.emit({ kind: 'test', subject: { type: 'portal', id: 'x' }, facts: { name: `a‮b\nc${'z'.repeat(200)}` } })!;
  assert.equal((long.facts.name as string).length, 80);
  assert.ok(!/[‮\n]/.test(long.facts.name as string));
  // dropped, not thrown
  assert.equal(bus.emit({ kind: 'nope' as never, subject: { type: 'portal', id: 'x' }, facts: {} }), null);
  assert.equal(bus.emit({ kind: 'test', subject: { type: 'portal', id: 'x' }, facts: { nested: { a: 1 } as never } }), null);
  assert.equal(bus.emit({ kind: 'test', subject: { type: 'portal', id: '../x y' }, facts: {} }), null);
  assert.equal(bus.emit({ kind: 'test', subject: { type: 'portal', id: 'x' }, facts: { 'bad key': 1 } }), null);
  assert.equal(bus.emit({ kind: 'test', subject: { type: 'portal', id: 'x' }, facts: { n: Number.NaN } }), null);
  // detail: redacted and clipped at 600; an offer of `other` is cut to Deny; audience keeps user ids only
  const a = bus.emit({
    kind: 'approval',
    subject: { type: 'session', id: 's1' },
    facts: {},
    detail: { text: `curl -H "Authorization: Bearer cpat_${'A'.repeat(40)}" ${'x'.repeat(700)}`, truncated: false },
    answer: { sessionId: 's1', requestId: 'r1', toolClass: 'other', decisions: ['allow', 'deny'] },
    audience: ['u_a', 'evil user', 'u_b'],
  })!;
  assert.ok(!a.detail!.text.includes('cpat_'));
  assert.equal(a.detail!.text.length, 600);
  assert.equal(a.detail!.truncated, true);
  assert.deepEqual(a.answer!.decisions, ['deny']);
  assert.deepEqual(a.audience, ['u_a', 'u_b']);
});

test('audit: a user reads their own rows, an admin all; detail keeps plain values only; 90-day sweep', async () => {
  const { store } = await freshStore();
  let now = new Date('2026-10-12T10:00:00Z');
  const audit = new PlatformAudit(store, () => now);
  audit.record({ kind: 'notify.action', actor: 'user:u_a', userId: 'u_a', subject: 'session:s1', detail: { decision: 'deny', nested: { secret: 'x' }, url: 'u'.repeat(300) } });
  audit.record({ kind: 'trigger.fired', actor: 'trigger:t1', userId: 'u_b', detail: {} });
  audit.record({ kind: 'notify.channel', actor: 'user:u_a', userId: 'u_a' });
  assert.deepEqual(
    audit.list({}, 'u_a').map((r) => r.kind),
    ['notify.channel', 'notify.action'],
  );
  assert.equal(audit.list({}, null).length, 3);
  assert.equal(audit.list({ kind: 'notify' }, null).length, 2);
  const row = audit.list({ kind: 'notify.action' }, 'u_a')[0]!;
  assert.equal(row.detail.nested, undefined);
  assert.equal((row.detail.url as string).length, 120);
  assert.throws(() => audit.record({ kind: 'Bad Kind', actor: 'x', userId: null }));
  now = new Date('2027-01-11T10:00:01Z'); // 91 days later
  assert.equal(audit.sweep(), 3);
  store.close();
});

test('audit: a Portal MCP token’s label is kept in the row as it was, one line and bounded', async () => {
  const { store } = await freshStore();
  const audit = new PlatformAudit(store, () => new Date('2026-10-12T10:00:00Z'));
  audit.record({ kind: 'trigger.fired', actor: 'portal-mcp:ptk_1', actorLabel: 'relay', userId: null, detail: { n: 1 } });
  audit.record({ kind: 'trigger.fired', actor: 'portal-mcp:ptk_2', actorLabel: `a\nb${'x'.repeat(200)}`, userId: null });
  audit.record({ kind: 'trigger.fired', actor: 'ui', userId: null });
  const rows = audit.list({}, null);
  const by = (a: string) => rows.find((r) => r.actor === a)!;
  assert.deepEqual([by('portal-mcp:ptk_1').detail.actorLabel, by('portal-mcp:ptk_1').detail.n], ['relay', 1]);
  assert.ok(!/\n/.test(by('portal-mcp:ptk_2').detail.actorLabel as string) && (by('portal-mcp:ptk_2').detail.actorLabel as string).length <= 120);
  assert.equal(by('ui').detail.actorLabel, undefined);
  store.close();
});

test('platform: modules register once, routes mount behind the session guard, /hooks outside /api, presence from a signed-in socket', async () => {
  const { store } = await freshStore();
  const chat = new FakeChat();
  const published: string[] = [];
  const platform = createPlatform({
    store,
    settings: null,
    chat,
    uiUrl: null,
    pushContact: null,
    selfOrigin: 'http://localhost:3232',
    publish: (t) => published.push(t),
    socketAuthorized: () => true,
    tools: false,
  });
  const extra = new Hono();
  extra.get('/', (c) => c.json({ ok: true, data: 'mine' }));
  platform.register({ name: 'standin', routes: [{ path: '/api/standin', app: extra }] });
  assert.throws(() => platform.register({ name: 'standin' }));
  platform.hooks.post('/t/:token', (c) => c.json({ received: c.req.param('token') }));
  // T-1043 S0a: a hook is its own door, and says so (an undeclared route is refused to anyone but the owner).
  declarePolicies('standin', { 'POST /hooks/t/:token': { kind: 'handler', checks: ['the test hook answers anyone'] } });
  platform.start();

  const CODE = '13572468';
  const portal = new Portal(CODE, 60_000);
  const stub: unknown = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub as object });
  const make = createApp as unknown as (...args: unknown[]) => Hono;
  const app = make(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, platform });
  const host = { Host: 'localhost:3232' };
  // no session: 401 on every module route
  assert.equal((await app.request('/api/notify', { headers: host })).status, 401);
  assert.equal((await app.request('/api/standin', { headers: host })).status, 401);
  assert.equal((await app.request('/api/platform/audit', { headers: host })).status, 401);
  const token = portal.signIn(CODE);
  const cookie = { ...host, Cookie: `portal_session=${token}` };
  const overview = (await (await app.request('/api/notify', { headers: cookie })).json()) as { data: { state: string; destinations: unknown[]; actionsCeiling: boolean } };
  assert.equal(overview.data.state, 'ready');
  assert.deepEqual(overview.data.destinations, []);
  assert.equal(((await (await app.request('/api/standin', { headers: cookie })).json()) as { data: string }).data, 'mine');
  // a mutating request from another origin is refused before the module sees it
  const foreign = await app.request('/api/notify/prefs', { method: 'PUT', headers: { ...cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"deny":false}' });
  assert.equal(foreign.status, 403);
  // /hooks: no cookie, no Origin check, its own door
  const hook = await app.request('/hooks/t/abc', { method: 'POST', headers: { ...host, Origin: 'https://git.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(hook.status, 200);
  assert.deepEqual(await hook.json(), { received: 'abc' });
  const huge = await app.request('/hooks/t/abc', { method: 'POST', headers: { ...host, 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) }, body: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(huge.status, 413);
  // presence from a signed-in socket reaches the pipeline (and leaves on close)
  const conn = {};
  platform.presence(conn, { type: 'presence', device: null, visible: true, active: true, session: null }, {} as never);
  platform.presence(conn, null, {} as never);
  platform.stop();
  store.close();
});
