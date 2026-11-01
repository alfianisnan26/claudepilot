// D-82 S1a, member access (owner request 2026-11-01): a member account's session passes the session middleware and the route's declared
// policy decides. The matrix:
//   1. (authz/memberRoutes.test.ts) the whole app's route table, and the session middleware over HTTP;
//   2. against the real seam, orgs module and grants: an org share at view or operate gives exactly that level on the workspace, its CI runs,
//      the bucket's tickets; nothing else of the org's or the owner's; a member's own session is theirs; their token is capped by their rights;
//   3. over HTTP through the real session middleware: a member signs in, reaches the doors, gets 404 on admin routes (never the server code);
//   4. the terminal and browser sockets need operate on the workspace, and an access change cuts them.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, platformRef, sessionRef, ticketBucketRef, workspaceRef, type Actor, type ObjectType, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { registerChatAuthz } from '../chat/authz.js';
import { registerCiAuthz } from '../ci/authz.js';
import { createOrgs, type OrgsModule } from '../orgs/index.js';
import { freshStore } from '../notify/testkit.js';
import { Portal } from '../portal.js';
import type { Store } from '../store/store.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';
import { declareAllPolicies } from './declarations.js';
import { Grants } from './grants.js';
import { registerOwnerResolvers } from './owners.js';
import { enforceRoutePolicy } from './routeGuard.js';
import { actorOfPrincipal, can, clearResolvers, emitAccessChange, useAccountRoles, useOrgAuthority, useSocketActor, type AccountRoleOf } from './seam.js';
import { cutOnLostOperate, workspaceSocketActor } from './socketAccess.js';

const SERVER_CODE = '24681357';
const MEMBER = 'u_Memb3r_S1a01' as UserId;
const ADMIN = 'u_Adm1n_S1a001' as UserId;
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });

/** One route behind the central check, the actor set as the session middleware sets it. */
function guarded(key: string, actor: Actor): Hono {
  const [method, path] = key.split(' ') as [string, string];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.on([method], path, (c) => c.json({ ok: true }));
  app.onError((e, c) => {
    const err = e as AppError;
    return c.json({ ok: false, error: { code: err.code } }, (err.status ?? 500) as 404);
  });
  return app;
}

/* ---------- 2. The real seam, orgs and grants ---------- */

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let org = '';
let other = '';
const WS = { org: 'docker/ws-org', shared: 'docker/ws-shared', own: 'docker/ws-own', oth: 'docker/ws-oth' };
const SESSIONS: Record<string, { workspaceId: string; ownerId: string | null }> = {
  s_mine: { workspaceId: WS.shared, ownerId: MEMBER },
  s_owner: { workspaceId: WS.shared, ownerId: null },
};
const TICKETS: Record<string, string> = { 'ORG-1': 'ORG', 'OWN-1': 'OWN', 'ZZZ-1': 'ZZZ' };
const RUNS: Record<string, string> = { r_shared: WS.shared, r_own: WS.own };

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

