// T-1043 (D-82): the one session-token reader and sign-in (sessionToken.ts) that the HTTP route guard (app.ts) and every socket use.
//   - `signedInFor` is the guard's real `signedIn`: only a full session (the server code, an admin account) is the founding owner; a member
//     account is a member (QA c691df71 M14: a guard that took any session for the owner failed no test, the session guard's 404 hid it).
//   - `sessionTokenFrom` / `sessionTokenOf` read the cookie the same way for a request and a handshake, whatever it is called (T-976:
//     `__Host-portal_session`), and `signedInOf` (sockets.ts) answers for a handshake exactly what the HTTP guard answers for the request.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { Portal } from './portal.js';
import { sessionTokenFrom, sessionTokenOf, signedInFor } from './sessionToken.js';
import { fullSessionOf, signedInOf } from './sockets.js';

const MEMBER = 'u_member1';
const ADMIN = 'u_admin01';
const GONE = 'u_gone001';

function portal() {
  const code = ['1357', '2468'].join('');
  const p = new Portal(code, 60_000);
  p.roleOf = (id) => (id === MEMBER ? 'member' : id === ADMIN ? 'admin' : null);
  return { p, code };
}

test('signedInFor: the server code and an admin account are full (the owner), a member is a member, anything else is nobody', () => {
  const { p, code } = portal();
  assert.deepEqual(signedInFor(p, p.signIn(code)), { full: true }, 'the server code');
  assert.deepEqual(signedInFor(p, p.openSession(ADMIN)), { full: true }, 'an admin account');
  assert.deepEqual(signedInFor(p, p.openSession(MEMBER)), { full: false, userId: MEMBER }, 'a member is never the founding owner');
  assert.equal(signedInFor(p, p.openSession(GONE)), null, 'an account that is gone signs in nobody');
  assert.equal(signedInFor(p, 'not-a-session'), null);
  assert.equal(signedInFor(p, undefined), null);
  assert.equal(signedInFor(p, ''), null);
});

test('signedInFor: a member stays a member after the owner signs in, and an admin made a member is a member at once', () => {
  const { p, code } = portal();
  const member = p.openSession(MEMBER);
  p.signIn(code);
  assert.deepEqual(signedInFor(p, member), { full: false, userId: MEMBER });
  let role: 'admin' | 'member' = 'admin';
  p.roleOf = (id) => (id === ADMIN ? role : null);
  const admin = p.openSession(ADMIN);
  assert.deepEqual(signedInFor(p, admin), { full: true });
  role = 'member';
  assert.deepEqual(signedInFor(p, admin), { full: false, userId: ADMIN });
});

/** A handshake with this `Cookie` header. */
const handshake = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as IncomingMessage;

/** What Hono's `getCookie` (the HTTP side before this module) reads from the same header. */
async function honoReads(header: string, name: string): Promise<string | undefined> {
  const app = new Hono();
  app.get('/', (c) => c.json({ v: getCookie(c, name) ?? null }));
  const v = ((await (await app.request('/', { headers: { cookie: header } })).json()) as { v: string | null }).v;
  return v ?? undefined;
}

test('one reader: a request and a handshake read the same token under any cookie name, `__Host-` included (T-976)', async () => {
  const value = ['tok', 'en', 'Value'].join('_');
  for (const name of ['portal_session', ['__Host', 'portal_session'].join('-'), ['__Secure', 'portal_session'].join('-')]) {
    for (const header of [`${name}=${value}`, `a=1; ${name}=${value}; b=2`, `x${name}=other; ${name}=${value}`, `${name}=${encodeURIComponent(`${value}/+=`)}`]) {
      const read = sessionTokenFrom(header, name);
      assert.ok(read?.startsWith(value), `${name} in ${header}`);
      assert.equal(read, await honoReads(header, name), `${header}: what Hono's getCookie reads`);
      assert.equal(sessionTokenOf(handshake(header), name), read, `${header}: a handshake reads the same`);
    }
    assert.equal(sessionTokenFrom(`x${name}=${value}`, name), undefined, 'a longer name is another cookie');
    assert.equal(sessionTokenFrom(`${name}=`, name), undefined, 'an empty cookie is no token');
  }
  assert.equal(sessionTokenFrom(undefined, 'portal_session'), undefined);
  assert.equal(sessionTokenOf(handshake(), 'portal_session'), undefined);
  // Under the `__Host-` name, the plain one is not the session (and the other way round).
  const host = ['__Host', 'portal_session'].join('-');
  assert.equal(sessionTokenFrom(`portal_session=${value}`, host), undefined);
  assert.equal(sessionTokenFrom(`${host}=${value}`, 'portal_session'), undefined);
});

test('sockets: signedInOf and fullSessionOf read a `__Host-` cookie and answer what the HTTP guard answers', () => {
  const { p, code } = portal();
  const host = ['__Host', 'portal_session'].join('-');
  const owner = p.signIn(code);
  const member = p.openSession(MEMBER);
  const as = (token: string, name = host) => handshake(`theme=dark; ${name}=${encodeURIComponent(token)}`);
  assert.deepEqual(signedInOf(p, host)(as(owner)), { full: true });
  assert.deepEqual(signedInOf(p, host)(as(member)), { full: false, userId: MEMBER });
  assert.equal(signedInOf(p, host)(as(owner, 'portal_session')), null, 'the old name is not read once the cookie is renamed');
  assert.equal(fullSessionOf(p, host)(as(owner)), true);
  assert.equal(fullSessionOf(p, host)(as(member)), false, 'a member is not a full session for a module’s own check');
  assert.equal(fullSessionOf(p, host)(as(owner, 'portal_session')), false);
  for (const token of [owner, member]) assert.deepEqual(signedInOf(p, host)(as(token)), signedInFor(p, sessionTokenFrom(`${host}=${encodeURIComponent(token)}`, host)));
});
