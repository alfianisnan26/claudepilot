// MCP tool isolation (security near miss 2026-11-01). A Portal MCP token owned by a MEMBER of one org (scope operate) called `workspace_list`
// on the live portal and got every workspace of every org. A token acts as its person capped by its scope; this file holds the whole registry
// to that, the way routeTable.test.ts holds every route to a declared policy:
//   1. the registry sweep: EVERY tool of the portal, through the dispatch's own check (`requireToolPolicy`, the call portalmcp/server.ts makes
//      before any handler), with a member's admin-scope token: a platform tool is refused; a tool that names no object is refused unless it is a
//      member door (authz/memberToolDoors.ts, each read for a per-person answer); a tool that names objects is refused on org B's objects and
//      passes on the member's own (the control that proves the refusal is the isolation, not a missing resolver);
//   2. end to end over /mcp with real tokens, a real migrated database, the real orgs module and owner resolvers: the lists and reads a member
//      may call answer only what the member may see (nothing of org B, nothing personal of another person); org B's objects read like missing
//      ones; an admin account outside org B does not see org B's workspaces either; a call without an org returns the person's whole visible set.
// Before the fix, `workspace_list` answered the member every workspace (test "workspace_list ... (the live leak)" fails on main).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, type Actor, type UserId } from '@portal/contracts';
import { registerOwnerResolvers } from './owners.js';
import { clearResolvers, requireToolPolicy, toolPolicyFor, useAccountRoles, useOrgAuthority, type AccountRoleOf } from './seam.js';
import { MEMBER_TOOL_DOORS } from './memberToolDoors.js';
import { registerAllTools } from './wholeApp.testkit.js';
import { registerChatAuthz } from '../chat/authz.js';
import { registerChatManagerTools } from '../chat/managerTools.js';
import { registerCiAuthz } from '../ci/authz.js';
import { registerCiTools } from '../ci/portalTools.js';
import { createOrgs, type OrgsModule } from '../orgs/index.js';
import { PortalMcpModule } from '../portalmcp/module.js';
import { portalTools } from '../portalmcp/registry.js';
import { readRpc, URL_ } from '../portalmcp/testkit.js';
import { registerBuiltInPortalTools } from '../portalmcp/tools/index.js';
import { registerRepoTools } from '../repos/portalTools.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';

const OWNER = FOUNDING_USER_ID as UserId; // owner of org A, not in org B
const MEMBER = 'u_Memb3r00000s' as UserId; // a member of org A only (the live case), shared one org A workspace
const EVE = 'u_Eve0000000s' as UserId; // owner of org B
const ADA = 'u_Ada00000000s' as UserId; // a second admin account, in no org

const NOW = new Date().toISOString();
const WS = { a: 'docker/ws-a', b: 'docker/ws-b', own: 'docker/ws-own', mine: 'docker/ws-mine' } as const;
/** Everything of org B (and of other people) carries one of these in its id or name; nothing of it may reach the member. */
const FOREIGN = /ws-b|ws-own|s_b\b|s_own|s_a_owner|run_b|run_own|bbbbbbbbbbbb|ffffffffffff|\bBBB\b|T-2\b/;

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let mcp: PortalMcpModule;

/** Org B's objects (and others' personal ones) by object type, and the member's own (the control) where the member may hold every verb. */
const FOREIGN_IDS: Record<string, string> = { workspace: WS.b, session: 's_b', claude: 'c_b', ci_run: 'run_b', ci_repo: 'cr_b', ticket: 'T-2', ticket_bucket: 'BBB', account: 'acc_b', budget: 'bud_b', pool: 'pool_b' };
const OWN_IDS: Record<string, string> = { workspace: WS.mine, session: 's_mine', claude: 'c_mine', ci_run: 'run_mine', ci_repo: 'cr_mine', ticket: 'T-1', ticket_bucket: 'MINE' };

const tokenActor = (userId: UserId, scope: 'read' | 'operate' | 'admin' = 'admin'): Actor => ({ kind: 'token', userId, tokenId: 'pmcp_probe', scope });

