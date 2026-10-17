// T-1043 S0a (D-82): the one route guard (routeGuard.ts) in front of every HTTP route.
//   1. The guard on its own, on a small app: a non-owner is refused a route with no declaration (403), refused a declared route it may not
//      use (a platform area: 403; an object it does not own: 404, the same as a missing one), and let through where the declaration allows
//      (signed-in, self, an object it owns). The founding owner goes through everything, as before; nobody signed in is 401.
//   2. The real app: every route it answers is declared (read off `app.routes`, so a route added later is covered without anyone adding it
//      here), and a member account on the real app is refused by the guard, while the owner is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, type Actor, type RoutePolicies } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createApp } from '../app.js';
import { createBrowserRoutes } from '../browser/routes.js';
import { realInstall } from '../connect/installPort.js';
import { openModule } from '../connect/testkit.js';
import { FakeChat, freshStore } from '../notify/testkit.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { NO_POLICY_MESSAGE, createRouteGuard, type SignedIn } from './routeGuard.js';
import { clearResolvers, declarePolicies, declaredPolicies, registerResolver } from './seam.js';

/* ---------- 1. The guard on a small app ---------- */

const MEMBER = 'u_member1';
const OTHER = 'u_other22';

const TEST_POLICIES: RoutePolicies = {
  'GET /t/admin': { kind: 'platform', area: 'users', verb: 'view' },
  'GET /t/list': { kind: 'signed-in', filter: 'ticket' },
  'GET /t/me': { kind: 'self' },
  'GET /t/open': { kind: 'public', why: 'a test door' },
  'GET /t/ticket/:id': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'id' }] },
  'POST /t/ticket': { kind: 'objects', checks: [{ type: 'ticket', verb: 'operate', from: 'body', param: 'ticketId' }] },
  'GET /t/search': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'query', param: 'ticket', optional: true }] },
};

function small(who: () => SignedIn) {
  declarePolicies('routeGuard.test', TEST_POLICIES);
  const app = new Hono();
  app.onError((e, c) => {
    const error = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });
  app.use('*', createRouteGuard({ signedIn: () => who() }));
  const reached: string[] = [];
  const ok = (c: { req: { path: string; method: string }; json: (v: unknown) => Response }) => (reached.push(`${c.req.method} ${c.req.path}`), c.json({ ok: true }));
  for (const p of ['/t/admin', '/t/list', '/t/me', '/t/open', '/t/ticket/:id', '/t/search', '/t/undeclared']) app.get(p, ok);
  app.post('/t/ticket', ok);
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const json = (await res.json()) as { error?: { code: string; message: string } };
    return { status: res.status, message: json.error?.message };
  };
  return { send, reached };
}

/** Tickets `mine` (the member's) and `theirs` (someone else's); anything else does not exist. */
function ticketsOwned() {
  clearResolvers();
  registerResolver({
    type: 'ticket',
    resolve: (id) => (id === 'mine' || id === 'theirs' ? { ref: objectRef('ticket', id), owner: { kind: 'user', id: (id === 'mine' ? MEMBER : OTHER) as never } } : null),
  });
}

test('a member is refused a route nobody declared (403), and the handler never runs', async () => {
  const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
  const r = await send('GET', '/t/undeclared');
  assert.deepEqual([r.status, r.message], [403, NO_POLICY_MESSAGE]);
  assert.deepEqual(reached, []);
});

test('a member is refused a declared route it may not use: an admin area is 403, an object it does not own is the same 404 as a missing one', async () => {
  ticketsOwned();
  try {
    const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
    const area = await send('GET', '/t/admin');
    assert.deepEqual([area.status, area.message], [403, 'Only an admin can do this.']);
    const theirs = await send('GET', '/t/ticket/theirs');
    const missing = await send('GET', '/t/ticket/nope');
    assert.deepEqual([theirs.status, theirs.message], [404, 'Not found.']);
    assert.deepEqual(theirs, missing, 'someone else’s object reads exactly like one that does not exist');
    const body = await send('POST', '/t/ticket', { ticketId: 'theirs' });
    assert.equal(body.status, 404, 'a body id is checked too');
    const noId = await send('POST', '/t/ticket', {});
    assert.equal(noId.status, 404, 'a required id that is missing is refused, not skipped');
    const query = await send('GET', '/t/search?ticket=theirs');
    assert.equal(query.status, 404, 'an optional query id that is given is checked');
    assert.deepEqual(reached, []);
  } finally {
    clearResolvers();
  }
});

test('a member is let through where the declaration allows: signed-in, self, public, and an object it owns', async () => {
  ticketsOwned();
  try {
    const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
    for (const path of ['/t/list', '/t/me', '/t/open', '/t/ticket/mine', '/t/search', '/t/search?ticket=mine']) assert.equal((await send('GET', path)).status, 200, path);
    assert.equal((await send('POST', '/t/ticket', { ticketId: 'mine' })).status, 200);
    assert.equal(reached.length, 7);
  } finally {
    clearResolvers();
  }
});

test('the founding owner goes through every route as before (an undeclared one included); nobody signed in is 401 except at a public door', async () => {
  const owner = small(() => ({ full: true }));
  for (const path of ['/t/undeclared', '/t/admin', '/t/ticket/anything']) assert.equal((await owner.send('GET', path)).status, 200, path);
  const nobody = small(() => null);
  for (const path of ['/t/undeclared', '/t/admin', '/t/me']) assert.equal((await nobody.send('GET', path)).status, 401, path);
  assert.equal((await nobody.send('GET', '/t/open')).status, 200);
});