before(async () => {
  declareAllPolicies();
  store = (await freshStore()).store;
  const db = store.db!;
  addUser(MEMBER, 'member');
  addUser(ADMIN, 'admin');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store, now: () => new Date(), credentials: () => ({ list: () => [], remove: () => undefined }), notifyBreakGlass: () => undefined });
  org = m.orgs.create(person(FOUNDING_USER_ID), { name: 'Konfersi', slug: 'konfersi-s1a' }).id;
  m.orgs.admit(org, MEMBER, 'member', 'invite', 'test');
  other = m.orgs.create(person(FOUNDING_USER_ID), { name: 'Other', slug: 'other-s1a' }).id;
  const now = new Date().toISOString();
  const owners: Record<keyof typeof WS, [string, string]> = { org: ['org', org], shared: ['org', org], own: ['user', FOUNDING_USER_ID], oth: ['org', other] };
  for (const [k, [kind, id]] of Object.entries(owners) as [keyof typeof WS, [string, string]][]) {
    const uid = `ws_${k.padEnd(9, 'a').slice(0, 9)}aaa`;
    db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, 'docker', ?, ?, ?)").run(uid, `ws-${k}`, WS[k], now);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'created')").run(WS[k], uid, kind, id, FOUNDING_USER_ID, now);
  }
  for (const [key, kind, id] of [['ORG', 'org', org], ['OWN', 'user', FOUNDING_USER_ID]] as const)
    db.prepare('INSERT INTO ticket_buckets (key, name, owner_kind, owner_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(key, key, kind, id, FOUNDING_USER_ID, now, now);
  registerOwnerResolvers({
    db: () => store.db,
    workspace: (ref) => {
      const r = db.prepare('SELECT id, legacy_id FROM workspace_identities WHERE (legacy_id = ? OR id = ?) AND removed_at IS NULL').get(ref, ref) as { id: string; legacy_id: string } | undefined;
      return r ? { id: r.id, legacyId: r.legacy_id } : null;
    },
  });
  registerChatAuthz((id) => (SESSIONS[id] ? { id, ...SESSIONS[id]! } : null));
  registerCiAuthz({ workspaceOfRun: (id) => RUNS[id] ?? null, workspaceOfRepo: () => null });
  const bucketOwnerOf = (key: string) => (db.prepare('SELECT owner_kind AS kind, owner_id AS id FROM ticket_buckets WHERE key = ?').get(key) as { kind: string; id: string } | undefined) ?? null;
  registerTicketBucketAuthz({ bucketOwner: () => null, bucketOwnerOf, bucketOf: (ref) => TICKETS[ref] ?? null });
  // The org shares one workspace at operate and its bucket at view (organizations slice 7's grants: subject the org).
  const grants = new Grants({ db: () => store.db });
  const shareUid = (db.prepare('SELECT uid FROM workspace_owners WHERE workspace_id = ?').get(WS.shared) as { uid: string }).uid;
  grants.add(db, { ref: workspaceRef(WS.shared), uid: shareUid, subject: { kind: 'org', id: org }, level: 'operate', shareId: 'osh_test_ws', by: FOUNDING_USER_ID });
  grants.add(db, { ref: ticketBucketRef('ORG'), subject: { kind: 'org', id: org }, level: 'view', shareId: 'osh_test_bucket', by: FOUNDING_USER_ID });
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  store.close();
});

const allows = (actor: Actor, verb: 'view' | 'operate' | 'manage', type: ObjectType, id: string) => can(actor, verb, objectRef(type, id)).allow;
const reason = (actor: Actor, verb: 'view' | 'operate' | 'manage', type: ObjectType, id: string) => {
  const d = can(actor, verb, objectRef(type, id));
  return d.allow ? 'allowed' : d.reason;
};

test('an org share at operate gives a member exactly operate on that workspace and its CI runs; nothing else of the org or the owner', () => {
  const me = person(MEMBER);
  assert.equal(allows(me, 'view', 'workspace', WS.shared), true);
  assert.equal(allows(me, 'operate', 'workspace', WS.shared), true);
  assert.equal(allows(me, 'manage', 'workspace', WS.shared), false, 'never manage from an org share');
  for (const ws of [WS.org, WS.own, WS.oth]) assert.equal(reason(me, 'view', 'workspace', ws), 'not_found', `${ws}: the same 404 as a missing one`);
  assert.equal(reason(me, 'view', 'workspace', 'docker/nosuch'), 'not_found');
  // A run is its workspace's (grantsFrom): the share counts for it; another workspace's run is not found.
  assert.equal(allows(me, 'operate', 'ci_run', 'r_shared'), true);
  assert.equal(reason(me, 'view', 'ci_run', 'r_own'), 'not_found');
  // The platform's areas and targets: nothing.
  for (const area of ['settings', 'usage', 'users', 'targets', 'system'] as const) assert.equal(can(me, 'view', platformRef(area)).allow, false, area);
  // Admins are unchanged: the founding user's personal workspace stays theirs and an admin account's (D-82).
  assert.equal(allows(person(ADMIN), 'manage', 'workspace', WS.own), true);
  assert.equal(allows(person(FOUNDING_USER_ID), 'manage', 'workspace', WS.own), true);
});

