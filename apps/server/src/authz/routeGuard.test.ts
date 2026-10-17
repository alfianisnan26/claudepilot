// T-1043 S0a (D-82): the one route guard (routeGuard.ts) in front of every HTTP route.
//   1. The guard on its own, on a small app: a non-owner is refused a route with no declaration, refused a declared route it may not use (a
//      platform area, an object it does not own), each with the same 404 a path nobody serves answers (the lead's decision on T-1043), and let
//      through where the declaration allows (signed-in, self, an object it owns). A request every route hands on and an undeclared `app.all`
//      endpoint are refused too (QA 10597 A1, A2). The founding owner goes through everything, as before; nobody signed in is 401.
//      Review 10681: a route that hands on never falls through to an open door (#1), a middleware's door opens nothing (#3), an
//      `app.all(path, (c, next) => …)` endpoint never answers unchecked (#4).
//   2. The real app, with and without the web app's static routes (#6): every route it answers is declared, `app.all` endpoints included
//      (read off `app.routes`, so a route added later is covered without anyone adding it here); nothing that answers is registered before
//      the guard (A3); no open door hands on to a guarded route (#3); every route for a member is the guard's allow or the unknown path's 404
//      (#2), never a 403 (#5), while the owner is not refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, type Actor, type RoutePolicies } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createApp } from '../app.js';
import { createBrowserRoutes } from '../browser/routes.js';
import { realInstall } from '../connect/installPort.js';
import { openModule } from '../connect/testkit.js';
import { FakeChat, freshStore } from '../notify/testkit.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { ROUTE_GUARD_NAME, createRouteGuard, isEndpoint, keyOf, type SignedIn } from './routeGuard.js';
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
  // A `/:ref` route that hands on a value that is not its kind of id (as the workspace `/:ref…` routes do).
  'GET /t/ws/:ref': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'ref' }] },
};

/** What a path nobody serves answers (app.ts's `app.all('/api/*')`): every refusal of the guard must read exactly like it. */
const UNKNOWN_PATH = { status: 404, body: new AppError('NOT_FOUND').toJSON() };

function small(who: () => SignedIn) {
  declarePolicies('routeGuard.test', TEST_POLICIES);
  const app = new Hono();
  app.onError((e, c) => {
    const error = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });
  // Values named `legacy…` are not this route's kind of id: it hands them on (idOf null).
  app.use('*', createRouteGuard({ signedIn: () => who(), idOf: (check, v) => (check.param === 'ref' && v.startsWith('legacy') ? null : undefined) }));
  const reached: string[] = [];
  const ok = (c: { req: { path: string; method: string }; json: (v: unknown) => Response }) => (reached.push(`${c.req.method} ${c.req.path}`), c.json({ ok: true }));
  for (const p of ['/t/admin', '/t/list', '/t/me', '/t/open', '/t/ticket/:id', '/t/search', '/t/undeclared', '/t/ws/:ref']) app.get(p, ok);
  app.post('/t/ticket', ok);
  // An undeclared endpoint written `app.all` (one argument: it answers, it does not hand on).
  app.all('/t/any', (c) => ok(c));
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const json = (await res.json()) as { error?: { code: string; message: string } };
    return { status: res.status, message: json.error?.message, body: json };
  };
  return { send, reached };
}

const refusedLikeUnknownPath = (r: { status: number; body: unknown }, what: string) => assert.deepEqual({ status: r.status, body: r.body }, UNKNOWN_PATH, what);

/** Tickets `mine` (the member's) and `theirs` (someone else's); anything else does not exist. */
function ticketsOwned() {
  clearResolvers();
  registerResolver({
    type: 'ticket',
    resolve: (id) => (id === 'mine' || id === 'theirs' ? { ref: objectRef('ticket', id), owner: { kind: 'user', id: (id === 'mine' ? MEMBER : OTHER) as never } } : null),
  });
}

