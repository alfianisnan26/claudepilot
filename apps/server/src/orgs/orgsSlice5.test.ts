// Organizations slice 5 (docs/prd/organizations.md §13.2 row 5) against a real migrated database: org-owned objects (owner and admin manage,
// a member or a guest none without a grant, an instance admin nothing by being one), the creator grant (and its end when the creator
// leaves), Move to organization for a workspace, a ticket bucket and a vault (manage on the object and member or up in the org; credentials
// re-consented), and break-glass (reason, instance admin as a person, one hour, the owners told, access rows, never a personal object,
// ended early by an org owner, the step-up declared on the Admin console's route).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { objectRef, ORGS_API, workspaceRef, type Actor, type MoveToOrgCredential, type ObjectRef, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { ADMIN_ROUTE_POLICIES } from '../admin/authz.js';
import { registerOwnerResolvers } from '../authz/owners.js';
import { enforceRoutePolicy } from '../authz/routeGuard.js';
import { can, clearResolvers, ownersOf, seesEverything, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';
import { createMoveToOrgRoute, createOrgs, type BreakGlassNotice, type OrgsModule } from './index.js';

const ADMIN = 'u_Adm1n000005' as UserId; // an instance admin, not in the org
const ALICE = 'u_Al1ce000005' as UserId; // org owner
const BOB = 'u_B0b00000005' as UserId; // org admin
const CAROL = 'u_Car0l000005' as UserId; // org member
const DAN = 'u_Dan00000005' as UserId; // org guest
const EVE = 'u_Eve00000005' as UserId; // not in the org

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let clock = Date.now();
let orgId = '';
let otherOrg = '';
const notices: { owners: UserId[]; notice: BreakGlassNotice }[] = [];
let assigned: MoveToOrgCredential[] = [];
const removedCalls: string[][] = [];

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const token = (userId: string): Actor => ({ kind: 'token', userId, tokenId: 'ptk_x', scope: 'admin' });
const code = (c: string, reason?: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
  return true;
};
const level = (userId: string, ref: ObjectRef, actor: Actor = person(userId)) =>
  can(actor, 'manage', ref).allow ? 'manage' : can(actor, 'operate', ref).allow ? 'operate' : can(actor, 'view', ref).allow ? 'view' : 'none';
const audit = (kind: string) =>
  store.db!.prepare('SELECT severity, actor, subject, detail FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { severity: string; actor: string; subject: string; detail: string }[];

const VAULT_ORG = objectRef('vault', 'v_alice_team');
const VAULT_PERSONAL = objectRef('vault', 'v_alice_own');
const BUCKET = objectRef('ticket_bucket', 'CRL');
const WS = workspaceRef('docker/ws-a');

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs5-'), secretKey: null });
  const db = store.db!;
  addUser(ADMIN, 'admin');
  for (const u of [ALICE, BOB, CAROL, DAN, EVE]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({
    store,
    now: () => new Date(clock),
    credentials: () => ({ list: () => assigned, remove: (_key, ids) => void removedCalls.push(ids) }),
    notifyBreakGlass: (owners, notice) => void notices.push({ owners, notice }),
  });
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

  // The org: created by the admin, Alice made owner, the admin leaves (so the instance admin is NOT a member).
  orgId = m.orgs.create(person(ADMIN), { name: 'Acme', slug: 'acme' }).id;
  m.orgs.admit(orgId, ALICE, 'owner', 'invite', 'test');
  m.orgs.admit(orgId, BOB, 'admin', 'invite', 'test');
  m.orgs.admit(orgId, CAROL, 'member', 'invite', 'test');
  m.orgs.admit(orgId, DAN, 'guest', 'invite', 'test');
  m.orgs.leave(person(ADMIN), orgId);
  otherOrg = m.orgs.create(person(ADMIN), { name: 'Other', slug: 'other' }).id;

  const now = new Date().toISOString();
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v_alice_team', 'Team', 'vault', '/t', 0, ?, ?, 'user', ?)").run(now, now, ALICE);
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v_alice_own', 'Own', 'vault', '/o', 0, ?, ?, 'user', ?)").run(now, now, ALICE);
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v_dan', 'Dan', 'vault', '/d', 0, ?, ?, 'user', ?)").run(now, now, DAN);
  db.prepare("INSERT INTO ticket_buckets (key, name, owner_id, created_by, created_at, updated_at) VALUES ('CRL', 'Carol', ?, ?, ?, ?)").run(CAROL, CAROL, now, now);
  db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES ('ws_aaaaaaaaaaaa', 'docker', 'ws-a', 'docker/ws-a', ?)").run(now);
  db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES ('docker/ws-a', 'ws_aaaaaaaaaaaa', 'user', ?, ?, ?, 'created')").run(ALICE, ALICE, now);
  db.prepare("INSERT INTO pools (id, type, name, created_at, updated_at, owner_kind, owner_id) VALUES ('p_s1', 'secrets', 'S1', ?, ?, 'user', ?)").run(now, now, ALICE);
  db.prepare("INSERT INTO pools (id, type, name, created_at, updated_at, owner_kind, owner_id) VALUES ('p_s2', 'secrets', 'S2', ?, ?, 'user', ?)").run(now, now, BOB);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

test('Move to organization: refused without manage on the object, without membership (guest, other org) — the same 404 as a missing one', () => {
  assert.throws(() => m.transfers.moveToOrg(person(EVE), 'ticket_bucket', 'CRL', { orgId }), code('NOT_FOUND'), 'another user’s bucket');
  assert.throws(() => m.transfers.moveToOrg(person(CAROL), 'ticket_bucket', 'NOPE', { orgId }), code('NOT_FOUND'), 'a missing bucket');
  assert.throws(() => m.transfers.moveToOrg(person(DAN), 'vault', 'v_dan', { orgId }), code('NOT_FOUND'), 'a guest cannot move into the org');
  assert.throws(() => m.transfers.moveToOrg(person(CAROL), 'ticket_bucket', 'CRL', { orgId: otherOrg }), code('NOT_FOUND'), 'an org she is not in');
  assert.throws(() => m.transfers.moveToOrg(person(CAROL), 'ticket_bucket', 'CRL', { orgId: 'org_nosuch' }), code('NOT_FOUND'));
  assert.throws(() => m.transfers.moveToOrg(token(CAROL), 'ticket_bucket', 'CRL', { orgId }), code('FORBIDDEN'), 'a token never moves');
  assert.equal(level(CAROL, BUCKET), 'manage', 'still hers');
});

test('a moved bucket: org owner and admin manage, the creator keeps manage by her grant, a guest, an outsider and the instance admin hold nothing', () => {
  const r = m.transfers.moveToOrg(person(CAROL), 'ticket_bucket', 'crl', { orgId });
  assert.deepEqual([r.id, r.owner, r.creatorGrant], ['CRL', { kind: 'org', id: orgId }, CAROL]);
  assert.equal((store.db!.prepare("SELECT owner_kind FROM ticket_buckets WHERE key = 'CRL'").get() as { owner_kind: string }).owner_kind, 'org');
  assert.equal(level(ALICE, BUCKET), 'manage');
  assert.equal(level(BOB, BUCKET), 'manage');
  assert.equal(level(CAROL, BUCKET), 'manage', 'creator grant');
  assert.equal(level(DAN, BUCKET), 'none');
  assert.equal(level(EVE, BUCKET), 'none');
  assert.equal(level(ADMIN, BUCKET), 'none', 'an instance admin holds nothing on org content without break-glass');
  const missing = can(person(EVE), 'view', objectRef('ticket_bucket', 'NOPE'));
  const theirs = can(person(EVE), 'view', BUCKET);
  assert.equal(theirs.allow === false && theirs.reason, missing.allow === false && missing.reason, 'the same 404 reason as a missing bucket');
  assert.deepEqual(ownersOf(BUCKET), [ALICE], 'the org’s owners hear about it');
  assert.equal(seesEverything(person(ADMIN)), false, 'no list fast path once an org owns something');
  const row = audit('object.transferred').at(-1)!;
  assert.equal(row.subject, 'ticket_bucket:CRL');
  assert.equal(JSON.parse(row.detail).from, `user:${CAROL}`);
  assert.throws(() => m.transfers.moveToOrg(person(BOB), 'ticket_bucket', 'CRL', { orgId }), code('CONFLICT', 'ORG_ALREADY_OWNER'));
  // A member (the creator) cannot move it out of the org: that needs its owner or admin by role.
  m.orgs.admit(otherOrg, CAROL, 'member', 'invite', 'test');
  assert.throws(() => m.transfers.moveToOrg(person(CAROL), 'ticket_bucket', 'CRL', { orgId: otherOrg }), code('FORBIDDEN'));
});

test('a vault moved by its owner; her personal vault stays out of reach of every org role', () => {
  m.transfers.moveToOrg(person(ALICE), 'vault', 'v_alice_team', { orgId });
  assert.equal(level(BOB, VAULT_ORG), 'manage');
  assert.equal(level(CAROL, VAULT_ORG), 'none', 'a member holds nothing without a grant');
  assert.equal(level(BOB, VAULT_PERSONAL), 'none', 'an org admin never reaches a member’s personal object');
  assert.equal(level(ALICE, VAULT_PERSONAL), 'manage');
});

test('a workspace move re-consents its credentials: the first call lists them, unticked sets are removed, a set the mover does not manage cannot be kept', () => {
  assigned = [
    { poolId: 'p_s1', name: 'S1' },
    { poolId: 'p_s2', name: 'S2' },
  ];
  assert.throws(
    () => m.transfers.moveToOrg(person(ALICE), 'workspace', 'ws_aaaaaaaaaaaa', { orgId }),
    (e: unknown) => code('CONFLICT', 'CREDENTIALS_CONSENT_REQUIRED')(e) && Array.isArray(((e as AppError).details as { credentials?: unknown } | undefined)?.credentials),
  );
  assert.throws(() => m.transfers.moveToOrg(person(ALICE), 'workspace', 'docker/ws-a', { orgId, keepCredentials: ['p_s2'] }), code('FORBIDDEN'), 'Bob’s set');
  assert.throws(() => m.transfers.moveToOrg(person(ALICE), 'workspace', 'docker/ws-a', { orgId, keepCredentials: ['p_zz'] }), code('VALIDATION_FAILED'));
  assert.equal(level(BOB, WS), 'none', 'nothing moved yet');
  const r = m.transfers.moveToOrg(person(ALICE), 'workspace', 'docker/ws-a', { orgId, keepCredentials: ['p_s1'] });
  assert.deepEqual([r.credentialsKept, r.credentialsRemoved], [['p_s1'], ['p_s2']]);
  assert.deepEqual(removedCalls.at(-1), ['p_s2']);
  assert.equal(level(BOB, WS), 'manage');
  assert.equal(level(CAROL, WS), 'none');
  assert.equal(level(ALICE, WS), 'manage');
  const g = m.grants.on(WS);
  assert.deepEqual(g.map((x) => [x.subjectId, x.level, x.shareId, x.objectUid]), [[ALICE, 'manage', 'creator', 'ws_aaaaaaaaaaaa']]);
  assigned = [];
});

test('org grants: to the org reach members, never guests; manage to a whole org is refused', () => {
  const db = store.db!;
  m.grants.add(db, { ref: VAULT_ORG, subject: { kind: 'org', id: orgId }, level: 'operate', shareId: 'sh_test', by: 'test' });
  assert.equal(level(CAROL, VAULT_ORG), 'operate');
  assert.equal(level(DAN, VAULT_ORG), 'none', 'a guest does not receive org-wide grants');
  assert.equal(level(EVE, VAULT_ORG), 'none');
  assert.throws(() => m.grants.add(db, { ref: VAULT_ORG, subject: { kind: 'org', id: orgId }, level: 'manage', shareId: 'sh_x', by: 'test' }));
  m.grants.removeFor(db, VAULT_ORG, 'sh_test');
  assert.equal(level(CAROL, VAULT_ORG), 'none');
});

test('break-glass: a reason, an instance admin as a person; one hour of manage on org content, never on personal objects; the owners told; access rows', () => {
  assert.throws(() => m.breakGlass.start(person(ADMIN), orgId, 'too short'), code('VALIDATION_FAILED'));
  assert.throws(() => m.breakGlass.start(person(ALICE), orgId, 'a long enough reason'), code('NOT_FOUND'), 'not an instance admin');
  assert.throws(() => m.breakGlass.start(token(ADMIN), orgId, 'a long enough reason'), code('NOT_FOUND'), 'a token never opens one');
  assert.equal(level(ADMIN, VAULT_ORG), 'none');
  const e = m.breakGlass.start(person(ADMIN), orgId, 'incident 42: data export check');
  assert.equal(e.open, true);
  assert.equal(Date.parse(e.expiresAt) - Date.parse(e.startedAt), 60 * 60_000);
  assert.deepEqual(notices.at(-1)?.owners, [ALICE], 'the org’s owners are notified');
  assert.equal(audit('org.break_glass_started').at(-1)?.severity, 'high');
  assert.equal(level(ADMIN, VAULT_ORG), 'manage', 'manage on the org’s vault');
  assert.equal(level(ADMIN, WS), 'manage', 'and its workspace');
  assert.equal(level(ADMIN, VAULT_PERSONAL), 'none', 'never a personal object (D12, MO4)');
  assert.equal(level(ADMIN, VAULT_ORG, token(ADMIN)), 'none', 'not through a token');
  const rows = audit('org.break_glass_access');
  assert.ok(rows.some((r) => JSON.parse(r.detail).object === 'vault:v_alice_team' && JSON.parse(r.detail).verb === 'manage'), 'a mutation-level decision writes an access row');
  const before = audit('org.break_glass_access').length;
  can(person(ADMIN), 'manage', VAULT_ORG);
  assert.equal(audit('org.break_glass_access').length, before, 'a burst on one object is one row');
  assert.deepEqual(m.breakGlass.mine(person(ADMIN)).map((x) => x.id), [e.id], 'the banner');
  assert.deepEqual(m.breakGlass.mine(person(BOB)), []);
  // Org owners read it; an org admin who is not an owner does not.
  assert.throws(() => m.breakGlass.forOrg(person(BOB), orgId), code('FORBIDDEN'));
  assert.throws(() => m.breakGlass.forOrg(person(EVE), orgId), code('NOT_FOUND'));
  const view = m.breakGlass.forOrg(person(ALICE), orgId);
  assert.equal(view.entries[0]?.reason, 'incident 42: data export check');
  assert.ok(view.access.length >= 1);
  // Expires at one hour (time faked), and the sweep writes the row.
  clock += 61 * 60_000;
  assert.equal(level(ADMIN, VAULT_ORG), 'none', 'expired: nothing, before any sweep');
  assert.equal(m.breakGlass.sweep(), 1);
  assert.equal(audit('org.break_glass_expired').length, 1);
});

test('break-glass: an org owner ends it early; a member cannot; the admin ends their own from the console', () => {
  const e = m.breakGlass.start(person(ADMIN), orgId, 'second look at the export');
  assert.throws(() => m.breakGlass.endByOrgOwner(person(CAROL), orgId, e.id), code('FORBIDDEN'));
  const ended = m.breakGlass.endByOrgOwner(person(ALICE), orgId, e.id);
  assert.deepEqual([ended.open, ended.endKind], [false, 'ended']);
  assert.equal(level(ADMIN, VAULT_ORG), 'none');
  m.breakGlass.start(person(ADMIN), orgId, 'third look at the export');
  assert.deepEqual(m.breakGlass.endByAdmin(person(ADMIN), orgId), { ended: 1 });
  assert.equal(level(ADMIN, VAULT_ORG), 'none');
  // The console's route needs the step-up (the router enforces `reauth`, admin.test.ts).
  assert.equal(ADMIN_ROUTE_POLICIES['POST /admin-api/orgs/:id/break-glass']?.kind, 'platform');
  assert.equal((ADMIN_ROUTE_POLICIES['POST /admin-api/orgs/:id/break-glass'] as { reauth?: boolean }).reauth, true);
});

test('the creator grant ends when the creator leaves; a suspended org gives nothing', () => {
  assert.equal(level(CAROL, BUCKET), 'manage');
  m.orgs.leave(person(CAROL), orgId);
  assert.equal(level(CAROL, BUCKET), 'none', 'a creator grant counts only while a member');
  store.db!.prepare("UPDATE orgs SET state = 'suspended' WHERE id = ?").run(orgId);
  assert.equal(level(BOB, VAULT_ORG), 'none');
  assert.equal(level(ALICE, WS), 'none', 'nothing comes from a suspended org, the creator grant neither');
  store.db!.prepare("UPDATE orgs SET state = 'active' WHERE id = ?").run(orgId);
  assert.equal(level(BOB, VAULT_ORG), 'manage');
});

test('the move route: the central check refuses another user’s vault exactly like a missing one, before the handler', async () => {
  const app = new Hono();
  let actor: Actor = person(EVE);
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.route('/api/knowledge', createMoveToOrgRoute(m.transfers, 'vault', '/vaults/:id/move-to-org', 'id'));
  app.onError((e, c) => c.json({ code: (e as AppError).code, message: (e as AppError).message }, ((e as AppError).status ?? 500) as 404));
  const post = async (id: string) => {
    const res = await app.request(`http://localhost/api/knowledge/vaults/${id}/move-to-org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId }) });
    return { status: res.status, body: await res.text() };
  };
  const missing = await post('v_nosuch');
  assert.equal(missing.status, 404);
  assert.deepEqual(await post('v_alice_own'), missing);
  actor = person(DAN);
  assert.deepEqual(await post('v_dan'), missing, 'a guest: the org’s 404');
});

test('the workspace move route takes `<target>/<name>` as two segments (the contract’s path), and the central check refuses an outsider like a missing one', async () => {
  const app = new Hono();
  let actor: Actor = person(EVE);
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.route('/api/workspaces', createMoveToOrgRoute(m.transfers, 'workspace', '/:target/:name/move-to-org', 'target+name'));
  app.onError((e, c) => c.json({ code: (e as AppError).code, message: (e as AppError).message }, ((e as AppError).status ?? 500) as 404));
  const post = async (ref: string, body: object = { orgId }) => {
    const res = await app.request(`http://localhost${ORGS_API.moveWorkspace(ref)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  };
  assert.equal(ORGS_API.moveWorkspace('docker/ws-a'), '/api/workspaces/docker/ws-a/move-to-org');
  const missing = await post('docker/nosuch');
  assert.equal(missing.status, 404);
  assert.deepEqual(await post('docker/ws-a'), missing, 'an outsider: the same 404 as a missing workspace');
  actor = person(ALICE);
  assert.notEqual((await post('docker/ws-a', { orgId, keepCredentials: [] })).status, 404, 'the org owner reaches the handler');
});
