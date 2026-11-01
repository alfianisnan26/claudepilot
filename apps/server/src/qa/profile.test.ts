// The account area and the Profile over HTTP (owner request 2026-11-01: "refine user information as well, and profile"): what GET /api/me
// answers for a server-code session (the founder, how it signed in) and for an account (its profile, how this browser signed in); a person
// changes only their OWN name, handle and picture; the device list shows only the account's own sign-ins and ends one of them, never
// another account's.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MyWebSession, SignedInAs } from '@portal/contracts';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { Portal } from '../portal.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const CODE = '13572468';
const PASSWORD = ['profile', 'over', 'http', 'pass', 'phrase'].join('-');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function build() {
  process.env.PORTAL_PASSWORD_COST ??= 'test';
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-profile-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const portal = new Portal(CODE, 60_000);
  const app = make(portal, stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
  const call = (method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) =>
    app.request(
      `http://localhost:3000${path}`,
      {
        method,
        headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
        body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
  const cookieOf = (r: Response) => /portal_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0];
  const data = async <T>(r: Response): Promise<T> => ((await r.json()) as { data: T }).data;
  return { call, cookieOf, data, portal, store, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('GET /api/me: a server-code session names the founder and says it is the server code; an account gets its profile and how it signed in', async () => {
  const { call, cookieOf, data, store, done } = await build();
  try {
    const code = cookieOf(await call('POST', '/api/login', { code: CODE }, undefined, { 'user-agent': MAC }))!;
    let me = await data<SignedInAs>(await call('GET', '/api/me', undefined, code));
    assert.deepEqual(me, { kind: 'code', founder: null, session: { method: 'code', provider: null } }, 'no founder account yet');

    const made = await data<{ id: string }>(await call('POST', '/api/admin/users', { email: 'Alfian@Example.com', displayName: 'Alfian', password: PASSWORD, role: 'admin' }, code));
    store.db!.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(made.id);
    me = await data<SignedInAs>(await call('GET', '/api/me', undefined, code));
    assert.equal(me.kind, 'code');
    assert.deepEqual(me.kind === 'code' && me.founder, { displayName: 'Alfian', email: 'alfian@example.com', username: null, avatar: null });

    const acct = cookieOf(await call('POST', '/api/login', { email: 'alfian@example.com', password: PASSWORD }, undefined, { 'user-agent': IPHONE }))!;
    me = await data<SignedInAs>(await call('GET', '/api/me', undefined, acct));
    assert.equal(me.kind, 'account');
    if (me.kind !== 'account') return;
    assert.equal(me.user.email, 'alfian@example.com', 'the old shape is still there');
    assert.deepEqual(me.session, { method: 'password', provider: null });
    assert.deepEqual(
      [me.profile?.displayName, me.profile?.role, me.profile?.founder, me.profile?.passwordSet, me.profile?.signIns, me.profile?.avatar],
      ['Alfian', 'admin', true, true, [], null],
    );
    assert.doesNotMatch(JSON.stringify(me), /scrypt|password_hash|token/i, 'no hash or token in the answer');

    // The server code has no profile of its own: the profile writes refuse it.
    assert.equal((await call('PATCH', '/api/me', { displayName: 'X' }, code)).status, 400);
    assert.equal((await call('GET', '/api/me/devices', undefined, code)).status, 400);
    // Signed out: 401 everywhere.
    for (const [m, p] of [['GET', '/api/me'], ['PATCH', '/api/me'], ['GET', '/api/me/devices'], ['DELETE', '/api/me/avatar'], ['GET', `/api/users/avatars/${'a'.repeat(64)}`]] as const)
      assert.equal((await call(m, p, m === 'PATCH' ? {} : undefined)).status, 401, `${m} ${p}`);
  } finally {
    done();
  }
});

test('a member edits only their own profile; the picture is theirs; the device list is theirs and ending another account’s sign-in is a 404', async () => {
  const { call, cookieOf, data, portal, done } = await build();
  try {
    const code = cookieOf(await call('POST', '/api/login', { code: CODE }))!;
    const admin = await data<{ id: string }>(await call('POST', '/api/admin/users', { email: 'admin@example.com', displayName: 'Admin Person', password: PASSWORD, role: 'admin' }, code));
    const member = await data<{ id: string }>(await call('POST', '/api/admin/users', { email: 'member@example.com', password: PASSWORD, role: 'member' }, code));
    const adminCookie = cookieOf(await call('POST', '/api/login', { email: 'admin@example.com', password: PASSWORD }, undefined, { 'user-agent': MAC }))!;
    const m1 = cookieOf(await call('POST', '/api/login', { email: 'member@example.com', password: PASSWORD }, undefined, { 'user-agent': IPHONE }))!;
    const m2 = cookieOf(await call('POST', '/api/login', { email: 'member@example.com', password: PASSWORD }, undefined, { 'user-agent': MAC }))!;

    // PATCH /api/me changes the caller's own row; an id in the body is ignored.
    const res = await call('PATCH', '/api/me', { displayName: 'Mia', username: 'mia', id: admin.id, userId: admin.id, role: 'admin' }, m1);
    assert.equal(res.status, 200, await res.clone().text());
    const me = await data<SignedInAs>(res);
    assert.ok(me.kind === 'account' && me.profile?.displayName === 'Mia' && me.profile.username === 'mia' && me.profile.role === 'member', 'its own name; the role is not the person’s to change');
    const adminMe = await data<SignedInAs>(await call('GET', '/api/me', undefined, adminCookie));
    assert.ok(adminMe.kind === 'account' && adminMe.profile?.displayName === 'Admin Person', 'the admin’s row is untouched');
    assert.equal((await call('PATCH', `/api/admin/users/${admin.id}`, { displayName: 'Hacked' }, m1)).status, 404, 'another account through the admin route: the same 404');
    assert.equal((await call('PATCH', '/api/me', { username: 'admin' }, m1)).status, 409, 'a reserved username');

    // The picture: an upload is re-encoded and served to a signed-in session by its hash.
    const pic = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 0, g: 128, b: 255 } } }).jpeg().toBuffer());
    const up = await call('POST', '/api/me/avatar', pic, m1, { 'content-type': 'image/jpeg' });
    assert.equal(up.status, 200, await up.clone().text());
    const { avatar } = await data<{ avatar: string }>(up);
    const img = await call('GET', avatar, undefined, adminCookie);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png', 'what is served is the portal’s PNG, not the upload');
    assert.equal((await call('POST', '/api/me/avatar', new TextEncoder().encode('<svg/>'), m1, { 'content-type': 'image/svg+xml' })).status, 400);
    assert.equal((await call('DELETE', '/api/me/avatar', undefined, m1)).status, 200);
    assert.equal((await call('GET', avatar, undefined, adminCookie)).status, 404, 'removed and swept');

    // The device list: the member's two browsers, this one marked, labels from the User-Agent.
    const list = await data<MyWebSession[]>(await call('GET', '/api/me/devices', undefined, m1));
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((s) => [s.device, s.current, s.method]).sort(), [['Chrome on Mac', false, 'password'], ['Safari on iPhone', true, 'password']]);
    assert.ok(list.every((s) => /^[0-9a-f]{16}$/.test(s.id)), 'a short handle, never the token');
    // Ending another account's sign-in by its handle: the same 404 as a handle that does not exist; the admin stays signed in.
    const adminHandle = portal.sessionsOf(admin.id)[0]!.id;
    assert.equal((await call('DELETE', `/api/me/devices/${adminHandle}`, undefined, m1)).status, 404);
    assert.equal((await call('GET', '/api/me', undefined, adminCookie)).status, 200, 'the admin is still signed in');
    // The current one is not ended here (sign out does that); the other one is.
    const current = list.find((s) => s.current)!;
    assert.equal((await call('DELETE', `/api/me/devices/${current.id}`, undefined, m1)).status, 404);
    const other = list.find((s) => !s.current)!;
    assert.equal((await call('DELETE', `/api/me/devices/${other.id}`, undefined, m1)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, m2)).status, 401, 'that browser is signed out');
    assert.equal((await call('GET', '/api/me', undefined, m1)).status, 200, 'this one stays');
    assert.ok(member.id);
  } finally {
    done();
  }
});