test('a member is refused a route nobody declared with the unknown path’s 404, and the handler never runs', async () => {
  const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
  refusedLikeUnknownPath(await send('GET', '/t/undeclared'), 'an undeclared route');
  assert.deepEqual(reached, []);
});

test('a member is refused a declared route it may not use, with the unknown path’s 404: an admin area, an object it does not own', async () => {
  ticketsOwned();
  try {
    const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
    refusedLikeUnknownPath(await send('GET', '/t/admin'), 'an admin area');
    const theirs = await send('GET', '/t/ticket/theirs');
    const missing = await send('GET', '/t/ticket/nope');
    refusedLikeUnknownPath(theirs, 'someone else’s object');
    assert.deepEqual(theirs, missing, 'someone else’s object reads exactly like one that does not exist');
    refusedLikeUnknownPath(await send('POST', '/t/ticket', { ticketId: 'theirs' }), 'a body id is checked too');
    refusedLikeUnknownPath(await send('POST', '/t/ticket', {}), 'a required id that is missing is refused, not skipped');
    refusedLikeUnknownPath(await send('GET', '/t/search?ticket=theirs'), 'an optional query id that is given is checked');
    assert.deepEqual(reached, []);
  } finally {
    clearResolvers();
  }
});

test('QA A1: a request every matched route hands on is refused, it never reaches the handler unchecked', async () => {
  ticketsOwned();
  try {
    const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
    refusedLikeUnknownPath(await send('GET', '/t/ws/legacy-theirs'), 'a value the route hands on');
    assert.deepEqual(reached, []);
    assert.equal((await send('GET', '/t/ws/mine')).status, 200, 'its own kind of id is checked and let through');
  } finally {
    clearResolvers();
  }
});

test('a member whose id is not one the seam knows (a real account: base64url) is a signed-in member, refused with the 404, never 401', async () => {
  // identity/users.ts makes `u_` + base64url; USER_ID_PATTERN takes lower case only. Built at runtime: upper case, `-` and `_`.
  const realShaped = ['u', 'Ab', 'c-D', 'e'].join('_');
  const { send, reached } = small(() => ({ full: false, userId: realShaped }));
  assert.equal((await send('GET', '/t/list')).status, 200, 'signed-in goes on: the handler scopes it');
  assert.equal((await send('GET', '/t/me')).status, 200);
  refusedLikeUnknownPath(await send('GET', '/t/admin'), 'an admin area');
  refusedLikeUnknownPath(await send('GET', '/t/undeclared'), 'an undeclared route');
  assert.deepEqual(reached, ['GET /t/list', 'GET /t/me']);
});

test('QA A2: an undeclared endpoint written app.all is seen by the guard and refused, for every method', async () => {
  const { send, reached } = small(() => ({ full: false, userId: MEMBER }));
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) refusedLikeUnknownPath(await send(m, '/t/any'), `${m} /t/any`);
  assert.deepEqual(reached, []);
  const owner = small(() => ({ full: true }));
  assert.equal((await owner.send('GET', '/t/any')).status, 200, 'the owner keeps it');
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
  assert.equal((await member.request('/t/undeclared')).status, 404, 'a member set on the context is refused, whatever the cookie says');
});

/** A bare app with the guard for a member (or `who`), the error shape of the real one, and a record of the handlers that ran. */
function bare(policies: RoutePolicies, who: () => SignedIn = () => ({ full: false, userId: MEMBER }), idOf?: (check: { param: string }, v: string) => string | null | undefined) {
  declarePolicies(`routeGuard.test.${Object.keys(policies).join(',')}`, policies);
  const app = new Hono();
  app.onError((e, c) => {
    const error = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });
  app.use('*', createRouteGuard({ signedIn: () => who(), ...(idOf ? { idOf } : {}) }));
  const reached: string[] = [];
  const send = async (method: string, path: string) => {
    const res = await app.request(path, { method });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  };
  return { app, reached, send };
}

