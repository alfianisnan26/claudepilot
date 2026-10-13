// T-42 slice 1 (docs/prd/targets-connect.md §24): an identity must not be a name. Every workspace has a stable opaque id (`ws_` and 12 hex)
// that is never changed, never reused and never derived from the name; the old `<target>/<name>` stays an alias that resolves; responses
// carry both; the runtime name (Deployment, container, home volume) is STORED and read back, never recomputed from the name. Kubernetes is
// the in-process fake API server (no cluster, KUBERNETES SAFETY RULE), the store a temporary directory: nothing real is touched.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { isStableWorkspaceId, workspaceRef, type Actor, type Workspace, type WorkspaceTarget } from '@portal/contracts';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import type { JsonFile } from '../jsonFile.js';
import { MIGRATIONS } from '../store/migrations.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { findWorkspace, homeVolumeOf, newRuntimeName, WorkspaceIdentities } from './identity.js';
import { createApp } from '../app.js';
import { CONTAINER_NAME, VOLUME_NAME } from '../connect/agent/services/docker/rules.js';
import { Portal } from '../portal.js';
import { ConnectDockerRuntime } from './connect/dockerCluster.js';
import { memoryDeps, targetRecord } from './connect/testkit.js';
import { kubeRuntimeOn } from './kubeTestkit.js';
import { Workspaces } from './manager.js';
import type { Runtime } from './runtime.js';

const savedKubeconfig = process.env.KUBECONFIG;
before(() => {
  // Anything that still called loadFromDefault() would read this, and fail: nothing must.
  process.env.KUBECONFIG = '/nonexistent/t42-kubeconfig';
});
after(() => {
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
});

const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
/** A stable id nobody has: built at run time, like every id-shaped fixture. */
const NOBODY = `ws_${'0'.repeat(12)}`;
const STABLE = /^ws_[0-9a-f]{12}$/;

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A runtime that lists what it is given and does nothing else. */
function listing(target: string, names: string[]): Runtime {
  const t: WorkspaceTarget = { id: target, label: target, kind: 'docker', where: `/${target}`, available: true };
  const list: Workspace[] = names.map((name) => ({ id: `${target}/${name}`, name, runtimeName: `claudepilot-${name}`, target, image: 'img', status: 'running', createdAt: '2026-10-01T00:00:00.000Z' }));
  return { target: t, check: async () => undefined, list: async () => list } as unknown as Runtime;
}

async function migratedStore(rows: string[]): Promise<Store> {
  const dir = tempDirectory('cp-t42-');
  // A database as it was before migration 712, with the workspaces the portal knew then.
  const first = await Store.open({ dataDir: dir, secretKey: null, migrations: MIGRATIONS.filter((m) => m.version !== 712) });
  for (const id of rows) first.db!.prepare('INSERT INTO workspace_delivery (workspace_id) VALUES (?)').run(id);
  first.close();
  const store = await Store.open({ dataDir: dir, secretKey: null, migrations: MIGRATIONS });
  assert.ok(store.writable, 'the migrated store can be written');
  return store;
}

