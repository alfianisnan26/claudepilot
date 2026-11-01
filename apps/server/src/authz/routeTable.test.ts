// Organizations slice 1 (docs/prd/organizations.md §13.2 row 1): ONE enumeration over the whole app's route table and every Portal MCP tool,
// the central route check that enforces what they declare (authz/routeGuard.ts), probes generated from every declared policy with two users
// (`u_a` owns everything named `a-…`, `u_b` everything named `b-…`), and the owners of P3 (authz/owners.ts, migration 410): an unowned object
// is the same 404 as a missing one.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, OBJECT_TYPE_IDS, objectRef, type Actor, type ObjectType, type RoutePolicy, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { MIGRATIONS } from '../store/migrations.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { freshStore } from '../notify/testkit.js';
import { declareAllPolicies } from './declarations.js';
import { OWNED_TYPES, P3_REQUIRED_TYPES, registerOwnerResolvers, workspaceOwnerResolver } from './owners.js';
import { enforceRoutePolicy, routeParams } from './routeGuard.js';
import { can, clearResolvers, declaredPolicies, declaredToolPolicies, policyFor, registerResolver, requireToolPolicy, resolverRequired } from './seam.js';
import { SERVER_CODE, buildWholeApp, registerAllTools, routeKeys } from './wholeApp.testkit.js';

const U_A = 'u_a' as UserId;
const U_B = 'u_b' as UserId;
const userActor = (userId: UserId): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
/** Declared for a socket, not a route: the chat socket's handshake (chat/authz.ts). */
const SOCKET_KEYS = new Set(['ALL /api/chat/live']);

afterEach(() => clearResolvers());
after(() => clearResolvers());

test('whole app: every route the app registers is declared, and every declaration is a route of the app (or a socket)', async () => {
  const { app } = await buildWholeApp();
  const keys = routeKeys(app);
  assert.ok(keys.size >= 550, `found only ${keys.size} routes; the whole app must be built with every module`);
  const undeclared = [...keys].filter((k) => !policyFor(k));
  assert.deepEqual(undeclared, [], 'routes of the app with no declared policy');
  const stale = [...declaredPolicies().keys()].filter((k) => !keys.has(k) && !SOCKET_KEYS.has(k));
  assert.deepEqual(stale, [], 'declarations with no route (drift)');
  // The prefixes the slice was asked to cover are all there.
  for (const prefix of ['/api/admin/users', '/api/knowledge/vaults', '/api/accounts', '/api/personas', '/api/skills', '/api/mcp', '/api/claude-usage', '/api/usage-spend', '/api/admin/app-sessions', '/api/pools', '/hooks/:token'])
    assert.ok([...keys].some((k) => k.split(' ')[1]!.startsWith(prefix) && policyFor(k)), `${prefix}: declared`);
});

test('whole app: every Portal MCP tool is declared, and the dispatch refuses one that is not', async () => {
  const tools = await registerAllTools();
  declareAllPolicies();
  assert.ok(tools.length >= 130, `found only ${tools.length} tools`);
  assert.deepEqual(tools.filter((t) => !declaredToolPolicies().has(t.name)).map((t) => t.name), [], 'tools with no declared policy');
  assert.throws(
    () => requireToolPolicy(userActor(FOUNDING_USER_ID), 'no_such_declared_tool', {}),
    (e: unknown) => e instanceof AppError && e.code === 'NO_POLICY' && e.status === 403,
    'an undeclared tool is refused, not left to its handler',
  );
});

