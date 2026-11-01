// The Admin console controls the instance (owner, 2026-11-01: "should all being controlled"): accounts (create with a one-time password, role,
// password reset, remove), organizations (create for an owner, detail, delete), workspaces and targets (list, start and stop as the seam
// allows), sign-in (the server code's switch and rotation, the console's OIDC allow list, SSO providers), the settings store, and the audit's
// new filters. Every new route: the same 404 as an unknown route on the main host, a step-up for every write, refused once the account is no
// longer an admin, and a platform audit row per write that never carries a password or a code.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { ADMIN_COOKIE, workspaceRef, type Actor, type SettingView, type SettingsView, type SsoProvider, type SsoProviderRequest, type Workspace, type WorkspaceTarget } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { registerResolver, useAccountRoles, type AccountRoleOf } from '../authz/seam.js';
import { AccountAdmin } from '../identity/accountAdmin.js';
import { PasswordHasher, TEST_PARAMS } from '../identity/passwords.js';
import { PortalUsers } from '../identity/users.js';
import { createOrgs, type OrgsService, type UserAbilities } from '../orgs/index.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { ADMIN_ROUTE_POLICIES, AdminHostGate, adminHostMiddleware, createAdminApp } from './index.js';

const ADMIN_HOST = 'admin.example.test';
const MAIN_HOST = 'pilot.example.test';
// Built at run time: no credential-shaped literal in the source.
const PASSWORD = ['copper', 'harbor', 'violet', 'summit', String(Date.now() % 89)].join('-');

let store: Store;
let users: PortalUsers;
let orgs: OrgsService;
let abilities: UserAbilities;
let restoreRoles: AccountRoleOf;
let adminId: string;
let otherAdminId: string;
let memberId: string;
let revoked: string[];
let forgotten: string[];
let started: string[];
let codeOn: boolean;
let code: string;
let codeSessions: number;
const settingsSet: { key: string; value: unknown; actor: string; confirm?: boolean }[] = [];
const ssoCalls: { op: string; req: SsoProviderRequest; by?: string }[] = [];

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-admin-control-'), secretKey: null });
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
  revoked = [];
  forgotten = [];
  started = [];
  codeOn = true;
  code = randomBytes(6).toString('hex');
  codeSessions = 3;
  settingsSet.length = 0;
  ssoCalls.length = 0;
});

afterEach(async () => {
  store.db!.exec(
    "DELETE FROM admin_sessions; DELETE FROM auth_throttle; DELETE FROM platform_audit; DELETE FROM user_abilities; DELETE FROM workspace_owners; UPDATE orgs SET state = 'deleting'; DELETE FROM org_invitations; DELETE FROM org_members; DELETE FROM orgs; UPDATE users SET founder = 0;",
  );
  for (const id of [adminId, otherAdminId, memberId]) {
    try {
      await users.update(id, { state: 'active' });
    } catch {
      // removed by a test: made again below
    }
  }
  await users.update(otherAdminId, { role: 'admin' });
  await users.update(memberId, { role: 'member' });
});

const SETTINGS: SettingView[] = [
  { key: 'sessions.allowBypass', group: 'sessions', label: 'Bypass', help: null, confirmText: 'Allow Bypass?', type: 'boolean', value: false, default: false, protective: false } as SettingView,
];

function fakeWorkspaces() {
  const list: Workspace[] = [
    { id: 'docker/mine', name: 'mine', target: 'docker', image: 'img:1', status: 'stopped', createdAt: new Date().toISOString() } as Workspace,
    { id: 'docker/theirs', name: 'theirs', target: 'docker', image: 'img:2', status: 'running', createdAt: new Date().toISOString() } as Workspace,
  ];
  const targets: WorkspaceTarget[] = [{ id: 'docker', label: 'Docker', kind: 'docker', where: '/var/run/docker.sock', available: true }];
  return {
    list: async () => list,
    targets: async () => targets,
    start: async (t: string, n: string) => void started.push(`start ${t}/${n}`),
    stop: async (t: string, n: string) => void started.push(`stop ${t}/${n}`),
    resolve: (ref: string) => (ref.startsWith('docker/') ? { id: `ws_${ref.slice(7).padEnd(12, '0').slice(0, 12)}` } : null),
  };
}

