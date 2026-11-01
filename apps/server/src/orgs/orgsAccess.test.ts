// Fine-grained org access (docs/prd/access.md; owner request 2026-11-01) against a real migrated database: shares to one person with an end
// and a note; the level ceiling (no grant without manage, never past the granter's own end) and the owners' `adminsMayShare`; an end that
// stops access at its instant on a fake clock and the sweep that closes the record; leaving the org ends shares to that person; access
// requests (request, list by who may decide, approve with a level and an end, deny, cancel, notifications, audit); the effective-access
// answers (each item's level is the seam's and its reasons explain it); the routes (declared, the same 404 for an outsider).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { LEVEL_RANK, maxLevel, objectRef, type Actor, type Level, type NotifyEvent, type ObjectRef, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { render } from '../notify/templates.js';
import { registerOwnerResolvers } from '../authz/owners.js';
import { enforceRoutePolicy } from '../authz/routeGuard.js';
import { can, clearResolvers, onAccessChange, useAccountRoles, useOrgAuthority, type AccessChange, type AccountRoleOf } from '../authz/seam.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';
import type { AccessNotice } from './access.js';
import { ORG_ROUTE_POLICIES } from './authz.js';
import { createOrgRoutes, createOrgs, type OrgsModule } from './index.js';

const ADMIN = 'u_Adm1n00000a' as UserId; // an instance admin, not in the org
const ALICE = 'u_Al1ce00000a' as UserId; // org owner
const BOB = 'u_B0b0000000a' as UserId; // org admin
const CAROL = 'u_Car0l00000a' as UserId; // org member
const DAN = 'u_Dan000000a0' as UserId; // org guest
const EVE = 'u_Eve000000a0' as UserId; // not in the org
const FRED = 'u_Fred00000a0' as UserId; // org member

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let orgId = '';
let clock = new Date('2030-01-01T00:00:00.000Z');
const notices: { to: UserId[]; n: AccessNotice }[] = [];

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const code = (c: string, reason?: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
  return true;
};
const level = (userId: string, ref: ObjectRef): Level =>
  can(person(userId), 'manage', ref).allow ? 'manage' : can(person(userId), 'operate', ref).allow ? 'operate' : can(person(userId), 'view', ref).allow ? 'view' : 'none';
const auditRows = (kind: string) => store.db!.prepare('SELECT actor, subject, org_id, detail FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { actor: string; subject: string; org_id: string; detail: string }[];
const hours = (h: number) => new Date(clock.getTime() + h * 3_600_000).toISOString();

const V1 = objectRef('vault', 'va_org1'); // org-owned
const V2 = objectRef('vault', 'va_org2'); // org-owned
const V3 = objectRef('vault', 'va_org3'); // org-owned, for expiry
const VA = objectRef('vault', 'va_alice'); // Alice's own
const target = (ref: ObjectRef) => ({ type: ref.type as 'vault', id: ref.id });

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id.slice(2, 7), role, 'active', 'not-a-hash', at, at, 'ui');
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs-access-'), secretKey: null });
  const db = store.db!;
  addUser(ADMIN, 'admin');
  for (const u of [ALICE, BOB, CAROL, DAN, EVE, FRED]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store, now: () => clock, credentials: () => ({ list: () => [], remove: () => undefined }), notifyAccess: (to, n) => void notices.push({ to, n }) });
  registerOwnerResolvers({
    db: () => store.db,
    workspace: (ref) => {
      const r = db.prepare('SELECT id, legacy_id FROM workspace_identities WHERE (legacy_id = ? OR id = ?) AND removed_at IS NULL').get(ref, ref) as { id: string; legacy_id: string } | undefined;
      return r ? { id: r.id, legacyId: r.legacy_id } : null;
    },
  });
  registerTicketBucketAuthz({
    bucketOwner: () => null,
    bucketOwnerOf: (key) => (db.prepare('SELECT owner_kind AS kind, owner_id AS id FROM ticket_buckets WHERE key = ?').get(key) as { kind: string; id: string } | undefined) ?? null,
  });

  orgId = m.orgs.create(person(ADMIN), { name: 'AcmeA', slug: 'acme-a' }).id;
  m.orgs.admit(orgId, ALICE, 'owner', 'invite', 'test');
  m.orgs.admit(orgId, BOB, 'admin', 'invite', 'test');
  m.orgs.admit(orgId, CAROL, 'member', 'invite', 'test');
  m.orgs.admit(orgId, DAN, 'guest', 'invite', 'test');
  m.orgs.admit(orgId, FRED, 'member', 'invite', 'test');
  m.orgs.leave(person(ADMIN), orgId);
  const other = m.orgs.create(person(ADMIN), { name: 'OtherA', slug: 'other-a' }).id;
  m.orgs.admit(other, EVE, 'member', 'invite', 'test');

  const now = new Date().toISOString();
  const vault = db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, 'vault', ?, 0, ?, ?, ?, ?)");
  vault.run('va_org1', 'Handbook', '/1', now, now, 'org', orgId);
  vault.run('va_org2', 'Runbooks', '/2', now, now, 'org', orgId);
  vault.run('va_org3', 'Drafts', '/3', now, now, 'org', orgId);
  vault.run('va_alice', 'Alice notes', '/a', now, now, 'user', ALICE);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

