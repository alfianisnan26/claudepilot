// D-82 S1a, member access (owner request 2026-11-01), the route table half (the seam half is authz/memberAccess.test.ts):
//   1. generated from the whole app's route table (like slice 1's routeTable.test.ts): a member reaches an object route only on its own
//      objects (anything else is exactly the missing 404), never a platform route, and a `signed-in`/`self`/`handler` door only where it is
//      listed (authz/memberDoors.ts); an admin account and the founding user reach every one, as before;
//   3. over HTTP through the real session middleware: a member signs in, reaches the doors, gets 404 on admin routes (never the server code).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, OBJECT_TYPE_IDS, objectRef, type Actor, type RoutePolicy, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { Portal } from '../portal.js';
import { MEMBER_DOORS, isMemberDoor } from './memberDoors.js';
import { enforceRoutePolicy } from './routeGuard.js';
import { clearResolvers, policyFor, registerResolver, useAccountRoles } from './seam.js';
import { SERVER_CODE, buildWholeApp, routeKeys } from './wholeApp.testkit.js';

const MEMBER = 'u_Memb3r_S1a01' as UserId;
const ADMIN = 'u_Adm1n_S1a001' as UserId;
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });

/* ---------- 1. The whole route table ---------- */

/** `m-…` is the member's, `o-…` the founding user's, anything else does not exist. */
function memberAndOwner(): void {
  for (const type of OBJECT_TYPE_IDS) {
    if (type === 'platform') continue;
    registerResolver({
      type,
      resolve: (id) =>
        id.startsWith('m-') ? { ref: objectRef(type, id), owner: { kind: 'user', id: MEMBER } } : id.startsWith('o-') ? { ref: objectRef(type, id), owner: { kind: 'user', id: FOUNDING_USER_ID } } : null,
    });
  }
}

function guarded(key: string, actor: Actor): Hono {
  const [method, path] = key.split(' ') as [string, string];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.on(method === 'ALL' ? ['GET'] : [method], path, (c) => c.json({ ok: true }));
  app.onError((e, c) => {
    const err = e as AppError;
    return c.json({ ok: false, error: { code: err.code, message: err.message } }, (err.status ?? 500) as 404);
  });
  return app;
}

function probe(key: string, policy: RoutePolicy, prefix: string): { url: string; init: RequestInit } {
  const [method, path] = key.split(' ') as [string, string];
  let concrete = path.replace(/:([A-Za-z]+)(\{[^}]*\})?\??/g, (_m, name: string) => `${prefix}-${name}`);
  concrete = concrete.replace(/\*$/, `${prefix}-rest`);
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  if (policy.kind === 'objects')
    for (const c of policy.checks) {
      if (c.from === 'query') query.append(c.param, `${prefix}-${c.param}`);
      if (c.from === 'body') body[c.param] = c.many ? [`${prefix}-${c.param}`] : `${prefix}-${c.param}`;
    }
  const hasBody = Object.keys(body).length > 0 && method !== 'GET';
  return {
    url: `http://localhost${concrete}${query.size ? `?${query}` : ''}`,
    init: { method: method === 'ALL' ? 'GET' : method, ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) },
  };
}

test('the whole route table: a member reaches only its own objects and the listed doors; never a platform route; admins reach all, as before', async () => {
  const { app } = await buildWholeApp();
  const keys = [...routeKeys(app)];
  assert.ok(keys.length >= 550);
  clearResolvers();
  memberAndOwner();
  const restore = useAccountRoles((id) => (id === MEMBER ? 'member' : id === ADMIN ? 'admin' : null));
  const failures: string[] = [];
  try {
    for (const key of keys) {
      const policy = policyFor(key);
      if (!policy) continue; // routeTable.test.ts fails on it
      const send = async (actor: Actor, prefix: string) => {
        const { url, init } = probe(key, policy, prefix);
        const res = await guarded(key, actor).request(url, init);
        return { status: res.status, body: await res.text() };
      };
      if (policy.kind === 'objects') {
        const mine = await send(person(MEMBER), 'm');
        const reaches = policy.checks.length > 0 || isMemberDoor(key);
        if (reaches && mine.status !== 200) failures.push(`${key}: the member on its own object got ${mine.status} ${mine.body}`);
        if (!reaches && mine.status !== 404) failures.push(`${key}: no object named, not a door, the member got ${mine.status}`);
        const theirs = await send(person(MEMBER), 'o');
        const missing = await send(person(MEMBER), 'z');
        if (policy.checks.length > 0) {
          if (theirs.status !== 404) failures.push(`${key}: the member on the owner’s object got ${theirs.status}`);
          if (theirs.status !== missing.status || theirs.body !== missing.body) failures.push(`${key}: the owner’s object answers unlike a missing one`);
        }
        const admin = await send(person(ADMIN), 'o');
        if (admin.status !== 200) failures.push(`${key}: an admin account on the owner’s object got ${admin.status} (D-82: unchanged)`);
      } else if (policy.kind === 'platform') {
        const m = await send(person(MEMBER), 'm');
        if (m.status !== 404) failures.push(`${key}: platform(${policy.area}) answered a member ${m.status}`);
        for (const a of [ADMIN, FOUNDING_USER_ID]) {
          const r = await send(person(a), 'o');
          if (r.status !== 200) failures.push(`${key}: platform(${policy.area}) refused ${a} (${r.status})`);
        }
      } else {
        const m = await send(person(MEMBER), 'm');
        const want = isMemberDoor(key) ? 200 : 404;
        if (m.status !== want) failures.push(`${key} (${policy.kind}): the member got ${m.status}, want ${want}`);
        for (const a of [ADMIN, FOUNDING_USER_ID]) {
          const r = await send(person(a), 'o');
          if (r.status !== 200) failures.push(`${key} (${policy.kind}): ${a} got ${r.status} (unchanged for admins)`);
        }
      }
    }
  } finally {
    useAccountRoles(restore);
    clearResolvers();
  }
  assert.deepEqual(failures, []);
});

