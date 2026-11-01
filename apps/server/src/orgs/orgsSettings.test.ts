// Org settings (owner request 2026-11-01, docs/prd/organizations.md §13.9) against a real migrated database: the Policies section's
// writes (PATCH /api/orgs/:id `policies`: owners only, as a person, only the three settable keys, booleans, merged into what is stored),
// `Org.may` (what the page offers matches what the services allow: invite and create a team), and the Audit section's `kind` filter.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { type Actor, type OrgId, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { registerOwnerResolvers } from '../authz/owners.js';
import { enforceRoutePolicy } from '../authz/routeGuard.js';
import { clearResolvers, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createOrgRoutes, createOrgs, type OrgsModule } from './index.js';

const ADMIN = 'u_Adm1n00000s' as UserId; // an instance admin, not in the orgs
const ALICE = 'u_Al1ce00000s' as UserId; // owner
const BOB = 'u_B0b0000000s' as UserId; // admin
const CAROL = 'u_Car0l00000s' as UserId; // member
const DAN = 'u_Dan0000000s' as UserId; // guest
const EVE = 'u_Eve0000000s' as UserId; // not in the org

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const token = (userId: string): Actor => ({ kind: 'token', userId, tokenId: 'ptk_x', scope: 'admin' });
const code = (c: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  return true;
};
const stored = (org: OrgId) => JSON.parse((store.db!.prepare('SELECT policies FROM orgs WHERE id = ?').get(org) as { policies: string }).policies) as Record<string, unknown>;

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

let n = 0;
/** A fresh org: Alice owner, Bob admin, Carol member, Dan guest; the instance admin who made it leaves. */
function freshOrg(): OrgId {
  const id = m.orgs.create(person(ADMIN), { name: `Settings ${++n}`, slug: `settings-${n}` }).id;
  m.orgs.admit(id, ALICE, 'owner', 'invite', 'test');
  m.orgs.admit(id, BOB, 'admin', 'invite', 'test');
  m.orgs.admit(id, CAROL, 'member', 'invite', 'test');
  m.orgs.admit(id, DAN, 'guest', 'invite', 'test');
  m.orgs.leave(person(ADMIN), id);
  return id;
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs-settings-'), secretKey: null });
  const db = store.db!;
  addUser(ADMIN, 'admin');
  for (const u of [ALICE, BOB, CAROL, DAN, EVE]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store });
  registerOwnerResolvers({ db: () => store.db, workspace: () => null });
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  store.close();
});

test('policies: an owner sets the three keys; they merge into what is stored (requireSso and the rest are kept) and write the audit', () => {
  const org = freshOrg();
  store.db!.prepare('UPDATE orgs SET policies = ? WHERE id = ?').run(JSON.stringify({ requireSso: true, ssoFreshnessDays: 7, custom: 'kept' }), org);
  const after = m.orgs.update(person(ALICE), org, { policies: { membersMayInvite: true, externalShares: true } });
  assert.equal(after.policies?.membersMayInvite, true);
  assert.equal(after.policies?.externalShares, true);
  assert.equal(after.policies?.membersCreateTeams, true, 'a key left out keeps its value (the default here)');
  assert.deepEqual(stored(org), { requireSso: true, ssoFreshnessDays: 7, custom: 'kept', membersMayInvite: true, externalShares: true });
  m.orgs.update(person(ALICE), org, { policies: { membersCreateTeams: false } });
  assert.equal(stored(org).membersCreateTeams, false);
  assert.equal(stored(org).membersMayInvite, true, 'the earlier change stays');
  const rows = m.orgs.audit(person(ALICE), org, { kind: 'org.updated' });
  assert.deepEqual(
    rows.map((r) => [r.detail.policies, r.detail.membersMayInvite, r.detail.membersCreateTeams, r.detail.externalShares]),
    [
      [['membersCreateTeams'], undefined, false, undefined],
      [['membersMayInvite', 'externalShares'], true, undefined, true],
    ],
    'one row per change, newest first, naming only what changed',
  );
});

