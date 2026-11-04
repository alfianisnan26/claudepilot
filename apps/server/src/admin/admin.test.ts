// Organizations slice 4 (docs/prd/organizations.md §6.11, §13.2 row 4): the Admin console host. The console's routes are 404 on the main host
// and with `adminHost` unset; on the admin host nothing of the main portal answers; the main portal's cookie and every token are refused; a
// member is refused at sign-in; the session ends 15 minutes idle and 2 hours after sign-in (fake clock, starting from now); step-up is
// required and lasts 5 minutes; every route is declared, and an undeclared one fails. Sockets are refused on the admin host.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { ADMIN_COOKIE, ADMIN_SESSION_LIMITS, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { policyFor, useAccountRoles, type AccountRoleOf } from '../authz/seam.js';
import { PasswordHasher, TEST_PARAMS } from '../identity/passwords.js';
import { PortalUsers } from '../identity/users.js';
import { createOrgs, type OrgsService, type UserAbilities } from '../orgs/index.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { ADMIN_ROUTE_POLICIES, AdminHostGate, adminHostMiddleware, assertDeclared, createAdminApp, routeAdminHostUpgrades } from './index.js';

const ADMIN_HOST = 'admin.example.test';
const MAIN_HOST = 'pilot.example.test';
// Built at run time: no credential-shaped literal in the source.
const PASSWORD = ['amber', 'lantern', 'orbit', 'meadow', String(Date.now() % 97)].join('-');

let store: Store;
let users: PortalUsers;
let orgs: OrgsService;
let abilities: UserAbilities;
let restoreRoles: AccountRoleOf;
let adminId: string;
let otherAdminId: string;
let memberId: string;
let clock: number;
let revoked: string[];

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-admin-'), secretKey: null });
  users = new PortalUsers(() => store.db, new PasswordHasher(TEST_PARAMS));
  adminId = (await users.create({ email: 'root@example.test', password: PASSWORD, role: 'admin' }, 'ui')).id;
  otherAdminId = (await users.create({ email: 'ops@example.test', password: PASSWORD, role: 'admin' }, 'ui')).id;
  memberId = (await users.create({ email: 'mia@example.test', password: PASSWORD, role: 'member' }, 'ui')).id;
  restoreRoles = useAccountRoles((id) => users.roleOf(id));
  ({ orgs, abilities } = createOrgs({ store }));
});

after(() => {
  useAccountRoles(restoreRoles);
  store.close();
});

beforeEach(() => {
  clock = Date.now();
  revoked = [];
});

afterEach(async () => {
  store.db!.exec("DELETE FROM admin_sessions; DELETE FROM auth_throttle; DELETE FROM platform_audit; DELETE FROM user_abilities; UPDATE orgs SET state = 'deleting'; DELETE FROM org_members; DELETE FROM orgs;");
  for (const id of [adminId, otherAdminId, memberId]) await users.update(id, { state: 'active' });
  await users.update(otherAdminId, { role: 'admin' });
});