const sessions: Record<string, { workspaceId: string; ownerId: UserId; title: string }> = {
  s_a: { workspaceId: WS.a, ownerId: MEMBER, title: 'member chat in org A' },
  s_a_owner: { workspaceId: WS.a, ownerId: OWNER, title: 'owner chat in org A' },
  s_b: { workspaceId: WS.b, ownerId: EVE, title: 'eve chat in org B' },
  s_own: { workspaceId: WS.own, ownerId: OWNER, title: 'owner personal chat' },
  s_mine: { workspaceId: WS.mine, ownerId: MEMBER, title: 'member personal chat' },
};
const runs: Record<string, string> = { run_a: WS.a, run_b: WS.b, run_own: WS.own, run_mine: WS.mine };
const repos: Record<string, string> = { r_aaaaaaaaaaaa: WS.a, r_bbbbbbbbbbbb: WS.b, r_ffffffffffff: WS.own, r_cccccccccccc: WS.mine };
const buckets: Record<string, { kind: string; id: string }> = {};
const tickets: Record<string, string> = { 'T-1': 'MINE', 'T-2': 'BBB' };

function addUser(id: string, role: 'admin' | 'member') {
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', NOW, NOW, 'ui');
}

/* ---------- Fakes of the services the tools adapt (each holds rows of every org; the tools must filter) ---------- */

const workspace = (id: string) => ({ id, name: id.split('/')[1]!, target: 'docker', image: 'img', status: 'running', createdAt: NOW });
const session = (id: string) => ({
  id,
  workspaceId: sessions[id]!.workspaceId,
  cwd: '/home/node/work',
  title: sessions[id]!.title,
  state: 'idle',
  origin: 'ui',
  model: null,
  mode: 'default',
  effort: null,
  costUsd: 0,
  turns: 1,
  lastSeq: 1,
  waiting: 0,
  createdAt: NOW,
  lastActivityAt: NOW,
  endedReason: null,
  archivedAt: null,
  pinnedAt: null,
  ticketId: null,
  startedBy: null,
  parentId: id === 's_b' || id === 's_a_owner' ? 's_a' : null, // foreign workers under the member's own chat: session_get must not list them
});
const run = (id: string) => ({ id, number: 1, workspaceId: runs[id]!, repoId: 'x', repo: `repo-${id}`, pipeline: 'deploy', branch: 'main', tag: null, sha: 'abc', subject: id, trigger: 'manual', status: 'success', reason: null, actor: null, actorLabel: null, ticketId: null, sessionId: null, createdAt: NOW, finishedAt: NOW, durationMs: 1 });
const repoNode = (id: string) => ({ id, workspaceId: repos[id]!, kind: 'repo', depth: 0, parentId: null, name: `repo of ${repos[id]}`, path: `/home/node/${id}`, state: null, attention: { reasons: ['dirty'], score: 1 }, error: null, submodule: null, sync: null, sessions: [], scannedAt: NOW });
const SUMMARY = { repos: 1, missing: 0, dirty: 1, diverged: 0, behind: 0, unpushed: 0, conflicted: 0, drifted: 0, errors: 0 };

const fakes = {
  store: { writable: true, schemaVersion: 1, trust: { state: 'ok', reasons: [] } },
  workspaces: {
    list: async () => Object.values(WS).map(workspace),
    targets: async () => [{ id: 'docker', label: 'Docker', kind: 'docker', available: true, problem: null }],
    usage: async () => [],
    resolve: () => null,
  },
  chat: {
    list: (f: { workspaceId?: string; parentId?: string } = {}) =>
      Object.keys(sessions)
        .map(session)
        .filter((s) => (!f.workspaceId || s.workspaceId === f.workspaceId) && (!f.parentId || s.parentId === f.parentId)),
    get: (id: string) => (sessions[id] ? session(id) : null),
    openRequests: () => [],
    historyTail: () => ({ events: [], cut: false }),
    listClaudes: () => [],
  },
  accounts: { overview: () => ({ locked: false, accounts: [], endpoints: [] }) },
  accountPools: { list: () => [], stateFor: () => null },
  poolService: { types: () => ['secrets'], list: () => [], typeOf: () => null, assignmentsFor: () => [] },
  reconciler: { row: () => null },
};

