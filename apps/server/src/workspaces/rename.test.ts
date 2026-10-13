// T-42 slice 2 (docs/prd/targets-connect.md §24.3): the name becomes a label. A rename changes the label ONLY: never the stable id, the
// `<target>/<name>` key, the runtime name or a stored reference, and it sends nothing to a runtime. Every form a workspace was called by keeps
// resolving while it lives; a label is unique on its target (its name, its label and every label it had count); the rules are checked; the
// seam decides on the workspace; the rename is audited. Kubernetes is the in-process fake API server, the store a temporary directory.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { rememberWorkspaceLabelMap, rememberWorkspaceLabels, WORKSPACE_LABEL_MAX, workspaceDisplayName, workspaceLabel, workspaceLabelProblem, workspaceRef, type Actor, type Workspace, type WorkspaceTarget } from '@portal/contracts';
import { createApp } from '../app.js';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import type { JsonFile } from '../jsonFile.js';
import { Portal } from '../portal.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { WorkspaceIdentities } from './identity.js';
import { kubeRuntimeOn } from './kubeTestkit.js';
import { Workspaces } from './manager.js';
import type { Runtime } from './runtime.js';

const savedKubeconfig = process.env.KUBECONFIG;
before(() => {
  // Anything that still called loadFromDefault() would read this, and fail: nothing must.
  process.env.KUBECONFIG = '/nonexistent/t42-rename-kubeconfig';
});
after(() => {
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
});

const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
const NOBODY = `ws_${'0'.repeat(12)}`;

/** A runtime that lists what it is given and does nothing else. */
function listing(target: string, names: string[]): Runtime {
  const t: WorkspaceTarget = { id: target, label: target, kind: 'docker', where: `/${target}`, available: true };
  const list: Workspace[] = names.map((name) => ({ id: `${target}/${name}`, name, runtimeName: `claudepilot-${name}`, target, image: 'img', status: 'running', createdAt: '2026-10-01T00:00:00.000Z' }));
  return { target: t, check: async () => undefined, list: async () => list } as unknown as Runtime;
}

const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(isAppError(e));
    return [e.code, e.message];
  }
  assert.fail('expected a refusal');
};

test('label rules: 1 to 40 characters, one line, plain text, no slash', () => {
  for (const ok of ['isnan-pod', 'Isnan Pod', 'Kohi · event 2', 'é'.repeat(WORKSPACE_LABEL_MAX), '🚀'.repeat(WORKSPACE_LABEL_MAX), '  padded  '])
    assert.equal(workspaceLabelProblem(ok), null, ok);
  for (const bad of ['', '   ', 'x'.repeat(WORKSPACE_LABEL_MAX + 1), 'two\nlines', 'tab\there', 'a/b', 'evil‮txt', 'nul\u0000', 'sep arator', '‏mark'])
    assert.ok(workspaceLabelProblem(bad), JSON.stringify(bad));
});