test('every member door is a route of the app, declared signed-in, self or handler (an object or platform route is decided by can())', async () => {
  const { app } = await buildWholeApp();
  const keys = routeKeys(app);
  for (const [key, why] of Object.entries(MEMBER_DOORS)) {
    assert.ok(keys.has(key), `${key}: no such route (drift)`);
    const p = policyFor(key);
    assert.ok(p && p.kind !== 'objects' && p.kind !== 'platform', `${key}: declared ${p?.kind}; a door is for routes that name no object`);
    assert.ok(why.length > 10, `${key}: say why it is per person`);
  }
  // The admin's own areas are never doors.
  for (const key of ['GET /api/admin/state', 'GET /api/settings', 'GET /api/admin/manager', 'POST /api/chat/reauth', 'POST /api/portal-mcp/tokens', 'GET /api/chat/audit', 'POST /api/notify/destinations', 'GET /api/approvals'])
    assert.equal(isMemberDoor(key), false, key);
});

/* ---------- 3. Over HTTP, through the real session middleware ---------- */

test('over HTTP: a member signs in and passes the session middleware; admin routes are the same 404 and never show the server code', async () => {
  process.env.PORTAL_PASSWORD_COST ??= 'test';
  clearResolvers();
  const { app, portal, store: s } = await buildWholeApp({ portal: new Portal(SERVER_CODE, 60_000) });
  const H = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' };
  const call = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(`http://localhost${path}`, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  const cookieOf = (r: Response) => /portal_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0];
  const password = ['member', 'access', 'test', 'phrase', 'long'].join('-');
  try {
    const admin = cookieOf(await call('POST', '/api/login', { code: SERVER_CODE }))!;
    const made = await call('POST', '/api/admin/users', { email: 'person@konfersi.example', password, role: 'member' }, admin);
    assert.equal(made.status, 201, await made.clone().text());
    const id = ((await made.json()) as { data: { id: string } }).data.id;
    const member = cookieOf(await call('POST', '/api/login', { email: 'person@konfersi.example', password }))!;
    assert.ok(member);
    const session = ((await (await call('GET', '/api/session', undefined, member)).json()) as { data: { authenticated: boolean; member: boolean } }).data;
    assert.deepEqual([session.authenticated, session.member], [true, true], 'the web shows the member’s app');
    for (const path of ['/api/admin/state', '/api/admin/users', '/api/settings', '/api/admin/manager', '/api/claude-usage', '/api/connect/targets/x', '/api/pools']) {
      const res = await call('GET', path, undefined, member);
      assert.equal(res.status, 404, `${path}: ${res.status}`);
      assert.doesNotMatch(await res.text(), new RegExp(SERVER_CODE), `${path}: never the server code`);
    }
    assert.equal((await call('POST', '/api/chat/reauth', { code: SERVER_CODE }, member)).status, 404, 'Bypass re-auth is the platform’s');
    assert.equal((await call('POST', '/api/portal-mcp/tokens', { label: 'x', scope: 'admin' }, member)).status, 404, 'no Portal MCP token minting for a member yet');
    // Doors answer the member as itself.
    assert.equal((await call('GET', '/api/orgs', undefined, member)).status, 200);
    assert.deepEqual(((await (await call('GET', '/api/orgs/abilities', undefined, member)).json()) as { data: unknown }).data !== undefined, true);
    // The admin is unchanged.
    assert.equal((await call('GET', '/api/admin/state', undefined, admin)).status, 200);
    // The role is read on every request: a disable ends the member's session at once.
    assert.equal((await call('PATCH', `/api/admin/users/${id}`, { state: 'disabled' }, admin)).status, 200);
    assert.equal((await call('GET', '/api/orgs', undefined, member)).status, 401);
    assert.equal(portal.personSession(member.split('=')[1]), undefined);
  } finally {
    s.close();
    clearResolvers();
  }
});