/** The main app's shape that matters here (app.ts): the gate first, then the portal's routes and its 404 for unknown /api routes. */
function portal(adminHost: string | null) {
  const gate = new AdminHostGate(adminHost, false);
  const consoleApp = gate.enabled
    ? createAdminApp({
        store,
        gate,
        users,
        revokePortalSessions: (id) => revoked.push(id),
        orgs,
        abilities,
        sso: { list: () => [] },
        ssoRedirectUri: '',
        clientKey: () => '10.1.2.3',
        now: () => clock,
      }).app
    : null;
  const main = new Hono();
  main.use(adminHostMiddleware(gate, () => consoleApp));
  main.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR');
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  main.get('/healthz', (c) => c.json({ ok: true }));
  main.get('/api/me', (c) => c.json({ data: 'the main portal' }));
  main.post('/mcp', (c) => c.json({ data: 'portal mcp' }));
  main.all('/api/*', () => {
    throw new AppError('NOT_FOUND');
  });
  main.get('*', (c) => c.html('<p>main shell</p>'));

  const call = async (method: string, path: string, o: { host?: string; cookie?: string; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
    const host = o.host ?? ADMIN_HOST;
    const headers: Record<string, string> = { host, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    const origin = o.origin === undefined ? (method === 'GET' ? null : `https://${host}`) : o.origin;
    if (origin) headers.origin = origin;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await main.request(`http://${host}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await res.text();
    let json: { data?: unknown; error?: { code: string; message: string } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, res };
  };
  const signIn = async (email = 'root@example.test', password = PASSWORD) => {
    const r = await call('POST', '/admin-api/session', { body: { email, password } });
    const set = r.res.headers.get('set-cookie') ?? '';
    const m = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(set);
    return { ...r, set, cookie: m ? `${ADMIN_COOKIE}=${m[1]}` : '' };
  };
  return { call, signIn };
}

const auditKinds = (kind: string) => (store.db!.prepare('SELECT kind, actor, subject, detail FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { kind: string; actor: string; subject: string; detail: string }[]);
const MIN = 60_000;

test('adminHost unset: the console is off, its paths are the 404 of an unknown route on every host, and the portal is unchanged', async () => {
  const p = portal(null);
  const unknown = await p.call('GET', '/api/no-such-route', { host: MAIN_HOST });
  assert.equal(unknown.status, 404);
  for (const host of [ADMIN_HOST, MAIN_HOST, 'localhost:3000'])
    for (const path of ['/admin-api/session', '/admin-api/users', '/admin-ui/', '/admin-ui/assets/x.js', '/admin-api']) {
      const r = await p.call('GET', path, { host });
      assert.equal(r.status, 404, `${host}${path}`);
      assert.deepEqual(r.json, unknown.json, 'the same 404 as an unknown route');
    }
  const signIn = await p.call('POST', '/admin-api/session', { host: ADMIN_HOST, body: { email: 'root@example.test', password: PASSWORD } });
  assert.equal(signIn.status, 404);
  assert.equal((await p.call('GET', '/api/me', { host: MAIN_HOST })).status, 200);
  assert.equal(new AdminHostGate('not a host!', false).enabled, false, 'a value that is not a host name keeps it off (fail closed)');
});

test('admin routes are 404 on the main host (same body as an unknown route); the main portal is not reachable on the admin host', async () => {
  const p = portal(ADMIN_HOST);
  const unknown = await p.call('GET', '/api/no-such-route', { host: MAIN_HOST });
  for (const [method, path] of [
    ['GET', '/admin-api/users'],
    ['POST', '/admin-api/session'],
    ['GET', '/admin-ui/'],
    ['GET', '/admin-ui/users'],
  ] as const) {
    const r = await p.call(method, path, { host: MAIN_HOST, body: method === 'POST' ? { email: 'root@example.test', password: PASSWORD } : undefined });
    assert.equal(r.status, 404, `${method} ${path} on the main host`);
    assert.deepEqual(r.json, unknown.json);
  }
  // A forged X-Forwarded-Host does not make the main host the admin host (no trusted proxy).
  assert.equal((await p.call('GET', '/admin-api/users', { host: MAIN_HOST, headers: { 'x-forwarded-host': ADMIN_HOST } })).status, 404);
  // On the admin host: /healthz answers; the portal's API, MCP and pages do not.
  assert.equal((await p.call('GET', '/healthz')).status, 200);
  for (const [method, path] of [
    ['GET', '/api/me'],
    ['POST', '/mcp'],
    ['GET', '/admin/home'],
    ['GET', '/'],
  ] as const) {
    const r = await p.call(method, path);
    assert.equal(r.status, 404, `${method} ${path} on the admin host`);
    assert.doesNotMatch(r.text, /main portal|portal mcp|main shell/);
  }
  // The admin host with a port, and in capitals, is still the admin host.
  assert.equal((await p.call('GET', '/admin-api/session', { host: 'ADMIN.example.test:443' })).status, 401);
});

test('X-Forwarded-Host counts only behind the trusted proxy', () => {
  const trusted = new AdminHostGate(ADMIN_HOST, true);
  const untrusted = new AdminHostGate(ADMIN_HOST, false);
  const h = { host: MAIN_HOST, 'x-forwarded-host': ADMIN_HOST };
  assert.equal(trusted.isAdmin(h), true);
  assert.equal(untrusted.isAdmin(h), false);
  assert.equal(trusted.isAdmin({ host: ADMIN_HOST, 'x-forwarded-host': `${ADMIN_HOST}, ${MAIN_HOST}` }), false, 'the last entry is the proxy’s');
});

test('sign-in: an active admin gets a __Host- cookie (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain); a member gets the wrong-password answer', async () => {
  const p = portal(ADMIN_HOST);
  const wrong = await p.signIn('root@example.test', `${PASSWORD}x`);
  const member = await p.signIn('mia@example.test');
  assert.equal(member.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(member.json, wrong.json, 'a member is told nothing more than a wrong password');
  assert.equal(member.cookie, '');
  const ok = await p.signIn();
  assert.equal(ok.status, 200);
  assert.ok(ok.set.startsWith(`${ADMIN_COOKIE}=`));
  for (const attr of [/;\s*Secure/i, /;\s*HttpOnly/i, /;\s*SameSite=Strict/i, /;\s*Path=\//i]) assert.match(ok.set, attr);
  assert.doesNotMatch(ok.set, /Domain=/i);
  assert.equal((await p.call('GET', '/admin-api/session', { cookie: ok.cookie })).status, 200);
  assert.equal(auditKinds('admin.signin').length, 1);
  assert.ok(auditKinds('admin.signin_failed').length >= 2);
  // A disabled admin cannot sign in.
  await users.update(otherAdminId, { state: 'disabled' });
  assert.equal((await p.signIn('ops@example.test')).status, 401);
});

test('PILOT-1138 review: a locked email answers 429 with the lockout’s own Retry-After (its `retryAfter` detail), not the default minute', async () => {
  const p = portal(ADMIN_HOST);
  let locked: Awaited<ReturnType<typeof p.signIn>> | null = null;
  for (let i = 0; i < 12 && !locked; i++) {
    const r = await p.signIn('root@example.test', `${PASSWORD}x`);
    if (r.status === 429) locked = r;
  }
  assert.ok(locked, 'the email locked');
  const wait = Number(locked.res.headers.get('retry-after'));
  // The first lock is 30 s (identity/throttle.ts, 5 failures); the fallback a missing detail gave was 60.
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 30, `Retry-After is the lockout's own wait: ${locked.res.headers.get('retry-after')}`);
});

test('the main portal’s cookie and every token are refused on the admin host; writes need the admin host’s Origin', async () => {
  const p = portal(ADMIN_HOST);
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: `portal_session=${randomBytes(32).toString('base64url')}` })).status, 401);
  const { cookie } = await p.signIn();
  const bearer = `Bearer ${['cp', 'at', randomBytes(16).toString('hex')].join('')}`;
  for (const scheme of [bearer, `Bearer ${randomBytes(24).toString('base64url')}`, 'Basic Zm9vOmJhcg==']) {
    const r = await p.call('GET', '/admin-api/users', { cookie, headers: { authorization: scheme } });
    assert.equal(r.status, 401, `refused with ${scheme.split(' ')[0]}`);
  }
  const noCookie = await p.call('GET', '/admin-api/users', { headers: { authorization: bearer } });
  assert.equal(noCookie.status, 401);
  // Origin: missing, the main host's, another site's: refused; the admin host's: accepted.
  for (const origin of [null, `https://${MAIN_HOST}`, 'https://evil.example', 'null'])
    assert.equal((await p.call('DELETE', '/admin-api/session', { cookie, origin })).status, 403, `origin ${origin}`);
  assert.equal((await p.call('POST', '/admin-api/session', { origin: `https://${MAIN_HOST}`, body: { email: 'root@example.test', password: PASSWORD } })).status, 403, 'no login CSRF');
  assert.equal((await p.call('DELETE', '/admin-api/session', { cookie })).status, 200);
  assert.equal((await p.call('GET', '/admin-api/session', { cookie })).status, 401, 'signed out');
});