const ciFake = {
  list: (f: { workspace?: string; limit?: number }) => ({ items: Object.keys(runs).map(run).filter((r) => !f.workspace || r.workspaceId === f.workspace) }),
  show: async (id: string) => ({ ...run(id), deployments: [{ environment: 'prod', approval: 'waiting' }], detail: [] }),
  repos: async () => [],
  stgAgeMinutes: () => null,
};

const reposFake = {
  overview: async (viewable: (ws: string) => boolean) => {
    const nodes = Object.keys(repos).map(repoNode).filter((n) => viewable(n.workspaceId));
    return { total: SUMMARY, workspaces: nodes.map((n) => ({ workspaceId: n.workspaceId, name: n.workspaceId, running: true, scannedAt: NOW, summary: SUMMARY })), attention: nodes };
  },
  workspace: async (ws: string) => ({ repos: Object.keys(repos).filter((id) => repos[id] === ws).map(repoNode), summary: SUMMARY, scan: { at: NOW, truncated: false, error: null }, running: true }),
  workspaceOf: (id: string) => {
    if (!repos[id]) throw new Error('no such repository');
    return repos[id]!;
  },
  detail: (id: string) => ({ repo: repoNode(id), children: [], events: [] }),
  eventsWithin: async (q: { workspaceId?: string }, viewable: (ws: string) => boolean) => ({
    events: Object.values(repos)
      .filter((ws) => (!q.workspaceId || ws === q.workspaceId) && viewable(ws))
      .map((ws, i) => ({ id: i + 1, at: NOW, kind: 'found', workspaceId: ws, repoId: 'r', repo: `repo in ${ws}`, actor: null, sessionId: null, summary: `found in ${ws}`, data: {} })),
    next: null,
  }),
};

/* ---------- Setup ---------- */

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-mcpiso-'), secretKey: null });
  const db = store.db!;
  addUser(OWNER, 'admin');
  addUser(ADA, 'admin');
  addUser(MEMBER, 'member');
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
  const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
  const orgA = m.orgs.create(person(OWNER), { name: 'Konfersi', slug: 'konfersi' }).id;
  m.orgs.admit(orgA, MEMBER, 'member', 'invite', 'test');
  const orgB = m.orgs.create(person(OWNER), { name: 'Kohilabs', slug: 'kohilabs' }).id;
  m.orgs.admit(orgB, EVE, 'owner', 'invite', 'test');
  m.orgs.leave(person(OWNER), orgB);

  const owners: Record<keyof typeof WS, [string, string]> = { a: ['org', orgA], b: ['org', orgB], own: ['user', OWNER], mine: ['user', MEMBER] };
  for (const k of Object.keys(WS) as (keyof typeof WS)[]) {
    const uid = `ws_${k}${'0'.repeat(12 - k.length)}`;
    db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, 'docker', ?, ?, ?)").run(uid, `ws-${k}`, WS[k], NOW);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'created')").run(WS[k], uid, owners[k][0], owners[k][1], OWNER, NOW);
    db.prepare('INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, ?, ?)').run(`c_${k}`, WS[k], `Claude ${k}`, '', NOW);
  }
  // The live case: org A shares one workspace with its member (operate), as Konfersi shares konfersi/konfersi.
  db.prepare("INSERT INTO grants (id, object_type, object_id, object_uid, subject_kind, subject_id, level, share_id, granted_by, created_at) VALUES ('gr_probe', 'workspace', ?, 'ws_a00000000000', 'user', ?, 'operate', 'test', ?, ?)").run(
    WS.a,
    MEMBER,
    `user:${OWNER}`,
    NOW,
  );
  // The real dispatch over the portal's registry: the families the end-to-end part calls get fakes with rows of every org; the rest stand-ins.
  mcp = new PortalMcpModule(store, { registry: portalTools, agentHost: { alive: () => false, url: () => 'http://127.0.0.1:1/mcp' }, managerAlive: () => false });
  mcp.settings.update({ enabled: true, sessionControl: true });
  registerBuiltInPortalTools({ ...fakes, module: mcp } as never);
  registerCiTools(ciFake as never, undefined);
  registerRepoTools(reposFake as never);
  registerChatManagerTools({ db: () => store.db, chat: fakes.chat as never, caps: () => null });
  await registerAllTools(['../portalmcp/tools/index.js', '../ci/portalTools.js', '../repos/portalTools.js', '../chat/managerTools.js']);
  // The resolvers last: a family registered with stand-ins may register its own (the tickets', the chat's) over them.
  registerChatAuthz((id) => (sessions[id] ? { id, workspaceId: sessions[id]!.workspaceId, ownerId: sessions[id]!.ownerId } : null));
  registerCiAuthz({ workspaceOfRun: (id) => runs[id] ?? null, workspaceOfRepo: (id) => (id === 'cr_b' ? WS.b : id === 'cr_mine' ? WS.mine : null) });
  buckets.BBB = { kind: 'org', id: orgB };
  buckets.MINE = { kind: 'user', id: MEMBER };
  registerTicketBucketAuthz({ bucketOwner: () => null, bucketOwnerOf: (key) => buckets[key] ?? null, bucketOf: (ref) => tickets[ref] ?? null });

});

