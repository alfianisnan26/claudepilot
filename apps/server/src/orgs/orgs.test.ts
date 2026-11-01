// Organizations slice 3 (docs/prd/organizations.md §13.2 row 3): the org core against a real migrated database. The last owner cannot leave
// (service, and the trigger on a second connection); an org answers 404 to anyone who is not a member, the platform admin included;
// POST /api/orgs is refused without the ability `orgs.create`; granting and revoking the ability write the platform audit.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, orgRef, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import { can, policyFor, useAccountRoles, type AccountRoleOf } from '../authz/seam.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { ORG_ROUTE_POLICIES, createOrgRoutes, createOrgs, orgLevel, type OrgsService, type UserAbilities } from './index.js';

const ADMIN = 'u_Adm1n000001';
const ALICE = 'u_Al1ce000001';
const BOB = 'u_B0b00000001';
const CAROL = 'u_Car0l000001';
const DAN = 'u_Dan00000001';
const OFF = 'u_D1sabled001';

let store: Store;
let orgs: OrgsService;
let abilities: UserAbilities;
let restoreRoles: AccountRoleOf;

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const token = (userId: string): Actor => ({ kind: 'token', userId, tokenId: 'ptk_x', scope: 'admin' });
const agent = (userId: string): Actor => ({ kind: 'agent', userId, tokenId: 'pst_x', sessionId: 's1', workspaceId: 'docker/ws' });

const code = (c: string, reason?: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
  return true;
};