test('the registry: a new id is ws_ and 12 hex with the runtime name ws-<hex>; both forms resolve; a removed id never comes back', () => {
  const ids = WorkspaceIdentities.memory();
  const api = ids.allocate('docker', 'api');
  assert.match(api.id, STABLE);
  assert.ok(isStableWorkspaceId(api.id));
  assert.equal(api.runtimeName, `ws-${api.id.slice(3)}`);
  assert.equal(api.runtimeName, newRuntimeName(api.id));
  assert.equal(homeVolumeOf(api.runtimeName!), `ws-${api.id.slice(3)}-home`);
  assert.equal(api.legacyId, 'docker/api');
  assert.ok(!api.id.includes('api') && !api.runtimeName!.includes('api'), 'neither is derived from the name');

  assert.equal(ids.resolve(api.id), api, 'the stable id resolves');
  assert.equal(ids.resolve('docker/api'), api, 'the alias resolves to the same workspace');
  assert.equal(ids.runtimeNameOf('docker', 'api'), api.runtimeName);
  for (const bad of [NOBODY, 'api', 'docker/../api', 'ws_ABCDEF012345', `${api.id}x`, '']) assert.equal(ids.resolve(bad), null, bad);

  // What a runtime reports never replaces a runtime name on record.
  assert.equal(ids.adopt('docker', 'api', 'claudepilot-api'), api);
  assert.equal(ids.runtimeNameOf('docker', 'api'), api.runtimeName);

  ids.retire('docker', 'api');
  assert.equal(ids.resolve(api.id), null, 'a removed workspace’s id resolves to nothing');
  assert.equal(ids.resolve('docker/api'), null, 'and its alias is free');
  const again = ids.allocate('docker', 'api');
  assert.notEqual(again.id, api.id, 'a new workspace of the same name gets a new id: ids are never reused');
  assert.equal(ids.resolve('docker/api'), again);

  // A workspace that existed before: recorded with what its runtime calls it; a reported name that is not plain is not kept.
  assert.equal(ids.adopt('docker', 'old', 'claudepilot-old').runtimeName, 'claudepilot-old');
  assert.equal(ids.adopt('docker', 'odd', 'x/../y').runtimeName, null);
  // A runtime that must name new workspaces its own way says so once, at the create; a pick that is not plain falls back.
  assert.equal(ids.allocate('lab', 'box', () => 'claudepilot-box').runtimeName, 'claudepilot-box');
  assert.match(ids.allocate('lab', 'two', () => 'not plain').runtimeName ?? '', /^ws-[0-9a-f]{12}$/);
});

