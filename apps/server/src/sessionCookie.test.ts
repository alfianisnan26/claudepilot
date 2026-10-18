// T-976: the portal session cookie is `__Host-portal_session` (Secure, Path=/, no Domain) over https, so an app on a sibling host
// (T-948 app ports) cannot plant or shadow it; plain http keeps `portal_session`. Tokens come from Portal.signIn at run time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';
import { config } from './config.js';
import { Portal } from './portal.js';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, overHttps, sessionCookieSpec, sessionFromCookies } from './sessionCookie.js';

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

const HOST = 'pilot.example.test';
type Scheme = 'https' | 'http';
const send = (app: import('hono').Hono, scheme: Scheme, method: string, path: string, extra: Record<string, string> = {}) =>
  app.request(`${scheme}://${HOST}${path}`, {
    method,
    headers: { host: HOST, origin: `${scheme}://${HOST}`, 'content-type': 'application/json', ...extra },
    body: method === 'GET' ? undefined : method === 'POST' && path === '/api/login' ? JSON.stringify({ code: CODE }) : '{}',
  }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } }); // the Node env @hono/node-server gives (sign-in's rate limit reads it)
const setCookies = (res: Response) => res.headers.getSetCookie();
const named = (res: Response, name: string) => setCookies(res).filter((c) => c.startsWith(`${name}=`));

test('the cookie reader: the __Host- name wins whenever it is there, the old name only when it is absent', () => {
  const a = `t${Date.now()}a`;
  const b = `t${Date.now()}b`;
  assert.deepEqual(sessionFromCookies(`${SESSION_COOKIE}=${a}; ${LEGACY_SESSION_COOKIE}=${b}`), { token: a, legacy: false });
  assert.deepEqual(sessionFromCookies(`${LEGACY_SESSION_COOKIE}=${b}; ${SESSION_COOKIE}=${a}`), { token: a, legacy: false }, 'order does not matter');
  assert.deepEqual(sessionFromCookies(`${LEGACY_SESSION_COOKIE}=${b}`), { token: b, legacy: true });
  assert.deepEqual(sessionFromCookies(`x${LEGACY_SESSION_COOKIE}=${b}; other=1`).token, undefined, 'a cookie whose name merely ends the same is not read');
  assert.equal(sessionFromCookies(undefined).token, undefined);
});

test('the cookie reader (pinned, QA #11040): a __Host- value that does not decode counts as absent, so the old name is read', () => {
  // A browser only sends a __Host- cookie this host set, and the portal sets it encoded, so an undecodable one is not a planter's tool:
  // the fallback is today's behaviour, pinned here so a change to it is a decision, not an accident.
  const b = `t${Date.now()}b`;
  const bad = '%E0%A4%A';
  assert.throws(() => decodeURIComponent(bad), URIError);
  assert.deepEqual(sessionFromCookies(`${SESSION_COOKIE}=${bad}; ${LEGACY_SESSION_COOKIE}=${b}`), { token: b, legacy: true });
  assert.deepEqual(sessionFromCookies(`${SESSION_COOKIE}=${bad}`), { token: undefined, legacy: true });
  const a = `t${Date.now()}a`;
  assert.deepEqual(sessionFromCookies(`${SESSION_COOKIE}=${bad}; ${SESSION_COOKIE}=${a}; ${LEGACY_SESSION_COOKIE}=${b}`), { token: a, legacy: false }, 'a second, decodable __Host- value still wins');
});

