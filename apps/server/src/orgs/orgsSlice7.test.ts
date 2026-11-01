// Organizations slice 7 (docs/prd/organizations.md §13.2 row 7) against a real migrated database: teams of an org (only org members, names
// unique per org, leaving the org leaves its teams), shares to the org or a team (guests excluded from org grants, manage to an org refused,
// credentials acknowledged, leaving ends the shares a member made of their own objects, revoking tells every receiver and stops their
// sessions in the workspace), and OD-3 (an org owner or admin reads a member's session in an ORG-OWNED workspace, never sends; each read is
// an audit row the member reads; nothing in a workspace the org does not own; a list's filter writes no row).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { objectRef, sessionRef, workspaceRef, type Actor, type MoveToOrgCredential, type ObjectRef, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { registerOwnerResolvers } from '../authz/owners.js';
import { enforceRoutePolicy } from '../authz/routeGuard.js';
import { can, clearResolvers, onAccessChange, registerResolver, useAccountRoles, useOrgAuthority, visible, type AccessChange, type AccountRoleOf } from '../authz/seam.js';
import { stopSessionsOnAccessLoss } from '../chat/accessStop.js';
import { sessionResolver, type SessionFacts } from '../chat/authz.js';
import { PlatformAudit } from '../platform/audit.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';
import { createOrgRoutes, createOrgs, type OrgsModule } from './index.js';

const ADMIN = 'u_Adm1n000007' as UserId; // an instance admin, not in the org
const ALICE = 'u_Al1ce000007' as UserId; // org owner
const BOB = 'u_B0b00000007' as UserId; // org admin
const CAROL = 'u_Car0l000007' as UserId; // org member
const DAN = 'u_Dan00000007' as UserId; // org guest
const EVE = 'u_Eve00000007' as UserId; // not in the org
const FRED = 'u_Fred0000007' as UserId; // org member who leaves

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let orgId = '';
let otherOrg = '';
let assigned: MoveToOrgCredential[] = [];
const sessions = new Map<string, SessionFacts>();

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
const rows = (kind: string) => store.db!.prepare('SELECT user_id, actor, subject, detail FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { user_id: string; actor: string; subject: string; detail: string }[];

const VAULT_ALICE = objectRef('vault', 'v7_alice');
const VAULT_FRED = objectRef('vault', 'v7_fred');
const WS_PERSONAL = workspaceRef('docker/ws-p7');

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs7-'), secretKey: null });
  const db = store.db!;
  addUser(ADMIN, 'admin');
  for (const u of [ALICE, BOB, CAROL, DAN, EVE, FRED]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store, credentials: () => ({ list: () => assigned, remove: () => undefined }) });
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
  registerResolver(sessionResolver((id) => sessions.get(id) ?? null));

  orgId = m.orgs.create(person(ADMIN), { name: 'Acme7', slug: 'acme7' }).id;
  m.orgs.admit(orgId, ALICE, 'owner', 'invite', 'test');
  m.orgs.admit(orgId, BOB, 'admin', 'invite', 'test');
  m.orgs.admit(orgId, CAROL, 'member', 'invite', 'test');
  m.orgs.admit(orgId, DAN, 'guest', 'invite', 'test');
  m.orgs.admit(orgId, FRED, 'member', 'invite', 'test');
  m.orgs.leave(person(ADMIN), orgId);
  otherOrg = m.orgs.create(person(ADMIN), { name: 'Other7', slug: 'other7' }).id;
  m.orgs.admit(otherOrg, EVE, 'member', 'invite', 'test');

  const now = new Date().toISOString();
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v7_alice', 'A', 'vault', '/a', 0, ?, ?, 'user', ?)").run(now, now, ALICE);
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v7_fred', 'F', 'vault', '/f', 0, ?, ?, 'user', ?)").run(now, now, FRED);
  db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES ('ws_p7p7p7p7p7p7', 'docker', 'ws-p7', 'docker/ws-p7', ?)").run(now);
  db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES ('docker/ws-p7', 'ws_p7p7p7p7p7p7', 'user', ?, ?, ?, 'created')").run(ALICE, ALICE, now);
  db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES ('ws_o7o7o7o7o7o7', 'docker', 'ws-o7', 'docker/ws-o7', ?)").run(now);
  db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES ('docker/ws-o7', 'ws_o7o7o7o7o7o7', 'org', ?, ?, ?, 'claimed')").run(orgId, CAROL, now);
  sessions.set('s7_org_carol', { id: 's7_org_carol', workspaceId: 'docker/ws-o7', ownerId: CAROL });
  sessions.set('s7_personal_alice', { id: 's7_personal_alice', workspaceId: 'docker/ws-p7', ownerId: CAROL });
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

