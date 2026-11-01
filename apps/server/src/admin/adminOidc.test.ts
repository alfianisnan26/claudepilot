// Admin console sign-in through an OIDC provider (owner, 2026-11-01: git.isnan.me, the owner only; docs/prd/organizations.md §6.11, §13.4).
// Against the fake provider (real keys, genuinely signed ID tokens) and a fake clock that starts from now: an allowed email gets the same
// admin session as the password path, fresh for step-up; an email not on the allow list, an allowed email with no admin account or a
// member's, and every verification failure (state, nonce, audience, expiry, issuer, unverified email) are refused with the same answer
// and an admin.signin_refused row (subject and email, never a token) the Audit filter finds; the routes are 404 with OIDC off and on the
// main host; the step-up dialog's re-auth marks the session that asked, only.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { ADMIN_COOKIE, type AdminMe } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { useAccountRoles, type AccountRoleOf } from '../authz/seam.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from '../identity/fakeIdp.js';
import { PasswordHasher, TEST_PARAMS } from '../identity/passwords.js';
import { PortalUsers } from '../identity/users.js';
import { createOrgs, type OrgsService, type UserAbilities } from '../orgs/index.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { ADMIN_OIDC_COOKIE, AdminHostGate, adminHostMiddleware, adminOidcConfig, createAdminApp, type AdminOidcConfig } from './index.js';

const ADMIN_HOST = 'admin.example.test';
const MAIN_HOST = 'pilot.example.test';
const CALLBACK = `https://${ADMIN_HOST}/admin-api/session/oidc/callback`;
// Built at run time: no credential-shaped literal in the source.
const PASSWORD = ['copper', 'harbor', 'violet', 'summit', String(Date.now() % 89)].join('-');
const CLIENT_SECRET = ['fake', 'client', 'secret', String(Date.now() % 83)].join('-');

let store: Store;
let users: PortalUsers;
let orgs: OrgsService;
let abilities: UserAbilities;
let restoreRoles: AccountRoleOf;
let adminId: string;
let memberId: string;
let opsId: string;
let clock: number;

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-admin-oidc-'), secretKey: null });
  users = new PortalUsers(() => store.db, new PasswordHasher(TEST_PARAMS));
  adminId = (await users.create({ email: 'root@example.test', password: PASSWORD, role: 'admin' }, 'ui')).id;
  memberId = (await users.create({ email: 'mia@example.test', password: PASSWORD, role: 'member' }, 'ui')).id;
  opsId = (await users.create({ email: 'ops@example.test', password: PASSWORD, role: 'admin' }, 'ui')).id;
  restoreRoles = useAccountRoles((id) => users.roleOf(id));
  ({ orgs, abilities } = createOrgs({ store }));
});

after(() => {
  useAccountRoles(restoreRoles);
  store.close();
});

beforeEach(() => {
  clock = Date.now();
});

afterEach(async () => {
  store.db!.exec('DELETE FROM admin_sessions; DELETE FROM auth_throttle; DELETE FROM platform_audit;');
  for (const id of [adminId, memberId, opsId]) await users.update(id, { state: 'active' });
});

const config = (o: Partial<AdminOidcConfig> = {}): AdminOidcConfig => ({
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  allow: ['root@example.test', 'mia@example.test', 'nobody@example.test', 'ops@example.test'],
  allowPrivate: false,
  name: new URL(ISSUER).host,
  ...o,
});

type Res = { status: number; json: { data?: unknown; error?: { code: string } } | null; location: string; cookies: Record<string, string>; setCookies: string[] };

