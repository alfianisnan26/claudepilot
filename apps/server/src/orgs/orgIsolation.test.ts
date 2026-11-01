// Org isolation (owner request 2026-11-01, docs/prd/organizations.md §16): what lives in an org stays in it. Against a real migrated database,
// the real owner resolvers and the orgs module: a workspace's Claudes and repositories follow their workspace's org (rights, and who hears a
// quota alert), the approvals queue and Needs you list only requests about what the person may use, usage and spend keep the workspaces and
// Claudes the person may view, and the repositories overview keeps the caller's workspaces in the org context. Each case also names the
// leak it closes: before, an admin account outside an org held the founding user's rights on another org's Claudes and repositories, every
// person saw every approval, and usage was read as the founding user for everyone.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, type Actor, type ReposOverview, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { Approvals } from '../approvals/service.js';
import { approvalAttentionSource } from '../approvals/attention.js';
import { registerOwnerResolvers } from '../authz/owners.js';
import { can, clearResolvers, ownersOf, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import { registerChatAuthz } from '../chat/authz.js';
import { seamCanUseClaude } from '../claudeusage/actor.js';
import { createReposRoutes } from '../repos/routes.js';
import type { ReposService } from '../repos/service.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { seamVisibility } from '../usagespend/actor.js';
import { createOrgs, type OrgsModule } from './index.js';

const OWNER = FOUNDING_USER_ID as UserId; // owner of org A, not in org B
const ADA = 'u_Ada00000000s' as UserId; // a second admin account, in no org
const CAROL = 'u_Car0l00000s' as UserId; // a member of org A
const EVE = 'u_Eve0000000s' as UserId; // owner of org B (a member account)

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let orgA = '';
let approvals: Approvals;
const WS = { org: 'docker/ws-org', own: 'docker/ws-own', oth: 'docker/ws-oth' };

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgiso-'), secretKey: null });
  const db = store.db!;
  addUser(OWNER, 'admin');
  addUser(ADA, 'admin');
  for (const u of [CAROL, EVE]) addUser(u, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store, now: () => new Date(), credentials: () => ({ list: () => [], remove: () => undefined }), notifyBreakGlass: () => undefined });
  registerOwnerResolvers({
    db: () => store.db,
    workspace: (ref) => {
      const r = db.prepare('SELECT id, legacy_id FROM workspace_identities WHERE (legacy_id = ? OR id = ?) AND removed_at IS NULL').get(ref, ref) as { id: string; legacy_id: string } | undefined;
      return r ? { id: r.id, legacyId: r.legacy_id } : null;
    },
  });
  orgA = m.orgs.create(person(OWNER), { name: 'Acme', slug: 'acme' }).id;
  m.orgs.admit(orgA, CAROL, 'member', 'invite', 'test');
  const orgB = m.orgs.create(person(OWNER), { name: 'Other', slug: 'other' }).id;
  m.orgs.admit(orgB, EVE, 'owner', 'invite', 'test');
  m.orgs.leave(person(OWNER), orgB);

  const now = new Date().toISOString();
  const owners: Record<keyof typeof WS, [string, string]> = { org: ['org', orgA], own: ['user', OWNER], oth: ['org', orgB] };
  for (const k of ['org', 'own', 'oth'] as const) {
    const uid = `ws_${k}aaaaaaaaa`;
    db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, 'docker', ?, ?, ?)").run(uid, `ws-${k}`, WS[k], now);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'created')").run(WS[k], uid, owners[k][0], owners[k][1], OWNER, now);
    db.prepare('INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, ?, ?)').run(`c_${k}`, WS[k], `Claude ${k}`, '', now);
    db.prepare("INSERT INTO repos (id, workspace_id, path, name, kind, first_seen_at, scanned_at) VALUES (?, ?, ?, ?, 'repo', ?, ?)").run(`r_${k}`, WS[k], `/home/node/${k}`, k, now, now);
  }
  // A session of EVE's in org B's workspace (sessions are their creator's).
  registerChatAuthz((id) => (id === 's_oth' ? { id, workspaceId: WS.oth, ownerId: EVE } : null));

  approvals = new Approvals({ db: () => store.db });
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const ask = db.prepare("INSERT INTO approvals (id, kind, payload, requester_session, workspace, created_at, expires_at) VALUES (?, 'guard.refusal', '{}', ?, ?, ?, ?)");
  ask.run('apr-org', null, WS.org, now, later);
  ask.run('apr-own', null, WS.own, now, later);
  ask.run('apr-oth', null, WS.oth, now, later);
  ask.run('apr-ses', 's_oth', null, now, later);
  ask.run('apr-portal', null, null, now, later);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  store.close();
});