test('policies: owners only, as a person; only the settable keys, booleans; a refused request writes nothing (the name neither)', () => {
  const org = freshOrg();
  const name = m.orgs.get(person(ALICE), org).name;
  assert.throws(() => m.orgs.update(person(BOB), org, { policies: { membersMayInvite: true } }), code('FORBIDDEN'), 'an admin');
  assert.throws(() => m.orgs.update(person(BOB), org, { name: 'Renamed', policies: { membersMayInvite: true } }), code('FORBIDDEN'), 'an admin, with a rename');
  assert.equal(m.orgs.get(person(ALICE), org).name, name, 'the rename in the refused request was not written');
  assert.throws(() => m.orgs.update(person(CAROL), org, { policies: { membersMayInvite: true } }), 'a member (no manage)');
  assert.throws(() => m.orgs.update(person(EVE), org, { policies: { membersMayInvite: true } }), code('NOT_FOUND'), 'an outsider: the same 404');
  assert.throws(() => m.orgs.update(token(ALICE), org, { policies: { membersMayInvite: true } }), 'a token of the owner is not a person');
  assert.throws(() => m.orgs.update(person(ALICE), org, { policies: { requireSso: true } as never }), code('VALIDATION_FAILED'), 'requireSso has its own route');
  assert.throws(() => m.orgs.update(person(ALICE), org, { policies: { defaultJoinRole: 'admin' } as never }), code('VALIDATION_FAILED'));
  assert.throws(() => m.orgs.update(person(ALICE), org, { policies: { membersMayInvite: 'yes' } as never }), code('VALIDATION_FAILED'), 'not a boolean');
  assert.throws(() => m.orgs.update(person(ALICE), org, { policies: [true] as never }), code('VALIDATION_FAILED'), 'not an object');
  assert.deepEqual(stored(org), {}, 'nothing was written');
  // An empty change is fine and writes no row.
  const before = m.orgs.audit(person(ALICE), org, { kind: 'org.updated' }).length;
  m.orgs.update(person(ALICE), org, { policies: {} });
  assert.equal(m.orgs.audit(person(ALICE), org, { kind: 'org.updated' }).length, before);
});

test('Org.may matches the services: invite and create a team, by role and policy; nothing while suspended', () => {
  const org = freshOrg();
  const may = (u: string) => m.orgs.get(person(u), org).may;
  assert.deepEqual(may(ALICE), { invite: true, createTeam: true });
  assert.deepEqual(may(BOB), { invite: true, createTeam: true });
  assert.deepEqual(may(CAROL), { invite: false, createTeam: true }, 'defaults: members create teams, do not invite');
  assert.deepEqual(may(DAN), { invite: false, createTeam: false });
  assert.equal(m.orgs.get(person(CAROL), org).policies, undefined, 'a member still does not read the policies');
  assert.throws(() => m.invitations.create(person(CAROL), org, { email: 'someone@example.test', role: 'member' }), code('FORBIDDEN'), 'and the service agrees');

  m.orgs.update(person(ALICE), org, { policies: { membersMayInvite: true, membersCreateTeams: false } });
  assert.deepEqual(may(CAROL), { invite: true, createTeam: false });
  assert.ok(m.invitations.create(person(CAROL), org, { email: 'someone@example.test', role: 'member' }).id, 'a member invites now');
  assert.throws(() => m.sharing.createTeam(person(CAROL), org, { name: 'Nope' }), code('FORBIDDEN'), 'and cannot create a team');
  assert.deepEqual(may(DAN), { invite: false, createTeam: false }, 'a guest never');

  m.orgs.suspend(person(ALICE), org, { by: 'owner' });
  assert.deepEqual(may(ALICE), { invite: false, createTeam: false }, 'a suspended org offers nothing');
});

