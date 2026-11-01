// The org context of the lists (docs/prd/organizations.md §7, authz/orgScope.ts) against a real migrated database and the real owner
// resolvers: `?org=<id>` keeps only what that org owns (a session and a CI run through their workspace, a ticket through its bucket),
// `?org=personal` only what no org owns, no `?org=` everything as before. An org the caller is not in (or a forged id) answers an empty list:
// the caller's normal visibility always applies first, so `?org=` never widens a list.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FOUNDING_USER_ID, workspaceRef, type Actor, type ChatSession, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { orgScopeFilter, type OrgScope } from '../authz/orgScope.js';
import { registerOwnerResolvers } from '../authz/owners.js';
import { clearResolvers, useAccountRoles, useOrgAuthority, visible, type AccountRoleOf } from '../authz/seam.js';
import { registerChatAuthz } from '../chat/authz.js';
import type { ChatController } from '../chat/controller.js';
import { createChatRoutes } from '../chat/routes.js';
import { createCiRoutes } from '../ci/routes.js';
import type { CiService } from '../ci/service.js';
import { createKnowledgeRoutes } from '../knowledge/routes.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createTicketRoutes } from '../tickets/routes.js';
import type { Tickets } from '../tickets/service.js';
import { createOrgs, type OrgsModule } from './index.js';

const OWNER = FOUNDING_USER_ID as UserId; // the portal's owner: owner of org A, not in org B
const CAROL = 'u_Car0l00000s' as UserId; // a member of org A with no grants
const EVE = 'u_Eve0000000s' as UserId; // owner of org B, not in org A

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let orgA = '';
let orgB = '';

// One of each object per owner: org A, the owner personally, org B.
const WS = { org: 'docker/ws-org', own: 'docker/ws-own', oth: 'docker/ws-oth' };
const SESSIONS = [
  { id: 's_org', workspaceId: WS.org },
  { id: 's_own', workspaceId: WS.own },
  { id: 's_oth', workspaceId: WS.oth },
];
const RUNS = [
  { id: 'r_org', workspaceId: WS.org },
  { id: 'r_own', workspaceId: WS.own },
  { id: 'r_oth', workspaceId: WS.oth },
];
const REPOS = [
  { id: 'cr_org', workspaceId: WS.org },
  { id: 'cr_own', workspaceId: WS.own },
  { id: 'cr_oth', workspaceId: WS.oth },
];
const TICKETS = [
  { id: 't_org', bucket: 'ORG' },
  { id: 't_own', bucket: 'OWN' },
  { id: 't_none' },
  { id: 't_oth', bucket: 'OTH' },
];

function addUser(id: string, role: 'admin' | 'member') {
  const at = new Date().toISOString();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', at, at, 'ui');
}

/** Every list route under test, mounted with fakes for the services (they only page and filter by the route's `keep`) and the caller set. */
function appFor(who: Actor) {
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', async (c, next) => {
    c.set('actor', who);
    await next();
  });
  app.route('/chat', chatRoutes as never);
  app.route('/tickets', ticketRoutes as never);
  app.route('/knowledge', knowledgeRoutes as never);
  app.route('/ci', ciRoutes as never);
  return async (path: string): Promise<string[]> => {
    const res = await app.request(path);
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    const data = ((await res.json()) as { data: { items?: { id?: string; key?: string }[] } | { id?: string; key?: string }[] }).data;
    const rows = Array.isArray(data) ? data : (data.items ?? []);
    return rows.map((r) => (r.id ?? r.key)!).sort();
  };
}