test('teams: a member creates one (policy default on); only org members may join; names are unique per org; a guest sees only her teams', () => {
  const team = m.sharing.createTeam(person(CAROL), orgId, { name: 'Ops' });
  assert.equal(team.myRole, 'owner');
  assert.throws(() => m.sharing.createTeam(person(BOB), orgId, { name: 'ops' }), code('CONFLICT'), 'same name in the same org');
  assert.equal(m.sharing.createTeam(person(EVE), otherOrg, { name: 'Ops' }).name, 'Ops', 'the same name in another org is fine');
  assert.throws(() => m.sharing.createTeam(person(DAN), orgId, { name: 'G' }), code('FORBIDDEN'), 'a guest cannot create');
  assert.throws(() => m.sharing.createTeam(person(EVE), orgId, { name: 'X' }), code('NOT_FOUND'), 'an outsider: the org’s 404');
  assert.throws(() => m.sharing.createTeam(token(CAROL), orgId, { name: 'T' }), code('FORBIDDEN'), 'a token cannot');

  assert.throws(() => m.sharing.setTeamMember(person(CAROL), orgId, team.id, EVE, 'member'), code('VALIDATION_FAILED', 'TEAM_NOT_ORG_MEMBER'));
  // The trigger is the second line: a raw insert of an outsider is refused too.
  assert.throws(() => store.db!.prepare("INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, 'member', 'test', 'now')").run(team.id, EVE), /TEAM_NOT_ORG_MEMBER/);
  assert.throws(() => m.sharing.setTeamMember(person(FRED), orgId, team.id, DAN, 'member'), code('FORBIDDEN'), 'not a team owner, not an org admin');
  m.sharing.setTeamMember(person(CAROL), orgId, team.id, DAN, 'member');
  assert.deepEqual(m.sharing.teams(person(DAN), orgId).map((t) => t.name), ['Ops'], 'the guest sees the team she is in');
  assert.throws(() => store.db!.prepare('UPDATE teams SET org_id = ? WHERE id = ?').run(otherOrg, team.id), /TEAM_ORG_FIXED/);
});

test('org shares: members receive, guests never; manage to a whole org is refused; a team share reaches its members (a guest too)', () => {
  assert.equal(level(CAROL, VAULT_ALICE), 'none');
  m.sharing.share(person(ALICE), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'org' }, level: 'operate' });
  assert.equal(level(CAROL, VAULT_ALICE), 'operate');
  assert.equal(level(BOB, VAULT_ALICE), 'operate', 'an org admin holds a personal object only through the share');
  assert.equal(level(DAN, VAULT_ALICE), 'none', 'a guest does not receive org-wide grants');
  assert.equal(level(EVE, VAULT_ALICE), 'none');
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'org' }, level: 'manage' }), code('VALIDATION_FAILED'));
  assert.throws(() => m.sharing.share(person(CAROL), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'org' }, level: 'view' }), code('FORBIDDEN'), 'operate is not manage: no re-share');
  assert.throws(() => m.sharing.share(person(EVE), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'org' }, level: 'view' }), code('NOT_FOUND'));
  assert.throws(() => m.sharing.share(person(DAN), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'org' }, level: 'view' }), code('FORBIDDEN'), 'a guest cannot share');

  const ops = m.sharing.teams(person(CAROL), orgId).find((t) => t.name === 'Ops')!;
  const other = m.sharing.teams(person(EVE), otherOrg)[0]!;
  assert.throws(() => m.sharing.share(person(ALICE), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'team', teamId: other.id }, level: 'view' }), code('NOT_FOUND'), 'another org’s team');
  m.sharing.share(person(ALICE), orgId, { target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'team', teamId: ops.id }, level: 'manage' });
  assert.equal(level(DAN, VAULT_ALICE), 'manage', 'a guest in the team gets the team share');
  assert.equal(level(CAROL, VAULT_ALICE), 'manage');
  assert.ok(m.sharing.shares(person(CAROL), orgId).length >= 2);
  assert.deepEqual(m.sharing.shares(person(DAN), orgId), [], 'a guest lists none');
  assert.equal(rows('org.share_created').length, 2);
});

