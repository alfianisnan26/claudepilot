// T-1043 (D-82): the one session-token reader and sign-in (sessionToken.ts) that the HTTP route guard (app.ts) and every socket use.
//   - `signedInFor` is the guard's real `signedIn`: only a full session (the server code, an admin account) is the founding owner; a member
//     account is a member (QA c691df71 M14: a guard that took any session for the owner failed no test, the session guard's 404 hid it).
//   - `sessionTokenFrom` / `sessionTokenOf` are thin callers of THE one reader, sessionCookie.ts (T-976: `__Host-portal_session` wins, the
//     old name only when it is absent), and `signedInOf` (sockets.ts) answers for a handshake exactly what the HTTP guard answers.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { Portal } from './portal.js';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, sessionFromCookies, sessionOfRequest } from './sessionCookie.js';
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

const HOST = SESSION_COOKIE;
const OLD = LEGACY_SESSION_COOKIE;

test('one reader: sessionTokenFrom and sessionTokenOf are sessionCookie.ts’s read rule, for a request and a handshake alike (T-976)', () => {
  assert.equal(HOST, ['__Host', 'portal_session'].join('-'), 'the reader’s new name');
  assert.equal(OLD, 'portal_session');
  const value = ['tok', 'en', 'Value'].join('_');
  const other = ['plant', 'ed', 'Value'].join('_');
  const headers = [
    `${HOST}=${value}`,
    `${OLD}=${value}`,
    `a=1; ${HOST}=${value}; b=2`,
    `x${HOST}=${other}; ${OLD}=${value}`,
    `${HOST}=${encodeURIComponent(`${value}/+=`)}`,
    `${OLD}=${other}; ${HOST}=${value}`,
    `${HOST}=${value}; ${OLD}=${other}`,
    `${HOST}=${value}; ${HOST}=${other}`,
    `x${OLD}=${value}`,
    `${HOST}=%E0%A4%A`,
    '',
  ];
  for (const header of headers) {
    const shared = sessionFromCookies(header).token || undefined;
    assert.equal(sessionTokenFrom(header), shared, `${header}: the request side is the shared reader`);
    assert.equal(sessionTokenOf(handshake(header)), shared, `${header}: the handshake side is the shared reader`);
    assert.equal(sessionOfRequest(handshake(header)) || undefined, shared);
  }
  // Both names resolve; the `__Host-` one wins whenever it is there, in either order; the old name only when it is absent.
  assert.equal(sessionTokenFrom(`${HOST}=${value}`), value, 'the new name resolves');
  assert.equal(sessionTokenFrom(`${OLD}=${value}`), value, 'the old name resolves when the new one is absent');
  assert.equal(sessionTokenFrom(`${OLD}=${other}; ${HOST}=${value}`), value, 'a planted old cookie first never overrides the real session');
  assert.equal(sessionTokenFrom(`${HOST}=${value}; ${OLD}=${other}`), value);
  assert.equal(sessionTokenOf(handshake(`${OLD}=${other}; ${HOST}=${value}`)), value, 'a handshake: the same winner');
  assert.equal(sessionTokenFrom(`x${OLD}=${value}`), undefined, 'a longer name is another cookie');
  assert.equal(sessionTokenFrom(`${OLD}=`), undefined, 'an empty cookie is no token');
  assert.equal(sessionTokenFrom(undefined), undefined);
  assert.equal(sessionTokenFrom(null), undefined);
  assert.equal(sessionTokenOf(handshake()), undefined);
});

test('sockets: signedInOf and fullSessionOf resolve both cookie names through the shared reader and answer what the HTTP guard answers', () => {
  const { p, code } = portal();
  const owner = p.signIn(code);
  const member = p.openSession(MEMBER);
  const as = (token: string, name = HOST) => handshake(`theme=dark; ${name}=${encodeURIComponent(token)}`);
  for (const name of [HOST, OLD]) {
    assert.deepEqual(signedInOf(p)(as(owner, name)), { full: true }, `${name}: the owner`);
    assert.deepEqual(signedInOf(p)(as(member, name)), { full: false, userId: MEMBER }, `${name}: a member`);
    assert.equal(fullSessionOf(p)(as(owner, name)), true);
    assert.equal(fullSessionOf(p)(as(member, name)), false, 'a member is not a full session for a module’s own check');
  }
  // A member's real `__Host-` session with the owner's token planted under the old name: the member it is, never the owner.
  const both = handshake(`${OLD}=${encodeURIComponent(owner)}; ${HOST}=${encodeURIComponent(member)}`);
  assert.deepEqual(signedInOf(p)(both), { full: false, userId: MEMBER }, 'the `__Host-` cookie wins on a socket');
  assert.equal(fullSessionOf(p)(both), false);
  for (const token of [owner, member]) assert.deepEqual(signedInOf(p)(as(token)), signedInFor(p, sessionTokenFrom(`${HOST}=${encodeURIComponent(token)}`)));
});