let chatRoutes: Hono;
let ticketRoutes: Hono;
let knowledgeRoutes: Hono;
let ciRoutes: Hono;

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgscope-'), secretKey: null });
  const db = store.db!;
  addUser(OWNER, 'admin');
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
  orgB = m.orgs.create(person(OWNER), { name: 'Other', slug: 'other' }).id;
  m.orgs.admit(orgB, EVE, 'owner', 'invite', 'test');
  m.orgs.leave(person(OWNER), orgB);

  const now = new Date().toISOString();
  const owners: [string, string][] = [
    ['org', orgA],
    ['user', OWNER],
    ['org', orgB],
  ];
  (['org', 'own', 'oth'] as const).forEach((k, i) => {
    const [kind, id] = owners[i]!;
    const uid = `ws_${k}aaaaaaaaa`;
    db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, 'docker', ?, ?, ?)").run(uid, `ws-${k}`, WS[k], now);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'created')").run(WS[k], uid, kind, id, OWNER, now);
    db.prepare('INSERT INTO ticket_buckets (key, name, owner_kind, owner_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(k.toUpperCase(), k, kind, id, OWNER, now, now);
    db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, 'vault', ?, 0, ?, ?, ?, ?)").run(`v_${k}`, k, `/${k}`, now, now, kind, id);
  });

  // Sessions are their creator's (here the owner's, all three); their org is their workspace's.
  registerChatAuthz((id) => {
    const s = SESSIONS.find((x) => x.id === id);
    return s ? { id: s.id, workspaceId: s.workspaceId, ownerId: OWNER } : null;
  });
  chatRoutes = createChatRoutes({
    listPage: (_f: unknown, args: { keep: (s: { id: string }) => boolean }) => ({ items: SESSIONS.filter(args.keep) as unknown as ChatSession[], next: null }),
  } as unknown as ChatController);

  const bucketOwnerOf = (key: string) => (db.prepare('SELECT owner_kind AS kind, owner_id AS id FROM ticket_buckets WHERE key = ?').get(key) as { kind: string; id: string } | undefined) ?? null;
  ticketRoutes = createTicketRoutes({
    bucketOwner: () => null,
    bucketOwnerOf,
    keyOf: () => null,
    buckets: () => (['ORG', 'OWN', 'OTH'] as const).map((key) => ({ key })),
    listPage: (_v: unknown, _f: unknown, args: { keep: (t: { id: string; bucket?: string }) => boolean }) => ({ items: TICKETS.filter(args.keep), next: null }),
  } as unknown as Tickets);

  knowledgeRoutes = createKnowledgeRoutes({
    list: (scope: { canView(id: string): boolean }) => ['v_org', 'v_own', 'v_oth'].filter((id) => scope.canView(id)).map((id) => ({ id })),
  } as unknown as KnowledgeService);

  ciRoutes = createCiRoutes({
    workspaceOfRun: (id: string) => RUNS.find((r) => r.id === id)?.workspaceId ?? null,
    workspaceOfRepo: (id: string) => REPOS.find((r) => r.id === id)?.workspaceId ?? null,
    listPage: (_f: unknown, args: { keep?: (r: { id: string }) => boolean }) => ({ items: RUNS.filter((r) => !args.keep || args.keep(r)), next: null }),
    repos: async () => REPOS,
  } as unknown as CiService);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

/** The workspaces list as app.ts builds it: what the caller may view, then the org narrowing. */
const workspacesFor = (who: Actor, scope: OrgScope | null) => {
  const seen = visible(who, 'workspace', Object.values(WS).map((id) => ({ id })), (w) => w.id);
  const inScope = orgScopeFilter(who, scope);
  return (inScope ? seen.filter((w) => inScope(workspaceRef(w.id))) : seen).map((w) => w.id).sort();
};

test('workspaces: an org keeps its own, personal keeps what no org owns, none keeps today’s list; a non-member org and a forged id are empty', () => {
  const me = person(OWNER);
  assert.deepEqual(workspacesFor(me, null), [WS.org, WS.own].sort(), 'today: everything the owner may see (not org B’s)');
  assert.deepEqual(workspacesFor(me, { kind: 'org', id: orgA }), [WS.org]);
  assert.deepEqual(workspacesFor(me, { kind: 'personal' }), [WS.own]);
  assert.deepEqual(workspacesFor(me, { kind: 'org', id: orgB }), [], 'an org she is not in');
  assert.deepEqual(workspacesFor(me, { kind: 'org', id: 'org_forged000000' }), []);
  assert.deepEqual(workspacesFor(me, { kind: 'org', id: 'not-an-org' }), []);
  assert.deepEqual(workspacesFor(person(EVE), { kind: 'org', id: orgB }), [WS.oth], 'org B’s owner sees org B’s');
  assert.deepEqual(workspacesFor(person(EVE), { kind: 'org', id: orgA }), [], 'never org A’s, by naming it');
  assert.deepEqual(workspacesFor(person(CAROL), { kind: 'org', id: orgA }), [], 'a member without a grant: visibility first, the filter never widens');
});