test('https: from the request URL, or from X-Forwarded-Proto only behind a trusted proxy', () => {
  assert.equal(overHttps('https://h/api', undefined), true);
  assert.equal(overHttps('http://h/api', 'https'), config.trustProxy, 'the header counts only with PORTAL_TRUST_PROXY');
  const was = config.trustProxy;
  try {
    config.trustProxy = true;
    assert.equal(overHttps('http://h/api', 'http, https'), true, 'the last hop (the trusted proxy) decides');
    assert.equal(overHttps('http://h/api', 'https, http'), false);
    config.trustProxy = false;
    assert.equal(overHttps('http://h/api', 'https'), false);
  } finally {
    config.trustProxy = was;
  }
  assert.equal(sessionCookieSpec(true, 1000).name, SESSION_COOKIE);
  assert.equal(sessionCookieSpec(false, 1000).name, LEGACY_SESSION_COOKIE);
});

test('signing in over https sets __Host-portal_session: Secure, Path=/, HttpOnly, SameSite=Strict, no Domain', async () => {
  const { app, portal } = build();
  const res = await send(app, 'https', 'POST', '/api/login');
  assert.equal(res.status, 200);
  const [cookie, ...more] = named(res, SESSION_COOKIE);
  assert.ok(cookie, `a ${SESSION_COOKIE} cookie: ${setCookies(res).map((c) => c.split('=')[0]).join(', ')}`);
  assert.equal(more.length, 0);
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /;\s*Path=\/(;|$)/);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*SameSite=Strict/i);
  assert.doesNotMatch(cookie, /;\s*Domain=/i);
  const old = named(res, LEGACY_SESSION_COOKIE);
  assert.equal(old.length, 1, 'over https the old name is only ever cleared');
  assert.match(old[0]!, /^portal_session=;/);
  assert.match(old[0]!, /Max-Age=0/i, 'a stale or planted portal_session is deleted at sign-in (review 10534)');
  assert.match(old[0]!, /;\s*Path=\/(;|$)/);
  const token = decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1).split(';')[0]!);
  assert.ok(portal.session(token), 'the cookie carries a live session');
  const state = await send(app, 'https', 'GET', '/api/admin/state', { cookie: `${SESSION_COOKIE}=${token}` });
  assert.equal(state.status, 200);
});

test('signing in over plain http (dev, scratch portal) keeps portal_session without Secure', async () => {
  const { app } = build();
  const res = await send(app, 'http', 'POST', '/api/login');
  assert.equal(res.status, 200);
  assert.equal(named(res, SESSION_COOKIE).length, 0, 'a browser would drop a __Host- cookie on http');
  const [cookie, ...more] = named(res, LEGACY_SESSION_COOKIE);
  assert.ok(cookie);
  assert.equal(more.length, 0, 'over http the old name is the session: set once, never cleared in the same answer');
  assert.doesNotMatch(cookie, /Max-Age=0/i);
  assert.doesNotMatch(cookie, /;\s*Secure/i);
  assert.match(cookie, /;\s*HttpOnly/i);
  const token = decodeURIComponent(cookie.slice(LEGACY_SESSION_COOKIE.length + 1).split(';')[0]!);
  const state = await send(app, 'http', 'GET', '/api/admin/state', { cookie: `${LEGACY_SESSION_COOKIE}=${token}` });
  assert.equal(state.status, 200);
});

test('behind a trusted proxy that says https, the cookie is the __Host- one', async () => {
  const { app } = build();
  const was = config.trustProxy;
  try {
    config.trustProxy = true;
    const res = await send(app, 'http', 'POST', '/api/login', { 'x-forwarded-proto': 'https' });
    assert.equal(res.status, 200);
    assert.equal(named(res, SESSION_COOKIE).length, 1);
    assert.match(named(res, SESSION_COOKIE)[0]!, /;\s*Secure/i);
  } finally {
    config.trustProxy = was;
  }
});