test('teams cannot cross orgs: leaving the org leaves its teams, and the team grant ends with the membership', () => {
  const ops = m.sharing.teams(person(CAROL), orgId).find((t) => t.name === 'Ops')!;
  m.sharing.setTeamMember(person(CAROL), orgId, ops.id, FRED, 'member');
  assert.equal(level(FRED, VAULT_ALICE), 'manage');
  m.orgs.leave(person(FRED), orgId);
  assert.equal(level(FRED, VAULT_ALICE), 'none');
  assert.equal(store.db!.prepare('SELECT count(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?').get(ops.id, FRED)!.n, 0, 'the trigger removed the team membership');
  m.orgs.admit(orgId, FRED, 'member', 'invite', 'test');
  assert.equal(level(FRED, VAULT_ALICE), 'operate', 'back in the org: the org share again, not the team');
});

test('leaving ends the shares a member made of their own objects; an org object’s shares stay', () => {
  m.sharing.share(person(FRED), orgId, { target: { type: 'vault', id: 'v7_fred' }, subject: { kind: 'org' }, level: 'view' });
  assert.equal(level(CAROL, VAULT_FRED), 'view');
  m.orgs.leave(person(FRED), orgId);
  assert.equal(level(CAROL, VAULT_FRED), 'none');
  const r = store.db!.prepare("SELECT end_reason FROM org_shares WHERE object_id = 'v7_fred'").get() as { end_reason: string };
  assert.equal(r.end_reason, 'member_left');
  assert.equal(store.db!.prepare("SELECT count(*) AS n FROM grants WHERE object_id = 'v7_fred'").get()!.n, 0);
  assert.equal(level(CAROL, VAULT_ALICE), 'manage', 'Alice’s shares are untouched');
});

test('revoking tells every receiver (sockets drop it) and stops their sessions in the workspace once they lose operate', () => {
  assigned = [{ poolId: 'p_s7', name: 'Prod keys' }];
  assert.throws(
    () => m.sharing.share(person(ALICE), orgId, { target: { type: 'workspace', id: 'docker/ws-p7' }, subject: { kind: 'org' }, level: 'operate' }),
    code('CONFLICT', 'SHARE_EXPOSES_CREDENTIALS'),
  );
  const sh = m.sharing.share(person(ALICE), orgId, { target: { type: 'workspace', id: 'docker/ws-p7' }, subject: { kind: 'org' }, level: 'operate', acknowledgeExposure: true });
  assigned = [];
  assert.equal(level(CAROL, WS_PERSONAL), 'operate');

  const changes: AccessChange[] = [];
  const offSpy = onAccessChange((c) => void changes.push(c));
  const ended: string[] = [];
  const offStop = stopSessionsOnAccessLoss({
    running: (ws) => (ws === 'docker/ws-p7' ? [{ id: 's_carol', startedBy: CAROL }, { id: 's_alice', startedBy: ALICE }, { id: 's_bob', startedBy: BOB }] : []),
    end: async (id) => void ended.push(id),
  });
  try {
    assert.throws(() => m.sharing.revoke(person(DAN), orgId, sh.id), code('FORBIDDEN'));
    m.sharing.revoke(person(ALICE), orgId, sh.id);
  } finally {
    offSpy();
    offStop();
  }
  assert.equal(level(CAROL, WS_PERSONAL), 'none');
  const told = new Set(changes.filter((c) => c.why === 'share_ended' && c.ref?.id === 'docker/ws-p7').map((c) => c.userId));
  for (const u of [ALICE, BOB, CAROL]) assert.ok(told.has(u), `${u} told`);
  assert.ok(!told.has(DAN), 'the guest never held it');
  assert.deepEqual(ended.sort(), ['s_bob', 's_carol'], 'the owner keeps hers; the receivers’ sessions stop');
  assert.equal(rows('org.share_ended').length, 1);
  assert.throws(() => m.sharing.revoke(person(ALICE), orgId, sh.id), code('NOT_FOUND'), 'already ended');
});