test('Kubernetes: an existing workspace keeps its Deployment and volume after the migration; a new one gets ws-<id>; a restart keeps both', async () => {
  const fake = await FakeKube.start();
  let store: Store | undefined;
  try {
    // The world before T-42: the old code made `kohi-event`, its objects named after it.
    await kubeRuntimeOn(fake).create({ name: 'kohi-event' }, () => undefined);
    assert.ok(fake.deployments.has('ws-kohi-event') && fake.claims.has('ws-kohi-event-home'));
    store = await migratedStore(['kd-kube/kohi-event']);
    const ids = new WorkspaceIdentities(store);
    const migrated = ids.of('kd-kube', 'kohi-event')!;
    assert.match(migrated.id, STABLE);
    assert.equal(migrated.runtimeName, null, 'the migration does not guess the runtime name');

    const ws = new Workspaces([kubeRuntimeOn(fake)], saved, {}, ids);
    const objects = () => [...fake.deployments.keys(), ...fake.claims.keys()].sort();
    const before = objects();
    const [w] = await ws.list();
    assert.deepEqual([w!.id, w!.name, w!.stableId, w!.runtimeName], ['kd-kube/kohi-event', 'kohi-event', migrated.id, 'ws-kohi-event'], 'the response carries both the id and the alias, and the name it has today');
    const stored = store.db!.prepare('SELECT runtime_name FROM workspace_identities WHERE id = ?').get(migrated.id) as { runtime_name: string };
    assert.equal(stored.runtime_name, 'ws-kohi-event', 'filled from what the cluster says it is called, and stored');

    await ws.stop('kd-kube', 'kohi-event');
    assert.equal((fake.deployments.get('ws-kohi-event')!.spec as { replicas: number }).replicas, 0);
    await ws.start('kd-kube', 'kohi-event');
    assert.equal((fake.deployments.get('ws-kohi-event')!.spec as { replicas: number }).replicas, 1);
    assert.deepEqual(objects(), before, 'nothing was made, renamed or removed');

    // A new workspace: named from its id, labelled with its name.
    const created = await ws.create({ name: 'fresh', target: 'kd-kube' });
    assert.match(created.stableId ?? '', STABLE);
    const rn = `ws-${created.stableId!.slice(3)}`;
    assert.equal(created.runtimeName, rn);
    await waitFor(() => fake.deployments.has(rn));
    assert.ok(fake.claims.has(`${rn}-home`), 'its home volume is <runtimeName>-home');
    assert.ok(!fake.deployments.has('ws-fresh') && !fake.claims.has('ws-fresh-home'), 'nothing is named after the workspace');
    assert.equal(fake.deployments.get(rn)!.metadata.labels!['claudepilot.workspace'], 'fresh');
    await waitFor(async () => (await ws.list()).some((x) => x.name === 'fresh' && x.status !== 'creating'));
    const fresh = (await ws.list()).find((x) => x.name === 'fresh')!;
    assert.deepEqual([fresh.id, fresh.stableId, fresh.runtimeName], ['kd-kube/fresh', created.stableId, rn]);
    await ws.stop('kd-kube', 'fresh');
    assert.equal((fake.deployments.get(rn)!.spec as { replicas: number }).replicas, 0, 'calls by name reach the stored runtime name');

    // Both forms of the id resolve to the same workspace.
    assert.equal((await ws.get(created.stableId!)).id, 'kd-kube/fresh');
    assert.equal((await ws.get('kd-kube/fresh')).stableId, created.stableId);
    assert.equal((await ws.get(migrated.id)).runtimeName, 'ws-kohi-event');

    // A restart: the same ids and runtime names, read back from the store.
    const ws2 = new Workspaces([kubeRuntimeOn(fake)], saved, {}, new WorkspaceIdentities(store));
    const pairs = (list: Workspace[]) => Object.fromEntries(list.map((x) => [x.name, [x.stableId, x.runtimeName]]));
    assert.deepEqual(pairs(await ws2.list()), { 'kohi-event': [migrated.id, 'ws-kohi-event'], fresh: [created.stableId, rn] });

    // Removing: its objects go, its id is retired for good, the other workspace is untouched.
    await ws2.remove('kd-kube', 'fresh');
    assert.ok(!fake.deployments.has(rn) && !fake.claims.has(`${rn}-home`));
    assert.equal(ws2.resolve(created.stableId!), null);
    assert.ok((store.db!.prepare('SELECT removed_at FROM workspace_identities WHERE id = ?').get(created.stableId!) as { removed_at: string | null }).removed_at);
    assert.deepEqual(objects(), before);
  } finally {
    store?.close();
    await fake.stop();
  }
});

test('get: either form of the id, decided on the workspace and never on the string; unknown and not yours are the same 404', async () => {
  const ws = new Workspaces([listing('docker', ['api', 'web'])], saved);
  const all = await ws.list();
  const api = findWorkspace(all, 'docker/api')!;
  const web = findWorkspace(all, 'docker/web')!;
  assert.match(api.stableId ?? '', STABLE);
  assert.equal(findWorkspace(all, api.stableId!), api, 'one resolver for both forms');
  assert.equal(findWorkspace(all, NOBODY), null);
  assert.equal((await ws.get(api.stableId!)).id, 'docker/api');
  assert.equal((await ws.get('docker/api')).stableId, api.stableId);

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      assert.ok(isAppError(e));
      return [e.code, e.message];
    }
    assert.fail('expected a refusal');
  };
  const asked: string[] = [];
  registerResolver({
    type: 'workspace',
    resolve: (id) => {
      asked.push(id);
      const owner = id === 'docker/api' ? 'u_a' : id === 'docker/web' ? 'u_b' : null;
      return owner ? { ref: workspaceRef(id), owner: { kind: 'user', id: owner } } : null;
    },
  });
  try {
    const a: Actor = { kind: 'user', userId: 'u_a', loginSessionId: 'x', via: 'ui' };
    assert.equal((await ws.get(api.stableId!, a)).id, 'docker/api', 'yours, by its stable id');
    const notYours = await refusal(ws.get(web.stableId!, a));
    assert.deepEqual(notYours, await refusal(ws.get(NOBODY, a)), 'not yours is the same 404 as one that does not exist');
    assert.deepEqual(notYours, await refusal(ws.get('docker/web', a)), 'by its alias too');
    assert.deepEqual(notYours, ['NOT_FOUND', 'Not found.']);
    assert.ok(asked.length && asked.every((id) => !id.startsWith('ws_')), 'the seam is asked about the workspace (its alias), never about the string given');
  } finally {
    clearResolvers();
  }

  // An agent stays in its own workspace whichever form it uses.
  const agent: Actor = { kind: 'agent', userId: 'u_owner', tokenId: 't1', sessionId: 's1', workspaceId: 'docker/api' };
  assert.equal((await ws.get(api.stableId!, agent)).id, 'docker/api');
  await assert.rejects(ws.get(web.stableId!, agent), (e) => isAppError(e) && e.code === 'FORBIDDEN');
});