test('a share to one person, with a note; the ceiling: no grant without manage, never past the granter’s own end', () => {
  assert.equal(level(CAROL, V1), 'none');
  assert.throws(() => m.sharing.share(person(CAROL), orgId, { target: target(V1), subject: { kind: 'user', userId: FRED }, level: 'view' }), code('NOT_FOUND'), 'nothing on it: the same 404');
  const s = m.sharing.share(person(ALICE), orgId, { target: target(V1), subject: { kind: 'user', userId: CAROL }, level: 'operate', note: 'on-call  week\u0007' });
  assert.deepEqual(s.subject, { kind: 'user', userId: CAROL, name: 'Car0l' });
  assert.equal(s.note, 'on-call week', 'control characters folded');
  assert.equal(s.expiresAt, null);
  assert.equal(level(CAROL, V1), 'operate');
  assert.equal(level(FRED, V1), 'none', 'only that person');

  // Operate is not manage: no re-share; the Access sheet offers nothing to grant and shows only her own reasons.
  assert.throws(() => m.sharing.share(person(CAROL), orgId, { target: target(V1), subject: { kind: 'user', userId: FRED }, level: 'view' }), code('FORBIDDEN'));
  const seen = m.access.object(person(CAROL), orgId, 'vault', 'va_org1');
  assert.deepEqual(seen.mayGrant, []);
  assert.deepEqual(seen.entries, [], 'the full list is for who may grant');
  assert.deepEqual(seen.mine.map((r) => [r.kind, r.level]), [['share', 'operate']]);

  // Delegation: manage for 7 days. Fred may grant up to manage, never past his own end.
  m.sharing.share(person(ALICE), orgId, { target: target(V1), subject: { kind: 'user', userId: FRED }, level: 'manage', expiresAt: hours(7 * 24) });
  const fredSees = m.access.object(person(FRED), orgId, 'vault', 'va_org1');
  assert.deepEqual(fredSees.mayGrant, ['view', 'operate', 'manage']);
  assert.equal(fredSees.maxUntil, hours(7 * 24));
  assert.throws(
    () => m.sharing.share(person(FRED), orgId, { target: target(V1), subject: { kind: 'user', userId: DAN }, level: 'view' }),
    code('FORBIDDEN', 'ACCESS_ABOVE_OWN'),
    'no end is past his own end',
  );
  assert.throws(
    () => m.sharing.share(person(FRED), orgId, { target: target(V1), subject: { kind: 'user', userId: DAN }, level: 'view', expiresAt: hours(8 * 24) }),
    code('FORBIDDEN', 'ACCESS_ABOVE_OWN'),
  );
  const toDan = m.sharing.share(person(FRED), orgId, { target: target(V1), subject: { kind: 'user', userId: DAN }, level: 'view', expiresAt: hours(3 * 24) });
  assert.equal(level(DAN, V1), 'view', 'a guest receives a share to her');
  assert.equal(toDan.createdBy, FRED);

  // Who may receive: a member of the org, not yourself, not an outsider.
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: target(V1), subject: { kind: 'user', userId: EVE }, level: 'view' }), code('VALIDATION_FAILED'));
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: target(V1), subject: { kind: 'user', userId: ALICE }, level: 'view' }), code('VALIDATION_FAILED'));
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: target(V1), subject: { kind: 'user', userId: CAROL }, level: 'view', note: 'x'.repeat(201) }), code('VALIDATION_FAILED'));
  // The audit row carries the end and the note.
  const created = auditRows('org.share_created').map((r) => JSON.parse(r.detail) as Record<string, unknown>);
  assert.ok(created.some((d) => d.subject === 'user' && d.subjectId === CAROL && d.note === 'on-call week' && d.expiresAt === null));
  assert.ok(auditRows('org.share_created').every((r) => r.org_id === orgId), 'the org’s audit lists them');
});

