// Owner need 2026-11-01: give an AI agent's account (a member) Portal MCP access limited to ONE org, from the Admin console. Two actions:
//   - Orgs → Members → Add (an existing account, or a new one with no password) and Remove (never an owner);
//   - Users → Tokens → New: a Portal MCP token whose owner is THAT account, so it acts with the account's rights capped by its scope.
// Against a real migrated database, the real orgs module, owner resolvers and the Portal MCP endpoint (the secret the console shows is used
// at /mcp): admin-only (the same 404 on the main host, 401 without the console session), step-up on every write, admin scope refused for a
// member, the token reaches its org's shared workspace and bucket and NOT another org's (byte for byte the missing answer), it stops while
// its account is suspended, and no audit row carries the secret.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { ADMIN_COOKIE, FOUNDING_USER_ID, workspaceRef, objectRef, type ToolPolicy, type UserId, type Workspace } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { registerOwnerResolvers } from '../authz/owners.js';
import { actorOfPrincipal, can, clearResolvers, declareToolPolicies, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import { PasswordHasher, TEST_PARAMS } from '../identity/passwords.js';
import { PortalUsers } from '../identity/users.js';
import { createOrgs, type OrgsModule } from '../orgs/index.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';
import { ADMIN_ROUTE_POLICIES, AdminHostGate, adminHostMiddleware, createAdminApp } from './index.js';

const ADMIN_HOST = 'admin.example.test';
const MAIN_HOST = 'pilot.example.test';
// Built at run time: no credential-shaped literal in the source.
const PASSWORD = ['amber', 'canyon', 'maple', 'orbit', String(Date.now() % 97)].join('-');
const WS = { k: 'docker/konf-api', o: 'docker/other-api', kPrivate: 'docker/konf-private' };
const BUCKET = { k: 'KAFG', o: 'OTHX' };

/** A toy tool per object type, its declared policy enforced at dispatch (portalmcp/registry.ts), counting the calls that reached it. */
const registry = new ToolRegistry();
const reached: string[] = [];
const TOOL_POLICIES: Record<string, ToolPolicy> = {
  t_member_ws: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'workspace', notFound: 'No such workspace.' }] },
  t_member_bucket: { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'view', arg: 'bucket', notFound: 'No such bucket.' }] },
};
declareToolPolicies('adminMemberToken.test', TOOL_POLICIES);
for (const [name, arg] of [
  ['t_member_ws', 'workspace'],
  ['t_member_bucket', 'bucket'],
] as const)
  registry.register({
    name,
    title: 'Toy',
    description: 'A toy tool for the org probe.',
    scope: 'read',
    hints: { readOnly: true },
    input: z.object({ [arg]: z.string() }),
    handler: (_ctx, args) => {
      reached.push(`${name}:${String((args as Record<string, string>)[arg])}`);
      return { summary: 'reached', ok: true };
    },
  });

let h: Awaited<ReturnType<typeof portalMcpHarness>>;
let users: PortalUsers;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let adminId: string;
let memberId: string;
let konfersi = '';
let other = '';