test('the session ends 15 minutes after the last request, and 2 hours after sign-in however busy', async () => {
  const p = portal(ADMIN_HOST);
  const a = await p.signIn();
  clock += ADMIN_SESSION_LIMITS.idleMs - MIN;
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: a.cookie })).status, 200, '14 minutes idle: alive, and touched');
  clock += ADMIN_SESSION_LIMITS.idleMs - MIN;
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: a.cookie })).status, 200, 'another 14 minutes after the last request');
  clock += ADMIN_SESSION_LIMITS.idleMs;
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: a.cookie })).status, 401, '15 minutes idle: ended');
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: a.cookie })).status, 401, 'and stays ended');

  const b = await p.signIn();
  const start = clock;
  while (clock + 10 * MIN < start + ADMIN_SESSION_LIMITS.absoluteMs) {
    clock += 10 * MIN;
    assert.equal((await p.call('GET', '/admin-api/session', { cookie: b.cookie })).status, 200);
  }
  clock = start + ADMIN_SESSION_LIMITS.absoluteMs;
  assert.equal((await p.call('GET', '/admin-api/session', { cookie: b.cookie })).status, 401, 'absolute 2 h');
  const ended = store.db!.prepare('SELECT end_reason FROM admin_sessions ORDER BY created_at').all() as { end_reason: string }[];
  assert.deepEqual(ended.map((r) => r.end_reason), ['idle', 'expired']);
});