test('the owners’ policy adminsMayShare: off, an admin manages by role but cannot share; owners always can', () => {
  m.orgs.update(person(ALICE), orgId, { policies: { adminsMayShare: false } });
  try {
    assert.equal(level(BOB, V2), 'manage');
    assert.throws(
      () => m.sharing.share(person(BOB), orgId, { target: target(V2), subject: { kind: 'user', userId: CAROL }, level: 'view' }),
      code('FORBIDDEN', 'ACCESS_SHARING_OWNERS_ONLY'),
    );
    assert.deepEqual(m.access.object(person(BOB), orgId, 'vault', 'va_org2').mayGrant, []);
    assert.ok(m.access.object(person(BOB), orgId, 'vault', 'va_org2').entries.length > 0, 'an admin still sees who has access');
  } finally {
    m.orgs.update(person(ALICE), orgId, { policies: { adminsMayShare: true } });
  }
  assert.throws(() => m.orgs.update(person(BOB), orgId, { policies: { adminsMayShare: false } }), code('FORBIDDEN'), 'owners set it');
  assert.deepEqual(m.access.object(person(BOB), orgId, 'vault', 'va_org2').mayGrant, ['view', 'operate', 'manage']);
});

test('an end stops access at its instant (fake clock); the sweep closes the record, audits it and tells the receiver', () => {
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: target(V3), subject: { kind: 'user', userId: CAROL }, level: 'view', expiresAt: hours(-1) }), code('VALIDATION_FAILED'));
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: target(V3), subject: { kind: 'user', userId: CAROL }, level: 'view', expiresAt: hours(24 * 400) }), code('VALIDATION_FAILED'));
  const team = m.sharing.createTeam(person(ALICE), orgId, { name: 'Writers' });
  m.sharing.setTeamMember(person(ALICE), orgId, team.id, FRED, 'member');
  const s = m.sharing.share(person(ALICE), orgId, { target: target(V3), subject: { kind: 'user', userId: CAROL }, level: 'operate', expiresAt: hours(1) });
  m.sharing.share(person(ALICE), orgId, { target: target(V3), subject: { kind: 'team', teamId: team.id }, level: 'view', expiresAt: hours(2) });
  assert.equal(level(CAROL, V3), 'operate');
  assert.equal(level(FRED, V3), 'view');

  const start = clock;
  clock = new Date(start.getTime() + 61 * 60_000);
  try {
    assert.equal(level(CAROL, V3), 'none', 'ended at its instant, before any sweep');
    assert.equal(level(FRED, V3), 'view', 'the team’s share runs on');
    assert.ok(!m.sharing.shares(person(ALICE), orgId).some((x) => x.id === s.id), 'an ended share is not listed');
    const changes: AccessChange[] = [];
    const off = onAccessChange((c) => void changes.push(c));
    try {
      assert.equal(m.sharing.sweepExpired(), 1);
    } finally {
      off();
    }
    assert.deepEqual(changes.map((c) => [c.userId, c.ref?.id, c.why]), [[CAROL, 'va_org3', 'share_ended']]);
    const row = store.db!.prepare('SELECT end_reason, ended_by FROM org_shares WHERE id = ?').get(s.id) as { end_reason: string; ended_by: string };
    assert.deepEqual({ ...row }, { end_reason: 'expired', ended_by: 'system:access-expiry' });
    assert.equal(store.db!.prepare('SELECT count(*) AS n FROM grants WHERE share_id = ?').get(s.id)!.n, 0);
    const expired = auditRows('org.share_expired');
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.org_id, orgId);
    assert.equal(m.sharing.sweepExpired(), 0, 'once');
    clock = new Date(start.getTime() + 3 * 3_600_000);
    assert.equal(level(FRED, V3), 'none');
    assert.equal(m.sharing.sweepExpired(), 1);
  } finally {
    clock = start;
  }
});

