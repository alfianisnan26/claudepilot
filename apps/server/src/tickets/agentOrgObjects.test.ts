// T-3319 (owner request 2026-11-01, agents blocked on org tickets): an agent acting for a session reaches an ORG-OWNED object exactly as far as
// both (a) the person it acts for may and (b) its workspace allows: an agent in a workspace org A owns reaches org A's buckets (every ticket of
// them, whatever workspace a ticket names), org A's vaults and its own workspace; never org B's objects (even when its person is in org B),
// never another person's, and never the `org` object itself (no org settings or members for an agent). Against a real migrated database, the
// real owner resolvers, the orgs module and the tickets service. The regression: Konfersi's lead (workspace konfersi/konfersi, owned by the
// Konfersi org) saw 8 of 144 open KONF tickets after KONF moved to the org; the rest answered NOT_FOUND because the agents' workspace rule
// (FR9) hid every KONF ticket that named another workspace.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, orgRef, vaultRef, workspaceRef, type Actor, type OrgId, type UserId } from '@portal/contracts';
import { registerOwnerResolvers } from '../authz/owners.js';
import { can, clearResolvers, useAccountRoles, useOrgAuthority, visible, type AccountRoleOf } from '../authz/seam.js';
import { createOrgs, type OrgsModule } from '../orgs/index.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { Tickets, type Caller } from './service.js';
import { FakeSessions } from './testkit.js';

const OWNER = FOUNDING_USER_ID as UserId; // owner of org A (Konfersi) and of org B
const MEM = 'u_Mem00000000s' as UserId; // a member of org A, no grant on its bucket
const EVE = 'u_Eve00000000s' as UserId; // in no org; owns a personal bucket

const WS_A = 'konfersi/konfersi'; // org A's workspace
const WS_A_OLD = 'kubernetes/konfersi-old'; // another workspace KONF tickets name
const WS_B = 'docker/other'; // org B's workspace
const WS_OWN = 'docker/own'; // the owner's personal workspace

let store: Store;
let m: OrgsModule;
let tickets: Tickets;
let sessions: FakeSessions;
let restoreRoles: AccountRoleOf;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const agentActor = (userId: string, workspaceId: string, sessionId: string): Actor => ({ kind: 'agent', userId, tokenId: `agt_${sessionId}`, sessionId, workspaceId });
const agentOf = (userId: string, workspaceId: string, sessionId: string): Extract<Caller, { kind: 'agent' }> => ({
  kind: 'agent',
  tokenId: `agt_${sessionId}`,
  label: `session ${sessionId} in ${workspaceId}`,
  workspaceId,
  sessionId,
  actor: agentActor(userId, workspaceId, sessionId),
});
const UI: Caller = { kind: 'ui' };
const notFound = (e: unknown) => isAppError(e) && e.code === 'NOT_FOUND';

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-agentorg-'), secretKey: null });
  const db = store.db!;
  addUser(MEM, 'member');
  addUser(EVE, 'member');
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
  sessions = new FakeSessions();
  tickets = new Tickets(store, sessions, {}); // registers the ticket and bucket resolvers
  orgA = m.orgs.create(person(OWNER), { name: 'Konfersi', slug: 'konfersi' }).id;
  m.orgs.admit(orgA, MEM, 'member', 'invite', 'test');
  orgB = m.orgs.create(person(OWNER), { name: 'Other', slug: 'other' }).id;

  const now = new Date().toISOString();
  const ws: [string, string, string, string][] = [
    [WS_A, 'ws_kaaaaaaaaaaa', 'org', orgA],
    [WS_A_OLD, 'ws_koaaaaaaaaaa', 'org', orgA],
    [WS_B, 'ws_baaaaaaaaaaa', 'org', orgB],
    [WS_OWN, 'ws_oaaaaaaaaaaa', 'user', OWNER],
  ];
  for (const [key, uid, kind, owner] of ws) {
    const [target, name] = key.split('/');
    db.prepare('INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, ?, ?, ?, ?)').run(uid, target!, name!, key, now);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'created')").run(key, uid, kind, owner, OWNER, now);
  }
  const bucket = (key: string, kind: string, owner: string) =>
    db
      .prepare("INSERT INTO ticket_buckets (key, name, owner_kind, owner_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'u_owner', ?, ?) ON CONFLICT (key) DO UPDATE SET owner_kind = excluded.owner_kind, owner_id = excluded.owner_id")
      .run(key, key, kind, owner, now, now);
  // KONF is personal first (the founding user's), as it was before the move.
  bucket('KONF', 'user', OWNER);
  bucket('OTH', 'org', orgB);
  bucket('MINE', 'user', OWNER);
  bucket('PRIV', 'user', EVE);
  const vault = (id: string, kind: string, owner: string) =>
    db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, 'vault', ?, 0, ?, ?, ?, ?)").run(id, id, `/${id}`, now, now, kind, owner);
  vault('v_konf', 'org', orgA);
  vault('v_oth', 'org', orgB);
  vault('v_eve', 'user', EVE);

  // KONF tickets naming the lead's workspace, the shared queue, an older org workspace and another org's workspace.
  for (const [name, workspaceId] of [['here', WS_A], ['queue', null], ['old', WS_A_OLD], ['elsewhere', WS_B], ['old2', WS_A_OLD]] as const)
    ids[name] = tickets.create(UI, { summary: `KONF ${name}`, bucket: 'KONF', workspaceId }).id;
  ids.oth = tickets.create(UI, { summary: 'org B', bucket: 'OTH', workspaceId: WS_A }).id;
  ids.priv = tickets.create(UI, { summary: 'Eve', bucket: 'PRIV', workspaceId: WS_A }).id;
  sessions.add({ id: 'lead', workspaceId: WS_A });
  sessions.add({ id: 'worker', workspaceId: WS_A, parentId: 'lead' });
  sessions.add({ id: 'mem', workspaceId: WS_A });
  sessions.add({ id: 'own', workspaceId: WS_OWN });
  sessions.add({ id: 'bee', workspaceId: WS_B });

  // Organizations slice 5 "Move to organization": KONF goes to org A.
  m.transfers.moveToOrg(person(OWNER), 'ticket_bucket', 'KONF', { orgId: orgA });
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