test('review 10681 #1: a route that hands on never falls through to a door open to anyone (`GET /*`, `ALL /api/*`)', async () => {
  for (const door of ['GET /g1/*', 'ALL /g1/*'] as const) {
    const { app, reached, send } = bare(
      { 'GET /g1/ws/:ref': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'ref' }] }, [door]: { kind: 'public', why: 'a test door' } } as RoutePolicies,
      undefined,
      (check, v) => (check.param === 'ref' && v.startsWith('legacy') ? null : undefined),
    );
    // The `/:ref` route hands a value on with next(), as app.ts's `/:ref/resources` does; the open door after it would answer anything.
    app.get('/g1/ws/:ref', async (c, next) => (reached.push('ref'), next()));
    if (door.startsWith('GET')) app.get('/g1/*', (c) => (reached.push('door'), c.json({ open: true })));
    else app.all('/g1/*', (c) => (reached.push('door'), c.json({ open: true })));
    refusedLikeUnknownPath(await send('GET', '/g1/ws/legacy-theirs'), `${door}: handed on, then the open door`);
    assert.deepEqual(reached, [], `${door}: neither the route that handed on nor the door ran`);
    assert.equal((await send('GET', '/g1/elsewhere')).status, 200, `${door}: as the first endpoint the door stays open`);
  }
});

test('review 10681 #3: a middleware declared public or bearer that calls next() opens nothing after it', async () => {
  for (const kind of ['public', 'bearer'] as const) {
    for (const [label, who] of [
      ['a member', () => ({ full: false, userId: MEMBER })],
      ['nobody signed in', () => null],
    ] as const) {
      const p = `/g3${kind}${label === 'a member' ? 'm' : 'n'}`;
      const { app, reached, send } = bare(
        { [`ALL ${p}/*`]: { kind, why: 'a test door' }, [`GET ${p}/admin`]: { kind: 'platform', area: 'users', verb: 'view' } } as RoutePolicies,
        who as () => SignedIn,
      );
      app.use(`${p}/*`, async (_c, next) => (reached.push('mw'), next()));
      app.get(`${p}/admin`, (c) => (reached.push('admin'), c.json({})));
      app.get(`${p}/undeclared`, (c) => (reached.push('undeclared'), c.json({})));
      // An endpoint the guard cannot tell from middleware: the middleware's door would be the only policy it saw.
      app.all(`${p}/answers`, async (c, _next) => (reached.push('answers'), c.json({ leaked: true })));
      const closed = label === 'a member' ? 404 : 401;
      assert.equal((await send('GET', `${p}/admin`)).status, closed, `${kind}, ${label}: a declared endpoint after it keeps its own policy`);
      assert.equal((await send('GET', `${p}/undeclared`)).status, closed, `${kind}, ${label}: an undeclared endpoint after it is refused`);
      refusedLikeUnknownPath(await send('POST', `${p}/answers`), `${kind}, ${label}: the door never counts as the endpoint's policy`);
      assert.deepEqual(reached, [], `${kind}, ${label}: nothing ran, the middleware included`);
    }
  }
});