function portal(o: { oidc?: AdminOidcConfig | null } = {}) {
  const idp = fakeIdp(() => clock);
  const gate = new AdminHostGate(ADMIN_HOST, false);
  const { app: consoleApp } = createAdminApp({
    store,
    gate,
    users,
    revokePortalSessions: () => {},
    orgs,
    abilities,
    sso: { list: () => [] },
    ssoRedirectUri: '',
    clientKey: () => '10.9.8.7',
    now: () => clock,
    oidc: o.oidc === null ? null : { config: o.oidc ?? config(), client: idp.client },
  });
  const main = new Hono();
  main.use(adminHostMiddleware(gate, () => consoleApp));
  main.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR');
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  main.all('/api/*', () => {
    throw new AppError('NOT_FOUND');
  });

  const call = async (method: string, path: string, opt: { host?: string; cookies?: string[]; body?: unknown } = {}): Promise<Res> => {
    const host = opt.host ?? ADMIN_HOST;
    const headers: Record<string, string> = { host };
    const jar = (opt.cookies ?? []).filter(Boolean);
    if (jar.length) headers.cookie = jar.join('; ');
    if (method !== 'GET') headers.origin = `https://${host}`;
    if (opt.body !== undefined) headers['content-type'] = 'application/json';
    const res = await main.request(`http://${host}${path}`, { method, headers, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
    const text = await res.text();
    let json: Res['json'] = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const setCookies = res.headers.getSetCookie();
    const cookies: Record<string, string> = {};
    for (const c of setCookies) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) cookies[m[1]!] = m[2]!;
    }
    return { status: res.status, json, location: res.headers.get('location') ?? '', cookies, setCookies };
  };

  /** Starts at the console, "signs in" at the provider with these claims, and returns the console's answer to the callback. */
  const flow = async (claims: Record<string, unknown>, opt: { start?: string; cookies?: string[]; tamper?: (q: URLSearchParams, stateCookie: string) => string } = {}) => {
    const start = await call('GET', opt.start ?? '/admin-api/session/oidc/start', { cookies: opt.cookies });
    assert.equal(start.status, 302, `start answered ${start.status} ${JSON.stringify(start.json)}`);
    const at = authorizeParams(start.location);
    const stateCookie = start.cookies[ADMIN_OIDC_COOKIE] ?? '';
    idp.next = { nonce: at.nonce, ...claims };
    const q = new URLSearchParams({ code: `code-${clock}`, state: at.state! });
    const cookieValue = opt.tamper ? opt.tamper(q, stateCookie) : stateCookie;
    const cb = await call('GET', `/admin-api/session/oidc/callback?${q}`, { cookies: [cookieValue ? `${ADMIN_OIDC_COOKIE}=${cookieValue}` : '', ...(opt.cookies ?? [])] });
    return { start, at, stateCookie, cb, adminCookie: cb.cookies[ADMIN_COOKIE] ? `${ADMIN_COOKIE}=${cb.cookies[ADMIN_COOKIE]}` : '' };
  };

  const passwordSignIn = async () => {
    const r = await call('POST', '/admin-api/session', { body: { email: 'root@example.test', password: PASSWORD } });
    return `${ADMIN_COOKIE}=${r.cookies[ADMIN_COOKIE]}`;
  };
  return { call, flow, idp, passwordSignIn };
}

const rows = (kind: string) =>
  (store.db!.prepare('SELECT kind, severity, actor, user_id, subject, detail FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as {
    kind: string;
    severity: string;
    actor: string;
    user_id: string | null;
    subject: string | null;
    detail: string;
  }[]).map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
const REFUSED = '/admin-ui/?oidc=refused';
const MIN = 60_000;