function addUser(id: string, role: 'admin' | 'member', state: 'active' | 'disabled' = 'active') {
  const at = new Date().toISOString();
  store.db!
    .prepare(
      'INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, state, 'not-a-hash', at, at, 'ui');
}

const auditRows = (kind: string) =>
  store.db!.prepare('SELECT kind, severity, actor, user_id, subject, detail FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as {
    kind: string;
    severity: string;
    actor: string;
    user_id: string | null;
    subject: string | null;
    detail: string;
  }[];

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs-'), secretKey: null });
  addUser(ADMIN, 'admin');
  for (const u of [ALICE, BOB, CAROL, DAN]) addUser(u, 'member');
  addUser(OFF, 'member', 'disabled');
  restoreRoles = useAccountRoles((id) => {
    const r = store.db!.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  ({ orgs, abilities } = createOrgs({ store }));
});

after(() => {
  useAccountRoles(restoreRoles);
  store.close();
});

afterEach(() => {
  // Each test starts with no org and no ability (the audit stays: tests read their own kinds).
  store.db!.exec("UPDATE orgs SET state = 'deleting'; DELETE FROM org_members; DELETE FROM orgs; DELETE FROM user_abilities; DELETE FROM platform_audit;");
});

/** An org Alice owns (she holds the ability), with Bob as a member. */
function aliceOrg(slug = 'acme') {
  abilities.grant(person(ADMIN), ALICE, 'orgs.create');
  const org = orgs.create(person(ALICE), { name: 'Acme', slug });
  orgs.admit(org.id, BOB, 'member', 'invite', `user:${ALICE}`);
  return org;
}

test('migrations 463-464: the tables exist and nobody holds an ability by default', () => {
  const tables = (store.db!.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name LIKE '%org%' OR name = 'user_abilities'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['orgs', 'org_members', 'user_abilities', 'org_members_keep_owner_update', 'org_members_keep_owner_delete', 'orgs_keep_owner_state']) assert.ok(tables.includes(t), t);
  for (const u of [ALICE, BOB, ADMIN]) assert.equal(abilities.holds(u, 'orgs.create'), false, u);
  assert.equal(abilities.may(ADMIN, 'orgs.create'), true, 'an instance admin may without a row');
  assert.equal(abilities.may(FOUNDING_USER_ID, 'orgs.create'), true);
  assert.equal(abilities.may(ALICE, 'orgs.create'), false);
});

test('POST /api/orgs is refused without the ability; with it the creator is the first owner; an instance admin may always', () => {
  assert.throws(() => orgs.create(person(ALICE), { name: 'Acme', slug: 'acme' }), code('FORBIDDEN', 'ORG_CREATE_NOT_ALLOWED'));
  assert.equal(store.db!.prepare('SELECT count(*) AS n FROM orgs').get()!.n, 0, 'nothing was made');
  abilities.grant(person(ADMIN), ALICE, 'orgs.create');
  const org = orgs.create(person(ALICE), { name: '  Acme  Inc ', slug: 'Acme-1' });
  assert.match(org.id, /^org_/);
  assert.deepEqual([org.name, org.slug, org.myRole, org.members, org.state], ['Acme Inc', 'acme-1', 'owner', 1, 'active']);
  assert.equal(org.policies?.membersCreateTeams, true);
  assert.equal(orgs.roleOf(org.id, ALICE), 'owner');
  const created = auditRows('org.created');
  assert.equal(created.length, 1);
  assert.equal(created[0]!.actor, `user:${ALICE}`);
  assert.equal(created[0]!.subject, `org:${org.id}`);
  // A token or an agent of a person who holds it is still not a person (no tool creates orgs, PRD §10).
  assert.throws(() => orgs.create(token(ALICE), { name: 'T', slug: 'tok' }), code('FORBIDDEN', 'ORG_CREATE_NOT_ALLOWED'));
  assert.throws(() => orgs.create(agent(ALICE), { name: 'T', slug: 'agt' }), code('FORBIDDEN', 'ORG_CREATE_NOT_ALLOWED'));
  // The slug is unique; a bad slug is a validation error.
  assert.throws(() => orgs.create(person(ALICE), { name: 'Again', slug: 'acme-1' }), code('CONFLICT', 'ORG_SLUG_TAKEN'));
  for (const slug of ['a', '-ab', 'ab-', 'a_b', 'a b', '', 'x'.repeat(41)]) assert.throws(() => orgs.create(person(ALICE), { name: 'N', slug }), code('VALIDATION_FAILED'), slug);
  // An instance admin needs no row; the founding user neither.
  assert.equal(orgs.create(person(ADMIN), { name: 'Admin org', slug: 'adm' }).myRole, 'owner');
  assert.equal(orgs.create(person(FOUNDING_USER_ID), { name: 'Founder org', slug: 'fnd' }).myRole, 'owner');
  // Revoked: refused again. A disabled account with a row holds nothing.
  abilities.revoke(person(ADMIN), ALICE, 'orgs.create');
  assert.throws(() => orgs.create(person(ALICE), { name: 'Later', slug: 'later' }), code('FORBIDDEN', 'ORG_CREATE_NOT_ALLOWED'));
  store.db!.prepare("INSERT INTO user_abilities (user_id, ability, granted_by, granted_at) VALUES (?, 'orgs.create', 'x', 'x')").run(OFF);
  assert.equal(abilities.holds(OFF, 'orgs.create'), false);
});

test('POST /api/orgs over HTTP: 403 without the ability, 201 with it', async () => {
  let who: Actor = person(BOB);
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use(async (c, next) => {
    c.set('actor', who);
    await next();
  });
  app.route('/api/orgs', createOrgRoutes(orgs));
  app.onError((e, c) => c.json({ code: (e as AppError).code, details: (e as AppError).details ?? null }, ((e as AppError).status ?? 500) as 403));
  const post = () => app.request('/api/orgs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bob co', slug: 'bobco' }) });
  const refused = await post();
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { code: 'FORBIDDEN', details: { reason: 'ORG_CREATE_NOT_ALLOWED' } });
  abilities.grant(person(ADMIN), BOB, 'orgs.create');
  const made = await post();
  assert.equal(made.status, 201);
  const id = ((await made.json()) as { data: { id: string } }).data.id;
  // A non-member reads the same 404 for this org as for one that does not exist.
  who = person(CAROL);
  const theirs = await app.request(`/api/orgs/${id}`);
  const missing = await app.request('/api/orgs/org_doesnotexist');
  assert.equal(theirs.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await theirs.json(), await missing.json());
  for (const [method, path] of [['GET', `/api/orgs/${id}/members`], ['PATCH', `/api/orgs/${id}`], ['POST', `/api/orgs/${id}/leave`], ['DELETE', `/api/orgs/${id}/members/${BOB}`]] as const) {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.deepEqual(((await (await app.request('/api/orgs')).json()) as { data: unknown[] }).data, [], 'not in the list either');
});