test('the runtimes are handed the registry: one added later reads the stored names too', async () => {
  const ws = new Workspaces([], saved);
  let names: unknown = null;
  const runtime = { ...listing('lab', []), useNames: (n: unknown) => (names = n) } as unknown as Runtime;
  ws.addRuntime(runtime);
  assert.equal(names, ws.identities);
});

test('Docker over Connect: a new workspace is named the way the installed agents admit, chosen once at the create and stored', () => {
  const rt = new ConnectDockerRuntime(targetRecord({ id: 'lab', kind: 'docker' }), [], memoryDeps());
  const ids = WorkspaceIdentities.memory();
  const box = ids.allocate('lab', 'box', () => rt.runtimeNameForNew('box'));
  assert.match(box.id, STABLE, 'the identity is still the opaque id');
  assert.equal(box.runtimeName, 'claudepilot-box');
  assert.ok(CONTAINER_NAME.test(box.runtimeName!) && VOLUME_NAME.test(homeVolumeOf(box.runtimeName!)), 'the agents’ policy admits it');
  assert.equal(CONTAINER_NAME.test(newRuntimeName(box.id)), false, 'and would refuse ws-<hex>: why this target names new workspaces the old way');
  assert.equal(ids.runtimeNameOf('lab', 'box'), 'claudepilot-box', 'stored: read back, not recomputed');
});

test('REST: GET /api/workspaces/<stable id> and /api/workspaces/<target>/<name> answer the same workspace; anything else is the same 404', async () => {
  const stub: object = new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub,
  });
  const code = String(24681357);
  const portal = new Portal(code, 60_000);
  const token = portal.signIn(code);
  const ws = new Workspaces([listing('docker', ['api'])], saved);
  const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
  const app = make(portal, ws, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub });
  const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const get = async (url: string, signedIn = true) => {
    const res = await app.request(`http://localhost:3000${url}`, { headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...(signedIn ? { cookie: `portal_session=${token}` } : {}) } }, env);
    return { status: res.status, body: (await res.json()) as { data?: Workspace; error?: { code: string } } };
  };

  const byAlias = await get('/api/workspaces/docker/api');
  assert.equal(byAlias.status, 200);
  const w = byAlias.body.data!;
  assert.match(w.stableId ?? '', STABLE);
  assert.deepEqual([w.id, w.name, w.runtimeName], ['docker/api', 'api', 'claudepilot-api'], 'both the id and the name');
  const byId = await get(`/api/workspaces/${w.stableId}`);
  assert.equal(byId.status, 200);
  assert.deepEqual([byId.body.data!.id, byId.body.data!.stableId], ['docker/api', w.stableId]);

  const unknown = await get(`/api/workspaces/${NOBODY}`);
  assert.equal(unknown.status, 404);
  for (const url of ['/api/workspaces/docker/nope', '/api/workspaces/not-an-id', `/api/workspaces/${w.stableId!.toUpperCase()}`]) {
    const r = await get(url);
    assert.deepEqual([r.status, r.body.error?.code], [404, unknown.body.error?.code], url);
  }
  assert.equal((await get(`/api/workspaces/${w.stableId}`, false)).status, 401, 'signed out is refused before anything resolves');
});