test('audit: `kind` filters by kind or prefix; a bad kind is refused; members never read it', () => {
  const org = freshOrg();
  m.orgs.update(person(ALICE), org, { name: 'Renamed once' });
  m.orgs.setRole(person(ALICE), org, CAROL, 'admin');
  m.orgs.removeMember(person(ALICE), org, DAN);
  const all = m.orgs.audit(person(BOB), org);
  assert.ok(all.length >= 3);
  const members = m.orgs.audit(person(BOB), org, { kind: 'org.member' });
  assert.ok(members.length >= 2, JSON.stringify(members.map((r) => r.kind)));
  assert.ok(members.every((r) => r.kind.startsWith('org.member')), JSON.stringify(members.map((r) => r.kind)));
  assert.deepEqual(
    m.orgs.audit(person(BOB), org, { kind: 'org.updated' }).map((r) => r.kind),
    ['org.updated'],
  );
  // `_` is a literal, not LIKE's any-one-character.
  assert.deepEqual(m.orgs.audit(person(BOB), org, { kind: 'org.member_role' }).map((r) => r.kind), ['org.member_role_changed']);
  assert.equal(m.orgs.audit(person(BOB), org, { kind: 'org.memberxrole' }).length, 0);
  for (const bad of ['%', 'org.%', 'Org.updated', "x' OR 1=1", 'x'.repeat(61)]) assert.throws(() => m.orgs.audit(person(BOB), org, { kind: bad }), code('VALIDATION_FAILED'), bad);
  assert.equal(m.orgs.audit(person(BOB), org, { kind: '' }).length, all.length, 'empty is no filter');
  assert.throws(() => m.orgs.audit(person(EVE), org), code('NOT_FOUND'), 'an outsider');
});

test('audit: team and move rows are the org’s (org_id), so the Audit section lists them (the browser check found them missing)', () => {
  const org = freshOrg();
  m.sharing.createTeam(person(BOB), org, { name: 'Platform' });
  const now = new Date().toISOString();
  store.db!.prepare('INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)').run('v_settings', 'Notes', 'vault', '/v_settings', now, now, 'user', CAROL);
  m.transfers.moveToOrg(person(CAROL), 'vault', 'v_settings', { orgId: org });
  assert.deepEqual(
    m.orgs.audit(person(ALICE), org, { kind: 'org.team' }).map((r) => r.kind),
    ['org.team_created'],
  );
  const moved = m.orgs.audit(person(ALICE), org, { kind: 'object.transferred' });
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.subject, 'vault:v_settings', 'the subject is still the object');
});

test('the routes: PATCH policies and GET audit?kind over HTTP, centrally checked', async () => {
  const org = freshOrg();
  const app = new Hono();
  let actor: Actor = person(BOB);
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.route('/api/orgs', createOrgRoutes(m.orgs, m.breakGlass, m.sharing, m.invitations));
  app.onError((e, c) => c.json({ code: (e as AppError).code }, ((e as AppError).status ?? 500) as 404));
  const patch = (body: unknown) => app.request(`http://localhost/api/orgs/${org}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await patch({ policies: { membersMayInvite: true } })).status, 403, 'an admin');
  actor = person(EVE);
  assert.equal((await patch({ policies: { membersMayInvite: true } })).status, 404, 'an outsider');
  actor = person(ALICE);
  const ok = await patch({ policies: { membersMayInvite: true } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { data: { policies: { membersMayInvite: boolean }; may: { invite: boolean } } };
  assert.equal(body.data.policies.membersMayInvite, true);
  assert.equal(body.data.may.invite, true);

  const audit = await app.request(`http://localhost/api/orgs/${org}/audit?kind=org.updated`);
  assert.equal(audit.status, 200);
  const rows = ((await audit.json()) as { data: { kind: string }[] }).data;
  assert.ok(rows.length >= 1 && rows.every((r) => r.kind === 'org.updated'), JSON.stringify(rows));
  assert.equal((await app.request(`http://localhost/api/orgs/${org}/audit?kind=%25`)).status, 422);
  actor = person(CAROL);
  assert.equal((await app.request(`http://localhost/api/orgs/${org}/audit`)).status, 403, 'a member sees the org, not its audit');
});