test('an org is 404 for every non-member, the platform admin and the founding user included; agents are boxed out', () => {
  const org = aliceOrg();
  for (const u of [CAROL, ADMIN, FOUNDING_USER_ID]) {
    assert.throws(() => orgs.get(person(u), org.id), code('NOT_FOUND'), u);
    assert.throws(() => orgs.members(person(u), org.id), code('NOT_FOUND'), u);
    assert.throws(() => orgs.update(person(u), org.id, { name: 'Mine' }), code('NOT_FOUND'), u);
    assert.throws(() => orgs.setRole(person(u), org.id, BOB, 'admin'), code('NOT_FOUND'), u);
    assert.throws(() => orgs.removeMember(person(u), org.id, BOB), code('NOT_FOUND'), u);
    assert.throws(() => orgs.leave(person(u), org.id), code('NOT_FOUND'), u);
    assert.deepEqual(orgs.mine(person(u)), [], u);
  }
  // A disabled account acts for nobody (401), whatever it was.
  assert.throws(() => orgs.get(person(OFF), org.id), code('UNAUTHORIZED'));
  assert.deepEqual(orgs.mine(person(OFF)), []);
  // The same answer as a missing org.
  assert.throws(() => orgs.get(person(CAROL), 'org_missing0001'), code('NOT_FOUND'));
  assert.throws(() => orgs.get(person(CAROL), 'not-an-org'), code('NOT_FOUND'));
  // Members read it; an agent of a member never does (boxed to its session); a token of a member does, capped by its scope.
  assert.equal(orgs.get(person(BOB), org.id).myRole, 'member');
  assert.equal(can(agent(BOB), 'view', orgRef(org.id)).allow, false);
  assert.deepEqual(orgs.mine(agent(BOB)), []);
  assert.equal(orgs.mine(token(BOB)).length, 1);
  // Removed: 404 at once (membership is read on every call).
  orgs.removeMember(person(ALICE), org.id, BOB);
  assert.throws(() => orgs.get(person(BOB), org.id), code('NOT_FOUND'));
});

test('levels by role and state: owner and admin manage, member and guest view; a suspended org leaves only its owners a view', () => {
  assert.deepEqual(
    (['owner', 'admin', 'member', 'guest'] as const).map((r) => [orgLevel('active', r), orgLevel('suspended', r), orgLevel('deleting', r)]),
    [
      ['manage', 'view', 'none'],
      ['manage', 'none', 'none'],
      ['view', 'none', 'none'],
      ['view', 'none', 'none'],
    ],
  );
  assert.equal(orgLevel('active', null), 'none');
  const org = aliceOrg();
  orgs.admit(org.id, CAROL, 'guest', 'invite', `user:${ALICE}`);
  assert.equal(can(person(ALICE), 'manage', orgRef(org.id)).allow, true);
  assert.equal(can(person(BOB), 'manage', orgRef(org.id)).allow, false);
  assert.equal(can(person(BOB), 'view', orgRef(org.id)).allow, true);
  // A guest sees the name only: no directory, no count.
  assert.equal(orgs.get(person(CAROL), org.id).members, 0);
  assert.throws(() => orgs.members(person(CAROL), org.id), code('FORBIDDEN'));
  assert.deepEqual(
    orgs.members(person(BOB), org.id).map((m) => [m.userId, m.role]),
    [
      [ALICE, 'owner'],
      [BOB, 'member'],
      [CAROL, 'guest'],
    ],
  );
  assert.equal(orgs.get(person(BOB), org.id).policies, undefined, 'policies are for owners and admins');
  store.db!.prepare("UPDATE orgs SET state = 'suspended' WHERE id = ?").run(org.id);
  assert.equal(can(person(BOB), 'view', orgRef(org.id)).allow, false);
  assert.equal(can(person(ALICE), 'view', orgRef(org.id)).allow, true);
  assert.equal(can(person(ALICE), 'manage', orgRef(org.id)).allow, false);
});