test('a session ends when its account stops being an active admin', async () => {
  const p = portal(ADMIN_HOST);
  const s = await p.signIn('ops@example.test');
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: s.cookie })).status, 200);
  await users.update(otherAdminId, { role: 'member' });
  assert.equal((await p.call('GET', '/admin-api/users', { cookie: s.cookie })).status, 401);
});

test('step-up: ability changes need the password again within 5 minutes; a wrong password does not count', async () => {
  const p = portal(ADMIN_HOST);
  const { cookie } = await p.signIn();
  const put = () => p.call('PUT', `/admin-api/users/${memberId}/abilities/orgs.create`, { cookie });
  const r1 = await put();
  assert.equal(r1.status, 403);
  assert.equal(r1.json?.error?.code, 'REAUTH_REQUIRED');
  const bad = await p.call('POST', '/admin-api/session/step-up', { cookie, body: { password: `${PASSWORD}x` } });
  assert.equal(bad.status, 403);
  assert.equal((await put()).json?.error?.code, 'REAUTH_REQUIRED');
  const good = await p.call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } });
  assert.equal(good.status, 200);
  assert.ok((good.json?.data as { freshUntil: string | null }).freshUntil);
  assert.equal((await put()).status, 200);
  assert.equal(abilities.holds(memberId as `u_${string}`, 'orgs.create'), true);
  const users_ = (await p.call('GET', '/admin-api/users', { cookie })).json?.data as { id: string; abilities: string[] }[];
  assert.deepEqual(users_.find((u) => u.id === memberId)?.abilities, ['orgs.create']);
  const rows = auditKinds('ability.granted');
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.actor, /^user:/);
  clock += ADMIN_SESSION_LIMITS.stepUpMs + 1000;
  const late = await p.call('DELETE', `/admin-api/users/${memberId}/abilities/orgs.create`, { cookie });
  assert.equal(late.json?.error?.code, 'REAUTH_REQUIRED', 'more than 5 minutes later');
  assert.equal((await p.call('PUT', `/admin-api/users/${memberId}/abilities/no.such`, { cookie })).status, 403, 'step-up is checked first');
});

test('suspend, resume and end sessions: step-up, the account’s sessions and tokens end, an audit row each; not yourself', async () => {
  const p = portal(ADMIN_HOST);
  const { cookie } = await p.signIn();
  const victim = await p.signIn('ops@example.test');
  assert.equal((await p.call('POST', `/admin-api/users/${otherAdminId}/suspend`, { cookie, body: {} })).json?.error?.code, 'REAUTH_REQUIRED');
  await p.call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } });
  assert.equal((await p.call('POST', `/admin-api/users/${adminId}/suspend`, { cookie, body: {} })).status, 409, 'not your own account');
  const s = await p.call('POST', `/admin-api/users/${otherAdminId}/suspend`, { cookie, body: { reason: 'left the team' } });
  assert.equal(s.status, 200);
  assert.equal(users.roleOf(otherAdminId), 'disabled');
  assert.deepEqual(revoked, [otherAdminId], 'the main portal sessions ended');
  assert.equal((await p.call('GET', '/admin-api/session', { cookie: victim.cookie })).status, 401, 'and the admin session');
  const row = auditKinds('account.suspended')[0]!;
  assert.equal(row.subject, `user:${otherAdminId}`);
  assert.equal(JSON.parse(row.detail).reason, 'left the team');
  assert.equal((await p.call('POST', `/admin-api/users/${otherAdminId}/resume`, { cookie, body: {} })).status, 200);
  assert.equal(users.roleOf(otherAdminId), 'admin');
  assert.equal(auditKinds('account.resumed').length, 1);
  assert.equal((await p.call('POST', `/admin-api/users/${memberId}/sessions/end`, { cookie, body: {} })).status, 200);
  assert.equal(auditKinds('account.sessions_ended').length, 1);
  assert.equal((await p.call('POST', '/admin-api/users/u_nobody00000/suspend', { cookie, body: {} })).status, 404);
});