test('review 10681 #4: an endpoint written app.all(path, (c, next) => …) looks like middleware, yet never answers unchecked', async () => {
  for (const [label, who, status] of [
    ['a member', () => ({ full: false, userId: MEMBER }), 404],
    ['nobody signed in', () => null, 404],
  ] as const) {
    const { app, reached, send } = bare({ 'GET /g4/declared': { kind: 'signed-in' } } as RoutePolicies, who as () => SignedIn);
    app.all('/g4/answers', async (c, _next) => (reached.push('answers'), c.json({ leaked: true })));
    const r = await send('POST', '/g4/answers');
    assert.equal(r.status, status, label);
    if (status === 404) refusedLikeUnknownPath(r, label);
    assert.deepEqual(reached, [], `${label}: the handler did not run`);
  }
  const owner = bare({ 'GET /g4o/declared': { kind: 'signed-in' } } as RoutePolicies, () => ({ full: true }));
  owner.app.all('/g4o/answers', async (c, _next) => c.json({ ok: true }));
  assert.equal((await owner.send('POST', '/g4o/answers')).status, 200, 'the founding owner keeps it, as before');
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

async function realApp(serveWeb = false) {
  const { store } = await freshStore();
  const platform = createPlatform({ store, settings: null, chat: new FakeChat(), uiUrl: null, pushContact: null, selfOrigin: 'http://localhost:3000', publish: () => undefined, socketAuthorized: () => true, tools: false });
  const cx = await openModule({ install: realInstall });
  const CODE = '24681357';
  const portal = new Portal(CODE, 60_000);
  const make = createApp as unknown as (...args: unknown[]) => Hono;
  const app = make(portal, spy('workspaces'), spy('store'), spy('accounts'), spy('pools'), spy('reconciler'), spy('health'), spy('chat'), {
    serveWeb,
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
    method = method === 'ALL' ? 'POST' : method;
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
    return { status: res.status, message, text };
  };
  return { app, portal, CODE, send, done: async () => (await cx.close(), cx.store.close(), store.close()) };
}

type Listed = { method: string; path: string; handler: { name: string; length: number } };
const listed = (app: Hono): Listed[] => app.routes as unknown as Listed[];

/** The keys of every endpoint an app lists: each method's routes and the `app.all` endpoints (middleware left out), each once. */
function endpointKeys(routes: Listed[]): string[] {
  return [...new Set(routes.filter(isEndpoint).map((r) => keyOf(r)))];
}

/** The endpoints registered before the guard: Hono runs them first, so they would answer unguarded (QA 10597 A3). */
function endpointsBeforeGuard(routes: Listed[]): string[] {
  const at = routes.findIndex((r) => r.handler.name === ROUTE_GUARD_NAME);
  if (at < 0) return ['(the route guard is not mounted)'];
  return routes.slice(0, at).filter(isEndpoint).map((r) => keyOf(r));
}

test('the walk sees an app.all endpoint and an endpoint registered before the guard (so the real-app checks below can fail)', () => {
  const app = new Hono();
  app.get('/early', (c) => c.json({}));
  app.use('/mw/*', async (_c, next) => next());
  app.use('*', createRouteGuard({ signedIn: () => null }));
  app.all('/any', (c) => c.json({}));
  app.get('/late', (c) => c.json({}));
  assert.deepEqual(endpointKeys(listed(app)), ['GET /early', 'ALL /any', 'GET /late'], 'app.all is an endpoint, use() is not');
  assert.deepEqual(endpointsBeforeGuard(listed(app)), ['GET /early']);
  const bare = new Hono();
  bare.get('/x', (c) => c.json({}));
  assert.deepEqual(endpointsBeforeGuard(listed(bare)), ['(the route guard is not mounted)']);
});

for (const serveWeb of [false, true]) {
  test(`every route the real app answers has a declared policy, app.all endpoints included (serveWeb ${serveWeb})`, async () => {
    const { app, done } = await realApp(serveWeb);
    try {
      const keys = endpointKeys(listed(app));
      assert.ok(keys.length > 300, `the walk saw the whole app (${keys.length} routes)`);
      assert.ok(keys.includes('ALL /api/*'), 'the walk lists the app.all endpoints');
      // Review 10681 #6: the built app's static routes are walked too.
      assert.equal(keys.includes('GET /*'), serveWeb, 'the web app shell is there exactly when the app serves it');
      const undeclared = keys.filter((k) => !declaredPolicies().has(k as never)).sort();
      assert.deepEqual(undeclared, [], `routes with no declaration (declare each in its module's authz.ts or authz/appPolicies.ts):\n${undeclared.join('\n')}`);
    } finally {
      await done();
    }
  });

  test(`QA A3: the real app registers nothing that answers before the route guard (serveWeb ${serveWeb})`, async () => {
    const { app, done } = await realApp(serveWeb);
    try {
      assert.deepEqual(endpointsBeforeGuard(listed(app)), []);
    } finally {
      await done();
    }
  });

  test(`review 10681 #3: no door open to anyone hands on to a later route that is not one (serveWeb ${serveWeb})`, async () => {
    const { app, done } = await realApp(serveWeb);
    try {
      assert.deepEqual(openDoorsHandingOn(listed(app)), []);
    } finally {
      await done();
    }
  });

  test(`review 10681 #2: every declared route of the real app, for a member: the guard's allow or the unknown path's 404 (serveWeb ${serveWeb})`, async () => {
    const { app, portal, CODE, send, done } = await realApp(serveWeb);
    clearResolvers();
    try {
      const routes = listed(app);
      const unknown = await send('GET', '/api/no-such-path', portal.openSession(MEMBER));
      if (serveWeb)
        for (const path of ['/', '/sessions', '/assets/app.js'])
          assert.notEqual((await send('GET', path)).status, 401, `${path}: the web app shell and its files are open to anyone (the sign-in page)`);
      const asOwner = table(routes, () => ({ full: true }));
      const asMember = table(routes, () => ({ full: false, userId: MEMBER }));
      const asNobody = table(routes, () => null);
      const wrong: string[] = [];
      let refused = 0;
      let allowed = 0;
      for (const key of endpointKeys(routes)) {
        const [method, path] = key.split(' ') as [string, string];
        const url = concrete(path);
        // The route that answers this request is the first endpoint Hono runs: what the owner (who goes through everything) reaches.
        const answers = (await asOwner.send(method, url)).key;
        const policy = answers ? declaredPolicies().get(answers) : undefined;
        if (!answers || !policy) {
          wrong.push(`${key}: the owner reached ${answers ?? 'nothing'}`);
          continue;
        }
        const expectAllow = OPEN.has(policy.kind) || policy.kind === 'signed-in' || policy.kind === 'self' || (policy.kind === 'objects' && policy.checks.every((ch) => ch.optional && ch.from !== 'path'));
        // The guard's decision, on the real declarations and the real route order.
        const m = await asMember.send(method, url);
        if (expectAllow ? m.key !== answers : m.status !== 404 || m.key !== undefined || JSON.stringify(m.body) !== JSON.stringify(UNKNOWN_PATH.body))
          wrong.push(`${key} (${answers}, ${policy.kind}): a member got ${m.status} ${m.key ?? ''}`);
        const n = await asNobody.send(method, url);
        if (OPEN.has(policy.kind) ? n.key !== answers : n.status !== 401) wrong.push(`${key} (${answers}, ${policy.kind}): nobody signed in got ${n.status}`);
        // The real app: a refusal is exactly the unknown path's answer and runs no handler; nothing is ever a 403 or shows the code.
        const before = touched.length;
        // A session of its own per request: `POST /api/logout` is public and ends the cookie it is sent with.
        const real = await send(method, url, portal.openSession(MEMBER));
        if (real.status === 403 || real.text.includes(CODE)) wrong.push(`${key}: the real app answered a member ${real.status}`);
        if (!expectAllow) {
          refused++;
          if (JSON.stringify(real) !== JSON.stringify(unknown)) wrong.push(`${key}: the real app's refusal is not the unknown path's (${real.status} ${real.text.slice(0, 80)})`);
          if (touched.length !== before) wrong.push(`${key}: a handler ran for a refused member (${touched.slice(before, before + 3).join(', ')})`);
        } else {
          allowed++;
          if (real.status === 401) wrong.push(`${key}: the real app answered a signed-in member 401`);
        }
      }
      assert.deepEqual(wrong, [], wrong.join('\n'));
      assert.ok(refused > 250 && allowed > 5, `both kinds were exercised (${refused} refused, ${allowed} let through)`);
    } finally {
      await done();
    }
  });
}

test('review 10681 #5: a member on a route behind requireSession gets the unknown path’s 404, never a 403', async () => {
  const { portal, send, done } = await realApp();
  try {
    const member = portal.openSession(MEMBER);
    const unknown = await send('GET', '/api/no-such-path', member);
    // `GET /api/workspaces` is `signed-in`: the guard lets the member on, the admin router's requireSession is what refuses it today.
    assert.equal(declaredPolicies().get('GET /api/workspaces')?.kind, 'signed-in');
    const before = touched.length;
    assert.deepEqual(await send('GET', '/api/workspaces', member), unknown);
    assert.equal(touched.length, before, 'the handler did not run');
  } finally {
    await done();
  }
});

const OPEN = new Set(['public', 'bearer', 'handler']);

/** A route pattern as a request path: each param `x1`, each wildcard `x`. */
const concrete = (path: string): string => path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, 'x1').replace(/\*/g, 'x');

/**
 * The real app's endpoints in their order, each answering with its own key, behind the route guard with the real declarations: what the guard
 * decides for `who`, on the routes and the order the real app has, without the real handlers (which would refuse on their own).
 */
function table(routes: Listed[], who: () => SignedIn) {
  const app = new Hono();
  app.onError((e, c) => {
    const error = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });
  app.use('*', createRouteGuard({ signedIn: () => who() }));
  const seen = new Set<string>();
  for (const r of routes) {
    if (!isEndpoint(r)) continue;
    const key = keyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const answer = (c: Context) => c.json({ key });
    if (r.method === 'ALL') app.all(r.path, answer);
    else app.on(r.method, r.path, answer);
  }
  const send = async (method: string, path: string) => {
    const res = await app.request(path, { method: method === 'ALL' ? 'POST' : method });
    const body = (await res.json().catch(() => ({}))) as { key?: string };
    return { status: res.status, key: body.key, body };
  };
  return { send };
}

/**
 * Review 10681 #3: the guard takes the first endpoint's door only. A door open to anyone whose LAST handler takes `next` can hand the request
 * on to a route registered after it; every endpoint after such a handler (of another route) must then be an open door too.
 */
function openDoorsHandingOn(routes: Listed[]): string[] {
  const out: string[] = [];
  const lastAt = new Map<string, number>();
  routes.forEach((r, i) => isEndpoint(r) && lastAt.set(keyOf(r), i));
  for (const [key, at] of lastAt) {
    const policy = declaredPolicies().get(key);
    if (!policy || !OPEN.has(policy.kind) || routes[at]!.handler.length < 2) continue;
    const after = routes.slice(at + 1).filter((r) => isEndpoint(r) && keyOf(r) !== key && !OPEN.has(declaredPolicies().get(keyOf(r))?.kind ?? ''));
    if (after.length > 0) out.push(`${key} hands on to ${after.map((r) => keyOf(r)).join(', ')}`);
  }
  return out;
}

test('the real app: a member is refused by the guard with the unknown path’s 404, the owner is not, nobody signed in is 401', async () => {
  const { portal, CODE, send, done } = await realApp();
  try {
    const member = portal.openSession(MEMBER);
    const unknown = await send('GET', '/api/no-such-path', member);
    assert.equal(unknown.status, 404);
    const users = await send('GET', '/api/admin/users', member);
    assert.deepEqual(users, unknown, 'an admin area refused reads exactly like a path nobody serves');
    const accounts = await send('DELETE', '/api/accounts/x1', member);
    assert.deepEqual(accounts, unknown, 'a change in an admin area too');
    assert.equal((await send('GET', '/api/admin/users')).status, 401);
    // The owner (the server code) reaches the handler: whatever it answers, it is not the guard's refusal.
    const owner = portal.signIn(CODE);
    const mine = await send('GET', '/api/admin/users', owner);
    assert.notDeepEqual(mine, unknown);
    assert.notEqual(mine.status, 401);
  } finally {
    await done();
  }
});
