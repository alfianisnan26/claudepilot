// QA regression: the authorization matrix over EVERY route the app registers (so a route added later is covered without
// touching this file), and the Origin rule for mutating requests (QA-002).
//
// The app is built with stub dependencies and called through `app.request`: nothing past the guards runs, so these tests
// only prove who gets in, not what the handlers do. A variadic cast keeps other areas' constructor changes from breaking this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { Portal } from '../portal.js';

/** Answers every property, call and construction with itself: enough for createApp to wire its routes. */
const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});

const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const CODE = '24681357';

function build() {
  const portal = new Portal(CODE, 60_000);
  const app = make(portal, stub, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
  return { app, portal };
}

/** Routes anyone may call: health, whether you are signed in, signing in and out. */
const PUBLIC = new Set(['GET /healthz', 'GET /api/session', 'POST /api/login', 'POST /api/logout']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function registered(app: import('hono').Hono) {
  const seen = new Set<string>();
  const routes: { method: string; path: string; url: string }[] = [];
  for (const r of app.routes) {
    const key = `${r.method} ${r.path}`;
    if (!METHODS.has(r.method) || r.path.includes('*') || seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: r.method, path: r.path, url: r.path.replace(/:[A-Za-z]+/g, 'x') });
  }
  return routes;
}

const same = { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' };
const send = (app: import('hono').Hono, method: string, url: string, headers: Record<string, string> = same) =>
  app.request(`http://localhost:3000${url}`, { method, headers, body: method === 'GET' ? undefined : '{}' });

test('every route except the public ones refuses a caller that is not signed in', async () => {
  const { app } = build();
  const routes = registered(app);
  assert.ok(routes.length > 90, `expected the whole API, found ${routes.length} routes`);
  const open: string[] = [];
  for (const r of routes) {
    if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
    const res = await send(app, r.method, r.url);
    if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(open, [], 'routes reachable without signing in');
});

test('a made-up session cookie and an expired one are no better than none', async () => {
  const { app, portal } = build();
  const routes = registered(app).filter((r) => !PUBLIC.has(`${r.method} ${r.path}`));
  const short = new Portal(CODE, 1);
  const expired = short.signIn(CODE);
  await new Promise((r) => setTimeout(r, 10));
  for (const cookie of ['portal_session=nope', 'portal_session=', `portal_session=${expired}`, 'other=1', `portal_session=${'A'.repeat(5000)}`]) {
    for (const r of routes.slice(0, 40)) {
      const res = await send(app, r.method, r.url, { ...same, cookie });
      assert.equal(res.status, 401, `${r.method} ${r.path} with cookie ${cookie.slice(0, 30)}`);
    }
  }
  assert.ok(portal);
});

test('path tricks do not get past the session guard', async () => {
  const { app } = build();
  for (const url of ['/api/admin/state/', '/api/admin/%73tate', '/api/admin/./state', '/api/admin/../admin/state', '/api/workspaces/docker/x/../../targets', '/api/chat/sessions/%2e%2e/%2e%2e/admin/state', '/api/admin/state?x=1']) {
    const res = await send(app, 'GET', url);
    assert.ok([401, 404].includes(res.status), `${url} -> ${res.status}`);
    assert.notEqual(res.status, 200, url);
  }
  // Method overrides are not honoured: a POST stays a POST.
  const res = await app.request('http://localhost:3000/api/admin/state', { method: 'POST', headers: { ...same, 'x-http-method-override': 'GET' }, body: '{}' });
  assert.notEqual(res.status, 200);
});

test('a mutating request from another origin is refused whatever its content type (QA-002)', async () => {
  const { app, portal } = build();
  const token = portal.signIn(CODE);
  const routes = registered(app).filter((r) => r.method !== 'GET');
  for (const r of routes) {
    for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      for (const origin of ['http://evil.example', 'http://localhost:3999', 'https://localhost:3000.evil.example', 'null', 'not a url']) {
        const headers: Record<string, string> = { host: 'localhost:3000', origin, cookie: `portal_session=${token}` };
        if (type) headers['content-type'] = type;
        const res = await send(app, r.method, r.url, headers);
        assert.equal(res.status, 403, `${r.method} ${r.path} (${type || 'no type'}) from ${origin} -> ${res.status}`);
      }
    }
  }
});

test('a request marked cross-site is refused even without an Origin header', async () => {
  const { app, portal } = build();
  const token = portal.signIn(CODE);
  const res = await send(app, 'POST', '/api/admin/code', { host: 'localhost:3000', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', cookie: `portal_session=${token}` });
  assert.equal(res.status, 403);
  assert.equal(portal.code, CODE, 'the server code was not rotated');
});

test('the portal’s own origin passes the check, with or without a port, behind a TLS proxy too', async () => {
  const { app, portal } = build();
  const token = portal.signIn(CODE);
  for (const [host, origin] of [
    ['localhost:3000', 'http://localhost:3000'],
    ['portal.example.com', 'https://portal.example.com'], // TLS ends at the proxy, which keeps Host
    ['127.0.0.1:3101', 'http://127.0.0.1:3101'],
  ] as const) {
    const res = await send(app, 'PUT', '/api/admin/enabled', { host, origin, 'content-type': 'application/json', cookie: `portal_session=${token}` });
    assert.notEqual(res.status, 403, `${origin} via ${host}`);
  }
  // Scripts that send no Origin are not browsers: they still need the session.
  const noOrigin = await send(app, 'PUT', '/api/admin/enabled', { host: 'localhost:3000', 'content-type': 'application/json' });
  assert.equal(noOrigin.status, 401);
});

test('signing in from another origin is refused too, and the code is not guessable through it', async () => {
  const { app } = build();
  const res = await send(app, 'POST', '/api/login', { host: 'localhost:3000', origin: 'http://evil.example', 'content-type': 'application/json' });
  assert.equal(res.status, 403);
});

// T-143: behind the TLS proxy the server sees http://, the browser names https://. Called without a cookie, so a request the
// Origin checks let through stops at the session guard (401) and one they refuse is 403: nothing past the guards runs.
const PROXIED = 'pilot.example.com';
const FORMS = ['multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'text/plain'];
const viaProxy = (app: import('hono').Hono, method: string, headers: Record<string, string>, path = '/api/skills/import') =>
  app.request(`http://${PROXIED}${path}`, { method, headers: { host: PROXIED, ...headers }, body: method === 'DELETE' ? undefined : 'x' });

test('a form-like POST from the portal’s own https page passes behind a TLS proxy (T-143)', async () => {
  const { app } = build();
  for (const type of FORMS) {
    for (const origin of [`https://${PROXIED}`, `http://${PROXIED}`]) {
      const res = await viaProxy(app, 'POST', { origin, 'content-type': type });
      assert.equal(res.status, 401, `${type} from ${origin} -> ${res.status}`);
    }
  }
});

test('a form-like POST is still refused from anything but the portal’s own host over http or https (T-143)', async () => {
  const { app } = build();
  const refused = [
    'https://evil.example', // foreign
    `https://${PROXIED}.evil.example`, // a host that only starts like ours
    `https://${PROXIED}:8443`, // another port
    `http://${PROXIED}:3000`,
    `ftp://${PROXIED}`, // another scheme
    `ws://${PROXIED}`,
    'not a url', // malformed
    `https://user@${PROXIED}`, // not how a browser writes an Origin
    `https://${PROXIED}/path`,
    'null',
  ];
  for (const type of FORMS) {
    for (const origin of refused) {
      const res = await viaProxy(app, 'POST', { origin, 'content-type': type });
      assert.equal(res.status, 403, `${type} from ${origin} -> ${res.status}`);
    }
    // A sandboxed or cross-site page sends Origin null and says it is cross-site.
    const nul = await viaProxy(app, 'POST', { origin: 'null', 'sec-fetch-site': 'cross-site', 'content-type': type });
    assert.equal(nul.status, 403, `${type} from null, cross-site`);
    // x-forwarded-* is not trusted to make a foreign Origin look like ours.
    const fwd = await viaProxy(app, 'POST', { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'content-type': type });
    assert.equal(fwd.status, 403, `${type} with x-forwarded-host`);
  }
});

test('JSON and a DELETE without a content type behave as before behind a TLS proxy (T-143)', async () => {
  const { app } = build();
  const json = { 'content-type': 'application/json' };
  assert.equal((await viaProxy(app, 'POST', { ...json, origin: `https://${PROXIED}` })).status, 401);
  assert.equal((await viaProxy(app, 'POST', { ...json, origin: 'https://evil.example' })).status, 403);
  assert.equal((await viaProxy(app, 'POST', { ...json, origin: `https://${PROXIED}:8443` })).status, 403);
  assert.equal((await viaProxy(app, 'POST', { ...json, 'sec-fetch-site': 'cross-site' })).status, 403);
  const del = '/api/skills/sources/x';
  assert.equal((await viaProxy(app, 'DELETE', { origin: `https://${PROXIED}` }, del)).status, 401);
  assert.equal((await viaProxy(app, 'DELETE', { origin: `http://${PROXIED}` }, del)).status, 401);
  assert.equal((await viaProxy(app, 'DELETE', { origin: 'https://evil.example' }, del)).status, 403);
  assert.equal((await viaProxy(app, 'DELETE', { 'sec-fetch-site': 'cross-site' }, del)).status, 403);
});