before(async () => {
  h = await portalMcpHarness({ registry });
  const db = h.store.db!;
  users = new PortalUsers(() => h.store.db, new PasswordHasher(TEST_PARAMS));
  adminId = (await users.create({ email: 'root@example.test', password: PASSWORD, role: 'admin' }, 'ui')).id;
  memberId = (await users.create({ email: 'agent@konfersi.test', password: PASSWORD, role: 'member' }, 'ui')).id;
  restoreRoles = useAccountRoles((id) => users.roleOf(id));
  m = createOrgs({ store: h.store });
  registerOwnerResolvers({
    db: () => h.store.db,
    workspace: (ref) => {
      const r = db.prepare('SELECT id, legacy_id FROM workspace_identities WHERE (legacy_id = ? OR id = ?) AND removed_at IS NULL').get(ref, ref) as { id: string; legacy_id: string } | undefined;
      return r ? { id: r.id, legacyId: r.legacy_id } : null;
    },
  });
  registerTicketBucketAuthz({
    bucketOwner: () => null,
    bucketOwnerOf: (key) => {
      const r = db.prepare('SELECT owner_kind, owner_id FROM ticket_buckets WHERE key = ?').get(key) as { owner_kind: string; owner_id: string } | undefined;
      return r ? { kind: r.owner_kind, id: r.owner_id } : null;
    },
  });
  const founder = { kind: 'user' as const, userId: FOUNDING_USER_ID, loginSessionId: 't', via: 'ui' as const };
  konfersi = m.orgs.create(founder, { name: 'Konfersi', slug: 'konfersi' }).id;
  other = m.orgs.create(founder, { name: 'Other', slug: 'other' }).id;
  const at = new Date().toISOString();
  const owners: [string, string, string][] = [
    [WS.k, 'ws_konfaaaaaaaa', konfersi],
    [WS.o, 'ws_otheraaaaaaa', other],
    [WS.kPrivate, 'ws_kprivaaaaaaa', konfersi],
  ];
  for (const [id, uid, org] of owners) {
    const [target, name] = id.split('/');
    db.prepare('INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, ?, ?, ?, ?)').run(uid, target, name, id, at);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, 'org', ?, 'u_owner', ?, 'created')").run(id, uid, org, at);
  }
  for (const [key, org] of [
    [BUCKET.k, konfersi],
    [BUCKET.o, other],
  ])
    db.prepare("INSERT INTO ticket_buckets (key, name, owner_kind, owner_id, created_at, updated_at) VALUES (?, ?, 'org', ?, ?, ?)").run(key, key, org, at, at);
  // Each org shares its API workspace and its bucket with its members (an org grant; the private workspace is shared with nobody).
  const grant = db.prepare("INSERT INTO grants (id, object_type, object_id, object_uid, subject_kind, subject_id, level, share_id, granted_by, created_at) VALUES (?, ?, ?, ?, 'org', ?, ?, 'test', 'user:u_owner', ?)");
  grant.run('gr_kws', 'workspace', WS.k, 'ws_konfaaaaaaaa', konfersi, 'operate', at);
  grant.run('gr_ows', 'workspace', WS.o, 'ws_otheraaaaaaa', other, 'operate', at);
  grant.run('gr_kbk', 'ticket_bucket', BUCKET.k, null, konfersi, 'operate', at);
  grant.run('gr_obk', 'ticket_bucket', BUCKET.o, null, other, 'operate', at);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  h.done();
});

afterEach(async () => {
  h.store.db!.exec('DELETE FROM admin_sessions; DELETE FROM auth_throttle;');
  await users.update(memberId, { state: 'active' });
  reached.length = 0;
});

function portal() {
  const gate = new AdminHostGate(ADMIN_HOST, false);
  const list: Workspace[] = Object.values(WS).map((id) => ({ id, name: id.split('/')[1]!, target: 'docker', image: 'img:1', status: 'running', createdAt: new Date().toISOString() }) as Workspace);
  const consoleApp = createAdminApp({
    store: h.store,
    gate,
    users,
    revokePortalSessions: () => undefined,
    orgs: m.orgs,
    abilities: m.abilities,
    sso: { list: () => [] },
    ssoRedirectUri: '',
    clientKey: () => '10.1.2.3',
    workspaces: { list: async () => list, targets: async () => [], start: async () => undefined, stop: async () => undefined, resolve: () => null },
    pmcp: h.module,
    mcpUrl: 'https://pilot.example.test/mcp',
  }).app;
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
    let json: { data?: any; error?: { code: string; message: string } } | null = null;
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
    const match = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '');
    return match ? `${ADMIN_COOKIE}=${match[1]}` : null;
  };
  const stepUp = async (cookie: string) => assert.equal((await call('POST', '/admin-api/session/step-up', { cookie, body: { password: PASSWORD } })).status, 200);
  return { call, signIn, stepUp };
}