test('tokens: an admin revokes a token the account minted (step-up, audit); another account’s token is not found', async () => {
  const p = portal(ADMIN_HOST);
  const { cookie } = await p.signIn();
  const at = new Date(clock).toISOString();
  const later = new Date(clock + 86_400_000).toISOString();
  const tid = `ptk_${randomBytes(6).toString('hex')}`;
  store.db!
    .prepare("INSERT INTO pmcp_tokens (id, label, token_hash, last4, scope, created_at, expires_at, owner_id) VALUES (?, 'laptop', ?, 'abcd', 'read', ?, ?, ?)")
    .run(tid, randomBytes(16).toString('hex'), at, later, otherAdminId);
  store.db!.prepare("INSERT INTO token_accounts (kind, token_id, account_id) VALUES ('pmcp', ?, ?)").run(tid, otherAdminId);
  const detail = (await p.call('GET', `/admin-api/users/${otherAdminId}`, { cookie })).json?.data as { tokens: { id: string }[]; sessions: unknown };
  assert.deepEqual(detail.tokens.map((t) => t.id), [tid]);
  assert.ok(!JSON.stringify(detail).includes('token_hash'));
  await p.call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } });
  assert.equal((await p.call('DELETE', `/admin-api/users/${memberId}/tokens/${tid}`, { cookie })).status, 404, 'not this account’s');
  assert.equal((await p.call('DELETE', `/admin-api/users/${otherAdminId}/tokens/${tid}`, { cookie })).status, 200);
  assert.ok((store.db!.prepare('SELECT revoked_at FROM pmcp_tokens WHERE id = ?').get(tid) as { revoked_at: string | null }).revoked_at);
  assert.equal(auditKinds('account.token_revoked').length, 1);
});

test('orgs: the list shows owners and needs-owner; recover owner needs step-up and a reason, and writes its audit row', async () => {
  const p = portal(ADMIN_HOST);
  const admin: Actor = { kind: 'user', userId: adminId as `u_${string}`, loginSessionId: 't', via: 'ui' };
  abilities.grant(admin, memberId as `u_${string}`, 'orgs.create');
  const org = orgs.create({ kind: 'user', userId: memberId as `u_${string}`, loginSessionId: 't', via: 'ui' }, { name: 'Acme', slug: 'acme' });
  await users.update(memberId, { state: 'disabled' });
  const { cookie } = await p.signIn();
  const list = (await p.call('GET', '/admin-api/orgs', { cookie })).json?.data as { id: string; needsOwner: boolean; members: number }[];
  assert.deepEqual(list.map((o) => [o.id, o.needsOwner, o.members]), [[org.id, true, 1]]);
  const recover = (reason: string) => p.call('POST', `/admin-api/orgs/${org.id}/recover-owner`, { cookie, body: { userId: otherAdminId, reason } });
  assert.equal((await recover('the owner left the company')).json?.error?.code, 'REAUTH_REQUIRED');
  await p.call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } });
  assert.equal((await recover('short')).status, 422);
  assert.equal((await recover('the owner left the company')).status, 200);
  assert.equal(auditKinds('org.ownership_recovered').length, 1);
  const after_ = (await p.call('GET', '/admin-api/orgs', { cookie })).json?.data as { needsOwner: boolean }[];
  assert.equal(after_[0]!.needsOwner, false);
});