test('OD-3: an org admin reads a member’s session in an org workspace, never sends; each read is an audit row the member reads', () => {
  const s = sessionRef('s7_org_carol');
  assert.equal(level(CAROL, s), 'manage', 'her own');
  for (const viewer of [BOB, ALICE]) {
    assert.equal(can(person(viewer), 'view', s).allow, true);
    const op = can(person(viewer), 'operate', s);
    assert.equal(op.allow, false, 'no send');
    assert.equal(op.allow === false && op.reason, 'no_right', 'a 403, not a hidden 404');
    assert.equal(can(person(viewer), 'manage', s).allow, false);
  }
  assert.equal(level(DAN, s), 'none', 'a guest');
  assert.equal(level(FRED, s), 'none', 'a member');
  assert.equal(level(EVE, s), 'none', 'an outsider');
  assert.equal(level(ADMIN, s), 'none', 'an instance admin without break-glass');
  assert.equal(level(BOB, s, token(BOB)), 'none', 'a token never reads through the org role');

  const views = rows('org.transcript_viewed');
  assert.equal(views.length, 2, 'one row per viewer (bursts de-duplicated)');
  const bob = views.find((v) => v.actor === `user:${BOB}`)!;
  assert.equal(bob.user_id, CAROL);
  assert.equal(bob.subject, `org:${orgId}`);
  assert.equal(JSON.parse(bob.detail).sessionId, 's7_org_carol');
  const audit = new PlatformAudit(store);
  assert.equal(audit.list({ kind: 'org.transcript_viewed' }, CAROL).length, 2, 'the member reads them in her own audit');
  assert.equal(audit.list({ kind: 'org.transcript_viewed' }, BOB).length, 0);

  assert.equal(m.sharing.transcriptViews(person(ALICE), orgId).length, 2, 'org owners read the org’s rows');
  assert.throws(() => m.sharing.transcriptViews(person(BOB), orgId), code('FORBIDDEN'), 'an admin does not');
});

test('OD-3: nothing in a workspace the org does not own, and a list’s filter writes no row', () => {
  const before = rows('org.transcript_viewed').length;
  assert.equal(level(BOB, sessionRef('s7_personal_alice')), 'none', 'personal workspace');
  sessions.set('s7_org_fred', { id: 's7_org_fred', workspaceId: 'docker/ws-o7', ownerId: FRED });
  const listed = visible(person(BOB), 'session', ['s7_org_fred', 's7_personal_alice'], (x) => x);
  assert.deepEqual(listed, ['s7_org_fred'], 'the list shows the org workspace’s session');
  assert.equal(rows('org.transcript_viewed').length, before, 'listing is not reading');
});

test('the routes: declared, centrally checked; an outsider gets the same 404 as a missing org', async () => {
  const app = new Hono();
  let actor: Actor = person(EVE);
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.route('/api/orgs', createOrgRoutes(m.orgs, m.breakGlass, m.sharing));
  app.onError((e, c) => c.json({ code: (e as AppError).code, message: (e as AppError).message }, ((e as AppError).status ?? 500) as 404));
  const get = async (path: string) => {
    const res = await app.request(`http://localhost${path}`);
    return { status: res.status, body: await res.text() };
  };
  const missing = await get('/api/orgs/org_nosuch/teams');
  assert.equal(missing.status, 404);
  assert.deepEqual(await get(`/api/orgs/${orgId}/teams`), missing);
  assert.deepEqual(await get(`/api/orgs/${orgId}/shares`), missing);
  actor = person(CAROL);
  assert.equal((await get(`/api/orgs/${orgId}/teams`)).status, 200);
  assert.equal((await get(`/api/orgs/${orgId}/transcript-views`)).status, 403, 'manage declared: a member who sees the org is refused');
  actor = person(ALICE);
  assert.equal((await get(`/api/orgs/${orgId}/transcript-views`)).status, 200);
  const res = await app.request(`http://localhost/api/orgs/${orgId}/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { type: 'vault', id: 'v7_alice' }, subject: { kind: 'org' }, level: 'view' }),
  });
  assert.equal(res.status, 201);
});