const auditRows = (kind: string) => h.store.db!.prepare('SELECT actor, subject, detail, severity FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { actor: string; subject: string; detail: string; severity: string }[];

const ROUTES: [string, (id: string) => string, unknown?][] = [
  ['POST', () => `/admin-api/orgs/${konfersi}/members`, { userId: 'u_x', role: 'member' }],
  ['DELETE', () => `/admin-api/orgs/${konfersi}/members/u_x`],
  ['GET', (id) => `/admin-api/users/${id}/workspaces`],
  ['POST', (id) => `/admin-api/users/${id}/tokens`, { label: 'x', scope: 'read', expiresInDays: 7 }],
];

test('the new routes are declared platform with the step-up on every write, the same 404 on the main host, 401 without the console session, and refused to a member', async () => {
  for (const k of ['POST /admin-api/orgs/:id/members', 'DELETE /admin-api/orgs/:id/members/:userId', 'POST /admin-api/users/:id/tokens']) {
    const p = ADMIN_ROUTE_POLICIES[k as keyof typeof ADMIN_ROUTE_POLICIES] as { kind: string; reauth?: boolean; audit?: string };
    assert.equal(p.kind, 'platform', k);
    assert.equal(p.reauth, true, `${k} needs the step-up`);
    assert.ok(p.audit, `${k} names its audit row`);
  }
  assert.equal((ADMIN_ROUTE_POLICIES['GET /admin-api/users/:id/workspaces' as keyof typeof ADMIN_ROUTE_POLICIES] as { kind: string }).kind, 'platform');
  const p = portal();
  const unknown = await p.call('GET', '/api/no-such-route', { host: MAIN_HOST });
  for (const [method, path, body] of ROUTES) {
    const onMain = await p.call(method, path(memberId), { host: MAIN_HOST, body });
    assert.equal(onMain.status, 404, `${method} on the main host`);
    assert.deepEqual(onMain.json, unknown.json);
    assert.equal((await p.call(method, path(memberId), { body })).status, 401, `${method} without a session`);
  }
  // A member's password never opens the console (the same refusal as a wrong one), so a member has no session to call these with.
  assert.equal(await p.signIn('agent@konfersi.test'), null);
  const cookie = (await p.signIn())!;
  for (const [method, path, body] of ROUTES) {
    if (method === 'GET') continue;
    assert.equal((await p.call(method, path(memberId), { cookie, body })).json?.error?.code, 'REAUTH_REQUIRED', `${method} ${path(memberId)} needs the step-up`);
  }
  assert.equal(m.orgs.roleOf(konfersi, memberId as UserId), null, 'nothing was changed');
  assert.equal(h.module.tokens.list().length, 0, 'no token was minted');
});

test('Members: add an existing account with a role (never owner), add a new account with no password, remove a member but never an owner; each audited', async () => {
  const p = portal();
  const cookie = (await p.signIn())!;
  await p.stepUp(cookie);
  const add = (body: unknown, org = konfersi) => p.call('POST', `/admin-api/orgs/${org}/members`, { cookie, body });
  assert.equal((await add({ userId: memberId, role: 'owner' })).status, 422, 'never owner');
  assert.equal((await add({ userId: memberId, role: 'boss' })).status, 422);
  assert.equal((await add({ userId: 'u_nobody00000', role: 'member' })).status, 422, 'not an account');
  assert.equal((await add({ role: 'member' })).status, 422, 'nobody named');
  assert.equal((await add({ userId: memberId, role: 'member' }, 'org_nosuchorg0')).status, 404);
  const added = await add({ userId: memberId, role: 'member' });
  assert.equal(added.status, 201);
  assert.ok((added.json?.data.memberList as { userId: string; role: string }[]).some((x) => x.userId === memberId && x.role === 'member'));
  assert.equal(m.orgs.roleOf(konfersi, memberId as UserId), 'member');
  assert.equal(m.orgs.roleOf(other, memberId as UserId), null, 'only the org it was added to');
  assert.equal((await add({ userId: memberId, role: 'admin' })).status, 409, 'already a member: the role changes in the org');
  const rows = auditRows('org.member_added_by_admin');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.subject, `org:${konfersi}`);
  assert.match(rows[0]!.actor, /^user:/);
  assert.deepEqual(
    (({ member, role, by }) => ({ member, role, by }))(JSON.parse(rows[0]!.detail)),
    { member: memberId, role: 'member', by: 'platform' },
  );

  // A new account with no password: it cannot sign in with one, it is a member of the portal, and a guest of the org here.
  const fresh = await add({ email: 'Bot@Konfersi.test', displayName: 'Bot', role: 'guest' });
  assert.equal(fresh.status, 201);
  const bot = users.list().find((u) => u.email === 'bot@konfersi.test')!;
  assert.equal(bot.role, 'member');
  assert.equal(m.orgs.roleOf(konfersi, bot.id as UserId), 'guest');
  assert.equal(JSON.parse(auditRows('account.created').at(-1)!.detail).password, 'none');
  await assert.rejects(users.verify('bot@konfersi.test', PASSWORD, '10.9.9.9'));
  assert.equal((await add({ email: 'bot@konfersi.test', role: 'member' })).status, 409, 'an existing email: pick the account instead');
  assert.equal((await add({ email: 'not-an-email', role: 'member' })).status, 422);

  // Remove: a member yes, an owner never, someone not in it is the 404.
  assert.equal((await p.call('DELETE', `/admin-api/orgs/${konfersi}/members/${bot.id}`, { cookie })).status, 200);
  assert.equal(m.orgs.roleOf(konfersi, bot.id as UserId), null);
  assert.equal((await p.call('DELETE', `/admin-api/orgs/${konfersi}/members/${FOUNDING_USER_ID}`, { cookie })).status, 409, 'not an owner');
  assert.equal((await p.call('DELETE', `/admin-api/orgs/${konfersi}/members/${bot.id}`, { cookie })).status, 404);
  assert.equal(JSON.parse(auditRows('org.member_removed_by_admin')[0]!.detail).role, 'guest');
});

