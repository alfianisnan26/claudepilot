// T-118 MU1-min over HTTP (owner, 2026-10-17: "multi user feature login by email ... fully tested"): someone signed in with the server code
// creates an email account; that email and password then sign in and get a working session; a wrong password, an unknown email and a
// disabled account get the same 401; the server code still signs in; the account routes are closed to a caller who is not signed in.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
const CODE = '24681357';
const PASSWORD = ['plenty', 'long', 'test', 'pass', 'phrase'].join('-');
const H = { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' };

async function build() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-email-login-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const portal = new Portal(CODE, 60_000);
  const app = make(portal, stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
  const call = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(`http://localhost:3000${path}`, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  const cookieOf = (r: Response) => /portal_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0];
  return { call, cookieOf, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('code sign-in creates an email account; the email signs in; wrong cases are one 401; the code still works', async () => {
  process.env.PORTAL_PASSWORD_COST ??= 'test';
  const { call, cookieOf, done } = await build();
  try {
    assert.equal(((await (await call('GET', '/api/session')).json()) as { data: { emailSignIn: boolean } }).data.emailSignIn, false);
    assert.equal((await call('GET', '/api/admin/users')).status, 401, 'closed to a caller who is not signed in');
    assert.equal((await call('POST', '/api/admin/users', { email: 'x@example.com', password: PASSWORD })).status, 401);

    const byCode = await call('POST', '/api/login', { code: CODE });
    assert.equal(byCode.status, 200, 'the server code still signs in: ' + (await byCode.clone().text()));
    const admin = cookieOf(byCode)!;
    const created = await call('POST', '/api/admin/users', { email: 'Owner@Example.com', displayName: 'Owner', password: PASSWORD }, admin);
    assert.equal(created.status, 201, await created.clone().text());
    const user = ((await created.json()) as { data: { id: string; email: string } }).data;
    assert.equal(user.email, 'owner@example.com');
    assert.equal(((await (await call('GET', '/api/session')).json()) as { data: { emailSignIn: boolean } }).data.emailSignIn, true);

    const byEmail = await call('POST', '/api/login', { email: 'owner@example.com', password: PASSWORD });
    assert.equal(byEmail.status, 200, await byEmail.clone().text());
    const session = cookieOf(byEmail)!;
    assert.ok(session && session !== admin);
    assert.equal((await call('GET', '/api/admin/users', undefined, session)).status, 200, 'the email session is a working session');

    const wrong = await call('POST', '/api/login', { email: 'owner@example.com', password: PASSWORD + '!' });
    const unknown = await call('POST', '/api/login', { email: 'nobody@example.com', password: PASSWORD });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    const msg = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
    assert.equal(await msg(wrong), await msg(unknown), 'the same answer: never says which part was wrong');

    assert.equal((await call('PATCH', `/api/admin/users/${user.id}`, { state: 'disabled' }, admin)).status, 200);
    assert.equal((await call('POST', '/api/login', { email: 'owner@example.com', password: PASSWORD })).status, 401, 'a disabled account cannot sign in');
    assert.equal((await call('DELETE', `/api/admin/users/${user.id}`, undefined, admin)).status, 200);
    assert.equal((await call('POST', '/api/login', { code: CODE })).status, 200, 'the code still works after');
  } finally {
    done();
  }
});