test('Kubernetes: a rename changes the label only; nothing reaches the cluster; every name it had keeps resolving, across a restart', async () => {
  const fake = await FakeKube.start();
  const store = await Store.open({ dataDir: tempDirectory('cp-t42r-'), secretKey: null });
  try {
    await kubeRuntimeOn(fake).create({ name: 'kohi-event' }, () => undefined);
    const audit: Record<string, unknown>[] = [];
    let changed = 0;
    const ws = new Workspaces([kubeRuntimeOn(fake)], saved, {}, new WorkspaceIdentities(store));
    ws.hooks.audit = (e) => void audit.push(e);
    ws.hooks.changed = () => void changed++;
    const [before] = await ws.list();
    assert.deepEqual([before!.name, before!.label, before!.runtimeName], ['kohi-event', 'kohi-event', 'ws-kohi-event'], 'unrenamed, the label is the name');
    const objects = () => [...fake.deployments.keys(), ...fake.claims.keys()].sort();
    const pods = () => [...fake.pods.keys()].sort();
    const was = objects();
    const podsWere = pods();
    const writes = () => fake.requests.filter((r) => r.method !== 'GET').length;
    const w0 = writes();

    const res = await ws.rename('kd-kube/kohi-event', '  isnan-pod ');
    assert.deepEqual(res, { id: 'kd-kube/kohi-event', stableId: before!.stableId, name: 'kohi-event', label: 'isnan-pod', previous: 'kohi-event' });
    assert.equal(writes(), w0, 'a rename sends nothing to the cluster');
    assert.deepEqual(objects(), was, 'no Deployment or claim made, renamed or removed');
    assert.deepEqual(pods(), podsWere, 'the pod was not restarted');
    assert.ok(changed > 0, 'the pages are told');
    const [after] = await ws.list();
    assert.deepEqual(
      [after!.id, after!.stableId, after!.name, after!.label, after!.runtimeName],
      ['kd-kube/kohi-event', before!.stableId, 'kohi-event', 'isnan-pod', 'ws-kohi-event'],
      'the id, the key, the runtime name stay; the label changed',
    );
    for (const ref of [before!.stableId!, 'kd-kube/kohi-event', 'kd-kube/isnan-pod', 'kd-kube/ISNAN-POD'])
      assert.equal((await ws.get(ref)).stableId, before!.stableId, ref);
    await ws.stop('kd-kube', 'kohi-event');
    assert.equal((fake.deployments.get('ws-kohi-event')!.spec as { replicas: number }).replicas, 0, 'calls by the key still reach the same Deployment');
    await ws.start('kd-kube', 'kohi-event');

    // Again, by the stable id: the label before stays an alias.
    await ws.rename(before!.stableId!, 'Isnan Pod');
    for (const ref of ['kd-kube/isnan-pod', 'kd-kube/kohi-event', 'kd-kube/Isnan Pod']) assert.equal(ws.resolve(ref)?.id, before!.stableId, ref);
    assert.deepEqual(
      audit.map((e) => [e.kind, e.actor, e.subject, e.detail]),
      [
        ['workspace.rename', 'user:u_owner', before!.stableId, { workspace: 'kd-kube/kohi-event', from: 'kohi-event', to: 'isnan-pod' }],
        ['workspace.rename', 'user:u_owner', before!.stableId, { workspace: 'kd-kube/kohi-event', from: 'isnan-pod', to: 'Isnan Pod' }],
      ],
    );
    // The same label again changes nothing and writes no audit row.
    assert.equal((await ws.rename('kd-kube/isnan-pod', 'Isnan Pod')).previous, 'Isnan Pod');
    assert.equal(audit.length, 2);

    // A restart: the label and every alias come back from the store.
    const ws2 = new Workspaces([kubeRuntimeOn(fake)], saved, {}, new WorkspaceIdentities(store));
    for (const ref of [before!.stableId!, 'kd-kube/kohi-event', 'kd-kube/isnan-pod', 'kd-kube/Isnan Pod']) assert.equal(ws2.resolve(ref)?.id, before!.stableId, ref);
    assert.equal((await ws2.list())[0]!.label, 'Isnan Pod');
    assert.deepEqual(ws2.identities.labels(), { 'kd-kube/kohi-event': 'Isnan Pod' });

    // Back to the name it was made with: no label of its own any more, and the old labels still resolve.
    await ws2.rename('kd-kube/isnan-pod', 'kohi-event');
    assert.equal((await ws2.list())[0]!.label, 'kohi-event');
    assert.deepEqual(ws2.identities.labels(), {});
    assert.equal(ws2.resolve('kd-kube/isnan-pod')?.id, before!.stableId);
    assert.deepEqual(objects(), was);
  } finally {
    store.close();
    await fake.stop();
  }
});

test('a label is unique on its target: another workspace’s name, label or former label is refused, whatever the case; another target is free', async () => {
  const ws = new Workspaces([listing('docker', ['api', 'web']), listing('lab', ['box'])], saved);
  await ws.list();
  await ws.rename('docker/api', 'front');
  const taken = await refusal(ws.rename('docker/web', 'front'));
  assert.deepEqual(taken, ['CONFLICT', '“front” is already a workspace on docker. Pick another name.']);
  await assert.rejects(ws.rename('docker/web', 'FRONT'), code('CONFLICT'), 'case does not make it another label');
  await assert.rejects(ws.rename('docker/web', ' front '), code('CONFLICT'));
  await assert.rejects(ws.rename('docker/web', 'api'), code('CONFLICT'), 'the name another workspace was made with');
  await ws.rename('docker/api', 'back');
  await assert.rejects(ws.rename('docker/web', 'front'), code('CONFLICT'), 'a label it had still answers to it while it lives');
  await assert.rejects(ws.create({ name: 'front', target: 'docker' }), code('CONFLICT'), 'nor can a new workspace take it');
  await ws.rename('lab/box', 'front');
  assert.equal((await ws.get('lab/front')).id, 'lab/box', 'the same label on another target is another workspace');
  // A removed workspace frees every name it had.
  ws.identities.retire('docker', 'api');
  await ws.rename('docker/web', 'front');
  assert.equal(ws.resolve('docker/front')?.legacyId, 'docker/web');

  for (const bad of ['', '   ', 'x'.repeat(WORKSPACE_LABEL_MAX + 1), 'two\nlines', 'a/b', 'evil‮txt', 42, null]) {
    await assert.rejects(ws.rename('docker/web', bad), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED' && typeof (e.details as { label?: unknown })?.label === 'string', JSON.stringify(bad));
  }
  await assert.rejects(ws.rename(NOBODY, 'x'), code('NOT_FOUND'));
});

test('authz: decided on the workspace through the seam; not yours is the same 404 as unknown; read is not enough; an agent only its own', async () => {
  const ws = new Workspaces([listing('docker', ['api', 'web'])], saved);
  const all = await ws.list();
  const web = all.find((w) => w.name === 'web')!;
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
    assert.equal((await ws.rename('docker/api', 'mine', a)).label, 'mine');
    const notYours = await refusal(ws.rename(web.stableId!, 'taken-over', a));
    assert.deepEqual(notYours, await refusal(ws.rename(NOBODY, 'taken-over', a)));
    assert.deepEqual(notYours, ['NOT_FOUND', 'Not found.']);
    assert.ok(asked.every((id) => !id.startsWith('ws_')), 'the seam is asked about the workspace, never the string given');
  } finally {
    clearResolvers();
  }
  assert.equal((await ws.get('docker/web')).label, 'web', 'the refused rename changed nothing');
  const reader: Actor = { kind: 'token', userId: 'u_owner', tokenId: 't1', scope: 'read' };
  await assert.rejects(ws.rename('docker/api', 'x', reader), code('FORBIDDEN'), 'a read token may not rename');
  const agent: Actor = { kind: 'agent', userId: 'u_owner', tokenId: 't2', sessionId: 's1', workspaceId: 'docker/api' };
  assert.equal((await ws.rename('docker/api', 'own', agent)).label, 'own');
  await assert.rejects(ws.rename(web.stableId!, 'other', agent), code('FORBIDDEN'));
});