test('chat sessions: through their workspace’s org', async () => {
  const get = appFor(person(OWNER));
  const all = await get('/chat');
  assert.ok(all.includes('s_org') && all.includes('s_own'));
  assert.deepEqual(await get(`/chat?org=${orgA}`), ['s_org']);
  assert.deepEqual(await get('/chat?org=personal'), ['s_own']);
  assert.deepEqual(await get(`/chat?org=${orgB}`), [], 'a session she may see in an org she is not in stays out');
  assert.deepEqual(await get('/chat?org=org_forged000000'), []);
  assert.deepEqual(await appFor(person(EVE))(`/chat?org=${orgB}`), [], 'the org’s owner gets no one else’s session by naming the org');
});

test('tickets and buckets: a ticket through its bucket’s org; a ticket with no bucket is personal', async () => {
  const get = appFor(person(OWNER));
  assert.deepEqual(await get('/tickets'), ['t_none', 't_org', 't_own']);
  assert.deepEqual(await get(`/tickets?org=${orgA}`), ['t_org']);
  assert.deepEqual(await get('/tickets?org=personal'), ['t_none', 't_own']);
  assert.deepEqual(await get(`/tickets?org=${orgB}`), []);
  assert.deepEqual(await get('/tickets/buckets'), ['ORG', 'OWN']);
  assert.deepEqual(await get(`/tickets/buckets?org=${orgA}`), ['ORG']);
  assert.deepEqual(await get('/tickets/buckets?org=personal'), ['OWN']);
  assert.deepEqual(await get(`/tickets/buckets?org=${orgB}`), []);
  assert.deepEqual(await appFor(person(EVE))(`/tickets/buckets?org=${orgB}`), ['OTH']);
  assert.deepEqual(await appFor(person(EVE))(`/tickets/buckets?org=${orgA}`), []);
  assert.deepEqual(await appFor(person(CAROL))(`/tickets/buckets?org=${orgA}`), [], 'member without a grant');
});

test('vaults: by their own owner', async () => {
  const get = appFor(person(OWNER));
  assert.deepEqual(await get('/knowledge/vaults'), ['v_org', 'v_own']);
  assert.deepEqual(await get(`/knowledge/vaults?org=${orgA}`), ['v_org']);
  assert.deepEqual(await get('/knowledge/vaults?org=personal'), ['v_own']);
  assert.deepEqual(await get(`/knowledge/vaults?org=${orgB}`), []);
  assert.deepEqual(await appFor(person(EVE))(`/knowledge/vaults?org=${orgB}`), ['v_oth']);
  assert.deepEqual(await appFor(person(EVE))(`/knowledge/vaults?org=${orgA}`), []);
});

test('CI runs and remotes: through their workspace’s org', async () => {
  const get = appFor(person(OWNER));
  assert.deepEqual(await get('/ci/runs'), ['r_org', 'r_own']);
  assert.deepEqual(await get(`/ci/runs?org=${orgA}`), ['r_org']);
  assert.deepEqual(await get('/ci/runs?org=personal'), ['r_own']);
  assert.deepEqual(await get(`/ci/runs?org=${orgB}`), []);
  assert.deepEqual(await get('/ci/repos'), ['cr_org', 'cr_own']);
  assert.deepEqual(await get(`/ci/repos?org=${orgA}`), ['cr_org']);
  assert.deepEqual(await get('/ci/repos?org=personal'), ['cr_own']);
  assert.deepEqual(await get(`/ci/repos?org=${orgB}`), []);
  assert.deepEqual(await appFor(person(EVE))(`/ci/runs?org=${orgB}`), ['r_oth']);
  assert.deepEqual(await appFor(person(EVE))(`/ci/repos?org=${orgA}`), []);
});