test('tickets are decided as their bucket: an org share at view lets a member read, not change; another bucket’s ticket is not found', () => {
  const me = person(MEMBER);
  assert.equal(allows(me, 'view', 'ticket', 'ORG-1'), true);
  assert.equal(allows(me, 'operate', 'ticket', 'ORG-1'), false, 'a view share does not let them change it');
  assert.equal(reason(me, 'view', 'ticket', 'OWN-1'), 'not_found');
  assert.equal(reason(me, 'view', 'ticket', 'NOPE-9'), 'not_found');
  // A key no bucket row has stays the platform's: the founding user and admins as before, never a member.
  assert.equal(allows(person(FOUNDING_USER_ID), 'manage', 'ticket', 'ZZZ-1'), true);
  assert.equal(reason(me, 'view', 'ticket', 'ZZZ-1'), 'not_found');
  assert.equal(allows(person(FOUNDING_USER_ID), 'operate', 'ticket', 'OWN-1'), true, 'the owner’s own bucket: unchanged');
});

test('a member’s own session is theirs; another person’s in the same shared workspace is the same 404 as a missing one', () => {
  const me = person(MEMBER);
  assert.equal(allows(me, 'manage', 'session', 's_mine'), true);
  assert.equal(reason(me, 'view', 'session', 's_owner'), 'not_found');
  assert.equal(reason(me, 'view', 'session', 's_nosuch'), 'not_found');
  assert.equal(allows(person(ADMIN), 'view', 'session', 's_owner'), true, 'admins keep the founding user’s sessions');
});

test('a Portal MCP token minted by a member has the member’s rights at most: no escalation through a token or its scope', () => {
  const token = actorOfPrincipal({ kind: 'user', userId: MEMBER, tokenId: 'pmt_member', scope: 'admin', workspaceId: null, sessionId: null });
  assert.equal(token.kind, 'token');
  assert.equal(allows(token, 'operate', 'workspace', WS.shared), true);
  assert.equal(allows(token, 'manage', 'workspace', WS.shared), false, 'an admin-scoped token caps at manage, the member holds operate');
  assert.equal(allows(token, 'view', 'workspace', WS.own), false);
  for (const area of ['settings', 'users', 'targets'] as const) assert.equal(can(token, 'view', platformRef(area)).allow, false, area);
  // An agent of the member's session acts as the member, inside its own session and workspace.
  const agent = actorOfPrincipal({ kind: 'agent', userId: MEMBER, tokenId: 'cst_member', scope: 'operate', workspaceId: WS.shared, sessionId: 's_mine' });
  assert.equal(can(agent, 'operate', sessionRef('s_mine')).allow, true);
  assert.equal(can(agent, 'view', sessionRef('s_owner')).allow, false);
  assert.equal(can(agent, 'view', workspaceRef(WS.own)).allow, false);
});

