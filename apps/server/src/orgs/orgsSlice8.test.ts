// Organizations slice 8 (docs/prd/organizations.md §6.8-§6.10, §13.2 row 8) against a real migrated database: invitations (single use, 7
// days, the email must match, throttled, never owner, a member only with membersMayInvite, never above your role, the code hashed and never
// in the audit, revoke, another org's verified domain), and every row of §6.9 that is built: leaving or removal (membership ends, the grants
// they made of personal objects to the org and their creator grants end, others' stay, the access change), role lowered (applies on the
// next call), suspension (owner or platform; every right from the org none, owners still see it; an owner cannot resume a platform
// suspension), deletion (only when it owns nothing, soft for 30 days, then purged), and the org's audit (org_id, owners and admins only).
// Invitation codes come from the service at run time; no code-shaped literal is in this file.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { ORG_DELETE_GRACE_MS, ORG_INVITATION_LIMITS, objectRef, orgRef, type Actor, type ObjectRef, type OrgId, type UserId } from '@portal/contracts';
import { ADMIN_ROUTE_POLICIES } from '../admin/authz.js';
import { registerOwnerResolvers } from '../authz/owners.js';
import { can, clearResolvers, onAccessChange, policyFor, useAccountRoles, useOrgAuthority, type AccessChange, type AccountRoleOf } from '../authz/seam.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createOrgs, hashInvitationCode, ORG_ROUTE_POLICIES, type OrgsModule } from './index.js';

const ADMIN = 'u_Adm1n000008' as UserId; // an instance admin, not in the orgs
const ALICE = 'u_Al1ce000008' as UserId; // owner
const BOB = 'u_B0b00000008' as UserId; // admin
const CAROL = 'u_Car0l000008' as UserId; // member
const DAN = 'u_Dan00000008' as UserId; // guest
const EVE = 'u_Eve00000008' as UserId; // not in the org
const FRAN = 'u_Fran0000008' as UserId; // invited
const GIL = 'u_Gil00000008' as UserId; // tries wrong codes

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let clock = Date.now();
const changes: AccessChange[] = [];
let offChanges: () => void = () => {};

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const token = (userId: string): Actor => ({ kind: 'token', userId, tokenId: 'ptk_x', scope: 'admin' });
const emailOf = (id: string) => `${id.toLowerCase()}@example.test`;
const code = (c: string, reason?: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
  return true;
};
const level = (userId: string, ref: ObjectRef) =>
  can(person(userId), 'manage', ref).allow ? 'manage' : can(person(userId), 'operate', ref).allow ? 'operate' : can(person(userId), 'view', ref).allow ? 'view' : 'none';