test('Tokens: a token for a member is owned by THAT account; admin scope is refused; the default workspace must be one it may operate; the secret is in no audit row', async () => {
  const p = portal();
  const cookie = (await p.signIn())!;
  await p.stepUp(cookie);
  // The member of Konfersi from the test before (tests run in order); make sure.
  if (!m.orgs.roleOf(konfersi, memberId as UserId)) m.orgs.admit(konfersi as never, memberId as UserId, 'member', 'invite', 'test');
  const mint = (body: unknown) => p.call('POST', `/admin-api/users/${memberId}/tokens`, { cookie, body });
  assert.equal((await mint({ label: 'Afgan', scope: 'admin', expiresInDays: 30 })).status, 422, 'admin scope is for admin accounts only');
  assert.equal((await mint({ label: 'Afgan', scope: 'operate', expiresInDays: 3 })).status, 422, 'a lifetime from the list only');
  assert.equal((await mint({ label: 'Afgan', scope: 'operate', expiresInDays: 30, defaultWorkspaceId: WS.o })).status, 422, 'not another org’s workspace');
  assert.equal((await mint({ label: 'Afgan', scope: 'operate', expiresInDays: 30, defaultWorkspaceId: WS.kPrivate })).status, 422, 'not one its org did not share');
  assert.equal((await mint({ label: 'Afgan', scope: 'read', expiresInDays: 30, defaultWorkspaceId: WS.k })).status, 422, 'a read token makes no tickets');
  assert.equal(h.module.tokens.list().length, 0, 'nothing was minted by a refusal');

  const choices = await p.call('GET', `/admin-api/users/${memberId}/workspaces`, { cookie });
  assert.deepEqual((choices.json?.data as { id: string }[]).map((w) => w.id), [WS.k], 'the workspaces it may operate: its org’s shared one only');

  const made = await mint({ label: 'Afgan', scope: 'operate', expiresInDays: 30, defaultWorkspaceId: WS.k });
  assert.equal(made.status, 201);
  const { token, secret, mcpUrl } = made.json?.data as { token: { id: string; scope: string; defaultWorkspaceId: string }; secret: string; mcpUrl: string };
  assert.equal(mcpUrl, 'https://pilot.example.test/mcp');
  assert.equal(token.scope, 'operate');
  assert.equal(token.defaultWorkspaceId, WS.k);
  assert.equal(h.module.tokens.get(token.id)?.ownerId, memberId, 'the token acts as the member, not the admin');
  const verified = h.module.tokens.verify(secret);
  assert.ok(verified.ok && verified.principal.userId === memberId);
  // It shows on the member's Tokens list (and can be revoked there).
  const detail = await p.call('GET', `/admin-api/users/${memberId}`, { cookie });
  assert.ok((detail.json?.data.tokens as { id: string }[]).some((t) => t.id === token.id));

  const rows = auditRows('pmcp.token.minted_for_user');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.subject, `user:${memberId}`);
  assert.equal(JSON.parse(rows[0]!.detail).tokenId, token.id);
  const everything = JSON.stringify(h.store.db!.prepare('SELECT * FROM platform_audit').all()) + JSON.stringify(h.store.db!.prepare('SELECT * FROM pmcp_audit').all());
  assert.ok(!everything.includes(secret), 'the secret is in no audit row');
  assert.ok(!everything.includes(secret.slice(-12)), 'nor a piece of it');

  // An admin account may get admin scope.
  const adminTok = await p.call('POST', `/admin-api/users/${adminId}/tokens`, { cookie, body: { label: 'ops-script', scope: 'admin', expiresInDays: 7 } });
  assert.equal(adminTok.status, 201);
  assert.equal(h.module.tokens.get((adminTok.json?.data as { token: { id: string } }).token.id)?.ownerId, adminId);

  // Revoke from the same list.
  assert.equal((await p.call('DELETE', `/admin-api/users/${memberId}/tokens/${token.id}`, { cookie })).status, 200);
  assert.equal(h.module.tokens.verify(secret).ok, false);
});