test('an actor already set on the request is the one decided for, not the cookie', async () => {
  declarePolicies('routeGuard.test', TEST_POLICIES);
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.onError((e, c) => c.json({}, (isAppError(e) ? e.status : 500) as ContentfulStatusCode));
  app.use('*', async (c, next) => (c.set('actor', { kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'x', via: 'ui' }), next()));
  app.use('*', createRouteGuard({ signedIn: () => null }));
  app.get('/t/undeclared', (c) => c.json({}));
  assert.equal((await app.request('/t/undeclared')).status, 200, 'the owner set on the context goes through, with no cookie');
  const member = new Hono<{ Variables: { actor: Actor } }>();
  member.onError((e, c) => c.json({}, (isAppError(e) ? e.status : 500) as ContentfulStatusCode));
  member.use('*', async (c, next) => (c.set('actor', { kind: 'user', userId: MEMBER, loginSessionId: 'x', via: 'ui' }), next()));
  member.use('*', createRouteGuard({ signedIn: () => ({ full: true }) }));
  member.get('/t/undeclared', (c) => c.json({}));
  assert.equal((await member.request('/t/undeclared')).status, 403, 'a member set on the context is refused, whatever the cookie says');
});

/* ---------- 2. The real app ---------- */

const touched: string[] = [];
const spy = (what: string): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : (touched.push(`${what}.${String(p)}`), spy(`${what}.${String(p)}`))),
    apply: () => spy(`${what}()`),
    construct: () => spy(`new ${what}`),
    set: () => true,
  });

async function realApp() {
  const { store } = await freshStore();
  const platform = createPlatform({ store, settings: null, chat: new FakeChat(), uiUrl: null, pushContact: null, selfOrigin: 'http://localhost:3000', publish: () => undefined, socketAuthorized: () => true, tools: false });
  const cx = await openModule({ install: realInstall });
  const CODE = '24681357';
  const portal = new Portal(CODE, 60_000);
  const make = createApp as unknown as (...args: unknown[]) => Hono;
  const app = make(portal, spy('workspaces'), spy('store'), spy('accounts'), spy('pools'), spy('reconciler'), spy('health'), spy('chat'), {
    serveWeb: false,
    poolService: spy('poolService'),
    mcp: spy('mcp'),
    skills: spy('skills'),
    personas: spy('personas'),
    settings: spy('settings'),
    secrets: spy('secrets'),
    portalMcp: spy('portalMcp'),
    tickets: spy('tickets'),
    ci: spy('ci'),
    knowledge: spy('knowledge'),
    browser: { routes: () => createBrowserRoutes(spy('browserService') as never) },
    claudeUsage: spy('claudeUsage'),
    usageSpend: spy('usageSpend'),
    lab: spy('lab'),
    repos: spy('repos'),
    glance: spy('glance'),
    attention: spy('attention'),
    codespaces: spy('codespaces'),
    platform,
    claudeVersions: spy('claudeVersions'),
    connect: cx.connect,
  });
  // A member account: what the users table answers for it (the real one is read in qa/emailLogin.test.ts).
  portal.roleOf = (id) => (id === MEMBER ? 'member' : null);
  const send = async (method: string, path: string, token?: string) => {
    const res = await app.request(
      `http://localhost:3000${path}`,
      { method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...(token ? { cookie: `portal_session=${token}` } : {}) } },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
    const text = await res.text();
    let message: string | undefined;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    } catch {
      /* not JSON */
    }
    return { status: res.status, message };
  };
  return { app, portal, CODE, send, done: async () => (await cx.close(), cx.store.close(), store.close()) };
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

test('every route the real app answers has a declared policy', async () => {
  const { app, done } = await realApp();
  try {
    const keys = new Set<string>();
    for (const r of app.routes) if (METHODS.has(r.method)) keys.add(`${r.method} ${r.path.length > 1 ? r.path.replace(/\/+$/, '') : r.path}`);
    assert.ok(keys.size > 300, `the walk saw the whole app (${keys.size} routes)`);
    const undeclared = [...keys].filter((k) => !declaredPolicies().has(k)).sort();
    assert.deepEqual(undeclared, [], `routes with no declaration (declare each in its module's authz.ts or authz/appPolicies.ts):\n${undeclared.join('\n')}`);
  } finally {
    await done();
  }
});

test('the real app: a member is refused by the guard, the owner is not, nobody signed in is 401', async () => {
  const { portal, CODE, send, done } = await realApp();
  try {
    const member = portal.openSession(MEMBER);
    const users = await send('GET', '/api/admin/users', member);
    assert.deepEqual([users.status, users.message], [403, 'Only an admin can do this.'], 'an admin area: refused by its declaration');
    const accounts = await send('DELETE', '/api/accounts/x1', member);
    assert.deepEqual([accounts.status, accounts.message], [403, 'Only an admin can do this.']);
    assert.equal((await send('GET', '/api/admin/users')).status, 401);
    // The owner (the server code) reaches the handler: whatever it answers, it is not the guard's refusal.
    const owner = portal.signIn(CODE);
    const mine = await send('GET', '/api/admin/users', owner);
    assert.notEqual(mine.message, 'Only an admin can do this.');
    assert.notEqual(mine.message, NO_POLICY_MESSAGE);
    assert.notEqual(mine.status, 401);
  } finally {
    await done();
  }
});