test('a shadowing portal_session (say Domain=<parent>, set by a sibling host) does not authenticate once the __Host- cookie exists', async () => {
  const { app, portal } = build();
  const mine = portal.signIn(CODE);
  const planted = portal.signIn(CODE); // a valid session the planter owns: the worst case
  portal.signOut(mine); // my __Host- cookie is now stale
  const both = { cookie: `${LEGACY_SESSION_COOKIE}=${planted}; ${SESSION_COOKIE}=${mine}` };
  const res = await send(app, 'https', 'GET', '/api/admin/state', both);
  assert.equal(res.status, 401, 'the stale __Host- cookie decides, the planted old-name one is ignored');
  assert.equal(named(res, SESSION_COOKIE).length, 0, 'the planted session is not moved into the __Host- cookie');
  const session = await send(app, 'https', 'GET', '/api/session', both);
  assert.equal(((await session.json()) as { data: { authenticated: boolean } }).data.authenticated, false);
  assert.ok(portal.session(planted), 'the planted session itself is untouched (only not used)');
});

test('with both names, the __Host- session is the one used: signing out ends it and not the other', async () => {
  const { app, portal } = build();
  const mine = portal.signIn(CODE);
  const other = portal.signIn(CODE);
  const both = { cookie: `${LEGACY_SESSION_COOKIE}=${other}; ${SESSION_COOKIE}=${mine}` };
  const ok = await send(app, 'https', 'GET', '/api/admin/state', both);
  assert.equal(ok.status, 200);
  assert.equal(named(ok, SESSION_COOKIE).length, 0, 'nothing to migrate when the new cookie is there');
  const out = await send(app, 'https', 'POST', '/api/logout', both);
  assert.equal(out.status, 200);
  assert.equal(portal.session(mine), undefined);
  assert.ok(portal.session(other));
  const cleared = setCookies(out);
  assert.ok(cleared.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/i.test(c) && /;\s*Secure/i.test(c)), cleared.join(' | '));
  assert.ok(cleared.some((c) => c.startsWith(`${LEGACY_SESSION_COOKIE}=;`) && /Max-Age=0/i.test(c)), cleared.join(' | '));
});

test('migration: a signed-in browser with only the old cookie stays signed in over https and gets the __Host- cookie', async () => {
  const { app, portal } = build();
  const token = portal.signIn(CODE);
  for (const path of ['/api/session', '/api/admin/state']) {
    const res = await send(app, 'https', 'GET', path, { cookie: `${LEGACY_SESSION_COOKIE}=${token}` });
    assert.equal(res.status, 200, path);
    const [moved] = named(res, SESSION_COOKIE);
    assert.ok(moved, `${path}: the session is re-issued under the new name`);
    assert.equal(decodeURIComponent(moved.slice(SESSION_COOKIE.length + 1).split(';')[0]!), token, 'same session, no sign-out');
    assert.match(moved, /;\s*Secure/i);
    assert.match(moved, /;\s*Path=\/(;|$)/);
    assert.doesNotMatch(moved, /;\s*Domain=/i);
    assert.ok(named(res, LEGACY_SESSION_COOKIE).some((c) => /Max-Age=0/i.test(c)), `${path}: the old cookie is cleared`);
  }
  const session = await send(app, 'https', 'GET', '/api/session', { cookie: `${LEGACY_SESSION_COOKIE}=${token}` });
  assert.equal(((await session.json()) as { data: { authenticated: boolean } }).data.authenticated, true);
});

test('migration does not happen for a dead old cookie, nor over plain http', async () => {
  const { app, portal } = build();
  const dead = portal.signIn(CODE);
  portal.signOut(dead);
  const res = await send(app, 'https', 'GET', '/api/admin/state', { cookie: `${LEGACY_SESSION_COOKIE}=${dead}` });
  assert.equal(res.status, 401);
  assert.equal(named(res, SESSION_COOKIE).length, 0, 'a dead session is never given the new name');
  const live = portal.signIn(CODE);
  const plain = await send(app, 'http', 'GET', '/api/admin/state', { cookie: `${LEGACY_SESSION_COOKIE}=${live}` });
  assert.equal(plain.status, 200);
  assert.equal(setCookies(plain).length, 0, 'http keeps the old name: nothing re-issued');
});