function portal(adminHost: string | null = ADMIN_HOST) {
  const gate = new AdminHostGate(adminHost, false);
  const accounts = new AccountAdmin({
    users,
    writable: () => store.db,
    revokeSessions: (id) => revoked.push(id),
    forget: [{ removeUser: (id: string) => void forgotten.push(id) }],
  });
  const consoleApp = gate.enabled
    ? createAdminApp({
        store,
        gate,
        users,
        revokePortalSessions: (id) => revoked.push(id),
        orgs,
        abilities,
        sso: {
          list: () => [],
          create: (req, by) => (ssoCalls.push({ op: 'create', req, by }), { id: 'sso_1', name: req.name ?? '', issuer: req.issuer ?? '', domains: req.domains ?? [], enabled: true, defaultRole: 'member' } as unknown as SsoProvider),
          update: (id, req, _uri, by) => (ssoCalls.push({ op: 'update', req, by }), { id, name: 'x', issuer: 'https://idp.example.test', domains: [], enabled: req.enabled ?? true } as unknown as SsoProvider),
        },
        ssoRedirectUri: '',
        clientKey: () => '10.1.2.3',
        accounts,
        workspaces: fakeWorkspaces(),
        serverCode: {
          summary: () => ({ enabled: codeOn, source: 'generated', codeUpdatedAt: new Date().toISOString(), sessions: codeSessions }),
          setEnabled: (v: boolean) => void (codeOn = v),
          rotate: () => {
            code = randomBytes(6).toString('hex');
            codeSessions = 0;
          },
          get code() {
            return code;
          },
          matches: (input: string) => input === code,
        },
        settings: {
          view: (): SettingsView => ({ groups: [{ id: 'sessions', label: 'Sessions' }], settings: SETTINGS }) as unknown as SettingsView,
          set: (key: string, value: unknown, opts: { actor: string; confirm?: boolean }) => {
            const s = SETTINGS.find((x) => x.key === key);
            if (!s) throw new AppError('NOT_FOUND', 'No such setting.');
            if (value === true && !opts.confirm) throw new AppError('CONFLICT', 'Confirm this change.');
            settingsSet.push({ key, value, ...opts });
            s.value = value as boolean;
            return s;
          },
        },
        oidc: { config: { issuer: 'https://git.example.test', clientId: 'c', clientSecret: randomBytes(8).toString('hex'), allow: ['root@example.test'], allowPrivate: false, name: 'git.example.test' } },
      }).app
    : null;
  const main = new Hono();
  main.use(adminHostMiddleware(gate, () => consoleApp));
  main.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR');
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  main.all('/api/*', () => {
    throw new AppError('NOT_FOUND');
  });
  const call = async (method: string, path: string, o: { host?: string; cookie?: string; body?: unknown } = {}) => {
    const host = o.host ?? ADMIN_HOST;
    const headers: Record<string, string> = { host };
    if (o.cookie) headers.cookie = o.cookie;
    if (method !== 'GET') headers.origin = `https://${host}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await main.request(`http://${host}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await res.text();
    let json: { data?: unknown; error?: { code: string; message: string } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
  const signIn = async (email = 'root@example.test') => {
    const res = await main.request(`http://${ADMIN_HOST}/admin-api/session`, {
      method: 'POST',
      headers: { host: ADMIN_HOST, origin: `https://${ADMIN_HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const m = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '');
    assert.ok(m, `signed in as ${email}`);
    return `${ADMIN_COOKIE}=${m[1]}`;
  };
  const stepUp = async (cookie: string) => assert.equal((await call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } })).status, 200);
  return { call, signIn, stepUp };
}

const audit = (kind: string) => store.db!.prepare('SELECT actor, subject, detail, severity FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { actor: string; subject: string | null; detail: string; severity: string }[];
const owner = (id: string): Actor => ({ kind: 'user', userId: id as `u_${string}`, loginSessionId: 't', via: 'ui' });

/** The new routes, with a concrete path and a body. */
const NEW_ROUTES: [string, string, unknown?][] = [
  ['POST', '/admin-api/users', { email: 'new@example.test' }],
  ['PATCH', '/admin-api/users/u_x', { role: 'admin' }],
  ['DELETE', '/admin-api/users/u_x'],
  ['POST', '/admin-api/users/u_x/password', {}],
  ['POST', '/admin-api/users/u_x/founder', { reason: 'the owner signs in with SSO now' }],
  ['POST', '/admin-api/orgs', { name: 'Acme', slug: 'acme' }],
  ['GET', '/admin-api/orgs/org_x'],
  ['DELETE', '/admin-api/orgs/org_x'],
  ['GET', '/admin-api/workspaces'],
  ['POST', '/admin-api/workspaces/docker/mine/start', {}],
  ['POST', '/admin-api/workspaces/docker/mine/stop', {}],
  ['GET', '/admin-api/targets'],
  ['POST', '/admin-api/sso', { name: 'Idp' }],
  ['PATCH', '/admin-api/sso/sso_1', { enabled: false }],
  ['GET', '/admin-api/signin'],
  ['PUT', '/admin-api/signin/server-code', { enabled: false }],
  ['POST', '/admin-api/signin/server-code/rotate', {}],
  ['GET', '/admin-api/settings'],
  ['PUT', '/admin-api/settings/sessions.allowBypass', { value: false }],
];

test('every new route is declared (platform, step-up on every write) and is the same 404 as an unknown route on the main host', async () => {
  const p = portal();
  const unknown = await p.call('GET', '/api/no-such-route', { host: MAIN_HOST });
  for (const [method, path, body] of NEW_ROUTES) {
    const r = await p.call(method, path, { host: MAIN_HOST, body });
    assert.equal(r.status, 404, `${method} ${path} on the main host`);
    assert.deepEqual(r.json, unknown.json);
  }
  const keys = Object.keys(ADMIN_ROUTE_POLICIES);
  for (const k of [
    'POST /admin-api/users',
    'PATCH /admin-api/users/:id',
    'DELETE /admin-api/users/:id',
    'POST /admin-api/users/:id/password',
    'POST /admin-api/users/:id/founder',
    'POST /admin-api/orgs',
    'DELETE /admin-api/orgs/:id',
    'POST /admin-api/workspaces/:target/:name/start',
    'POST /admin-api/workspaces/:target/:name/stop',
    'POST /admin-api/sso',
    'PATCH /admin-api/sso/:id',
    'PUT /admin-api/signin/server-code',
    'POST /admin-api/signin/server-code/rotate',
    'PUT /admin-api/settings/:key',
  ]) {
    assert.ok(keys.includes(k), `${k} is declared`);
    const policy = ADMIN_ROUTE_POLICIES[k as keyof typeof ADMIN_ROUTE_POLICIES] as { kind: string; reauth?: boolean; audit?: string };
    assert.equal(policy.kind, 'platform', k);
    assert.equal(policy.reauth, true, `${k} needs the step-up`);
    assert.ok(policy.audit, `${k} names its audit row`);
  }
  for (const k of ['GET /admin-api/orgs/:id', 'GET /admin-api/workspaces', 'GET /admin-api/targets', 'GET /admin-api/signin', 'GET /admin-api/settings'])
    assert.equal((ADMIN_ROUTE_POLICIES[k as keyof typeof ADMIN_ROUTE_POLICIES] as { kind: string }).kind, 'platform', k);
});

test('every new write needs the step-up first; without a session every new route is 401; an account that stops being an admin is refused', async () => {
  const p = portal();
  for (const [method, path, body] of NEW_ROUTES) assert.equal((await p.call(method, path, { body })).status, 401, `${method} ${path} without a session`);
  const cookie = await p.signIn('ops@example.test');
  for (const [method, path, body] of NEW_ROUTES) {
    const r = await p.call(method, path, { cookie, body });
    if (method === 'GET') assert.notEqual(r.status, 403, `${method} ${path} reads without the step-up`);
    else assert.equal(r.json?.error?.code, 'REAUTH_REQUIRED', `${method} ${path} needs the step-up`);
  }
  assert.deepEqual(started, [], 'the runtime was never asked');
  assert.equal(settingsSet.length + ssoCalls.length, 0, 'nothing was changed');
  await users.update(otherAdminId, { role: 'member' });
  for (const [method, path, body] of NEW_ROUTES) assert.equal((await p.call(method, path, { cookie, body })).status, 401, `${method} ${path} after the demotion`);
});

test('accounts: create shows a one-time password once (it signs in, it is in no audit row); role, password reset and remove end what they must', async () => {
  const p = portal();
  const cookie = await p.signIn();
  await p.stepUp(cookie);
  const made = await p.call('POST', '/admin-api/users', { cookie, body: { email: 'Nia@Example.test', role: 'member', displayName: 'Nia' } });
  assert.equal(made.status, 201);
  const { user, password } = made.json?.data as { user: { id: string; email: string; role: string }; password: string };
  assert.equal(user.email, 'nia@example.test');
  assert.ok(password.length >= 20);
  assert.equal((await users.verify('nia@example.test', password, '10.9.9.9')).id, user.id, 'the one-time password signs in');
  assert.equal((await p.call('POST', '/admin-api/users', { cookie, body: { email: 'nia@example.test' } })).status, 409, 'one account per email');
  const created = audit('account.created');
  assert.equal(created.length, 1);
  assert.match(created[0]!.actor, /^user:/);
  assert.equal(created[0]!.subject, `user:${user.id}`);
  assert.ok(!JSON.stringify(created).includes(password), 'the password is in no audit row');

  // Role: promote, then demote; never yourself.
  assert.equal((await p.call('PATCH', `/admin-api/users/${user.id}`, { cookie, body: { role: 'admin' } })).status, 200);
  assert.equal(users.roleOf(user.id), 'admin');
  assert.equal((await p.call('PATCH', `/admin-api/users/${user.id}`, { cookie, body: { role: 'member' } })).status, 200);
  assert.equal(users.roleOf(user.id), 'member');
  assert.deepEqual(revoked, [user.id], 'a demotion ends the main-portal sessions');
  assert.equal((await p.call('PATCH', `/admin-api/users/${adminId}`, { cookie, body: { role: 'member' } })).status, 409, 'not your own');
  assert.equal((await p.call('PATCH', `/admin-api/users/${user.id}`, { cookie, body: {} })).status, 422, 'nothing to change');
  const updated = audit('account.updated').map((r) => JSON.parse(r.detail) as { roleFrom?: string; roleTo?: string });
  assert.deepEqual(updated.map((d) => [d.roleFrom, d.roleTo]), [['member', 'admin'], ['admin', 'member']]);

  // Password reset: a new one-time password, the old one stops working; never your own here.
  const reset = await p.call('POST', `/admin-api/users/${user.id}/password`, { cookie, body: { reason: 'forgot it' } });
  assert.equal(reset.status, 200);
  const next = (reset.json?.data as { password: string }).password;
  assert.notEqual(next, password);
  await assert.rejects(users.verify('nia@example.test', password, '10.9.9.8'));
  assert.equal((await users.verify('nia@example.test', next, '10.9.9.7')).id, user.id);
  assert.equal((await p.call('POST', `/admin-api/users/${adminId}/password`, { cookie, body: {} })).status, 409);
  const resetRows = audit('account.password_reset');
  assert.equal(resetRows.length, 1);
  assert.ok(!JSON.stringify(resetRows).includes(next));

  // Remove: not yourself, not the founder; the account is gone and forgotten by shares, teams and SSO.
  assert.equal((await p.call('DELETE', `/admin-api/users/${adminId}`, { cookie })).status, 409);
  store.db!.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(otherAdminId);
  assert.equal((await p.call('DELETE', `/admin-api/users/${otherAdminId}`, { cookie })).status, 409, 'the founder’s account stays');
  assert.equal((await p.call('DELETE', `/admin-api/users/${user.id}`, { cookie })).status, 200);
  assert.equal(users.roleOf(user.id), null);
  assert.deepEqual(forgotten, [user.id]);
  assert.equal(audit('account.removed').length, 1);
  assert.equal((await p.call('DELETE', `/admin-api/users/${user.id}`, { cookie })).status, 404);
});

test('orgs: create for an owner the admin picks, the detail (members, objects, invitations), delete only when it owns nothing', async () => {
  const p = portal();
  const cookie = await p.signIn();
  await p.stepUp(cookie);
  const made = await p.call('POST', '/admin-api/orgs', { cookie, body: { name: 'Acme', slug: 'acme', ownerId: memberId } });
  assert.equal(made.status, 201);
  const org = made.json?.data as { id: `org_${string}`; memberList: { userId: string; role: string }[]; owners: { userId: string }[] };
  assert.deepEqual(org.memberList.map((m) => [m.userId, m.role]), [[memberId, 'owner']], 'the owner picked, not the admin');
  assert.equal(orgs.roleOf(org.id, memberId as `u_${string}`), 'owner');
  assert.equal(orgs.roleOf(org.id, adminId as `u_${string}`), null);
  assert.equal((await p.call('POST', '/admin-api/orgs', { cookie, body: { name: 'Again', slug: 'acme', ownerId: memberId } })).status, 409, 'slug taken');
  assert.equal((await p.call('POST', '/admin-api/orgs', { cookie, body: { name: 'Bad', slug: 'b', ownerId: memberId } })).status, 422);
  assert.equal((await p.call('POST', '/admin-api/orgs', { cookie, body: { name: 'Ghost', slug: 'ghost', ownerId: 'u_nobody0000' } })).status, 422);
  const created = audit('org.created');
  assert.equal(created.length, 1);
  assert.equal(JSON.parse(created[0]!.detail).by, 'platform');

  // The detail: an object it owns; no invitation yet (an invitation's code is never in it).
  const at = new Date().toISOString();
  store.db!.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES ('docker/acme-api', 'ws_aaaaaaaaaaaa', 'org', ?, 'u_owner', ?, 'claimed')").run(org.id, at);
  const detail = (await p.call('GET', `/admin-api/orgs/${org.id}`, { cookie })).json?.data as { objects: { kind: string; id: string }[]; invitations: unknown[]; sso: unknown; domains: unknown };
  assert.deepEqual(detail.objects.map((o) => [o.kind, o.id]), [['workspace', 'docker/acme-api']]);
  assert.deepEqual(detail.invitations, []);
  assert.ok(!JSON.stringify(detail).includes('code_hash'));
  assert.equal((await p.call('GET', '/admin-api/orgs/org_nosuch', { cookie })).status, 404);

  // Delete: refused while it owns something; then deleting, with its audit row.
  const refused = await p.call('DELETE', `/admin-api/orgs/${org.id}`, { cookie });
  assert.equal(refused.status, 409);
  store.db!.prepare('DELETE FROM workspace_owners WHERE workspace_id = ?').run('docker/acme-api');
  assert.equal((await p.call('DELETE', `/admin-api/orgs/${org.id}`, { cookie, body: { reason: 'test org' } })).status, 200);
  assert.equal(orgs.stateOf(org.id), 'deleting');
  assert.equal(JSON.parse(audit('org.deleted')[0]!.detail).by, 'platform');
  assert.equal((await p.call('GET', `/admin-api/orgs/${org.id}`, { cookie })).status, 404, 'a deleted org is gone');
  assert.equal((await p.call('DELETE', `/admin-api/orgs/${org.id}`, { cookie })).status, 404);
});

test('workspaces: the list names owners; start and stop go through the seam (another person’s is the 404, the runtime never asked); targets list', async () => {
  const p = portal();
  const cookie = await p.signIn();
  registerResolver({
    type: 'workspace',
    resolve: (id) => (id === 'docker/mine' ? { ref: workspaceRef(id), owner: { kind: 'user', id: adminId as `u_${string}` } } : id === 'docker/theirs' ? { ref: workspaceRef(id), owner: { kind: 'user', id: memberId as `u_${string}` } } : null),
  });
  try {
    const at = new Date().toISOString();
    store.db!.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES ('docker/theirs', 'ws_bbbbbbbbbbbb', 'user', ?, ?, ?, 'created')").run(memberId, memberId, at);
    const list = (await p.call('GET', '/admin-api/workspaces', { cookie })).json?.data as { id: string; owner: { kind: string; name: string | null } }[];
    assert.deepEqual(list.map((w) => [w.id, w.owner.kind, w.owner.name]), [['docker/mine', 'none', null], ['docker/theirs', 'user', 'mia@example.test']]);
    const targets = (await p.call('GET', '/admin-api/targets', { cookie })).json?.data as { id: string; available: boolean }[];
    assert.deepEqual(targets.map((t) => [t.id, t.available]), [['docker', true]]);
    await p.stepUp(cookie);
    assert.equal((await p.call('POST', '/admin-api/workspaces/docker/mine/start', { cookie, body: {} })).status, 200);
    assert.equal((await p.call('POST', '/admin-api/workspaces/docker/mine/stop', { cookie, body: {} })).status, 200);
    const theirs = await p.call('POST', '/admin-api/workspaces/docker/theirs/stop', { cookie, body: {} });
    const missing = await p.call('POST', '/admin-api/workspaces/docker/nope/stop', { cookie, body: {} });
    assert.equal(theirs.status, 404, 'D12: an admin holds no right on another person’s workspace');
    assert.deepEqual(theirs.json, missing.json, 'the same answer as a workspace that does not exist');
    assert.deepEqual(started, ['start docker/mine', 'stop docker/mine']);
    assert.deepEqual(audit('workspace.start').map((r) => JSON.parse(r.detail).workspace), ['docker/mine']);
    assert.equal(audit('workspace.stop').length, 1);
  } finally {
    registerResolver({ type: 'workspace', resolve: () => null });
  }
});

test('sign-in: the server code is never shown except once on rotation; the switch and the rotation are audited without it; the OIDC allow list is read only', async () => {
  const p = portal();
  const cookie = await p.signIn();
  const config = (await p.call('GET', '/admin-api/signin', { cookie })).json?.data as { serverCode: { enabled: boolean; sessions: number }; adminOidc: { allow: string[]; name: string }; adminHost: string };
  assert.equal(config.serverCode.enabled, true);
  assert.deepEqual(config.adminOidc.allow, ['root@example.test']);
  assert.equal(config.adminHost, ADMIN_HOST);
  assert.ok(!JSON.stringify(config).includes(code), 'the code is not in the config');
  assert.ok(!JSON.stringify(config).includes('clientSecret'));
  await p.stepUp(cookie);
  const off = await p.call('PUT', '/admin-api/signin/server-code', { cookie, body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(codeOn, false);
  assert.equal((await p.call('PUT', '/admin-api/signin/server-code', { cookie, body: { enabled: 'no' } })).status, 422);
  const old = code;
  const rotated = await p.call('POST', '/admin-api/signin/server-code/rotate', { cookie, body: {} });
  assert.equal(rotated.status, 200);
  const shown = (rotated.json?.data as { code: string }).code;
  assert.equal(shown, code);
  assert.notEqual(shown, old);
  assert.equal(JSON.parse(audit('portal.server_code_switched')[0]!.detail).enabled, false);
  const rows = audit('portal.server_code_rotated');
  assert.equal(JSON.parse(rows[0]!.detail).sessionsEnded, 3);
  assert.ok(!JSON.stringify(store.db!.prepare('SELECT detail FROM platform_audit').all()).includes(shown), 'the code is in no audit row');
});

test('SSO providers: create and edit (turn off) through the service, audited without the secret', async () => {
  const p = portal();
  const cookie = await p.signIn();
  await p.stepUp(cookie);
  const secret = randomBytes(12).toString('hex');
  const made = await p.call('POST', '/admin-api/sso', { cookie, body: { name: 'Corp', issuer: 'https://idp.example.test', clientId: 'portal', clientSecret: secret, domains: ['example.test'] } });
  assert.equal(made.status, 201);
  assert.equal((await p.call('PATCH', '/admin-api/sso/sso_1', { cookie, body: { enabled: false, clientSecret: secret } })).status, 200);
  assert.deepEqual(ssoCalls.map((c) => [c.op, c.by]), [['create', 'root@example.test'], ['update', 'root@example.test']]);
  const rows = [...audit('sso.provider_created'), ...audit('sso.provider_changed')];
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[1]!.detail).secretChanged, true);
  assert.ok(!JSON.stringify(rows).includes(secret), 'the secret is in no audit row');
});

test('settings: the store is read and changed with the step-up; a protective switch needs the confirmation; an audit row per change', async () => {
  const p = portal();
  const cookie = await p.signIn();
  const view = (await p.call('GET', '/admin-api/settings', { cookie })).json?.data as SettingsView;
  assert.deepEqual(view.settings.map((s) => s.key), ['sessions.allowBypass']);
  await p.stepUp(cookie);
  assert.equal((await p.call('PUT', '/admin-api/settings/sessions.allowBypass', { cookie, body: { value: true } })).status, 409, 'confirm first');
  assert.equal((await p.call('PUT', '/admin-api/settings/sessions.allowBypass', { cookie, body: { value: true, confirm: true } })).status, 200);
  assert.equal((await p.call('PUT', '/admin-api/settings/no.such', { cookie, body: { value: 1 } })).status, 404);
  assert.deepEqual(settingsSet.map((s) => [s.key, s.value, s.confirm, /^user:/.test(s.actor)]), [['sessions.allowBypass', true, true, true]]);
  const rows = audit('setting.changed').map((r) => JSON.parse(r.detail) as { key: string; from: unknown; to: unknown });
  assert.deepEqual(rows, [{ key: 'sessions.allowBypass', from: false, to: true, via: 'admin-console' }]);
  SETTINGS[0]!.value = false;
});

test('audit: filters by actor (exact or a prefix), by org and by date; refused sign-ins are a kind', async () => {
  const p = portal();
  const cookie = await p.signIn();
  abilities.grant(owner(adminId), memberId as `u_${string}`, 'orgs.create');
  const org = orgs.create(owner(memberId), { name: 'Beta', slug: 'beta' });
  const insert = store.db!.prepare("INSERT INTO platform_audit (at, severity, kind, actor, user_id, subject, detail) VALUES (?, 'medium', 'admin.signin_refused', 'anonymous', NULL, NULL, '{}')");
  insert.run('2026-01-02T10:00:00.000Z');
  insert.run('2026-01-03T10:00:00.000Z');
  const q = async (s: string) => (await p.call('GET', `/admin-api/audit?${s}`, { cookie })).json?.data as { kind: string; actor: string; at: string; subject: string | null }[];
  const mine = await q(`actor=${encodeURIComponent((await q('kind=admin.signin'))[0]!.actor)}`);
  assert.ok(mine.length >= 1 && mine.every((r) => r.actor.startsWith('user:')));
  const anon = await q('actor=anonymous&kind=admin.signin_refused');
  assert.equal(anon.length, 2);
  assert.ok((await q('actor=user:')).every((r) => r.actor.startsWith('user:')), 'a prefix');
  const byOrg = await q(`org=${org.id}`);
  assert.ok(byOrg.length >= 1 && byOrg.every((r) => r.subject === `org:${org.id}`));
  const day = await q('from=2026-01-02&to=2026-01-02');
  assert.deepEqual(day.map((r) => r.at), ['2026-01-02T10:00:00.000Z'], 'a bare date as `to` is that whole day');
  assert.deepEqual((await q('from=2026-01-03T00:00:00Z&kind=admin.signin_refused')).map((r) => r.at), ['2026-01-03T10:00:00.000Z']);
  assert.ok((await q('from=not-a-date')).length >= 3, 'a bad date is ignored, not an error');
});

test('adminHost unset: the new routes are off too', async () => {
  const p = portal(null);
  for (const [method, path, body] of NEW_ROUTES) assert.equal((await p.call(method, path, { host: ADMIN_HOST, body })).status, 404, `${method} ${path}`);
});

test('founder (owner request 2026-11-01): only the current founder, or the server code; a reason; audited high without the code; moves back', async () => {
  const p = portal();
  const cookie = await p.signIn();
  await p.stepUp(cookie);
  const reason = 'the owner signs in with git SSO from now on';
  const path = `/admin-api/users/${otherAdminId}/founder`;
  assert.equal((await p.call('POST', path, { cookie, body: { reason: 'short' } })).status, 422);
  // Nobody is marked: the server code is the only way.
  const none = await p.call('POST', path, { cookie, body: { reason } });
  assert.equal(none.status, 403);
  assert.equal((await p.call('POST', path, { cookie, body: { reason, serverCode: 'wrong-code' } })).status, 403);
  assert.deepEqual(audit('identity.founder_transfer_refused').map((r) => JSON.parse(r.detail).why), ['not the founder', 'wrong server code']);
  const ok = await p.call('POST', path, { cookie, body: { reason, serverCode: code } });
  assert.equal(ok.status, 200);
  assert.equal(users.principalOf(otherAdminId), 'u_owner', 'ops acts as the founding user now');
  assert.equal(users.principalOf(adminId), adminId);
  const row = audit('identity.founder_transferred')[0]!;
  assert.equal(row.severity, 'high');
  const detail = JSON.parse(row.detail);
  assert.deepEqual([detail.to, detail.from, detail.how, detail.reason], ['ops@example.test', null, 'server-code', reason]);
  assert.ok(!JSON.stringify(store.db!.prepare('SELECT detail FROM platform_audit').all()).includes(code), 'the code is in no audit row');
  const list = (await p.call('GET', '/admin-api/users', { cookie })).json?.data as { id: string; founder?: boolean }[];
  assert.deepEqual(list.filter((u) => u.founder).map((u) => u.id), [otherAdminId]);
  // root is not the founder: without the code it may not move the mark back; the founder (ops) may, with no code.
  assert.equal((await p.call('POST', `/admin-api/users/${adminId}/founder`, { cookie, body: { reason } })).status, 403);
  const ops = await p.signIn('ops@example.test');
  await p.stepUp(ops);
  assert.equal((await p.call('POST', `/admin-api/users/${adminId}/founder`, { cookie: ops, body: { reason } })).status, 200);
  assert.equal(users.principalOf(adminId), 'u_owner');
  // A member never becomes the founder.
  const root = await p.signIn();
  await p.stepUp(root);
  assert.equal((await p.call('POST', `/admin-api/users/${memberId}/founder`, { cookie: root, body: { reason } })).status, 409);
});

test('server code off (owner request 2026-11-01): refused while no active admin can sign in with a password or a linked sign-in; the config names who can', async () => {
  const p = portal();
  const cookie = await p.signIn();
  await p.stepUp(cookie);
  try {
    store.db!.exec("UPDATE users SET password_set = 0 WHERE role = 'admin'");
    const config = (await p.call('GET', '/admin-api/signin', { cookie })).json?.data as { admins: { email: string; methods: string[] }[] };
    assert.ok(config.admins.length >= 2 && config.admins.every((a) => a.methods.length === 0));
    const refused = await p.call('PUT', '/admin-api/signin/server-code', { cookie, body: { enabled: false } });
    assert.equal(refused.status, 409);
    assert.equal(codeOn, true, 'still on');
    assert.equal(audit('portal.server_code_switched').length, 0);
  } finally {
    store.db!.exec('UPDATE users SET password_set = 1');
  }
  const ready = (await p.call('GET', '/admin-api/signin', { cookie })).json?.data as { admins: { email: string; methods: string[] }[] };
  assert.deepEqual(ready.admins.find((a) => a.email === 'root@example.test')?.methods, ['password']);
  assert.equal((await p.call('PUT', '/admin-api/signin/server-code', { cookie, body: { enabled: false } })).status, 200);
  assert.equal(codeOn, false);
});