test('REST: PATCH renames by either form; the new label resolves; a duplicate is 409; a bad label is 422 with the field; /labels lists them', async () => {
  const stub: object = new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub,
  });
  const secret = String(24681357);
  const portal = new Portal(secret, 60_000);
  const token = portal.signIn(secret);
  const ws = new Workspaces([listing('docker', ['api', 'web'])], saved);
  const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
  const app = make(portal, ws, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub });
  const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.request(
      `http://localhost:3000${url}`,
      {
        method,
        headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `portal_session=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      },
      env,
    );
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: Record<string, string> } } };
  };

  const renamed = await call('PATCH', '/api/workspaces/docker/api', { label: 'front' });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.body.data!.id, renamed.body.data!.name, renamed.body.data!.label, renamed.body.data!.previous], ['docker/api', 'api', 'front', 'api']);
  const stableId = renamed.body.data!.stableId as string;
  const byLabel = await call('GET', '/api/workspaces/docker/front');
  assert.deepEqual([byLabel.status, byLabel.body.data!.id, byLabel.body.data!.label], [200, 'docker/api', 'front']);
  assert.equal((await call('PATCH', `/api/workspaces/${stableId}`, { label: 'Front door' })).body.data!.label, 'Front door');
  assert.deepEqual((await call('GET', '/api/workspaces/labels')).body.data, { 'docker/api': 'Front door' });

  const dup = await call('PATCH', '/api/workspaces/docker/web', { label: 'FRONT' });
  assert.deepEqual([dup.status, dup.body.error?.code], [409, 'CONFLICT']);
  const bad = await call('PATCH', '/api/workspaces/docker/web', { label: 'two\nlines' });
  assert.deepEqual([bad.status, bad.body.error?.code, typeof bad.body.error?.details?.label], [422, 'VALIDATION_FAILED', 'string']);
  assert.equal((await call('PATCH', `/api/workspaces/${NOBODY}`, { label: 'x' })).status, 404);
  assert.equal((await call('GET', '/api/workspaces/docker/web')).body.data!.label, 'web', 'the refused renames changed nothing');
});

test('the web names a workspace by its label wherever it only holds the id, once a list or the labels map said so', () => {
  assert.equal(workspaceLabel('kubernetes/kohi-event'), 'kohi-event');
  rememberWorkspaceLabels([{ id: 'kubernetes/kohi-event', name: 'kohi-event', label: 'isnan-pod' }]);
  assert.equal(workspaceLabel('kubernetes/kohi-event'), 'isnan-pod');
  assert.equal(workspaceDisplayName({ name: 'kohi-event', label: 'isnan-pod' }), 'isnan-pod');
  rememberWorkspaceLabels([{ id: 'kubernetes/kohi-event', name: 'kohi-event', label: 'kohi-event' }]);
  assert.equal(workspaceLabel('kubernetes/kohi-event'), 'kohi-event', 'renamed back');
  rememberWorkspaceLabelMap({ 'docker/api': 'Front door' });
  assert.equal(workspaceLabel('docker/api'), 'Front door');
  rememberWorkspaceLabels([{ id: 'docker/api', name: 'api' }]);
  assert.equal(workspaceLabel('docker/api'), 'api');
});