test('roles: an admin changes roles up to admin and never touches an owner; a member manages nothing; an owner changes anything', () => {
  const org = aliceOrg();
  orgs.admit(org.id, CAROL, 'member', 'invite', `user:${ALICE}`);
  orgs.setRole(person(ALICE), org.id, BOB, 'admin');
  assert.equal(orgs.roleOf(org.id, BOB), 'admin');
  assert.equal(auditRows('org.member_role_changed').length, 1);
  assert.throws(() => orgs.setRole(person(BOB), org.id, CAROL, 'owner'), code('FORBIDDEN'));
  assert.throws(() => orgs.setRole(person(BOB), org.id, ALICE, 'member'), code('FORBIDDEN'));
  assert.throws(() => orgs.removeMember(person(BOB), org.id, ALICE), code('FORBIDDEN'));
  orgs.setRole(person(BOB), org.id, CAROL, 'guest');
  assert.equal(orgs.roleOf(org.id, CAROL), 'guest');
  assert.throws(() => orgs.setRole(person(CAROL), org.id, BOB, 'member'), code('FORBIDDEN'), 'a guest views, it does not manage');
  assert.throws(() => orgs.setRole(person(ALICE), org.id, DAN, 'member'), code('NOT_FOUND'), 'not a member');
  assert.throws(() => orgs.setRole(person(ALICE), org.id, CAROL, 'boss' as never), code('VALIDATION_FAILED'));
  orgs.setRole(person(ALICE), org.id, BOB, 'owner');
  assert.equal(orgs.roleOf(org.id, BOB), 'owner');
  orgs.update(person(BOB), org.id, { name: 'Acme 2' });
  assert.equal(orgs.get(person(ALICE), org.id).name, 'Acme 2');
});