test('whole app: the central check runs in the session middleware, before every handler (a refusal is the same 404 as a missing one)', async () => {
  const { store } = await freshStore();
  registerOwnerResolvers({ db: () => store.db, workspace: () => null });
  const now = new Date().toISOString();
  store.db!.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v_unowned', 'U', 'vault', '/x', 0, ?, ?, 'org', 'org_x')").run(now, now);
  store.db!.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v_other', 'O', 'vault', '/y', 0, ?, ?, 'user', 'u_b')").run(now, now);
  const { app, portal } = await buildWholeApp({ store });
  const token = portal.signIn(SERVER_CODE);
  const get = async (path: string) => {
    const res = await app.request(`http://localhost${path}`, { headers: { cookie: `portal_session=${token}`, host: 'localhost' } });
    return { status: res.status, body: await res.text() };
  };
  // The founding user (the server code) is refused an unowned vault and another user's vault exactly like a vault that does not exist.
  const missing = await get('/api/knowledge/vaults/v_nosuch');
  assert.equal(missing.status, 404);
  assert.deepEqual(await get('/api/knowledge/vaults/v_unowned'), missing, 'unowned: the same 404');
  assert.deepEqual(await get('/api/knowledge/vaults/v_other'), missing, 'another user’s: the same 404');
});

/** A fake resolver for every object type: `a-…` is u_a's, `b-…` u_b's, anything else does not exist. */
function twoUsers(): void {
  for (const type of OBJECT_TYPE_IDS) {
    if (type === 'platform') continue;
    registerResolver({
      type,
      resolve: (id) => (id.startsWith('a-') ? { ref: objectRef(type, id), owner: { kind: 'user', id: U_A } } : id.startsWith('b-') ? { ref: objectRef(type, id), owner: { kind: 'user', id: U_B } } : null),
    });
  }
}

/** One route behind the central check, the actor set as the session middleware sets it. */
function guarded(key: string, actor: Actor): Hono {
  const [method, path] = key.split(' ') as [string, string];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('actor' as never, actor as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.on(method === 'ALL' ? ['GET'] : [method], path, (c) => c.json({ ok: true, reached: key }));
  app.onError((e, c) => {
    const err = e as AppError;
    return c.json({ ok: false, error: { code: err.code, message: err.message } }, (err.status ?? 500) as 404);
  });
  return app;
}

/** A request that names `prefix-…` for every object the policy checks (path, query and body), so the route reaches its handler or is refused. */
function probe(key: string, policy: RoutePolicy, prefix: string): { url: string; init: RequestInit } {
  const [method, path] = key.split(' ') as [string, string];
  const params = new Map<string, string>();
  let concrete = path.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, (_m, name: string) => {
    const v = `${prefix}-${name}`;
    params.set(name, v);
    return v;
  });
  concrete = concrete.replace(/\*$/, `${prefix}-rest`);
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  if (policy.kind === 'objects')
    for (const c of policy.checks) {
      if (c.from === 'query') query.append(c.param, `${prefix}-${c.param}`);
      if (c.from === 'body') body[c.param] = c.many ? [`${prefix}-${c.param}`] : `${prefix}-${c.param}`;
    }
  const hasBody = Object.keys(body).length > 0 && method !== 'GET';
  return {
    url: `http://localhost${concrete}${query.size ? `?${query}` : ''}`,
    init: { method: method === 'ALL' ? 'GET' : method, ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) },
  };
}

test('probes from every declared policy: the owner reaches the handler, the other user gets exactly the missing answer, platform areas only for the platform', async () => {
  const { app: whole } = await buildWholeApp();
  const keys = [...routeKeys(whole)].filter((k) => {
    const p = policyFor(k);
    return p && (p.kind === 'objects' || p.kind === 'platform');
  });
  assert.ok(keys.length >= 250, `only ${keys.length} routes declare objects or platform`);
  twoUsers();
  const failures: string[] = [];
  let probed = 0;
  for (const key of keys) {
    const policy = policyFor(key)!;
    const send = async (actor: Actor, prefix: string) => {
      const { url, init } = probe(key, policy, prefix);
      const res = await guarded(key, actor).request(url, init);
      return { status: res.status, body: await res.text() };
    };
    if (policy.kind === 'objects') {
      const own = await send(userActor(U_A), 'a');
      if (own.status !== 200) failures.push(`${key}: the owner got ${own.status} ${own.body}`);
      const theirs = await send(userActor(U_B), 'a');
      const missing = await send(userActor(U_B), 'z');
      if (theirs.status !== 404) failures.push(`${key}: another user got ${theirs.status}`);
      if (theirs.body !== missing.body || theirs.status !== missing.status) failures.push(`${key}: another user’s answer differs from a missing object’s`);
      const anonymous = await send({ kind: 'anonymous' }, 'a');
      if (anonymous.status !== 401) failures.push(`${key}: anonymous got ${anonymous.status}`);
    } else {
      const founder = await send(userActor(FOUNDING_USER_ID), 'a');
      if (founder.status !== 200) failures.push(`${key}: the founding user got ${founder.status}`);
      const member = await send(userActor(U_B), 'a');
      if (member.status !== 404) failures.push(`${key}: a user who is not an admin got ${member.status} on a platform area`);
    }
    probed++;
  }
  assert.deepEqual(failures, []);
  assert.equal(probed, keys.length);
});

