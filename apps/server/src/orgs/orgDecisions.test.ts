// Owner decision D-111 (2026-11-01, docs/prd/organizations.md §16.4) against a real migrated database: D1 who owns a new workspace (the org
// of the creator's context when they may create there, a clear refusal otherwise, the creator in Personal), D2 Move to organization for a
// set (manage on it, member or up in the org, the exposure acknowledgement for Secrets & env, assignments kept, the creator grant, audit),
// and the Pools and Schedules lists in the org context (an org's own and shared sets, Personal, an org the caller is not in: empty).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, ORGS_ERROR_CODES, objectRef, poolRef, workspaceRef, type Actor, type PoolSummary, type UserId, type Workspace, type WorkspaceTarget } from '@portal/contracts';
import { Hono } from 'hono';
import { registerOwnerResolvers } from '../authz/owners.js';
import { can, clearResolvers, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import type { JsonFile } from '../jsonFile.js';
import { scopeSets, workspaceScope } from '../pools/scope.js';
import { createSchedulesRoutes } from '../schedules/routes.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { WorkspaceIdentities } from '../workspaces/identity.js';
import { Workspaces } from '../workspaces/manager.js';
import type { Runtime } from '../workspaces/runtime.js';
import { createOrgs, type OrgsModule } from './index.js';

const OWNER = FOUNDING_USER_ID as UserId; // the founding user; an owner of the org
const ADA = 'u_Ada00000111' as UserId; // org admin, an admin account
const MEL = 'u_Mel00000111' as UserId; // org member
const GUS = 'u_Gus00000111' as UserId; // org guest
const OUT = 'u_Out00000111' as UserId; // not in the org

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let orgId = '';
let otherOrg = '';
let ids: WorkspaceIdentities;

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const code = (c: string, reason?: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
  return true;
};
const level = (userId: string, ref: ReturnType<typeof objectRef>) =>
  can(person(userId), 'manage', ref).allow ? 'manage' : can(person(userId), 'operate', ref).allow ? 'operate' : can(person(userId), 'view', ref).allow ? 'view' : 'none';
const audit = (kind: string) => store.db!.prepare('SELECT actor, subject, detail, org_id FROM platform_audit WHERE kind = ? ORDER BY id').all(kind) as { actor: string; subject: string; detail: string; org_id: string | null }[];
const ownerRow = (key: string) => store.db!.prepare('SELECT owner_kind AS kind, owner_id AS id, created_by FROM workspace_owners WHERE workspace_id = ?').get(key) as { kind: string; id: string; created_by: string };

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT OR IGNORE INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}
const addPool = (id: string, type: string, owner: string) => {
  const now = new Date().toISOString();
  store.db!.prepare("INSERT INTO pools (id, type, name, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, ?, ?, ?, 'user', ?)").run(id, type, `Set ${id}`, now, now, owner);
};

/** A runtime that creates nothing, so the manager's create runs to its owner row. */
function fakeRuntime(): Runtime {
  const target: WorkspaceTarget = { id: 'docker', label: 'docker', kind: 'docker', where: '/d', available: true };
  return { target, check: async () => undefined, list: async () => [], create: async () => undefined } as unknown as Runtime;
}
const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-d111-'), secretKey: null });
  const db = store.db!;
  addUser(OWNER, 'admin');
  addUser(ADA, 'admin');
  for (const u of [MEL, GUS, OUT]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store });
  ids = new WorkspaceIdentities(store);
  registerOwnerResolvers({
    db: () => store.db,
    workspace: (ref) => {
      const r = db.prepare('SELECT id, legacy_id FROM workspace_identities WHERE (legacy_id = ? OR id = ?) AND removed_at IS NULL').get(ref, ref) as { id: string; legacy_id: string } | undefined;
      return r ? { id: r.id, legacyId: r.legacy_id } : null;
    },
  });
  orgId = m.orgs.create(person(OWNER), { name: 'Acme', slug: 'acme' }).id;
  m.orgs.admit(orgId, ADA, 'admin', 'invite', 'test');
  m.orgs.admit(orgId, MEL, 'member', 'invite', 'test');
  m.orgs.admit(orgId, GUS, 'guest', 'invite', 'test');
  // Another org: Out owns it, the founding user is not in it.
  otherOrg = m.orgs.create(person(OWNER), { name: 'Other', slug: 'other' }).id;
  m.orgs.admit(otherOrg, OUT, 'owner', 'invite', 'test');
  m.orgs.leave(person(OWNER), otherOrg);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  store.close();
});