test('the last owner cannot leave, be demoted or be removed (service); with a second owner they can', () => {
  const org = aliceOrg();
  assert.throws(() => orgs.leave(person(ALICE), org.id), code('CONFLICT', 'ORG_NEEDS_OWNER'));
  assert.throws(() => orgs.setRole(person(ALICE), org.id, ALICE, 'admin'), code('CONFLICT', 'ORG_NEEDS_OWNER'));
  assert.throws(() => orgs.removeMember(person(ALICE), org.id, ALICE), code('CONFLICT', 'ORG_NEEDS_OWNER'));
  assert.equal(orgs.roleOf(org.id, ALICE), 'owner', 'nothing changed');
  assert.equal(auditRows('org.member_left').length, 0);
  // A member leaves freely.
  orgs.leave(person(BOB), org.id);
  assert.equal(orgs.roleOf(org.id, BOB), null);
  assert.equal((store.db!.prepare('SELECT state FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, BOB) as { state: string }).state, 'removed', 'the row stays');
  // Two owners: one may go.
  orgs.admit(org.id, CAROL, 'owner', 'migration', 'system:test');
  orgs.leave(person(ALICE), org.id);
  assert.equal(orgs.roleOf(org.id, ALICE), null);
  assert.equal(auditRows('org.member_left').length, 2);
  assert.throws(() => orgs.leave(person(CAROL), org.id), code('CONFLICT', 'ORG_NEEDS_OWNER'));
});

test('the trigger keeps an owner across two connections: each removing "the other" owner cannot leave none', () => {
  const org = aliceOrg();
  orgs.admit(org.id, BOB, 'owner', 'migration', 'system:test');
  const second = new DatabaseSync(store.path);
  second.exec('PRAGMA busy_timeout = 2000');
  try {
    // Connection one checks: another owner (Bob) exists, so Alice may go. Before it writes, connection two removes Bob (Alice still owns).
    const others = store.db!.prepare("SELECT count(*) AS n FROM org_members WHERE org_id = ? AND user_id != ? AND role = 'owner' AND state = 'active'").get(org.id, ALICE) as { n: number };
    assert.equal(others.n, 1);
    second.prepare("UPDATE org_members SET state = 'removed' WHERE org_id = ? AND user_id = ?").run(org.id, BOB);
    // Connection one now writes what its stale check allowed: the database refuses.
    assert.throws(() => store.db!.prepare("UPDATE org_members SET state = 'removed' WHERE org_id = ? AND user_id = ?").run(org.id, ALICE), /ORG_NEEDS_OWNER/);
    assert.throws(() => second.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(org.id, ALICE), /ORG_NEEDS_OWNER/);
    assert.throws(() => second.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND user_id = ?").run(org.id, ALICE), /ORG_NEEDS_OWNER/);
    assert.equal(orgs.roleOf(org.id, ALICE), 'owner');
    // And the service on top answers the same 409.
    assert.throws(() => orgs.leave(person(ALICE), org.id), code('CONFLICT', 'ORG_NEEDS_OWNER'));
    // An org being deleted is not held to it (purge, slice 8); a deleted org takes its members with it.
    second.prepare("UPDATE orgs SET state = 'deleting' WHERE id = ?").run(org.id);
    second.prepare("UPDATE org_members SET state = 'removed' WHERE org_id = ? AND user_id = ?").run(org.id, ALICE);
    assert.throws(() => second.prepare("UPDATE orgs SET state = 'active' WHERE id = ?").run(org.id), /ORG_NEEDS_OWNER/, 'not brought back without an owner');
  } finally {
    second.close();
  }
});

test('abilities: only an instance admin grants and revokes, as a person; each change writes a platform audit row', () => {
  assert.throws(() => abilities.grant(person(ALICE), BOB, 'orgs.create'), code('NOT_FOUND'), 'a member: the platform answers like a missing route');
  assert.throws(() => abilities.grant(token(ADMIN), BOB, 'orgs.create'), code('NOT_FOUND'), 'a token never grants');
  assert.throws(() => abilities.grant(agent(ADMIN), BOB, 'orgs.create'), code('NOT_FOUND'));
  assert.throws(() => abilities.grant(person(ADMIN), 'u_nobody00001', 'orgs.create'), code('NOT_FOUND'));
  assert.throws(() => abilities.grant(person(ADMIN), BOB, 'orgs.delete' as never), code('VALIDATION_FAILED'));
  assert.equal(auditRows('ability.granted').length, 0, 'a refusal writes nothing');

  assert.deepEqual(abilities.grant(person(ADMIN), BOB, 'orgs.create', 'runs the Konfersi org'), { changed: true });
  assert.deepEqual(abilities.grant(person(ADMIN), BOB, 'orgs.create'), { changed: false });
  const granted = auditRows('ability.granted');
  assert.equal(granted.length, 1, 'one row per change');
  assert.deepEqual(
    { ...granted[0], detail: JSON.parse(granted[0]!.detail) },
    { kind: 'ability.granted', severity: 'medium', actor: `user:${ADMIN}`, user_id: BOB, subject: `user:${BOB}`, detail: { ability: 'orgs.create', reason: 'runs the Konfersi org' } },
  );
  assert.deepEqual(
    abilities.of(person(ADMIN), BOB).map((a) => [a.userId, a.ability, a.grantedBy]),
    [[BOB, 'orgs.create', `user:${ADMIN}`]],
  );
  assert.equal(abilities.list(person(ADMIN), 'orgs.create').length, 1);
  assert.throws(() => abilities.list(person(BOB)), code('NOT_FOUND'));

  assert.deepEqual(abilities.revoke(person(ADMIN), BOB, 'orgs.create'), { changed: true });
  assert.deepEqual(abilities.revoke(person(ADMIN), BOB, 'orgs.create'), { changed: false });
  const revoked = auditRows('ability.revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.actor, `user:${ADMIN}`);
  assert.equal(revoked[0]!.user_id, BOB);
  assert.equal(abilities.holds(BOB, 'orgs.create'), false);
  // The founding user grants as an instance admin too.
  assert.deepEqual(abilities.grant(person(FOUNDING_USER_ID), CAROL, 'orgs.create'), { changed: true });
});

test('the platform admin’s org list (names, counts, owners) and owner recovery for an org whose owners are all gone', () => {
  const org = aliceOrg();
  assert.throws(() => orgs.listAll(person(ALICE)), code('NOT_FOUND'));
  assert.throws(() => orgs.listAll(token(ADMIN)), code('NOT_FOUND'));
  const [row] = orgs.listAll(person(ADMIN));
  assert.deepEqual(
    { ...row, createdAt: undefined },
    {
      id: org.id,
      slug: 'acme',
      name: 'Acme',
      state: 'active',
      members: 2,
      owners: [{ userId: ALICE, email: `${ALICE}@example.test`, active: true }],
      needsOwner: false,
      createdBy: `user:${ALICE}`,
      createdAt: undefined,
    },
  );
  assert.throws(() => orgs.recoverOwner(person(ADMIN), org.id, BOB, 'Alice left the company'), code('CONFLICT'), 'it has an active owner');
  // Alice's account is disabled: the org has no owner who can act.
  store.db!.prepare("UPDATE users SET state = 'disabled' WHERE id = ?").run(ALICE);
  try {
    assert.equal(orgs.listAll(person(ADMIN))[0]!.needsOwner, true);
    assert.throws(() => orgs.recoverOwner(person(ADMIN), org.id, BOB, 'short'), code('VALIDATION_FAILED'));
    assert.throws(() => orgs.recoverOwner(person(BOB), org.id, BOB, 'I would like to own this'), code('NOT_FOUND'));
    assert.throws(() => orgs.recoverOwner(person(ADMIN), org.id, OFF, 'Alice left the company'), code('NOT_FOUND'));
    orgs.recoverOwner(person(ADMIN), org.id, BOB, 'Alice left the company');
    assert.equal(orgs.roleOf(org.id, BOB), 'owner');
    assert.equal(orgs.listAll(person(ADMIN))[0]!.needsOwner, false);
    const rows = auditRows('org.ownership_recovered');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.severity, 'medium');
    assert.equal(rows[0]!.actor, `user:${ADMIN}`);
    assert.equal(JSON.parse(rows[0]!.detail).reason, 'Alice left the company');
    // Recovering ownership is not reading content: the admin is still not a member.
    assert.throws(() => orgs.get(person(ADMIN), org.id), code('NOT_FOUND'));
  } finally {
    store.db!.prepare("UPDATE users SET state = 'active' WHERE id = ?").run(ALICE);
  }
});

test('every org route is declared (slice 1’s enumeration), and every declaration has its route', () => {
  const app = new Hono();
  app.route('/api/orgs', createOrgRoutes(orgs));
  const routes = new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path.replace(/(.)\/$/, '$1')}`));
  const declared = new Set(Object.keys(ORG_ROUTE_POLICIES));
  assert.deepEqual([...routes].sort(), [...declared].sort());
  for (const key of declared) assert.ok(policyFor(key), `${key} is registered with the seam`);
  assert.equal(ORG_ROUTE_POLICIES['POST /api/orgs']?.bearer, undefined, 'cookie only');
});