const KONF_IDS = () => [ids.here!, ids.queue!, ids.old!, ids.elsewhere!, ids.old2!].sort();

test('T-3319 regression: after its bucket moved to the org, the org workspace’s agent lists and reads every ticket of it', () => {
  const lead = agentOf(OWNER, WS_A, 'lead');
  const listed = tickets.list(lead, { bucket: 'KONF' });
  assert.deepEqual(listed.items.map((t) => t.id).sort(), KONF_IDS(), 'every open KONF ticket, whatever workspace it names');
  assert.equal(listed.total, 5);
  for (const id of KONF_IDS()) assert.equal(tickets.get(lead, id).ticket.id, id);
  // Its bucket is listed (as ticket_buckets lists them: the service's FR41 rule, then the seam).
  assert.ok(visible(lead.actor!, 'ticket_bucket', tickets.buckets(lead), (b) => b.key).some((b) => b.key === 'KONF'));
});

test('the org workspace’s agent claims, comments on, hands off and closes an org ticket that names another workspace', () => {
  const lead = agentOf(OWNER, WS_A, 'lead');
  const claimed = tickets.claimNext(lead, { id: ids.old! });
  assert.equal(claimed?.id, ids.old);
  tickets.comment(lead, ids.old!, 'on it');
  // A lead hands it to its live worker (FR9f) and the worker closes it.
  tickets.update(lead, ids.old!, { assignee: { kind: 'session', sessionId: 'worker' } });
  assert.deepEqual(tickets.get(lead, ids.old!).ticket.assignee, { kind: 'session', sessionId: 'worker' });
  const closed = tickets.close(agentOf(OWNER, WS_A, 'worker'), ids.old!, { outcome: 'done', summary: 'done' });
  assert.equal(closed.status, 'done');
});