test('the central check: an undeclared route is refused (403 NO_POLICY) before its handler; signed-in and self need a person', async () => {
  let reached = 0;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('actor' as never, (c.req.header('x-anon') ? { kind: 'anonymous' } : userActor(U_A)) as never);
    await enforceRoutePolicy(c);
    await next();
  });
  app.get('/api/zz-slice1-undeclared', (c) => (reached++, c.json({ ok: true })));
  app.get('/api/me', (c) => (reached++, c.json({ ok: true })));
  app.onError((e, c) => c.json({ code: (e as AppError).code }, ((e as AppError).status ?? 500) as 403));
  const res = await app.request('http://localhost/api/zz-slice1-undeclared');
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { code: 'NO_POLICY' });
  assert.equal(reached, 0, 'the handler never ran');
  declareAllPolicies();
  assert.equal((await app.request('http://localhost/api/me')).status, 200, 'a declared door passes through');
});

test('route parameters are read from the answering route’s pattern', () => {
  assert.deepEqual(routeParams('/api/workspaces/:target/:name/terminals/:term', '/api/workspaces/docker/w1/terminals/t%2F1'), { target: 'docker', name: 'w1', term: 't/1' });
  assert.deepEqual(routeParams('/api/x/:id{[0-9]+}', '/api/x/42'), { id: '42' });
  assert.equal(routeParams('/api/x/:id', '/api/y/1'), null);
  assert.deepEqual(routeParams('/reporter/v1/*', '/reporter/v1/a/b'), {});
});

/* ---------- P3: owners and resolvers ---------- */

test('P3: the owner resolvers mark their types required, so a type whose resolver is gone refuses instead of answering the founding user', async () => {
  const { store } = await freshStore();
  registerOwnerResolvers({ db: () => store.db, workspace: () => null });
  for (const t of P3_REQUIRED_TYPES) assert.equal(resolverRequired(t), true, `${t} is required`);
  clearResolvers();
  for (const t of [...OWNED_TYPES, 'template'] as ObjectType[]) {
    const d = can(userActor(FOUNDING_USER_ID), 'view', objectRef(t, 'anything'));
    assert.equal(d.allow, false, `${t}: no resolver, no right`);
  }
});