test('a workspace’s Claudes and repositories follow its org: its people hold them, an admin outside the org holds nothing', () => {
  for (const type of ['claude', 'repo'] as const) {
    const id = (k: string) => (type === 'claude' ? `c_${k}` : `r_${k}`);
    assert.equal(can(person(OWNER), 'manage', objectRef(type, id('org'))).allow, true, `${type}: an owner of the org manages it`);
    assert.equal(can(person(OWNER), 'view', objectRef(type, id('oth'))).allow, false, `${type}: another org's is not found`);
    assert.equal(can(person(EVE), 'manage', objectRef(type, id('oth'))).allow, true, `${type}: org B's owner manages org B's`);
    // Before: no resolver, so an admin account held the founding user's `manage` on every Claude and repository of every org.
    const ada = can(person(ADA), 'view', objectRef(type, id('org')));
    assert.equal(ada.allow === false && ada.reason, 'not_found', `${type}: an admin outside the org gets the missing 404`);
    assert.equal(can(person(ADA), 'manage', objectRef(type, id('own'))).allow, true, `${type}: a personal one of the founding user stays an admin's (D-82)`);
    assert.equal(can(person(CAROL), 'view', objectRef(type, id('org'))).allow, false, `${type}: a member without a grant holds nothing`);
    assert.equal(can(person(OWNER), 'view', objectRef(type, 'nosuch')).allow, false);
  }
  // A workspace grant reaches its Claudes (a member who may use the workspace may use its Claude, never manage it).
  store.db!
    .prepare("INSERT INTO grants (id, object_type, object_id, object_uid, subject_kind, subject_id, level, share_id, granted_by, created_at) VALUES ('gr_t1', 'workspace', ?, 'ws_orgaaaaaaaaa', 'user', ?, 'operate', 'test', ?, ?)")
    .run(WS.org, CAROL, OWNER, new Date().toISOString());
  try {
    assert.equal(can(person(CAROL), 'operate', objectRef('claude', 'c_org')).allow, true);
    assert.equal(can(person(CAROL), 'manage', objectRef('claude', 'c_org')).allow, false);
    assert.equal(seamCanUseClaude(CAROL, 'c_org'), true, 'her usage view keeps the Claude she may use');
  } finally {
    store.db!.prepare("DELETE FROM grants WHERE id = 'gr_t1'").run();
  }
  // A workspace's default Claude (usage spend names it `default:<workspace>`).
  assert.equal(can(person(EVE), 'view', objectRef('claude', `default:${WS.oth}`)).allow, true);
  assert.equal(can(person(OWNER), 'view', objectRef('claude', `default:${WS.oth}`)).allow, false);
});

test('a Claude’s quota alert goes to its workspace’s org owners, not the founding user', () => {
  // Before: no `claude` resolver, so ownersOf answered the founding user for every Claude (notify's audience of a quota alert).
  assert.deepEqual(ownersOf(objectRef('claude', 'c_oth')), [EVE]);
  assert.deepEqual(ownersOf(objectRef('claude', 'c_org')), [OWNER]);
  assert.deepEqual(ownersOf(objectRef('claude', 'c_own')), [OWNER]);
});

test('usage and spend: a person sees the workspaces and Claudes they may view; a budget on everything is a platform admin’s', () => {
  assert.equal(seamVisibility(OWNER, { kind: 'workspace', id: WS.org }), true);
  assert.equal(seamVisibility(OWNER, { kind: 'workspace', id: WS.oth }), false, 'another org’s spend is hidden');
  assert.equal(seamVisibility(EVE, { kind: 'workspace', id: WS.oth }), true);
  assert.equal(seamVisibility(ADA, { kind: 'workspace', id: WS.org }), false, 'an admin outside the org');
  assert.equal(seamVisibility(EVE, { kind: 'claude', id: 'c_oth' }), true);
  assert.equal(seamVisibility(EVE, { kind: 'claude', id: 'c_org' }), false);
  assert.equal(seamVisibility(EVE, { kind: 'budget', id: 'b1' }), false);
  assert.equal(seamVisibility(OWNER, { kind: 'budget', id: 'b1' }), true);
  assert.equal(seamVisibility('', { kind: 'workspace', id: WS.own }), false, 'nobody sees nothing');
  assert.equal(seamCanUseClaude(OWNER, 'c_oth'), false);
  assert.equal(seamCanUseClaude(EVE, 'c_oth'), true);
});