test('the agent of org A’s workspace never reaches org B’s bucket, vault or tickets (its person owns org B too), nor another person’s', () => {
  const lead = agentOf(OWNER, WS_A, 'lead');
  const a = lead.actor!;
  for (const ref of [objectRef('ticket_bucket', 'OTH'), vaultRef('v_oth'), objectRef('ticket', ids.oth!), objectRef('ticket_bucket', 'PRIV'), vaultRef('v_eve'), workspaceRef(WS_B)])
    assert.equal(can(a, 'view', ref).allow, false, `${ref.type} ${ref.id}`);
  const d = can(a, 'view', objectRef('ticket_bucket', 'OTH'));
  assert.equal(!d.allow && d.reason, 'not_found', 'the same 404 as a missing bucket');
  assert.throws(() => tickets.get(lead, ids.oth!), notFound);
  assert.throws(() => tickets.get(lead, ids.priv!), notFound);
  assert.ok(!tickets.list(lead, {}).items.some((t) => t.id === ids.oth || t.id === ids.priv));
  assert.ok(!visible(a, 'ticket_bucket', tickets.buckets(lead), (b) => b.key).some((b) => b.key === 'OTH' || b.key === 'PRIV'));
  // The person (and their token) still reach org B: only the agent is boxed.
  assert.equal(can(person(OWNER), 'view', objectRef('ticket_bucket', 'OTH')).allow, true);
  // Its own person's personal bucket stays (T-3069: portal problems go to the person's PILOT from any workspace).
  assert.equal(can(a, 'operate', objectRef('ticket_bucket', 'MINE')).allow, true);
});

test('within its org: view and operate on the org bucket and vault (capped at operate), never manage; never the org itself', () => {
  const a = agentActor(OWNER, WS_A, 'lead');
  for (const ref of [objectRef('ticket_bucket', 'KONF'), vaultRef('v_konf'), objectRef('ticket', ids.here!), workspaceRef(WS_A)]) {
    assert.equal(can(a, 'operate', ref).allow, true, `${ref.type} ${ref.id}`);
    assert.equal(can(a, 'manage', ref).allow, false, `${ref.type} ${ref.id}: an agent never manages`);
  }
  // No org-admin powers: not the org object, not its members, not its settings.
  for (const verb of ['view', 'operate', 'manage'] as const) assert.equal(can(a, verb, orgRef(orgA as OrgId)).allow, false);
  assert.deepEqual(m.orgs.mine(a), []);
  assert.throws(() => m.orgs.members(a, orgA as OrgId));
  assert.throws(() => m.orgs.update(a, orgA as OrgId, { name: 'Hijacked' }));
  assert.throws(() => m.orgs.setRole(a, orgA as OrgId, MEM, 'admin'));
});

test('an agent in a personal workspace or another org’s workspace gets none of org A’s objects (the person owns org A)', () => {
  for (const [ws, s] of [[WS_OWN, 'own'], [WS_B, 'bee']] as const) {
    const ag = agentOf(OWNER, ws, s);
    for (const ref of [objectRef('ticket_bucket', 'KONF'), vaultRef('v_konf'), objectRef('ticket', ids.queue!)]) assert.equal(can(ag.actor!, 'view', ref).allow, false, `${ws}: ${ref.type}`);
    assert.throws(() => tickets.get(ag, ids.queue!), notFound);
    assert.ok(!tickets.list(ag, {}).items.some((t) => KONF_IDS().includes(t.id)), ws);
  }
});

test('the person rule still holds: a member’s agent in the org workspace with no grant on the bucket sees none of it', () => {
  const ag = agentOf(MEM, WS_A, 'mem');
  assert.equal(can(ag.actor!, 'view', objectRef('ticket_bucket', 'KONF')).allow, false);
  assert.equal(tickets.list(ag, { bucket: undefined }).items.filter((t) => KONF_IDS().includes(t.id)).length, 0);
  assert.throws(() => tickets.get(ag, ids.here!), notFound);
});

test('a token is unchanged: the person’s token reaches both orgs’ buckets (no workspace box), capped by its scope', () => {
  const tok: Actor = { kind: 'token', userId: OWNER, tokenId: 'ptk_x', scope: 'operate' };
  assert.equal(can(tok, 'operate', objectRef('ticket_bucket', 'KONF')).allow, true);
  assert.equal(can(tok, 'operate', objectRef('ticket_bucket', 'OTH')).allow, true);
  assert.equal(can(tok, 'manage', objectRef('ticket_bucket', 'KONF')).allow, false);
  const memTok: Actor = { kind: 'token', userId: MEM, tokenId: 'ptk_m', scope: 'admin' };
  assert.equal(can(memTok, 'view', objectRef('ticket_bucket', 'KONF')).allow, false, 'a member without a grant: none, as before');
  const caller: Caller = { kind: 'token', tokenId: 'ptk_x', label: 'x', scope: 'operate', actor: tok };
  assert.ok(tickets.list(caller, { includeClosed: true }).items.some((t) => t.id === ids.oth));
});