test('the member’s token at /mcp reaches its org’s shared workspace and bucket, and another org’s exactly like a missing one; it stops while the account is suspended', async () => {
  const p = portal();
  const cookie = (await p.signIn())!;
  await p.stepUp(cookie);
  if (!m.orgs.roleOf(konfersi, memberId as UserId)) m.orgs.admit(konfersi as never, memberId as UserId, 'member', 'invite', 'test');
  const made = await p.call('POST', `/admin-api/users/${memberId}/tokens`, { cookie, body: { label: 'Afgan probe', scope: 'operate', expiresInDays: 7 } });
  assert.equal(made.status, 201);
  const { secret } = made.json?.data as { secret: string };

  // The seam, as the token's actor.
  const v = h.module.tokens.verify(secret);
  assert.ok(v.ok);
  const actor = actorOfPrincipal(v.principal);
  assert.equal(can(actor, 'operate', workspaceRef(WS.k)).allow, true, 'its org’s shared workspace');
  assert.equal(can(actor, 'view', workspaceRef(WS.o)).allow, false, 'not another org’s');
  assert.equal(can(actor, 'view', workspaceRef(WS.kPrivate)).allow, false, 'not its own org’s unshared one');
  assert.equal(can(actor, 'manage', workspaceRef(WS.k)).allow, false, 'never more than its scope and grant');
  assert.equal(can(actor, 'view', objectRef('ticket_bucket', BUCKET.k)).allow, true);
  assert.equal(can(actor, 'view', objectRef('ticket_bucket', BUCKET.o)).allow, false);

  // The tools, over the real endpoint.
  const ws = (id: string) => h.call(secret, 't_member_ws', { workspace: id });
  const bucket = (key: string) => h.call(secret, 't_member_bucket', { bucket: key });
  assert.equal((await ws(WS.k)).result?.isError, undefined);
  assert.equal((await bucket(BUCKET.k)).result?.isError, undefined);
  const theirs = await ws(WS.o);
  assert.equal(theirs.result?.structuredContent.error.code, 'NOT_FOUND');
  assert.deepEqual(theirs.result, (await ws('docker/no-such')).result, 'another org’s workspace reads like a missing one');
  assert.deepEqual((await bucket(BUCKET.o)).result, (await bucket('NOPE')).result, 'another org’s bucket reads like a missing one');
  assert.deepEqual(reached.sort(), [`t_member_bucket:${BUCKET.k}`, `t_member_ws:${WS.k}`], 'only its own org’s reached a handler');

  // Suspended: the token stops at once (verify) and for good (revoked with the account's tokens).
  assert.equal((await p.call('POST', `/admin-api/users/${memberId}/suspend`, { cookie, body: {} })).status, 200);
  assert.equal(h.module.tokens.verify(secret).ok, false);
  await users.update(memberId, { state: 'active' });
  assert.equal(h.module.tokens.verify(secret).ok, false, 'resuming revives nothing');
});

test('a token minted for an account stops while that account is disabled, even before anything revokes it', async () => {
  const { token, secret } = h.module.createToken({ label: 'direct', scope: 'read', expiresInDays: 7 }, '', `user:${adminId}`, undefined, { ownerId: memberId as UserId, accountId: adminId });
  assert.equal(token.ownerId, memberId);
  assert.equal(h.module.tokens.verify(secret).ok, true);
  h.store.db!.prepare("UPDATE users SET state = 'disabled' WHERE id = ?").run(memberId);
  assert.equal(h.module.tokens.verify(secret).ok, false);
  h.store.db!.prepare("UPDATE users SET state = 'active' WHERE id = ?").run(memberId);
  assert.equal(h.module.tokens.verify(secret).ok, true, 'a disabled owner stops it; nothing here revoked it');
  h.module.revokeToken(token.id);
});