/* ---------- D1 ---------- */

test('D1: who may create in an org context: owner and admin yes; a member and a guest refused clearly; an outsider or a made-up org is the 404', () => {
  assert.deepEqual(m.creation.ownerFor(person(OWNER), orgId), { kind: 'org', id: orgId });
  assert.deepEqual(m.creation.ownerFor(person(ADA), 'acme'), { kind: 'org', id: orgId }, 'a slug names the org');
  assert.throws(() => m.creation.ownerFor(person(MEL), orgId), code('FORBIDDEN', ORGS_ERROR_CODES.ORG_CREATE_WORKSPACE_NOT_ALLOWED));
  assert.throws(() => m.creation.ownerFor(person(MEL), orgId), /owners and admins/, 'the message says why');
  assert.throws(() => m.creation.ownerFor(person(GUS), orgId), code('FORBIDDEN', ORGS_ERROR_CODES.ORG_CREATE_WORKSPACE_NOT_ALLOWED));
  assert.throws(() => m.creation.ownerFor(person(OUT), orgId), code('NOT_FOUND'), 'not in the org: the same 404 as a missing one');
  assert.throws(() => m.creation.ownerFor(person(MEL), otherOrg), code('NOT_FOUND'));
  assert.throws(() => m.creation.ownerFor(person(MEL), 'org_nosuchorg0'), code('NOT_FOUND'));
  assert.throws(() => m.creation.ownerFor({ kind: 'system', job: 't' }, orgId), code('NOT_FOUND'), 'nobody behind the actor: never an org');
  // Personal (or nothing): the creator.
  assert.deepEqual(m.creation.ownerFor(person(MEL), 'personal'), { kind: 'user', id: MEL });
  assert.deepEqual(m.creation.ownerFor(person(MEL), undefined), { kind: 'user', id: MEL });
  // The policy lets members create.
  m.orgs.update(person(OWNER), orgId, { policies: { membersCreateWorkspaces: true } });
  try {
    assert.deepEqual(m.creation.ownerFor(person(MEL), orgId), { kind: 'org', id: orgId });
    assert.throws(() => m.creation.ownerFor(person(GUS), orgId), code('FORBIDDEN'), 'a guest never');
  } finally {
    m.orgs.update(person(OWNER), orgId, { policies: { membersCreateWorkspaces: false } });
  }
});

test('D1: created in an org context the workspace is the org’s (owners and admins manage, the creator by the creator grant); in Personal the creator’s, not the founding user’s', async () => {
  const ws = new Workspaces([fakeRuntime()], saved, {}, ids);
  // Ada (an org admin, an admin account so she may use the target) creates in the org's context.
  const owner = m.creation.ownerFor(person(ADA), orgId);
  const made = await ws.create({ name: 'org-made', target: 'docker' }, person(ADA), owner);
  m.creation.created(person(ADA), owner, made);
  assert.deepEqual([ownerRow('docker/org-made').kind, ownerRow('docker/org-made').id], ['org', orgId]);
  assert.equal(ownerRow('docker/org-made').created_by, `user:${ADA}`);
  const ref = workspaceRef('docker/org-made');
  assert.equal(level(OWNER, ref), 'manage', 'the org’s owner');
  assert.equal(level(ADA, ref), 'manage');
  assert.equal(level(MEL, ref), 'none', 'a member holds nothing by role');
  assert.equal(level(OUT, ref), 'none');
  assert.deepEqual(m.grants.on(ref).map((g) => [g.subjectId, g.level, g.shareId, g.objectUid]), [[ADA, 'manage', 'creator', made.stableId]]);
  const row = audit('workspace.created_in_org').at(-1)!;
  assert.equal(row.org_id, orgId, 'the org’s Audit shows it');

  // Personal: the creator (here Ada), no longer always the founding user.
  const mine = await ws.create({ name: 'ada-own', target: 'docker' }, person(ADA), m.creation.ownerFor(person(ADA), 'personal'));
  assert.deepEqual([ownerRow('docker/ada-own').kind, ownerRow('docker/ada-own').id], ['user', ADA]);
  assert.equal(mine.id, 'docker/ada-own');
  // No owner given (an older caller): still the creator.
  await ws.create({ name: 'ada-two', target: 'docker' }, person(ADA));
  assert.equal(ownerRow('docker/ada-two').id, ADA);
  assert.equal(level(ADA, workspaceRef('docker/ada-two')), 'manage');
  // The founding user's create stays the founding user's.
  await ws.create({ name: 'founder', target: 'docker' }, person(OWNER));
  assert.equal(ownerRow('docker/founder').id, OWNER);
});