test('approvals: the queue, one request, a decision and Needs you keep what the person may use', async () => {
  const ids = (who: UserId) => approvals.pending(person(who)).map((a) => a.id).sort();
  // Before: every person read every pending request of every workspace (and could deny it).
  assert.deepEqual(ids(OWNER), ['apr-org', 'apr-own', 'apr-portal']);
  assert.deepEqual(ids(EVE), ['apr-oth', 'apr-ses']);
  assert.deepEqual(ids(ADA), ['apr-own', 'apr-portal'], 'an admin outside the orgs: the founding user’s personal and the portal’s');
  assert.deepEqual(ids(CAROL), [], 'a member without a grant: none');
  const notFound = (e: unknown) => isAppError(e) && e.code === 'NOT_FOUND';
  assert.throws(() => approvals.getFor(person(EVE), 'apr-org'), notFound);
  assert.equal(approvals.getFor(person(EVE), 'apr-oth').id, 'apr-oth');
  await assert.rejects(approvals.deny(person(EVE), 'apr-org', 'no'), notFound, 'another org’s request cannot be denied');
  await assert.rejects(approvals.allow(person(CAROL), 'apr-org'), notFound);
  const needsYou = (who: Actor) => approvalAttentionSource(approvals).list(who, Date.now()).map((i) => i.id).sort();
  assert.deepEqual(needsYou(person(EVE)), ['apr-oth', 'apr-ses']);
  assert.deepEqual(needsYou(person(CAROL)), []);
  assert.equal(needsYou({ kind: 'system' }).length, 5, 'the portal itself lists every one');
});

test('repositories: the overview and the log keep the caller’s workspaces, narrowed by the org context', async () => {
  const seen: string[][] = [];
  const fake = {
    overview: async (keep: (id: string) => boolean): Promise<ReposOverview> => {
      const kept = Object.values(WS).filter(keep);
      seen.push(kept);
      return { total: {} as never, workspaces: kept.map((w) => ({ workspaceId: w, name: w, running: true, scannedAt: null, summary: {} as never })), attention: [] };
    },
    eventsWithin: async (_q: unknown, keep: (id: string) => boolean) => ({ events: Object.values(WS).filter(keep).map((w) => ({ workspaceId: w })), next: null }),
  } as unknown as ReposService;
  const appFor = (who: Actor) => {
    const app = new Hono<{ Variables: { actor: Actor } }>();
    app.use('*', async (c, next) => {
      c.set('actor', who);
      await next();
    });
    app.route('/api/repos', createReposRoutes(fake));
    app.onError((e, c) => c.json({ code: isAppError(e) ? e.code : 'ERR' }, (isAppError(e) ? e.status : 500) as 404));
    return app;
  };
  const list = async (who: Actor, query = '') => {
    const res = await appFor(who).request(`http://localhost/api/repos${query}`);
    return ((await res.json()) as { data: ReposOverview }).data.workspaces.map((w) => w.workspaceId).sort();
  };
  assert.deepEqual(await list(person(OWNER)), [WS.org, WS.own]);
  assert.deepEqual(await list(person(OWNER), `?org=${orgA}`), [WS.org]);
  assert.deepEqual(await list(person(OWNER), '?org=personal'), [WS.own]);
  assert.deepEqual(await list(person(EVE)), [WS.oth]);
  assert.deepEqual(await list(person(ADA)), [WS.own], 'an admin outside the orgs');
  const events = await appFor(person(EVE)).request('http://localhost/api/repos/events');
  assert.deepEqual(((await events.json()) as { data: { events: { workspaceId: string }[] } }).data.events.map((e) => e.workspaceId), [WS.oth]);
  const theirs = await appFor(person(EVE)).request(`http://localhost/api/repos/events?workspaceId=${encodeURIComponent(WS.org)}`);
  assert.equal(theirs.status, 404, 'a log asked for another org’s workspace is the missing 404');
  const repo = await appFor(person(EVE)).request('http://localhost/api/repos/events?repoId=r_org');
  assert.equal(repo.status, 404);
  assert.ok(seen.length >= 5);
});