after(() => {
  void mcp?.mcp.close().catch(() => undefined);
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
  store.close();
});

/* ---------- 1. The registry sweep ---------- */

const refusedNotFound = (fn: () => void): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return isAppError(e) && e.code === 'NOT_FOUND';
  }
};

test('every tool of the portal: a member’s token is refused platform tools, undeclared doors and org B’s objects, and passes its own', () => {
  const member = tokenActor(MEMBER);
  const tools = portalTools.list();
  assert.ok(tools.length >= 130, `the whole registry is loaded (${tools.length} tools)`);
  const reach: string[] = [];
  const problems: string[] = [];
  for (const tool of tools) {
    const policy = toolPolicyFor(tool.name);
    if (!policy) {
      problems.push(`${tool.name}: no declared policy`);
      continue;
    }
    if (policy.kind === 'platform') {
      if (!refusedNotFound(() => requireToolPolicy(member, tool.name, {}))) problems.push(`${tool.name}: a platform tool passed a member's token`);
      continue;
    }
    const door = Object.prototype.hasOwnProperty.call(MEMBER_TOOL_DOORS, tool.name);
    if (policy.kind !== 'objects') {
      const refused = refusedNotFound(() => requireToolPolicy(member, tool.name, {}));
      if (door && refused) problems.push(`${tool.name}: a member door refused a member's token`);
      if (!door && !refused) problems.push(`${tool.name}: a ${policy.kind} tool that is not a member door passed a member's token`);
      if (door) reach.push(tool.name);
      continue;
    }
    // Objects: every check named, with org B's object of its type (or another person's), is refused like a missing one.
    for (const check of policy.checks) {
      const foreign = FOREIGN_IDS[check.type];
      if (!foreign) {
        problems.push(`${tool.name}: no org B ${check.type} in the probe (add one)`);
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const c of policy.checks) if (!c.optional || c === check) args[c.arg] = OWN_IDS[c.type] !== undefined ? (c.many ? [OWN_IDS[c.type]] : OWN_IDS[c.type]) : c.many ? [FOREIGN_IDS[c.type]] : FOREIGN_IDS[c.type];
      args[check.arg] = check.many ? [OWN_IDS[check.type] ?? foreign, foreign] : foreign;
      if (!refusedNotFound(() => requireToolPolicy(member, tool.name, args))) problems.push(`${tool.name}: ${check.arg} = org B's ${check.type} passed`);
    }
    // The control: the member's own objects pass (so the refusal above is the isolation, not a missing resolver), where the probe has them.
    const required = policy.checks.filter((c) => !c.optional);
    if (required.every((c) => OWN_IDS[c.type] !== undefined)) {
      const own: Record<string, unknown> = {};
      for (const c of required) own[c.arg] = c.many ? [OWN_IDS[c.type]] : OWN_IDS[c.type];
      const named = required.length > 0;
      if (named || door) {
        try {
          requireToolPolicy(member, tool.name, own);
          reach.push(tool.name);
        } catch (e) {
          problems.push(`${tool.name}: the member's own objects were refused (${(e as Error).message})`);
        }
      } else if (!refusedNotFound(() => requireToolPolicy(member, tool.name, own))) problems.push(`${tool.name}: names no object and is not a member door, yet passed`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  // Every door is a real tool (a renamed tool leaves no stale door behind).
  const names = new Set(tools.map((t) => t.name));
  assert.deepEqual(Object.keys(MEMBER_TOOL_DOORS).filter((n) => !names.has(n)), []);
  assert.ok(reach.includes('workspace_list') && reach.includes('session_list') && !reach.includes('workspace_create') && !reach.includes('audit_search'));
});

test('a platform admin is not held to the member doors; an admin account’s token passes them too', () => {
  for (const userId of [OWNER, ADA]) {
    const admin = tokenActor(userId);
    assert.doesNotThrow(() => requireToolPolicy(admin, 'workspace_create', {}));
    assert.doesNotThrow(() => requireToolPolicy(admin, 'pool_list', {}));
    assert.doesNotThrow(() => requireToolPolicy(admin, 'audit_search', {}));
  }
});

/* ---------- 2. End to end over /mcp ---------- */

const mint = (userId: UserId, scope: 'read' | 'operate' | 'admin', label: string) => mcp.createToken({ label, scope }, URL_, `user:${userId}`).secret;

async function call(secret: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp.mcp.handle(
    new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    { ip: '10.0.0.9' },
  );
  const r = await readRpc(res);
  const result = r.body?.result as { isError?: boolean; structuredContent?: Record<string, any>; content?: { text: string }[] } | undefined;
  return { result, data: result?.structuredContent ?? {}, code: result?.structuredContent?.error?.code as string | undefined, text: JSON.stringify(r.body ?? null) };
}

test('workspace_list with a member’s operate token answers only what the member may see (the live leak)', async () => {
  const secret = mint(MEMBER, 'operate', 'afgan-probe');
  const r = await call(secret, 'workspace_list');
  assert.equal(r.result?.isError, undefined, r.text);
  const ids = (r.data.workspaces as { id: string }[]).map((w) => w.id).sort();
  // Before: every workspace of every org (docker/ws-a, ws-b, ws-mine, ws-own).
  assert.deepEqual(ids, [WS.a, WS.mine].sort(), 'the shared org A workspace and the member’s own; never org B’s or the owner’s personal one');
  assert.equal(r.data.total, 2);
  assert.doesNotMatch(r.text, FOREIGN);
});

test('every list and read a member may call answers nothing of org B or of another person', async () => {
  const secret = mint(MEMBER, 'operate', 'afgan-lists');
  const lists: [string, Record<string, unknown>, (data: Record<string, any>) => void][] = [
    ['portal_status', {}, (d) => (assert.equal(d.workspaces.total, 2), assert.deepEqual(d.targets, []), assert.equal(d.portal.trust, undefined))],
    ['workspace_list', {}, (d) => assert.equal(d.total, 2)],
    ['workspace_get', { id: WS.a }, (d) => assert.deepEqual(d.sessions.map((s: { id: string }) => s.id), ['s_a'])],
    ['session_list', {}, (d) => assert.deepEqual(d.sessions.map((s: { id: string }) => s.id).sort(), ['s_a', 's_mine'])],
    ['session_list', { workspace_id: WS.a }, (d) => assert.deepEqual(d.sessions.map((s: { id: string }) => s.id), ['s_a'])],
    ['session_get', { id: 's_a' }, (d) => assert.equal(d.workers_total, 0, 'foreign workers under its own chat are not listed')],
    ['ci_runs_list', {}, (d) => assert.deepEqual(d.runs.map((x: { id: string }) => x.id).sort(), ['run_a', 'run_mine'])],
    ['deploy_status', {}, (d) => assert.deepEqual(d.deploys.map((x: { id: string }) => x.id).sort(), ['run_a', 'run_mine'])],
  ];
  for (const [name, args, check] of lists) {
    const r = await call(secret, name, args);
    assert.equal(r.result?.isError, undefined, `${name} ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, FOREIGN, `${name} ${JSON.stringify(args)} showed something of org B or of another person`);
    check(r.data);
  }
});

test('org B’s objects read like missing ones to a member’s token; writes on them are refused before anything runs', async () => {
  const secret = mint(MEMBER, 'admin', 'afgan-admin-scope');
  const refused: [string, Record<string, unknown>][] = [
    ['workspace_get', { id: WS.b }],
    ['workspace_get', { id: WS.own }],
    ['workspace_start', { id: WS.b }],
    ['workspace_delete', { id: WS.b }],
    ['session_get', { id: 's_b' }],
    ['session_get', { id: 's_a_owner' }],
    ['session_send', { id: 's_b', text: 'hi' }],
    ['session_list', { workspace_id: WS.b }],
    ['ci_run_get', { id: 'run_b' }],
    // Not for members yet (multi-user.md §22): repositories and the approvals queue, even their own.
    ['repos_list', {}],
    ['repos_list', { workspace_id: WS.mine }],
    ['repo_get', { id: 'r_cccccccccccc' }],
    ['approvals_list', {}],
    // Not member doors: the same answer as an unknown object, whatever the token's scope.
    ['workspace_create', { name: 'x', target: 'docker' }],
    ['pool_list', {}],
    ['account_list', {}],
    ['audit_search', {}],
    ['settings_get', {}],
    ['claude_usage_summary', {}],
    ['lab_summary', {}],
    ['crew_scorecard', {}],
    ['metrics_overview', {}],
  ];
  for (const [name, args] of refused) {
    const r = await call(secret, name, args);
    assert.equal(r.result?.isError, true, `${name} ${JSON.stringify(args)} was not refused: ${r.text}`);
    assert.equal(r.code, 'NOT_FOUND', `${name} ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, FOREIGN, `${name} named something of org B in its refusal`);
  }
});

test('an admin account outside org B does not see org B’s workspaces either; the founding user sees its own and org A’s', async () => {
  const ada = await call(mint(ADA, 'read', 'ada-probe'), 'workspace_list');
  const adaIds = (ada.data.workspaces as { id: string }[]).map((w) => w.id);
  assert.ok(!adaIds.includes(WS.b) && !adaIds.includes(WS.a), `an admin account holds nothing in an org it is not in: ${adaIds.join(', ')}`);
  assert.ok(adaIds.includes(WS.own), 'the founding user’s personal workspace stays an admin’s (D-82)');
  const owner = await call(mint(OWNER, 'read', 'owner-probe'), 'workspace_list');
  const ownerIds = (owner.data.workspaces as { id: string }[]).map((w) => w.id).sort();
  // No `?org=` over MCP: the person's whole visible set (every org they are in, and personal), never more.
  assert.deepEqual(ownerIds, [WS.a, WS.own].sort());
});

test('repositories over MCP keep to the workspaces the token’s person may view (an admin account outside org B, and a workspace_id)', async () => {
  const secret = mint(ADA, 'operate', 'ada-repos');
  const all = await call(secret, 'repos_list');
  assert.equal(all.result?.isError, undefined, all.text);
  assert.deepEqual((all.data.workspaces as { workspace_id: string }[]).map((w) => w.workspace_id), [WS.own]);
  const attention = await call(secret, 'repos_attention');
  assert.deepEqual((attention.data.repos as { workspace_id: string }[]).map((r) => r.workspace_id), [WS.own]);
  const events = await call(secret, 'repo_events');
  assert.deepEqual((events.data.events as { workspace_id: string }[]).map((e) => e.workspace_id), [WS.own]);
  // Before: a workspace_id or a repository id of another org was read as it is (ctx.assertWorkspace let every token that is not an agent's through).
  for (const [name, args] of [
    ['repos_list', { workspace_id: WS.b }],
    ['repos_attention', { workspace_id: WS.b }],
    ['repo_events', { workspace_id: WS.b }],
    ['repo_get', { id: 'r_bbbbbbbbbbbb' }],
    ['repo_get', { id: 'r_aaaaaaaaaaaa' }],
  ] as [string, Record<string, unknown>][]) {
    const r = await call(secret, name, args);
    assert.equal(r.code, 'NOT_FOUND', `${name} ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, /ws-b|ws-a|bbbbbbbbbbbb|aaaaaaaaaaaa/);
  }
  const own = await call(secret, 'repo_get', { id: 'r_ffffffffffff' });
  assert.equal(own.data.repo?.id, 'r_ffffffffffff', 'the founding user’s personal workspace stays an admin’s (D-82)');
});