/* ---------- D2 ---------- */

test('D2: moving a set needs manage on it and member or up in the org (a guest, an outsider, a token: refused, the same 404 as missing)', () => {
  addPool('p_mel_skills', 'skillset', MEL);
  addPool('p_out_skills', 'skillset', OUT);
  assert.throws(() => m.transfers.moveToOrg(person(OUT), 'pool', 'p_mel_skills', { orgId }, 'skillset'), code('NOT_FOUND'), 'not hers');
  assert.throws(() => m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_skills', { orgId }, 'secrets'), code('NOT_FOUND'), 'the URL’s type must be the set’s');
  assert.throws(() => m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_skills', { orgId }), code('NOT_FOUND'), 'no type');
  assert.throws(() => m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_skills', { orgId: otherOrg }, 'skillset'), code('NOT_FOUND'), 'an org she is not in');
  assert.throws(() => m.transfers.moveToOrg({ kind: 'token', userId: MEL, tokenId: 'ptk_x', scope: 'admin' }, 'pool', 'p_mel_skills', { orgId }, 'skillset'), code('FORBIDDEN'));
  addPool('p_gus', 'skillset', GUS);
  assert.throws(() => m.transfers.moveToOrg(person(GUS), 'pool', 'p_gus', { orgId }, 'skillset'), code('NOT_FOUND'), 'a guest cannot move into the org');

  const r = m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_skills', { orgId }, 'skillset');
  assert.deepEqual([r.kind, r.id, r.owner, r.creatorGrant], ['pool', 'p_mel_skills', { kind: 'org', id: orgId }, MEL]);
  const ref = poolRef('p_mel_skills', 'skillset');
  assert.equal(level(OWNER, ref), 'manage');
  assert.equal(level(ADA, ref), 'manage');
  assert.equal(level(MEL, ref), 'manage', 'the creator grant');
  assert.equal(level(GUS, ref), 'none');
  assert.equal(level(OUT, ref), 'none');
  const row = audit('object.transferred').at(-1)!;
  assert.equal(row.subject, 'pool:p_mel_skills');
  assert.equal(row.org_id, orgId);
  assert.equal(JSON.parse(row.detail).poolType, 'skillset');
  assert.throws(() => m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_skills', { orgId }, 'skillset'), code('CONFLICT', ORGS_ERROR_CODES.ORG_ALREADY_OWNER));
});

test('D2: a Secrets & env set asks for the exposure acknowledgement first; its assignments stay, so its workspaces keep it', () => {
  addPool('p_mel_keys', 'secrets', MEL);
  const now = new Date().toISOString();
  store.db!.prepare("INSERT INTO assignments (workspace_id, pool_id, pool_type, pinned_revision, assigned_at) VALUES ('docker/org-made', 'p_mel_keys', 'secrets', NULL, ?)").run(now);
  let details: { reason?: string; credentials?: { poolId: string; name: string }[] } = {};
  assert.throws(
    () => m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_keys', { orgId }, 'secrets'),
    (e: unknown) => (isAppError(e) && e.code === 'CONFLICT' ? ((details = e.details as typeof details), true) : false),
  );
  assert.equal(details.reason, ORGS_ERROR_CODES.SHARE_EXPOSES_CREDENTIALS);
  assert.deepEqual(details.credentials, [{ poolId: 'p_mel_keys', name: 'Set p_mel_keys' }], 'a name, never a value');
  assert.equal(level(ADA, poolRef('p_mel_keys', 'secrets')), 'none', 'nothing moved: the admin still cannot read it');
  assert.throws(() => m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_keys', { orgId, acknowledgeExposure: false }, 'secrets'), code('CONFLICT'));

  m.transfers.moveToOrg(person(MEL), 'pool', 'p_mel_keys', { orgId, acknowledgeExposure: true }, 'secrets');
  assert.equal(level(ADA, poolRef('p_mel_keys', 'secrets')), 'manage');
  assert.equal((store.db!.prepare("SELECT count(*) AS n FROM assignments WHERE pool_id = 'p_mel_keys'").get() as { n: number }).n, 1, 'still assigned');
  assert.equal(JSON.parse(audit('object.transferred').at(-1)!.detail).exposureAcknowledged, true);
});

/* ---------- the Pools and Schedules lists in the org context ---------- */

const summary = (id: string): PoolSummary => ({ id, type: 'skillset' }) as PoolSummary;

test('Pools list: an org keeps its own and its shared sets (marked); Personal keeps what no org owns; an org the caller is not in keeps nothing', () => {
  addPool('p_own_mel', 'skillset', MEL);
  addPool('p_shared', 'skillset', OWNER);
  m.grants.add(store.db!, { ref: poolRef('p_shared', 'skillset'), subject: { kind: 'org', id: orgId }, level: 'view', shareId: 'osh_test', by: 'test' });
  const seen = ['p_mel_skills', 'p_own_mel', 'p_shared', 'p_out_skills'].map(summary);
  const ids = (l: PoolSummary[]) => l.map((p) => `${p.id}${p.shared ? '*' : ''}`).sort();
  assert.deepEqual(ids(scopeSets(person(OWNER), 'skillset', seen, { kind: 'org', id: orgId }, store.db)), ['p_mel_skills', 'p_shared*']);
  assert.deepEqual(ids(scopeSets(person(OWNER), 'skillset', seen, { kind: 'personal' }, store.db)), ['p_out_skills', 'p_own_mel', 'p_shared']);
  assert.deepEqual(scopeSets(person(OUT), 'skillset', seen, { kind: 'org', id: orgId }, store.db), [], 'not a member: empty, never wider');
  assert.deepEqual(scopeSets(person(OWNER), 'skillset', seen, { kind: 'org', id: 'org_madeupxxxx' }, store.db), []);
  assert.equal(scopeSets(person(OWNER), 'skillset', seen, null, store.db).length, 4, 'no context: no narrowing');
  // Assigning to a workspace: its owner's context, plus what it already has.
  const ws = workspaceScope(person(OWNER), 'docker/org-made')!;
  assert.deepEqual([ws.scope, ws.key], [{ kind: 'org', id: orgId }, 'docker/org-made']);
  assert.deepEqual(ids(scopeSets(person(OWNER), 'skillset', seen, ws.scope, store.db, new Set(['p_own_mel']))), ['p_mel_skills', 'p_own_mel', 'p_shared*']);
  assert.deepEqual(workspaceScope(person(ADA), 'docker/ada-own')!.scope, { kind: 'personal' });
  assert.equal(workspaceScope(person(OUT), 'docker/org-made'), null, 'a workspace the caller cannot view offers nothing');
});

test('Schedules: a trigger follows its workspace’s org; the portal’s own loops only in Personal', async () => {
  const items = [
    { id: 'loop:tickets', kind: 'loop', target: null },
    { id: 'trigger:a', kind: 'trigger', target: 'docker/org-made' },
    { id: 'trigger:b', kind: 'trigger', target: 'docker/founder' },
    { id: 'helper:x', kind: 'helper', target: null },
  ];
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use(async (c, next) => (c.set('actor', person(OWNER)), next()));
  app.route('/api/schedules', createSchedulesRoutes({ list: () => items } as never));
  const get = async (q: string) => (((await (await app.request(`/api/schedules${q}`)).json()) as { data: { items: { id: string }[] } }).data.items.map((i) => i.id));
  assert.deepEqual(await get(''), items.map((i) => i.id), 'no context: everything');
  assert.deepEqual(await get(`?org=${orgId}`), ['trigger:a']);
  assert.deepEqual(await get('?org=personal'), ['loop:tickets', 'trigger:b', 'helper:x']);
  assert.deepEqual(await get(`?org=${otherOrg}`), [], 'an org the caller is not in: empty');
});