test('leaving the org ends the shares to that person (trigger), and a person share counts only while they are an active member (join)', () => {
  const s = m.sharing.share(person(ALICE), orgId, { target: target(V2), subject: { kind: 'user', userId: FRED }, level: 'view' });
  assert.equal(level(FRED, V2), 'view');
  // The join: the grant row alone is not enough once the membership is not active (the trigger is the second line).
  store.db!.exec('DROP TRIGGER org_members_end_shares');
  try {
    store.db!.prepare("UPDATE org_members SET state = 'removed' WHERE org_id = ? AND user_id = ?").run(orgId, FRED);
    assert.equal(store.db!.prepare('SELECT count(*) AS n FROM grants WHERE share_id = ?').get(s.id)!.n, 1, 'the grant is still there');
    assert.equal(level(FRED, V2), 'none', 'yet it gives nothing');
    store.db!.prepare("UPDATE org_members SET state = 'active' WHERE org_id = ? AND user_id = ?").run(orgId, FRED);
  } finally {
    store.db!.exec(`CREATE TRIGGER org_members_end_shares AFTER UPDATE OF state ON org_members
      WHEN OLD.state = 'active' AND NEW.state != 'active'
    BEGIN
      DELETE FROM grants WHERE share_id IN (SELECT id FROM org_shares WHERE org_id = NEW.org_id AND ended_at IS NULL
        AND ((created_by = NEW.user_id AND personal = 1) OR (subject_kind = 'user' AND subject_id = NEW.user_id)));
      UPDATE org_shares SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_by = 'system:org-membership', end_reason = 'member_left'
        WHERE org_id = NEW.org_id AND ended_at IS NULL AND ((created_by = NEW.user_id AND personal = 1) OR (subject_kind = 'user' AND subject_id = NEW.user_id));
    END;`);
  }
  assert.equal(level(FRED, V2), 'view');
  m.orgs.leave(person(FRED), orgId);
  assert.equal(level(FRED, V2), 'none');
  assert.equal((store.db!.prepare('SELECT end_reason FROM org_shares WHERE id = ?').get(s.id) as { end_reason: string }).end_reason, 'member_left');
  assert.equal(store.db!.prepare('SELECT count(*) AS n FROM grants WHERE share_id = ?').get(s.id)!.n, 0);
  m.orgs.admit(orgId, FRED, 'member', 'invite', 'test');
  assert.equal(level(FRED, V2), 'none', 'coming back does not bring it back');
});