test('the route guard with the real seam: a member gets 404 on admin and owner routes, reaches its shared workspace and its doors', async () => {
  const me = person(MEMBER);
  const send = async (key: string, url: string, init: RequestInit = {}) => (await guarded(key, me).request(`http://localhost${url}`, init)).status;
  assert.equal(await send('GET /api/admin/state', '/api/admin/state'), 404);
  assert.equal(await send('GET /api/settings', '/api/settings'), 404);
  assert.equal(await send('GET /api/admin/users', '/api/admin/users'), 404);
  assert.equal(await send('GET /api/workspaces/:target/:name', '/api/workspaces/docker/ws-shared'), 200);
  assert.equal(await send('POST /api/workspaces/:target/:name/start', '/api/workspaces/docker/ws-shared/start', { method: 'POST' }), 200);
  assert.equal(await send('DELETE /api/workspaces/:target/:name', '/api/workspaces/docker/ws-shared', { method: 'DELETE' }), 403, 'remove needs manage: a 403 (they may see it)');
  assert.equal(await send('GET /api/workspaces/:target/:name', '/api/workspaces/docker/ws-own'), 404);
  assert.equal(await send('GET /api/workspaces', '/api/workspaces'), 200, 'the list is a door (it keeps what they may view)');
  // Starting a session needs operate on the body's workspace; a ticket session too (it started anywhere on the ticket's right before).
  const json = (b: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal(await send('POST /api/chat/sessions', '/api/chat/sessions', json({ workspaceId: WS.shared })), 200);
  assert.equal(await send('POST /api/chat/sessions', '/api/chat/sessions', json({ workspaceId: WS.own })), 404);
  assert.equal(await send('POST /api/chat/sessions', '/api/chat/sessions', json({})), 404, 'no workspace named: not a door for a member');
  assert.equal(await send('POST /api/tickets/:id/session', '/api/tickets/ORG-1/session', json({ workspaceId: WS.shared })), 403, 'a view share on the bucket: no session (403, they may see it)');
  assert.equal(await send('GET /api/tickets/:id', '/api/tickets/ORG-1'), 200);
  assert.equal(await send('GET /api/tickets/:id', '/api/tickets/OWN-1'), 404);
  // A new workspace needs operate on a target: the platform's.
  assert.equal(await send('POST /api/workspaces', '/api/workspaces', json({ target: 'docker', name: 'mine' })), 404);
});

test('personSession: the server code, an admin and a member; never a disabled, gone or unreadable account; session() stays the admin’s', () => {
  const portal = new Portal(SERVER_CODE, 60_000);
  const roles: Record<string, 'admin' | 'member' | 'disabled' | 'unavailable'> = { u_A: 'admin', u_M: 'member', u_D: 'disabled', u_U: 'unavailable' };
  portal.roleOf = (id) => roles[id] ?? null;
  const code = portal.signIn(SERVER_CODE);
  const [a, mm, d, u, g] = ['u_A', 'u_M', 'u_D', 'u_U', 'u_G'].map((id) => portal.openSession(id));
  assert.ok(portal.personSession(code) && portal.personSession(a) && portal.personSession(mm));
  assert.equal(portal.personSession(d), undefined);
  assert.equal(portal.personSession(u), undefined, 'unreadable: fail closed (the session is kept for later)');
  assert.ok(portal.anySession(u));
  assert.equal(portal.personSession(g), undefined);
  assert.equal(portal.session(mm), undefined, 'a member is not a full session: the server code’s state and re-auth stay the admin’s');
  assert.ok(portal.session(a));
});

/* ---------- 4. Terminal and browser sockets ---------- */

test('the terminal and browser sockets: operate on the workspace for the cookie’s person, and an access change cuts them', () => {
  const req = {} as IncomingMessage;
  const signedIn = () => true;
  const was = useSocketActor(() => person(MEMBER));
  try {
    assert.ok(workspaceSocketActor(req, signedIn, WS.shared), 'operate through the org share');
    assert.equal(workspaceSocketActor(req, signedIn, WS.own), null, 'the owner’s workspace: refused (404)');
    assert.equal(workspaceSocketActor(req, signedIn, WS.org), null, 'an org workspace with no share: refused');
    assert.equal(workspaceSocketActor(req, () => false, WS.shared), null, 'not signed in');
    // The share ends: an open socket of that person is cut; another person's change does not touch it.
    let closed = 0;
    const off = cutOnLostOperate(person(MEMBER), WS.shared, () => closed++);
    emitAccessChange({ userId: ADMIN, ref: null, why: 'share_ended' });
    emitAccessChange({ userId: MEMBER, ref: workspaceRef(WS.shared), why: 'share_ended' });
    assert.equal(closed, 0, 'still holds operate: kept');
    store.db!.prepare("DELETE FROM grants WHERE share_id = 'osh_test_ws'").run();
    emitAccessChange({ userId: MEMBER, ref: workspaceRef(WS.shared), why: 'share_ended' });
    assert.equal(closed, 1, 'lost operate: cut');
    emitAccessChange({ userId: MEMBER, ref: null, why: 'share_ended' });
    assert.equal(closed, 1, 'once');
    off();
  } finally {
    useSocketActor(was);
  }
});