test('an allowed, verified email signs in: the same admin session as the password path, fresh for step-up for 5 minutes', async () => {
  const p = portal();
  const methods = await p.call('GET', '/admin-api/session/methods');
  assert.deepEqual(methods.json?.data, { password: true, oidc: { name: 'idp.example.com' } });
  const { start, at, cb, adminCookie } = await p.flow({ sub: 'gitea-1', email: 'Root@Example.test' });
  // The start: the provider's authorize URL with PKCE S256, state, nonce and the admin host's redirect URI; a host-only state cookie.
  assert.ok(start.location.startsWith(`${ISSUER}/authorize?`));
  assert.equal(at.redirect_uri, CALLBACK);
  assert.equal(at.client_id, CLIENT_ID);
  assert.equal(at.code_challenge_method, 'S256');
  assert.ok(at.state && at.nonce && at.code_challenge);
  const sc = start.setCookies.find((c) => c.startsWith(`${ADMIN_OIDC_COOKIE}=`))!;
  for (const attr of [/;\s*Secure/i, /;\s*HttpOnly/i, /;\s*SameSite=Lax/i, /;\s*Path=\//i, /;\s*Max-Age=600/i]) assert.match(sc, attr);
  assert.doesNotMatch(sc, /Domain=/i);
  // The callback: the admin cookie as the password path sets it, the state cookie cleared, back to the console.
  assert.equal(cb.status, 302);
  assert.equal(cb.location, '/admin-ui/');
  const set = cb.setCookies.find((c) => c.startsWith(`${ADMIN_COOKIE}=`))!;
  for (const attr of [/;\s*Secure/i, /;\s*HttpOnly/i, /;\s*SameSite=Strict/i, /;\s*Path=\//i, /;\s*Max-Age=7200/i]) assert.match(set, attr);
  assert.match(cb.setCookies.find((c) => c.startsWith(`${ADMIN_OIDC_COOKIE}=`)) ?? '', /Max-Age=0/i);
  const me = await p.call('GET', '/admin-api/session', { cookies: [adminCookie] });
  assert.equal(me.status, 200);
  const data = me.json?.data as AdminMe;
  assert.equal(data.userId, adminId);
  assert.equal(new Date(data.expiresAt).getTime(), clock + 2 * 60 * MIN);
  assert.equal(new Date(data.freshUntil!).getTime(), clock + 5 * MIN, 'the provider sign-in counts as fresh auth');
  // A step-up route works now without the password, and not after the 5 minutes.
  assert.equal((await p.call('POST', `/admin-api/users/${memberId}/sessions/end`, { cookies: [adminCookie] })).status, 200);
  clock += 6 * MIN;
  const late = await p.call('POST', `/admin-api/users/${memberId}/sessions/end`, { cookies: [adminCookie] });
  assert.equal(late.status, 403);
  assert.equal(late.json?.error?.code, 'REAUTH_REQUIRED');
  // Idle 15 minutes ends it, like any admin session.
  clock += 16 * MIN;
  assert.equal((await p.call('GET', '/admin-api/session', { cookies: [adminCookie] })).status, 401);
  const signin = rows('admin.signin');
  assert.equal(signin.length, 1);
  assert.equal(signin[0]!.detail.method, 'oidc');
  assert.equal(signin[0]!.detail.issuer, ISSUER);
  assert.equal(rows('admin.signin_refused').length, 0);
});

test('preferred_username is the fallback match; the account is still found by the verified email', async () => {
  const p = portal({ oidc: config({ allow: ['rooty'] }) });
  const ok = await p.flow({ sub: 'gitea-1', email: 'root@example.test', preferred_username: 'Rooty' });
  assert.equal(ok.cb.location, '/admin-ui/');
  assert.ok(ok.adminCookie);
  // A username match with no email: nothing names an account.
  const none = await p.flow({ sub: 'gitea-1', email: undefined, email_verified: undefined, preferred_username: 'rooty' });
  assert.equal(none.cb.location, REFUSED);
  assert.equal(rows('admin.signin_refused').at(-1)!.detail.reason, 'no_admin_account');
});

test('an email not on the allow list is refused with the neutral answer and an audit row the Audit filter finds (subject and email, no token)', async () => {
  const p = portal();
  const r = await p.flow({ sub: 'gitea-77', email: 'eve@example.test' });
  assert.equal(r.cb.status, 302);
  assert.equal(r.cb.location, REFUSED);
  assert.equal(r.adminCookie, '', 'no session');
  const [row] = rows('admin.signin_refused');
  assert.ok(row);
  assert.equal(row.severity, 'medium');
  assert.equal(row.actor, 'anonymous');
  assert.equal(row.user_id, null);
  assert.deepEqual(
    { method: row.detail.method, reason: row.detail.reason, issuer: row.detail.issuer, subject: row.detail.subject, email: row.detail.email, purpose: row.detail.purpose },
    { method: 'oidc', reason: 'not_allowed', issuer: ISSUER, subject: 'gitea-77', email: 'eve@example.test', purpose: 'sign-in' },
  );
  const raw = JSON.stringify(row.detail);
  assert.doesNotMatch(raw, /code-|eyJ|id_token|access|secret/i, 'no code, token or secret in the row');
  assert.ok(!raw.includes(CLIENT_SECRET));
  // The owner reads it in the console's Audit, by its kind and by the `admin` prefix.
  const owner = await p.passwordSignIn();
  for (const q of ['kind=admin.signin_refused', 'kind=admin&severity=medium']) {
    const list = (await p.call('GET', `/admin-api/audit?${q}`, { cookies: [owner] })).json?.data as { kind: string; detail: Record<string, unknown> }[];
    const hit = list.find((x) => x.kind === 'admin.signin_refused');
    assert.ok(hit, q);
    assert.equal(hit.detail.email, 'eve@example.test');
  }
  const exact = (await p.call('GET', '/admin-api/audit?kind=admin.signin_refused', { cookies: [owner] })).json?.data as { kind: string }[];
  assert.ok(exact.every((x) => x.kind === 'admin.signin_refused'));
});

test('an allowed email with no account, a member account or a disabled admin is refused the same way', async () => {
  const p = portal();
  const answers: string[] = [];
  for (const email of ['nobody@example.test', 'mia@example.test']) {
    const r = await p.flow({ sub: `s-${email}`, email });
    answers.push(r.cb.location);
    assert.equal(r.adminCookie, '');
  }
  await users.update(opsId, { state: 'disabled' });
  const off = await p.flow({ sub: 's-ops', email: 'ops@example.test' });
  answers.push(off.cb.location);
  assert.equal(off.adminCookie, '');
  assert.deepEqual(answers, [REFUSED, REFUSED, REFUSED]);
  assert.deepEqual(
    rows('admin.signin_refused').map((r) => [r.detail.email, r.detail.reason]),
    [
      ['nobody@example.test', 'no_admin_account'],
      ['mia@example.test', 'no_admin_account'],
      ['ops@example.test', 'no_admin_account'],
    ],
  );
  assert.equal(rows('admin.signin').length, 0);
});

test('verification failures are refused: bad state, tampered or missing cookie, expired state, nonce, audience, expiry, issuer, unverified email', async () => {
  const p = portal();
  const good = { sub: 'gitea-1', email: 'root@example.test' };
  const cases: [string, Parameters<typeof p.flow>[0], Parameters<typeof p.flow>[1], string][] = [
    ['bad state', good, { tamper: (q, c) => (q.set('state', 'not-the-state'), c) }, 'state'],
    ['no state cookie', good, { tamper: () => '' }, 'state'],
    ['tampered cookie', good, { tamper: (_q, c) => `${c.split('.')[0]}x.${c.split('.')[1]}` }, 'state'],
    ['provider error', good, { tamper: (q, c) => (q.delete('code'), q.set('error', 'access_denied'), c) }, 'provider'],
    ['wrong nonce', { ...good, nonce: 'another-nonce' }, {}, 'token'],
    ['wrong audience', { ...good, aud: 'another-client' }, {}, 'token'],
    ['expired token', { ...good, exp: Math.floor(clock / 1000) - 3600, iat: Math.floor(clock / 1000) - 7200 }, {}, 'token'],
    ['wrong issuer', { ...good, iss: 'https://evil.example.com' }, {}, 'token'],
    ['unverified email', { ...good, email_verified: false }, {}, 'email_unverified'],
  ];
  for (const [name, claims, opt, reason] of cases) {
    const before = rows('admin.signin_refused').length;
    const r = await p.flow(claims, opt);
    assert.equal(r.cb.status, 302, name);
    assert.equal(r.cb.location, REFUSED, name);
    assert.equal(r.adminCookie, '', `${name}: no session`);
    const added = rows('admin.signin_refused');
    assert.equal(added.length, before + 1, `${name}: one audit row`);
    assert.equal(added.at(-1)!.detail.reason, reason, name);
  }
  // A state older than 10 minutes is refused (the fake clock moves between the start and the return).
  const start = await p.call('GET', '/admin-api/session/oidc/start');
  const at = authorizeParams(start.location);
  p.idp.next = { ...good, nonce: at.nonce };
  clock += 11 * MIN;
  const late = await p.call('GET', `/admin-api/session/oidc/callback?code=c&state=${at.state}`, { cookies: [`${ADMIN_OIDC_COOKIE}=${start.cookies[ADMIN_OIDC_COOKIE]}`] });
  assert.equal(late.location, REFUSED);
  assert.equal(rows('admin.signin_refused').at(-1)!.detail.reason, 'state');
  // A state is good once: replaying the same callback (the cookie is cleared by the first) is refused.
  clock = Date.now();
  const once = await p.flow(good);
  assert.ok(once.adminCookie);
  const replay = await p.call('GET', `/admin-api/session/oidc/callback?code=c&state=${once.at.state}`);
  assert.equal(replay.location, REFUSED);
  assert.equal(rows('admin.signin').length, 1);
});

test('OIDC is off when the env is missing: no button, its routes are 404; the password sign-in is unchanged', async () => {
  assert.equal(adminOidcConfig({}), null);
  assert.equal(adminOidcConfig({ issuer: 'https://git.example.test', clientId: 'c', allow: 'a@example.test' }), null, 'no secret');
  assert.equal(adminOidcConfig({ issuer: 'https://git.example.test', clientId: 'c', clientSecret: CLIENT_SECRET }), null, 'no allow list');
  assert.equal(adminOidcConfig({ issuer: 'http://git.example.test', clientId: 'c', clientSecret: CLIENT_SECRET, allow: 'a@example.test' }), null, 'not https');
  const on = adminOidcConfig({ issuer: 'https://git.example.test/', clientId: ' c ', clientSecret: CLIENT_SECRET, allow: ' A@Example.test, ,b ' });
  assert.deepEqual(on && { ...on, clientSecret: on.clientSecret === CLIENT_SECRET }, {
    issuer: 'https://git.example.test',
    clientId: 'c',
    clientSecret: true,
    allow: ['a@example.test', 'b'],
    allowPrivate: false,
    name: 'git.example.test',
  });
  assert.equal(adminOidcConfig({ issuer: 'https://git.example.test', clientId: 'c', clientSecret: CLIENT_SECRET, allow: 'a@example.test', allowPrivate: 'true' })?.allowPrivate, true);

  const p = portal({ oidc: null });
  assert.deepEqual((await p.call('GET', '/admin-api/session/methods')).json?.data, { password: true, oidc: null });
  for (const path of ['/admin-api/session/oidc/start', '/admin-api/session/oidc/callback?code=x&state=y']) assert.equal((await p.call('GET', path)).status, 404, path);
  assert.ok((await p.passwordSignIn()).length > ADMIN_COOKIE.length + 1);
  assert.equal(rows('admin.signin_refused').length, 0);
});

test('the OIDC routes are 404 on the main host', async () => {
  const p = portal();
  const unknown = await p.call('GET', '/api/no-such-route', { host: MAIN_HOST });
  for (const path of ['/admin-api/session/methods', '/admin-api/session/oidc/start', '/admin-api/session/oidc/callback?code=x&state=y']) {
    const r = await p.call('GET', path, { host: MAIN_HOST });
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.json, unknown.json);
    assert.equal(r.location, '');
  }
});

test('step-up through the provider: needs the admin session, marks only the session that asked, for the same account', async () => {
  const p = portal();
  // Without a session, a step-up start is refused.
  assert.equal((await p.call('GET', '/admin-api/session/oidc/start?for=step-up')).status, 401);
  const cookie = await p.passwordSignIn();
  const action = () => p.call('POST', `/admin-api/users/${memberId}/sessions/end`, { cookies: [cookie] });
  assert.equal((await action()).json?.error?.code, 'REAUTH_REQUIRED');
  const r = await p.flow({ sub: 'gitea-1', email: 'root@example.test' }, { start: '/admin-api/session/oidc/start?for=step-up&next=users', cookies: [cookie] });
  assert.equal(r.cb.location, '/admin-ui/#users');
  assert.equal(r.adminCookie, '', 'a step-up opens no new session');
  assert.equal((await action()).status, 200, 'fresh now');
  const stepUp = rows('admin.step_up');
  assert.equal(stepUp.length, 1);
  assert.equal(stepUp[0]!.detail.method, 'oidc');
  clock += 6 * MIN;
  assert.equal((await action()).json?.error?.code, 'REAUTH_REQUIRED', 'for 5 minutes');

  // Bound to the session that asked: started by one session, returned with another session's cookie, it marks nothing.
  const other = await p.passwordSignIn();
  const start = await p.call('GET', '/admin-api/session/oidc/start?for=step-up', { cookies: [cookie] });
  const at = authorizeParams(start.location);
  p.idp.next = { sub: 'gitea-1', email: 'root@example.test', nonce: at.nonce };
  const swapped = await p.call('GET', `/admin-api/session/oidc/callback?code=c&state=${at.state}`, {
    cookies: [`${ADMIN_OIDC_COOKIE}=${start.cookies[ADMIN_OIDC_COOKIE]}`, other],
  });
  assert.equal(swapped.location, '/admin-ui/?oidc=refused');
  assert.equal(rows('admin.signin_refused').at(-1)!.detail.reason, 'session');
  assert.equal(rows('admin.signin_refused').at(-1)!.detail.purpose, 'step-up');
  for (const c of [cookie, other]) assert.equal((await p.call('POST', `/admin-api/users/${memberId}/sessions/end`, { cookies: [c] })).json?.error?.code, 'REAUTH_REQUIRED');

  // For the same account: another allowed admin's identity does not step up root's session.
  const viaOps = await p.flow({ sub: 'gitea-2', email: 'ops@example.test' }, { start: '/admin-api/session/oidc/start?for=step-up&next=audit', cookies: [cookie] });
  assert.equal(viaOps.cb.location, '/admin-ui/?oidc=refused#audit');
  assert.equal(rows('admin.signin_refused').at(-1)!.detail.reason, 'session');
  assert.equal((await action()).json?.error?.code, 'REAUTH_REQUIRED');
  assert.equal(rows('admin.step_up').length, 1);
});

test('step-up in a popup (owner, 2026-11-01): the return says stepped or refused with popup=1, so the console resumes the interrupted action', async () => {
  const p = portal();
  const cookie = await p.passwordSignIn();
  const action = () => p.call('POST', `/admin-api/users/${memberId}/sessions/end`, { cookies: [cookie] });
  assert.equal((await action()).json?.error?.code, 'REAUTH_REQUIRED');
  const ok = await p.flow({ sub: 'gitea-1', email: 'root@example.test' }, { start: '/admin-api/session/oidc/start?for=step-up&popup=1&next=users', cookies: [cookie] });
  assert.equal(ok.cb.location, '/admin-ui/?oidc=stepped&popup=1#users');
  assert.equal(ok.adminCookie, '', 'a step-up opens no new session');
  assert.equal((await action()).status, 200, 'fresh now: the console runs the action again without asking');

  // Refused (another admin's identity): the popup hears it too, and nothing is marked.
  clock += 6 * MIN;
  const refused = await p.flow({ sub: 'gitea-2', email: 'ops@example.test' }, { start: '/admin-api/session/oidc/start?for=step-up&popup=1&next=audit', cookies: [cookie] });
  assert.equal(refused.cb.location, '/admin-ui/?oidc=refused&popup=1#audit');
  assert.equal((await action()).json?.error?.code, 'REAUTH_REQUIRED');

  // A sign-in (not a step-up) ignores popup=1: it comes back to the console as before.
  const signIn = await p.flow({ sub: 'gitea-1', email: 'root@example.test' }, { start: '/admin-api/session/oidc/start?popup=1' });
  assert.equal(signIn.cb.location, '/admin-ui/');
});