const audit = (kind: string) =>
  store.db!.prepare('SELECT actor, subject, detail, org_id FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { actor: string; subject: string; detail: string; org_id: string | null }[];

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@Example.test`, emailOf(id), id, role, 'active', 'not-a-hash', at, at, 'ui');
}

let n = 0;
/** A fresh org: Alice owner, Bob admin, Carol member, Dan guest; the instance admin who made it leaves. */
function freshOrg(): OrgId {
  const id = m.orgs.create(person(ADMIN), { name: `Acme ${++n}`, slug: `acme-${n}` }).id;
  m.orgs.admit(id, ALICE, 'owner', 'invite', 'test');
  m.orgs.admit(id, BOB, 'admin', 'invite', 'test');
  m.orgs.admit(id, CAROL, 'member', 'invite', 'test');
  m.orgs.admit(id, DAN, 'guest', 'invite', 'test');
  m.orgs.leave(person(ADMIN), id);
  return id;
}

function vault(id: string, owner: { kind: 'user' | 'org'; id: string }) {
  const now = new Date().toISOString();
  store.db!.prepare('INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)').run(id, id, 'vault', `/${id}`, now, now, owner.kind, owner.id);
  return objectRef('vault', id);
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs8-'), secretKey: null });
  const db = store.db!;
  addUser(ADMIN, 'admin');
  for (const u of [ALICE, BOB, CAROL, DAN, EVE, FRAN, GIL]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store, now: () => new Date(clock) });
  registerOwnerResolvers({ db: () => store.db, workspace: () => null });
  offChanges = onAccessChange((c) => void changes.push(c));
});

after(() => {
  offChanges();
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

/* ---------- Invitations (§6.8) ---------- */

test('invite: owners and admins invite; the code is answered once and only its hash is stored; never owner; never above your role', () => {
  const org = freshOrg();
  const inv = m.invitations.create(person(BOB), org, { email: `  ${FRAN}@EXAMPLE.test `, role: 'member' });
  assert.equal(inv.email, emailOf(FRAN), 'normalized');
  assert.equal(inv.state, 'pending');
  assert.ok(inv.code.length >= ORG_INVITATION_LIMITS.codeMin);
  assert.equal(Date.parse(inv.expiresAt) - Date.parse(inv.createdAt), ORG_INVITATION_LIMITS.ttlMs, '7 days');
  const row = store.db!.prepare('SELECT code_hash FROM org_invitations WHERE id = ?').get(inv.id) as { code_hash: string };
  assert.equal(row.code_hash, hashInvitationCode(inv.code));
  assert.ok(!JSON.stringify(store.db!.prepare('SELECT * FROM org_invitations').all()).includes(inv.code), 'the code is nowhere in the table');
  assert.ok(!JSON.stringify(audit('org.member_invited')).includes(inv.code), 'nor in the audit');
  assert.equal(audit('org.member_invited').at(-1)!.org_id, org);
  assert.ok(!('code' in m.invitations.list(person(ALICE), org)[0]!), 'the list never carries the code');

  assert.throws(() => m.invitations.create(person(ALICE), org, { email: emailOf(EVE), role: 'owner' }), code('VALIDATION_FAILED'), 'ownership is transferred, not invited');
  assert.throws(() => m.invitations.create(person(ALICE), org, { email: 'not-an-email', role: 'member' }), code('VALIDATION_FAILED'));
  assert.throws(() => m.invitations.create(person(ALICE), org, { email: emailOf(CAROL), role: 'member' }), code('CONFLICT', 'ALREADY_MEMBER'));
  assert.throws(() => m.invitations.create(person(CAROL), org, { email: emailOf(EVE), role: 'member' }), code('FORBIDDEN'), 'a member, policy off');
  assert.throws(() => m.invitations.create(person(DAN), org, { email: emailOf(EVE), role: 'guest' }), code('FORBIDDEN'), 'a guest never');
  assert.throws(() => m.invitations.create(person(EVE), org, { email: emailOf(EVE), role: 'guest' }), code('NOT_FOUND'), 'not in the org: its 404');
  assert.throws(() => m.invitations.create(token(ALICE), org, { email: emailOf(EVE), role: 'guest' }), code('NOT_FOUND'), 'a token never invites');

  store.db!.prepare('UPDATE orgs SET policies = ? WHERE id = ?').run(JSON.stringify({ membersMayInvite: true }), org);
  assert.equal(m.invitations.create(person(CAROL), org, { email: emailOf(EVE), role: 'member' }).role, 'member', 'membersMayInvite lets a member invite');
  assert.throws(() => m.invitations.create(person(CAROL), org, { email: emailOf(GIL), role: 'admin' }), code('FORBIDDEN'), 'not above their own role');
  assert.throws(() => m.invitations.list(person(CAROL), org), code('FORBIDDEN'), 'the list is for owners and admins');
});

test('accept: the signed-in email must match; joins with the role (via invite); single use; already a member; the audit row', () => {
  const org = freshOrg();
  const inv = m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'admin' });
  assert.throws(() => m.invitations.accept(person(EVE), { code: inv.code }), code('FORBIDDEN', 'INVITATION_EMAIL_MISMATCH'), 'another account');
  assert.throws(() => m.invitations.accept(token(FRAN), { code: inv.code }), code('FORBIDDEN'), 'a token cannot accept');
  const joined = m.invitations.accept(person(FRAN), { code: inv.code });
  assert.deepEqual(joined, { orgId: org, orgName: m.orgs.get(person(ALICE), org).name, role: 'admin' });
  assert.equal(m.orgs.roleOf(org, FRAN), 'admin');
  assert.equal((store.db!.prepare('SELECT via FROM org_members WHERE org_id = ? AND user_id = ?').get(org, FRAN) as { via: string }).via, 'invite');
  assert.throws(() => m.invitations.accept(person(FRAN), { code: inv.code }), code('NOT_FOUND', 'INVITATION_INVALID'), 'single use: a replay is not valid');
  const row = audit('org.member_joined').at(-1)!;
  assert.equal(row.org_id, org);
  assert.equal(JSON.parse(row.detail).email, emailOf(FRAN));
  assert.ok(!row.detail.includes(inv.code));
  assert.equal(m.invitations.list(person(ALICE), org).length, 0, 'a used invitation leaves the pending list');

  const again = m.invitations.create(person(ALICE), org, { email: emailOf(EVE), role: 'member' });
  m.orgs.admit(org, EVE, 'member', 'invite', 'test');
  assert.throws(() => m.invitations.accept(person(EVE), { code: again.code }), code('CONFLICT', 'ALREADY_MEMBER'), 'already in: refused, not demoted or promoted');
  m.orgs.removeMember(person(ALICE), org, EVE);
});

test('accept: expired after 7 days (says so), revoked at once, a newer invitation replaces the older, a suspended org is not valid', () => {
  const org = freshOrg();
  const start = clock;
  const old = m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'member' });
  clock = start + ORG_INVITATION_LIMITS.ttlMs + 1;
  try {
    assert.equal(m.invitations.list(person(ALICE), org)[0]!.state, 'expired', 'the list says expired');
    assert.throws(() => m.invitations.accept(person(FRAN), { code: old.code }), code('CONFLICT', 'INVITATION_EXPIRED'));
  } finally {
    clock = start;
  }
  const first = m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'member' });
  const second = m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'guest' });
  assert.throws(() => m.invitations.accept(person(FRAN), { code: first.code }), code('NOT_FOUND', 'INVITATION_INVALID'), 'replaced');
  m.invitations.revoke(person(BOB), org, second.id);
  assert.equal(audit('org.invitation_revoked').length >= 1, true);
  assert.throws(() => m.invitations.accept(person(FRAN), { code: second.code }), code('NOT_FOUND', 'INVITATION_INVALID'), 'revoked');
  assert.throws(() => m.invitations.revoke(person(BOB), org, second.id), code('NOT_FOUND'), 'revoking twice');
  assert.throws(() => m.invitations.revoke(person(CAROL), org, second.id), code('FORBIDDEN'), 'a member cannot revoke');

  const live = m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'member' });
  m.orgs.suspend(person(ALICE), org, { by: 'owner' });
  assert.throws(() => m.invitations.accept(person(FRAN), { code: live.code }), code('NOT_FOUND', 'INVITATION_INVALID'), 'a suspended org takes nobody in');
  assert.throws(() => m.invitations.create(person(ALICE), org, { email: emailOf(GIL), role: 'member' }), code('FORBIDDEN'), 'nor invites');
  m.orgs.resume(person(ALICE), org, { by: 'owner' });
});

test('accept is throttled per person (scope invitation): wrong codes count, the next attempt is refused even with a good code', () => {
  const org = freshOrg();
  const good = m.invitations.create(person(ALICE), org, { email: emailOf(GIL), role: 'member' });
  for (let i = 0; i < ORG_INVITATION_LIMITS.acceptPerWindow; i++)
    assert.throws(() => m.invitations.accept(person(GIL), { code: randomBytes(32).toString('base64url') }), code('NOT_FOUND', 'INVITATION_INVALID'));
  assert.throws(() => m.invitations.accept(person(GIL), { code: good.code }), code('LOCKED_OUT'));
  assert.ok(store.db!.prepare("SELECT 1 FROM auth_throttle WHERE scope = 'invitation'").get(), 'the counter is a row (survives a restart)');
  const start = clock;
  clock = start + ORG_INVITATION_LIMITS.acceptWindowMs + 1;
  try {
    assert.equal(m.invitations.accept(person(GIL), { code: good.code }).role, 'member', 'after the window it works');
  } finally {
    clock = start;
  }
});

test('an email on a domain ANOTHER org verified is refused (that org’s IdP vouches for it)', () => {
  const org = freshOrg();
  const other = freshOrg();
  // Slice 10's `org_domains` (migration 471): a domain the other org verified.
  store.db!.prepare("INSERT INTO org_domains (org_id, domain, state, challenge, added_by, added_at) VALUES (?, 'corp.example', 'verified', 'x', 'test', 'x')").run(other);
  try {
    assert.throws(() => m.invitations.create(person(ALICE), org, { email: 'kim@corp.example', role: 'member' }), code('CONFLICT', 'INVITATION_OTHER_ORG_DOMAIN'));
    assert.equal(m.invitations.create(person(ALICE), other, { email: 'kim@corp.example', role: 'member' }).state, 'pending', 'its own org may invite');
  } finally {
    store.db!.prepare("DELETE FROM org_domains WHERE domain = 'corp.example'").run();
  }
});

/* ---------- Leaving and removal (§6.9 row 1) ---------- */

test('leaving or removal: the membership ends (row kept), their personal grants to the org and their creator grants end; others stay; sockets told', () => {
  const org = freshOrg();
  const db = store.db!;
  const carolsOwn = vault(`v_c_${org}`, { kind: 'user', id: CAROL });
  const bobsOwn = vault(`v_b_${org}`, { kind: 'user', id: BOB });
  const orgVault = vault(`v_o_${org}`, { kind: 'org', id: org });
  m.grants.add(db, { ref: carolsOwn, subject: { kind: 'org', id: org }, level: 'view', shareId: 'sh_c', by: `user:${CAROL}` });
  m.grants.add(db, { ref: bobsOwn, subject: { kind: 'org', id: org }, level: 'view', shareId: 'sh_b', by: `user:${BOB}` });
  m.grants.add(db, { ref: orgVault, subject: { kind: 'user', id: CAROL }, level: 'manage', shareId: 'creator', by: `user:${CAROL}` });
  assert.equal(level(DAN, carolsOwn), 'none', 'a guest never gets org grants');
  assert.equal(level(BOB, carolsOwn), 'view', 'Carol’s share reaches the org');
  assert.equal(level(CAROL, orgVault), 'manage', 'her creator grant');

  changes.length = 0;
  m.orgs.leave(person(CAROL), org);
  const row = db.prepare('SELECT state, ended_at FROM org_members WHERE org_id = ? AND user_id = ?').get(org, CAROL) as { state: string; ended_at: string | null };
  assert.equal(row.state, 'removed', 'kept for the audit');
  assert.ok(row.ended_at);
  assert.equal(level(BOB, carolsOwn), 'none', 'the grant she made of her own vault to the org ended');
  assert.equal(level(CAROL, orgVault), 'none', 'her creator grant ended; the vault stays the org’s');
  assert.equal((db.prepare("SELECT count(*) AS n FROM grants WHERE subject_id = ? AND share_id = 'creator'").get(CAROL) as { n: number }).n, 0, 'the row is gone');
  assert.equal((db.prepare('SELECT owner_kind FROM kg_vaults WHERE id = ?').get(orgVault.id) as { owner_kind: string }).owner_kind, 'org');
  assert.equal(level(ALICE, bobsOwn), 'view', 'Bob’s share stays');
  assert.deepEqual(changes.filter((c) => c.userId === CAROL).map((c) => c.why), ['org_membership_ended']);
  assert.throws(() => m.orgs.get(person(CAROL), org), code('NOT_FOUND'), 'the org is a 404 to her on the next call');

  m.orgs.removeMember(person(ALICE), org, BOB);
  assert.equal(level(ALICE, bobsOwn), 'none', 'removal ends his shares the same way');
  assert.equal(audit('org.member_left').at(-1)!.org_id, org);
  assert.equal(audit('org.member_removed').at(-1)!.org_id, org);
  assert.throws(() => m.orgs.leave(person(ALICE), org), code('CONFLICT', 'ORG_NEEDS_OWNER'), 'the last owner cannot leave');
});

/* ---------- Role lowered (§6.9 row 2) ---------- */

test('role lowered: an admin demoted to member loses manage on org objects on the next call', () => {
  const org = freshOrg();
  const orgVault = vault(`v_r_${org}`, { kind: 'org', id: org });
  assert.equal(level(BOB, orgVault), 'manage');
  m.orgs.setRole(person(ALICE), org, BOB, 'member');
  assert.equal(level(BOB, orgVault), 'none', 'a member holds nothing on an org object without a grant');
  assert.throws(() => m.invitations.list(person(BOB), org), code('FORBIDDEN'));
});

/* ---------- Suspension (§6.9 row 3) ---------- */

test('suspension by an owner: every right from the org is none; owners still see it and resume; members are told', () => {
  const org = freshOrg();
  const db = store.db!;
  const orgVault = vault(`v_s_${org}`, { kind: 'org', id: org });
  const carolsOwn = vault(`v_sc_${org}`, { kind: 'user', id: CAROL });
  m.grants.add(db, { ref: carolsOwn, subject: { kind: 'org', id: org }, level: 'operate', shareId: 'sh_s', by: `user:${CAROL}` });
  assert.throws(() => m.orgs.suspend(person(BOB), org, { by: 'owner' }), code('FORBIDDEN'), 'an admin cannot suspend');
  assert.throws(() => m.orgs.suspend(person(EVE), org, { by: 'owner' }), code('NOT_FOUND'));
  changes.length = 0;
  m.orgs.suspend(person(ALICE), org, { by: 'owner', reason: 'audit in progress' });
  assert.deepEqual(new Set(changes.map((c) => c.userId)), new Set([ALICE, BOB, CAROL, DAN]));
  assert.ok(changes.every((c) => c.why === 'org_suspended'));
  assert.equal(level(ALICE, orgVault), 'none', 'even the owner holds nothing on its objects');
  assert.equal(level(BOB, orgVault), 'none');
  assert.equal(level(BOB, carolsOwn), 'none', 'org grants give nothing');
  assert.equal(level(ALICE, orgRef(org)), 'view', 'owners still see it');
  assert.equal(level(BOB, orgRef(org)), 'none');
  assert.throws(() => m.orgs.members(person(CAROL), org), code('NOT_FOUND'));
  assert.equal(m.orgs.get(person(ALICE), org).state, 'suspended');
  assert.throws(() => m.orgs.suspend(person(ALICE), org, { by: 'owner' }), code('CONFLICT'), 'already suspended');
  m.orgs.resume(person(ALICE), org, { by: 'owner' });
  assert.equal(level(BOB, orgVault), 'manage', 'back');
  assert.equal(level(BOB, carolsOwn), 'operate');
  assert.equal(JSON.parse(audit('org.suspended').at(-1)!.detail).reason, 'audit in progress');
  assert.equal(audit('org.resumed').at(-1)!.org_id, org);
});

test('suspension by the platform admin (Admin console): only the console resumes it; the console routes need the step-up', () => {
  const org = freshOrg();
  assert.throws(() => m.orgs.suspend(person(ALICE), org, { by: 'platform' }), code('NOT_FOUND'), 'an org owner is not the platform');
  assert.throws(() => m.orgs.suspend(token(ADMIN), org, { by: 'platform' }), code('NOT_FOUND'), 'a token is not a person');
  m.orgs.suspend(person(ADMIN), org, { by: 'platform', reason: 'abuse report' });
  assert.throws(() => m.orgs.resume(person(ALICE), org, { by: 'owner' }), code('FORBIDDEN', 'ORG_SUSPENDED_BY_PLATFORM'));
  assert.equal(JSON.parse(audit('org.suspended').at(-1)!.detail).by, 'platform');
  m.orgs.resume(person(ADMIN), org, { by: 'platform' });
  assert.equal(m.orgs.stateOf(org), 'active');
  assert.throws(() => m.orgs.suspend(person(ADMIN), 'org_nosuch', { by: 'platform' }), code('NOT_FOUND'));
  for (const verb of ['suspend', 'resume'] as const) {
    const p = ADMIN_ROUTE_POLICIES[`POST /admin-api/orgs/:id/${verb}`];
    assert.equal(p?.reauth, true, `${verb} needs the step-up`);
    assert.equal(p?.kind, 'platform');
  }
});

/* ---------- Deletion (§6.9 row 4) ---------- */

test('deletion: owners only, only when the org owns nothing; deleting at once (nobody sees it, invitations revoked); purged after 30 days', () => {
  const org = freshOrg();
  const db = store.db!;
  const orgVault = vault(`v_d_${org}`, { kind: 'org', id: org });
  const carolsOwn = vault(`v_dc_${org}`, { kind: 'user', id: CAROL });
  m.grants.add(db, { ref: carolsOwn, subject: { kind: 'org', id: org }, level: 'view', shareId: 'sh_d', by: `user:${CAROL}` });
  const pending = m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'member' });

  assert.throws(() => m.orgs.delete(person(BOB), org), code('FORBIDDEN'), 'an admin cannot delete');
  assert.throws(() => m.orgs.delete(person(EVE), org), code('NOT_FOUND'));
  assert.throws(() => m.orgs.delete(person(ALICE), org), code('CONFLICT', 'ORG_OWNS_OBJECTS'), 'it still owns a vault');
  db.prepare("UPDATE kg_vaults SET owner_kind = 'user', owner_id = ? WHERE id = ?").run(ALICE, orgVault.id);

  changes.length = 0;
  m.orgs.delete(person(ALICE), org);
  assert.equal(m.orgs.stateOf(org), 'deleting');
  assert.ok(changes.some((c) => c.userId === CAROL && c.why === 'org_membership_ended'));
  assert.throws(() => m.orgs.get(person(ALICE), org), code('NOT_FOUND'), 'nobody sees a deleting org, its owner included');
  assert.ok(!m.orgs.mine(person(BOB)).some((o) => o.id === org), 'gone from the switcher');
  assert.equal(level(BOB, carolsOwn), 'none', 'grants to it give nothing');
  assert.throws(() => m.invitations.accept(person(FRAN), { code: pending.code }), code('NOT_FOUND', 'INVITATION_INVALID'), 'its invitations are revoked');
  assert.equal(audit('org.deleted').at(-1)!.org_id, org);

  const start = clock;
  assert.equal(m.orgs.purgeDeleted(), 0, 'not before 30 days');
  clock = start + ORG_DELETE_GRACE_MS + 1;
  try {
    assert.ok(m.orgs.purgeDeleted() >= 1);
  } finally {
    clock = start;
  }
  assert.equal(db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(org), undefined, 'purged');
  assert.equal(db.prepare('SELECT 1 FROM org_members WHERE org_id = ?').get(org), undefined, 'memberships with it');
  assert.equal(db.prepare('SELECT 1 FROM org_invitations WHERE org_id = ?').get(org), undefined, 'invitations with it');
  assert.equal(db.prepare("SELECT 1 FROM grants WHERE subject_kind = 'org' AND subject_id = ?").get(org), undefined, 'grants to it');
  assert.equal(audit('org.purged').at(-1)!.org_id, org);
});

/* ---------- The org's audit (§6.10) and the routes ---------- */

test('the org’s audit: owners and admins read their org’s rows only (org_id), newest first; members and outsiders cannot', () => {
  const org = freshOrg();
  const other = freshOrg();
  m.invitations.create(person(ALICE), org, { email: emailOf(FRAN), role: 'guest' });
  const rows = m.orgs.audit(person(BOB), org);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.subject === `org:${org}`), 'only this org’s rows');
  assert.equal(rows[0]!.kind, 'org.member_invited', 'newest first');
  assert.deepEqual([...rows].sort((a, b) => b.id - a.id), rows);
  assert.equal(m.orgs.audit(person(BOB), org, { limit: 1 }).length, 1);
  assert.ok(!m.orgs.audit(person(ALICE), other).some((r) => r.subject === `org:${org}`));
  assert.throws(() => m.orgs.audit(person(CAROL), org), code('FORBIDDEN'), 'a member sees the org, not its audit');
  assert.throws(() => m.orgs.audit(person(EVE), org), code('NOT_FOUND'), 'an outsider');
});

test('every slice 8 route is declared (cookie only), with the level the service builds on', () => {
  const want: Record<string, string> = {
    'POST /api/orgs/invitations/accept': 'signed-in',
    'GET /api/orgs/:id/invitations': 'manage',
    'POST /api/orgs/:id/invitations': 'view',
    'DELETE /api/orgs/:id/invitations/:invitationId': 'manage',
    'POST /api/orgs/:id/suspend': 'manage',
    'POST /api/orgs/:id/resume': 'view',
    'DELETE /api/orgs/:id': 'view',
    'GET /api/orgs/:id/audit': 'manage',
  };
  for (const [key, verb] of Object.entries(want)) {
    const p = ORG_ROUTE_POLICIES[key as keyof typeof ORG_ROUTE_POLICIES];
    assert.ok(p && policyFor(key), `${key} is declared and registered`);
    assert.ok(!p.bearer, `${key} takes no bearer`);
    if (p.kind === 'objects') assert.equal(p.checks[0]!.verb, verb, key);
    else assert.equal(p.kind, verb, key);
  }
});