test('P3: vault, set, account pool, account and endpoint: the owner manages, another user and an unowned row are the missing 404', async () => {
  const { store } = await freshStore();
  const db = store.db!;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_id) VALUES ('v1', 'V', 'vault', '/v', 0, ?, ?, 'u_a')").run(now, now);
  db.prepare("INSERT INTO pools (id, type, name, created_at, updated_at, owner_id) VALUES ('p1', 'secrets', 'S', ?, ?, 'u_a')").run(now, now);
  db.prepare("INSERT INTO pools (id, type, name, created_at, updated_at, owner_id) VALUES ('ap1', 'account', 'A', ?, ?, 'u_a')").run(now, now);
  db.prepare("INSERT INTO endpoints (id, kind, name, base_url, created_at, updated_at, owner_id) VALUES ('e1', 'custom', 'E', 'https://e.example', ?, ?, 'u_a')").run(now, now);
  db.prepare("INSERT INTO accounts (id, endpoint_id, name, fingerprint, masked, created_at, updated_at, owner_id) VALUES ('k1', 'e1', 'K', 'fp1', '…', ?, ?, 'u_a')").run(now, now);
  db.prepare("INSERT INTO pools (id, type, name, created_at, updated_at, owner_kind, owner_id) VALUES ('p_org', 'skillset', 'O', ?, ?, 'org', 'org_x')").run(now, now);
  registerOwnerResolvers({ db: () => store.db, workspace: () => null });
  const cases: [ObjectType, string, string?][] = [['vault', 'v1'], ['pool', 'p1', 'secrets'], ['account_pool', 'ap1'], ['endpoint', 'e1'], ['account', 'k1']];
  for (const [type, id, poolType] of cases) {
    const ref = objectRef(type, id, poolType as never);
    assert.equal(can(userActor(U_A), 'manage', ref).allow, true, `${type}: its owner manages it`);
    const theirs = can(userActor(U_B), 'view', ref);
    const missing = can(userActor(U_B), 'view', objectRef(type, 'nosuch', poolType as never));
    assert.equal(theirs.allow, false);
    assert.equal(theirs.allow === false && theirs.reason, 'not_found', `${type}: another user's is not found`);
    assert.equal(missing.allow === false && missing.reason, 'not_found');
    assert.equal(can(userActor(FOUNDING_USER_ID), 'view', ref).allow, false, `${type}: the founding user holds nothing on another user's (D12)`);
  }
  // A set reached under another type is not found; an account pool is not a set.
  assert.equal(can(userActor(U_A), 'view', objectRef('pool', 'p1', 'skillset')).allow, false);
  assert.equal(can(userActor(U_A), 'view', objectRef('pool', 'ap1')).allow, false);
  // Unowned (an org owner before organizations land): nobody, the founding user too; the answer is 404 like a missing one.
  const unowned = can(userActor(FOUNDING_USER_ID), 'view', objectRef('pool', 'p_org', 'skillset'));
  assert.equal(unowned.allow === false && unowned.reason, 'unowned');
});

test('P3: workspaces: the owner row counts only for the workspace it was made for (uid); a workspace with no row is unclaimed, the platform’s', async () => {
  const { store } = await freshStore();
  const db = store.db!;
  const live: Record<string, { id: string; legacyId: string }> = {
    'docker/mine': { id: 'ws_000000000001', legacyId: 'docker/mine' },
    'docker/reused': { id: 'ws_000000000003', legacyId: 'docker/reused' },
    'docker/unowned': { id: 'ws_000000000004', legacyId: 'docker/unowned' },
  };
  const resolveWs = (ref: string) => live[ref] ?? Object.values(live).find((w) => w.id === ref) ?? null;
  const now = new Date().toISOString();
  const row = db.prepare('INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)');
  row.run('docker/mine', 'ws_000000000001', 'user', 'u_a', 'u_a', now, 'created');
  row.run('docker/reused', 'ws_000000000002', 'user', 'u_a', 'u_a', now, 'created'); // made for an earlier workspace of that name
  row.run('docker/unowned', 'ws_000000000004', 'org', 'org_x', 'u_owner', now, 'created');
  const r = workspaceOwnerResolver({ db: () => db, workspace: resolveWs });
  assert.deepEqual(r.resolve('docker/mine')?.owner, { kind: 'user', id: 'u_a' });
  assert.deepEqual(r.resolve('ws_000000000001')?.owner, { kind: 'user', id: 'u_a' }, 'by its stable id');
  assert.equal(r.resolve('ws_000000000001')?.ref.id, 'docker/mine', 'decided on its key');
  assert.deepEqual(r.resolve('docker/reused')?.owner, { kind: 'platform' }, 'another uid: unclaimed');
  assert.deepEqual(r.resolve('docker/fresh')?.owner, { kind: 'platform' }, 'no row: unclaimed');
  assert.equal(r.resolve('docker/unowned')?.owner, null, 'an owner the seam cannot read yet: unowned');
  assert.equal(r.resolve('ws_ffffffffffff'), null, 'an unknown stable id: not found');
  assert.equal(r.resolve('not a workspace'), null);
  registerOwnerResolvers({ db: () => db, workspace: resolveWs });
  assert.equal(can(userActor(U_A), 'manage', objectRef('workspace', 'docker/mine')).allow, true);
  assert.equal(can(userActor(U_B), 'view', objectRef('workspace', 'docker/mine')).allow, false);
  assert.equal(can(userActor(FOUNDING_USER_ID), 'manage', objectRef('workspace', 'docker/fresh')).allow, true, 'the platform admin keeps an unclaimed one');
  assert.equal(can(userActor(U_B), 'view', objectRef('workspace', 'docker/fresh')).allow, false, 'nobody else sees it');
  // CI runs and remotes take their workspace's owner.
  const { registerCiAuthz } = await import('../ci/authz.js');
  registerCiAuthz({ workspaceOfRun: (id) => (id === 'run1' ? 'docker/mine' : id === 'run2' ? 'docker/unowned' : null), workspaceOfRepo: () => null });
  assert.equal(can(userActor(U_A), 'view', objectRef('ci_run', 'run1')).allow, true);
  assert.equal(can(userActor(U_B), 'view', objectRef('ci_run', 'run1')).allow, false);
  assert.equal(can(userActor(FOUNDING_USER_ID), 'view', objectRef('ci_run', 'run2')).allow, false, 'a run of an unowned workspace: nobody');
});