test('orgs: suspend and resume need the step-up, write their audit rows, and the owner cannot resume what the console suspended (slice 8)', async () => {
  const p = portal(ADMIN_HOST);
  const owner: Actor = { kind: 'user', userId: memberId as `u_${string}`, loginSessionId: 't', via: 'ui' };
  abilities.grant({ kind: 'user', userId: adminId as `u_${string}`, loginSessionId: 't', via: 'ui' }, memberId as `u_${string}`, 'orgs.create');
  const org = orgs.create(owner, { name: 'Acme', slug: 'acme' });
  const { cookie } = await p.signIn();
  const suspend = () => p.call('POST', `/admin-api/orgs/${org.id}/suspend`, { cookie, body: { reason: 'abuse report' } });
  assert.equal((await suspend()).json?.error?.code, 'REAUTH_REQUIRED');
  await p.call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } });
  assert.equal((await suspend()).status, 200);
  assert.equal(orgs.stateOf(org.id), 'suspended');
  assert.equal((await suspend()).status, 409, 'already suspended');
  assert.throws(() => orgs.resume(owner, org.id, { by: 'owner' }), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
  assert.equal((await p.call('POST', `/admin-api/orgs/${org.id}/resume`, { cookie, body: {} })).status, 200);
  assert.equal(orgs.stateOf(org.id), 'active');
  assert.equal((await p.call('POST', '/admin-api/orgs/org_nosuch/suspend', { cookie, body: {} })).status, 404);
  assert.equal(JSON.parse(auditKinds('org.suspended')[0]!.detail).by, 'platform');
  assert.equal(auditKinds('org.resumed').length, 1);
});

test('audit: filters by kind prefix and severity, newest first', async () => {
  const p = portal(ADMIN_HOST);
  const { cookie } = await p.signIn();
  await p.signIn('root@example.test', `${PASSWORD}x`);
  const rows = (await p.call('GET', '/admin-api/audit?kind=admin&severity=medium', { cookie })).json?.data as { kind: string; severity: string; id: number }[];
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.match(r.kind, /^admin\./);
    assert.equal(r.severity, 'medium');
  }
  const all = (await p.call('GET', '/admin-api/audit?limit=5', { cookie })).json?.data as { id: number }[];
  assert.ok(all.length <= 5);
  assert.deepEqual([...all].sort((x, y) => y.id - x.id), all);
  assert.equal((await p.call('GET', '/admin-api/sso', { cookie })).status, 200);
});

test('every admin route is declared and registered with the seam; an undeclared one fails', () => {
  const gate = new AdminHostGate(ADMIN_HOST, false);
  const { app } = createAdminApp({ store, gate, users, revokePortalSessions: () => {}, orgs, abilities, sso: { list: () => [] }, ssoRedirectUri: '', clientKey: () => 'x' });
  assert.doesNotThrow(() => assertDeclared(app.routes, ADMIN_ROUTE_POLICIES));
  for (const key of Object.keys(ADMIN_ROUTE_POLICIES)) assert.ok(policyFor(key), `${key} is registered`);
  const extra = [...app.routes, { method: 'POST', path: '/admin-api/users/:id/delete' }];
  assert.throws(() => assertDeclared(extra, ADMIN_ROUTE_POLICIES), /undeclared \["POST \/admin-api\/users\/:id\/delete"\]/);
  const missing = app.routes.filter((r) => r.path !== '/admin-api/audit');
  assert.throws(() => assertDeclared(missing, ADMIN_ROUTE_POLICIES), /declared without a route/);
  // Every step-up action of §6.11 that this slice builds is marked reauth.
  for (const key of Object.keys(ADMIN_ROUTE_POLICIES).filter((k) => !k.startsWith('GET ') && !k.includes('/session')))
    assert.equal(ADMIN_ROUTE_POLICIES[key as keyof typeof ADMIN_ROUTE_POLICIES]?.reauth, true, `${key} needs step-up`);
});

test('sockets are refused on the admin host and pass on any other', async () => {
  const server = createServer();
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n'));
  routeAdminHostUpgrades(server, new AdminHostGate(ADMIN_HOST, false));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const status = (host: string) =>
    new Promise<string>((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () =>
        s.write(`GET /api/live HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`),
      );
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('end', () => resolve(buf.split('\r\n')[0]!));
      s.on('error', reject);
    });
  try {
    assert.match(await status(ADMIN_HOST), /404/);
    assert.match(await status(MAIN_HOST), /101/);
  } finally {
    server.close();
  }
});