test('access requests: ask, the deciders are told and see it, approve with a level and an end, deny, cancel; audit for each', () => {
  notices.length = 0;
  assert.throws(() => m.access.request(person(DAN), orgId, { target: target(V2), level: 'view' }), code('FORBIDDEN'), 'a guest asks an admin instead');
  assert.throws(() => m.access.request(person(CAROL), orgId, { target: target(VA), level: 'view' }), code('NOT_FOUND'), 'a person’s own object is not asked for here');
  assert.throws(() => m.access.request(person(EVE), orgId, { target: target(V2), level: 'view' }), code('NOT_FOUND'), 'an outsider: the org’s 404');
  assert.throws(() => m.access.request(person(CAROL), orgId, { target: target(V1), level: 'view' }), code('CONFLICT', 'ACCESS_ALREADY_HELD'));

  const req = m.access.request(person(CAROL), orgId, { target: target(V2), level: 'manage', note: 'need to fix the runbook' });
  assert.equal(req.state, 'open');
  assert.equal(req.name, 'Runbooks');
  assert.equal(req.mayDecide, false, 'not her own');
  assert.throws(() => m.access.request(person(CAROL), orgId, { target: target(V2), level: 'view' }), code('CONFLICT', 'ACCESS_REQUEST_OPEN'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.n.what, 'requested');
  assert.deepEqual(new Set(notices[0]!.to), new Set([ALICE, BOB]), 'owners and admins (adminsMayShare), never the requester');
  assert.deepEqual(m.access.catalog(person(CAROL), orgId).find((c) => c.target.id === 'va_org2')?.openRequest, req.id);
  assert.deepEqual(m.access.catalog(person(DAN), orgId), [], 'a guest has no catalog');

  assert.deepEqual(m.access.requests(person(FRED), orgId).map((r) => r.id), [], 'another member does not see it');
  const bobs = m.access.requests(person(BOB), orgId);
  assert.equal(bobs.find((r) => r.id === req.id)?.mayDecide, true);
  assert.throws(() => m.access.approve(person(CAROL), orgId, req.id, {}), code('FORBIDDEN'), 'not her own');
  assert.throws(() => m.access.approve(person(FRED), orgId, req.id, {}), code('NOT_FOUND'), 'someone who may not decide: the same 404');

  const done = m.access.approve(person(BOB), orgId, req.id, { level: 'operate', expiresAt: hours(30 * 24) });
  assert.equal(done.state, 'approved');
  assert.equal(done.grantedLevel, 'operate', 'the decider chose less than asked');
  assert.equal(done.expiresAt, hours(30 * 24));
  assert.equal(level(CAROL, V2), 'operate');
  assert.throws(() => m.access.approve(person(BOB), orgId, req.id, {}), code('CONFLICT'), 'once');
  assert.deepEqual(notices.at(-1)!.to, [CAROL]);
  assert.equal(notices.at(-1)!.n.what, 'approved');
  const shareRow = auditRows('org.share_created').map((r) => JSON.parse(r.detail) as Record<string, unknown>).find((d) => d.requestId === req.id);
  assert.ok(shareRow, 'the share made by the approval names the request');

  const again = m.access.request(person(CAROL), orgId, { target: target(V2), level: 'manage' });
  const denied = m.access.deny(person(ALICE), orgId, again.id, { note: 'not now' });
  assert.equal(denied.state, 'denied');
  assert.equal(denied.decisionNote, 'not now');
  assert.equal(level(CAROL, V2), 'operate');
  assert.equal(notices.at(-1)!.n.what, 'denied');

  const third = m.access.request(person(CAROL), orgId, { target: target(V2), level: 'manage' });
  assert.throws(() => m.access.cancel(person(FRED), orgId, third.id), code('NOT_FOUND'));
  m.access.cancel(person(CAROL), orgId, third.id);
  assert.throws(() => m.access.approve(person(ALICE), orgId, third.id, {}), code('CONFLICT'));

  for (const kind of ['org.access_requested', 'org.access_request_approved', 'org.access_request_denied', 'org.access_request_cancelled'])
    assert.ok(auditRows(kind).length >= 1 && auditRows(kind).every((r) => r.org_id === orgId), `${kind} written to the org’s audit`);
  assert.equal(auditRows('org.access_requested').length, 3);
});

test('effective access: each item’s level is the seam’s and its reasons explain it; a guest gets no org-wide share; who may ask', () => {
  const team = m.sharing.teams(person(ALICE), orgId).find((t) => t.name === 'Writers')!;
  m.sharing.setTeamMember(person(ALICE), orgId, team.id, FRED, 'member'); // leaving (above) took him out of the org's teams
  m.sharing.share(person(ALICE), orgId, { target: target(V1), subject: { kind: 'org' }, level: 'view' });
  m.sharing.share(person(ALICE), orgId, { target: target(V2), subject: { kind: 'team', teamId: team.id }, level: 'manage' });
  m.sharing.share(person(ALICE), orgId, { target: target(VA), subject: { kind: 'user', userId: DAN }, level: 'view' });

  for (const who of [ALICE, BOB, CAROL, DAN, FRED]) {
    const p = m.access.person(person(ALICE), orgId, who);
    for (const item of p.items) {
      const ref = objectRef(item.target.type, item.target.id);
      assert.equal(item.level, level(who, ref), `${who} on ${item.target.id}: the seam’s level`);
      assert.equal(maxLevel(...item.reasons.map((r) => r.level)), item.level, `${who} on ${item.target.id}: the reasons explain it`);
    }
    // Every object they reach is listed.
    for (const ref of [V1, V2, V3, VA]) if (level(who, ref) !== 'none') assert.ok(p.items.some((i) => i.target.id === ref.id), `${who} reaches ${ref.id}: listed`);
  }
  const bob = m.access.person(person(ALICE), orgId, BOB);
  assert.deepEqual(bob.items.find((i) => i.target.id === 'va_org1')?.reasons.map((r) => r.kind), ['org_role', 'share'], 'admin by role, and the org-wide share');
  const fred = m.access.person(person(ALICE), orgId, FRED);
  const fredV2 = fred.items.find((i) => i.target.id === 'va_org2')!;
  assert.equal(fredV2.level, 'manage');
  assert.deepEqual(fredV2.reasons.map((r) => (r.kind === 'share' ? `${r.share.subject.kind}:${r.level}` : r.kind)), ['team:manage']);
  const dan = m.access.person(person(ALICE), orgId, DAN);
  assert.equal(dan.role, 'guest');
  assert.ok(!dan.items.some((i) => i.target.id === 'va_org1' && i.reasons.some((r) => r.kind === 'share' && r.share.subject.kind === 'org')), 'no org-wide share for a guest');
  assert.equal(dan.items.find((i) => i.target.id === 'va_alice')?.level, 'view', 'a personal object shared into the org to her');

  assert.throws(() => m.access.person(person(CAROL), orgId, FRED), code('NOT_FOUND'), 'a member sees only her own');
  assert.equal(m.access.person(person(CAROL), orgId, CAROL).userId, CAROL);
  assert.throws(() => m.access.person(person(ALICE), orgId, EVE), code('NOT_FOUND'));

  // The object's side: who can reach it and why; a revocable row ends with one call.
  const v2 = m.access.object(person(ALICE), orgId, 'vault', 'va_org2');
  assert.equal(v2.owner.kind, 'org');
  assert.equal(v2.entries[0]!.subject.kind, 'org_managers');
  const carolRow = v2.entries.find((e) => e.subject.kind === 'user' && e.subject.id === CAROL)!;
  assert.equal(carolRow.reason.kind, 'share');
  assert.ok(carolRow.reason.kind === 'share' && carolRow.reason.revocable);
  assert.ok(v2.entries.every((e, i) => i === 0 || LEVEL_RANK[v2.entries[i - 1]!.level] >= LEVEL_RANK[e.level]), 'highest first');
  if (carolRow.reason.kind === 'share') m.sharing.revoke(person(ALICE), orgId, carolRow.reason.share.id);
  assert.equal(level(CAROL, V2), 'none');
  assert.throws(() => m.access.object(person(CAROL), orgId, 'vault', 'va_org2'), code('NOT_FOUND'), 'no view: the same 404 as a missing one');
  assert.throws(() => m.access.object(person(CAROL), orgId, 'vault', 'va_nosuch'), code('NOT_FOUND'));
  assert.throws(() => m.access.object(person(CAROL), orgId, 'pool', 'p_x'), code('NOT_FOUND'));
});

test('the notification of a request opens the org’s Access section', () => {
  const e: NotifyEvent = {
    id: 'evt_0000000000000000',
    kind: 'attention',
    at: new Date().toISOString(),
    subject: { type: 'portal', id: 'access-request:arq_x' },
    facts: { what: 'Access request', why: 'AcmeA', orgId },
  };
  const r = render(e);
  assert.equal(r.path, `/admin/orgs/${orgId}?tab=access`);
  assert.equal(r.title, 'Needs you');
  assert.equal(render({ ...e, facts: { ...e.facts, orgId: '/evil' } }).path, '/admin/notifications', 'a bad org id falls back');
});

test('the routes: declared; an outsider gets the same 404 as a missing org; a member reads the catalog and asks', async () => {
  for (const key of [
    'GET /api/orgs/:id/access/catalog',
    'GET /api/orgs/:id/access/object',
    'GET /api/orgs/:id/access/people/:uid',
    'GET /api/orgs/:id/access/requests',
    'POST /api/orgs/:id/access/requests',
    'POST /api/orgs/:id/access/requests/:requestId/approve',
    'POST /api/orgs/:id/access/requests/:requestId/deny',
    'DELETE /api/orgs/:id/access/requests/:requestId',
  ])
    assert.ok(ORG_ROUTE_POLICIES[key], `${key} declared`);
  const app = new Hono();
  let actor: Actor = person(EVE);
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.route('/api/orgs', createOrgRoutes(m.orgs, m.breakGlass, m.sharing, m.invitations, m.access));
  app.onError((e, c) => c.json({ code: (e as AppError).code, message: (e as AppError).message }, ((e as AppError).status ?? 500) as 404));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  };
  for (const [method, suffix, body] of [
    ['GET', '/access/catalog'],
    ['GET', '/access/object?type=vault&id=va_org1'],
    ['GET', `/access/people/${CAROL}`],
    ['GET', '/access/requests'],
    ['POST', '/access/requests', { target: target(V1), level: 'view' }],
    ['POST', '/access/requests/arq_x/approve', {}],
    ['DELETE', '/access/requests/arq_x'],
  ] as [string, string, unknown?][]) {
    const missing = await call(method, `/api/orgs/org_nosuchorg/${suffix.slice(1)}`.replace('//', '/'), body);
    assert.equal(missing.status, 404, `${method} ${suffix}: missing org`);
    assert.deepEqual(await call(method, `/api/orgs/${orgId}${suffix}`, body), missing, `${method} ${suffix}: an outsider, the same answer`);
  }
  actor = person(CAROL);
  const cat = await call('GET', `/api/orgs/${orgId}/access/catalog`);
  assert.equal(cat.status, 200);
  assert.ok(cat.body.includes('va_org3'));
  const hidden = await call('GET', `/api/orgs/${orgId}/access/object?type=vault&id=va_org3`);
  const none = await call('GET', `/api/orgs/${orgId}/access/object?type=vault&id=va_none`);
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden, none, 'an object she may not see answers like a missing one');
  const asked = await call('POST', `/api/orgs/${orgId}/access/requests`, { target: target(V3), level: 'view' });
  assert.equal(asked.status, 201);
});