test('P3 migration 410: existing workspaces, vaults, sets, accounts and endpoints are the founding user’s; a new workspace records its creator', async () => {
  const dataDir = tempDirectory('orgs-slice1-');
  const before = MIGRATIONS.filter((m) => m.version !== 410);
  const old = await Store.open({ dataDir, secretKey: null, migrations: before });
  const now = new Date().toISOString();
  old.db!.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES ('ws_00000000000a', 'kubernetes', 'kohi-event', 'kubernetes/kohi-event', ?)").run(now);
  old.db!.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at, removed_at) VALUES ('ws_00000000000b', 'docker', 'gone', 'docker/gone', ?, ?)").run(now, now);
  old.db!.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at) VALUES ('v_old', 'Old', 'vault', '/o', 0, ?, ?)").run(now, now);
  old.db!.prepare("INSERT INTO pools (id, type, name, created_at, updated_at) VALUES ('p_old', 'secrets', 'Old', ?, ?)").run(now, now);
  old.close();
  const store = await Store.open({ dataDir, secretKey: null });
  const db = store.db!;
  assert.deepEqual(
    { ...(db.prepare("SELECT uid, owner_kind, owner_id, origin FROM workspace_owners WHERE workspace_id = 'kubernetes/kohi-event'").get() as object) },
    { uid: 'ws_00000000000a', owner_kind: 'user', owner_id: FOUNDING_USER_ID, origin: 'migrated' },
  );
  assert.equal(db.prepare("SELECT 1 FROM workspace_owners WHERE workspace_id = 'docker/gone'").get(), undefined, 'a removed workspace gets no owner');
  for (const [table, id] of [['kg_vaults', 'v_old'], ['pools', 'p_old'], ['endpoints', 'anthropic']] as const)
    assert.deepEqual({ ...(db.prepare(`SELECT owner_kind, owner_id FROM ${table} WHERE id = ?`).get(id) as object) }, { owner_kind: 'user', owner_id: FOUNDING_USER_ID }, table);
  assert.throws(() => db.prepare("UPDATE pools SET owner_kind = 'nobody' WHERE id = 'p_old'").run(), /CHECK/);
  // A workspace the portal creates now records its owner with its own uid (workspaces/identity.ts `allocate`).
  const { WorkspaceIdentities } = await import('../workspaces/identity.js');
  const ids = new WorkspaceIdentities(store);
  const w = ids.allocate('docker', 'new-one', undefined, 'user:u_a');
  assert.deepEqual(
    { ...(db.prepare("SELECT uid, owner_id, created_by, origin FROM workspace_owners WHERE workspace_id = 'docker/new-one'").get() as object) },
    { uid: w.id, owner_id: FOUNDING_USER_ID, created_by: 'user:u_a', origin: 'created' },
  );
  store.close();
});
