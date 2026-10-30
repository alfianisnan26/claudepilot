// T-98 (docs/prd/targets-connect.md §25): CPU and memory of a Kubernetes workspace from the portal. The wanted values are stored on the
// workspace's record; they reach the Deployment only when the person picked: now (the pod restarts; refused while a CI run is running there,
// and when the pod would not fit its node, the numbers in the refusal) or at its next start. Decided through the seam (never an agent),
// audited. Kubernetes is the in-process fake API server with one node; the store a temporary directory.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { workspaceRef, workspaceResourcesProblem, type Actor, type Workspace, type WorkspaceTarget } from '@portal/contracts';
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
import { valuesOf } from './resources.js';
import type { Runtime } from './runtime.js';

const savedKubeconfig = process.env.KUBECONFIG;
before(() => {
  process.env.KUBECONFIG = '/nonexistent/t98-resources-kubeconfig';
});
after(() => {
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
});

const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
const NOBODY = `ws_${'0'.repeat(12)}`;
const REF = 'kd-kube/box';

const refusal = async (p: Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, string> }> => {
  try {
    await p;
  } catch (e) {
    assert.ok(isAppError(e), String(e));
    return { code: e.code, message: e.message, details: e.details as Record<string, string> | undefined };
  }
  assert.fail('expected a refusal');
};

type Container = { name: string; resources?: { limits?: Record<string, string>; requests?: Record<string, string> } };
const deploymentOf = (fake: FakeKube) => fake.deployments.get('ws-box') as unknown as { metadata: { labels: Record<string, string>; annotations?: Record<string, string> }; spec: { replicas: number; template: { spec: { containers: Container[] } } } };
const resourcesOf = (fake: FakeKube) => deploymentOf(fake).spec.template.spec.containers.find((c) => c.name === 'workspace')!.resources;
const pods = (fake: FakeKube) => [...fake.pods.keys()].sort();

/** One node of 8 CPU and 16 GiB, a pod of another app on it asking 3 CPU and 4 GiB, and the workspace `box` (4 CPU, 8 GiB, requests = limits). */
async function world(opts: { otherCpu?: string } = {}) {
  const fake = await FakeKube.start();
  fake.nodes.set('n1', { metadata: { name: 'n1', labels: { 'kubernetes.io/hostname': 'n1' } }, status: { allocatable: { cpu: '8', memory: '16Gi' } } } as never);
  fake.otherPods.push({ metadata: { name: 'db-0', namespace: 'other' }, spec: { nodeName: 'n1', containers: [{ name: 'db', resources: { requests: { cpu: opts.otherCpu ?? '3', memory: '4Gi' } } }] }, status: { phase: 'Running' } } as never);
  await kubeRuntimeOn(fake, undefined, { fitCheck: true }).create({ name: 'box', cpus: 4, memoryMb: 8192 }, () => undefined);
  const store = await Store.open({ dataDir: tempDirectory('cp-t98-'), secretKey: null });
  const make = () => {
    const ws = new Workspaces([kubeRuntimeOn(fake, undefined, { fitCheck: true, resize: { pollMs: 5, waitMs: 60 } })], saved, {}, new WorkspaceIdentities(store));
    const audit: Record<string, unknown>[] = [];
    ws.hooks.audit = (e) => void audit.push(e);
    return { ws, audit };
  };
  const { ws, audit } = make();
  await ws.list();
  return { fake, store, ws, audit, make, close: async () => (store.close(), await fake.stop()) };
}

test('a create that fits on no node is refused with the numbers, and nothing is made; a cluster the portal may not read is not checked', async () => {
  const fake = await FakeKube.start();
  try {
    fake.nodes.set('n1', { metadata: { name: 'n1' }, status: { allocatable: { cpu: '8', memory: '16Gi' } } } as never);
    fake.otherPods.push({ metadata: { name: 'db-0', namespace: 'other' }, spec: { nodeName: 'n1', containers: [{ name: 'db', resources: { requests: { cpu: '6', memory: '4Gi' } } }] }, status: { phase: 'Running' } } as never);
    const refused = await refusal(kubeRuntimeOn(fake, undefined, { fitCheck: true }).create({ name: 'big', cpus: 4, memoryMb: 8192 }, () => undefined));
    assert.equal(refused.code, 'CONFLICT');
    assert.match(refused.message, /does not fit on n1 .*the other pods request 6000m and 4096Mi, this one would ask 4000m and 8192Mi, the node can allocate 8000m and 16384Mi/);
    assert.deepEqual([fake.deployments.size, fake.claims.size], [0, 0], 'nothing made');
    await kubeRuntimeOn(fake, undefined, { fitCheck: true }).create({ name: 'small', cpus: 2, memoryMb: 2048 }, () => undefined);
    assert.equal(fake.deployments.size, 1, 'one that fits is made');
    fake.clusterReads = false;
    await kubeRuntimeOn(fake, undefined, { fitCheck: true }).create({ name: 'blind', cpus: 4, memoryMb: 8192 }, () => undefined);
    assert.equal(fake.deployments.size, 2, 'not checked: the create goes on as before');
    fake.clusterReads = true;
    const before = fake.requests.length;
    await kubeRuntimeOn(fake).create({ name: 'enrolled', cpus: 4, memoryMb: 8192 }, () => undefined);
    assert.ok(fake.requests.slice(before).every((r) => !/^\/api\/v1\/(nodes|pods)/.test(r.url)), 'an enrolled cluster is never asked for cluster-wide reads');
    assert.match((await kubeRuntimeOn(fake).resources.fit('enrolled', { cpuRequest: 1, memoryRequestMb: 64 })).message, /enrolled through Connect/);
  } finally {
    await fake.stop();
  }
});

test('values: quantities read back in cores and MiB; bounds; a request never above its limit', () => {
  assert.deepEqual(valuesOf({ limits: { cpu: '4', memory: '8Gi' }, requests: { cpu: '250m', memory: '1048576Ki' } }), { cpus: 4, memoryMb: 8192, cpuRequest: 0.25, memoryRequestMb: 1024 });
  assert.deepEqual(valuesOf(undefined), {});
  assert.equal(workspaceResourcesProblem({ cpus: 4, memoryMb: 8192, cpuRequest: 0.25, memoryRequestMb: 1024 }), null);
  const bad = workspaceResourcesProblem({ cpus: 4, memoryMb: 8192, cpuRequest: 5, memoryRequestMb: 9000 })!;
  assert.deepEqual(Object.keys(bad).sort(), ['cpuRequest', 'memoryRequestMb']);
  for (const v of [{ cpus: 0 }, { cpus: 65 }, { cpus: 0.0001 }, { memoryMb: 100 }, { memoryMb: 1024.5 }, { cpus: '4' }, { memoryRequestMb: 10 }])
    assert.ok(workspaceResourcesProblem({ cpus: 4, memoryMb: 8192, cpuRequest: 1, memoryRequestMb: 1024, ...v }), JSON.stringify(v));
});

test('Kubernetes: stored on the record; at the next restart nothing moves until a start applies them; across a portal restart', async () => {
  const w = await world();
  try {
    const first = await w.ws.resourcesOf(REF);
    assert.deepEqual(first.live, { cpus: 4, memoryMb: 8192, cpuRequest: 4, memoryRequestMb: 8192 }, 'what the Deployment has');
    assert.deepEqual([first.wanted, first.pending, first.running], [null, false, true], 'an existing workspace keeps what it has until someone applies');

    const podsWere = pods(w.fake);
    const writes = () => w.fake.requests.filter((r) => r.method !== 'GET').length;
    const w0 = writes();
    const set = await w.ws.setResources(REF, { apply: 'next_restart', cpus: 6, memoryMb: 12288, cpuRequest: 1, memoryRequestMb: 2048 });
    assert.deepEqual([set.outcome, set.pending, set.fit?.state], ['pending', true, 'fits']);
    assert.deepEqual(set.wanted, { cpus: 6, memoryMb: 12288, cpuRequest: 1, memoryRequestMb: 2048 });
    assert.equal(set.live.cpus, 4, 'the Deployment is not touched');
    assert.equal(writes(), w0, 'nothing written to the cluster');
    assert.deepEqual(pods(w.fake), podsWere, 'the pod keeps running');
    assert.deepEqual(
      w.audit.map((e) => [e.kind, e.actor, e.subject, (e.detail as Record<string, unknown>).apply, (e.detail as Record<string, unknown>).outcome, (e.detail as Record<string, unknown>).to]),
      [['workspace.resources', 'user:u_owner', set.stableId, 'next_restart', 'pending', '6 CPU (request 1), 12288 MiB (request 2048)']],
    );

    // A portal restart: still pending, from the record.
    const again = w.make();
    assert.deepEqual([(await again.ws.resourcesOf(REF)).pending, (await again.ws.resourcesOf(REF)).wanted?.cpus], [true, 6]);

    await again.ws.stop('kd-kube', 'box');
    assert.equal(resourcesOf(w.fake)?.limits?.cpu, '4', 'a stop applies nothing');
    await again.ws.start('kd-kube', 'box');
    assert.deepEqual(resourcesOf(w.fake), { limits: { cpu: '6', memory: '12288Mi' }, requests: { cpu: '1', memory: '2048Mi' } }, 'the start wrote them before it scaled up');
    assert.equal(deploymentOf(w.fake).spec.replicas, 1);
    const after = await again.ws.resourcesOf(REF);
    assert.deepEqual([after.pending, after.live.cpus, after.problem, typeof after.appliedAt], [false, 6, null, 'string']);
    assert.equal((await again.ws.list()).find((x) => x.id === REF)!.cpus, 6, 'the list shows the new limit');
    assert.deepEqual(again.audit.map((e) => [e.kind, e.actor, (e.detail as Record<string, unknown>).outcome]), [['workspace.resources', 'system:workspaces', 'applied']]);
  } finally {
    await w.close();
  }
});

test('Kubernetes: apply now, the in-place resize refused (a QoS class change): the Deployment is patched and the pod restarts, the reason surfaced; equal values change nothing', async () => {
  const w = await world();
  try {
    const before = pods(w.fake);
    let pulled = 0;
    w.ws.hooks.beforeStop = async () => void pulled++;
    // requests = limits today (Guaranteed); lower requests would make it Burstable, which the API server refuses to do in place.
    const done = await w.ws.setResources(REF, { apply: 'now', cpuRequest: 0.5, memoryRequestMb: 1024 });
    assert.deepEqual([done.outcome, done.pending, done.running, done.how], ['applied', false, true, 'restarted']);
    assert.match(done.resizeRefused ?? '', /the cluster refused the in-place resize: .*Pod QOS Class may not change/);
    assert.deepEqual(done.live, { cpus: 4, memoryMb: 8192, cpuRequest: 0.5, memoryRequestMb: 1024 }, 'left-out values keep what it had');
    assert.deepEqual(resourcesOf(w.fake), { limits: { cpu: '4', memory: '8192Mi' }, requests: { cpu: '500m', memory: '1024Mi' } });
    assert.ok(deploymentOf(w.fake).metadata.annotations?.['claudepilot.resources-changed']);
    const now = pods(w.fake);
    assert.equal(now.length, 1);
    assert.notDeepEqual(now, before, 'a new pod (Recreate)');
    assert.equal(pulled, 1, 'events written just before are pulled first, as at a stop');
    assert.deepEqual(
      w.audit.map((e) => [e.kind, (e.detail as Record<string, unknown>).outcome, (e.detail as Record<string, unknown>).restarted, (e.detail as Record<string, unknown>).how, (e.detail as Record<string, unknown>).from]),
      [['workspace.resources', 'applied', true, 'restarted', '4 CPU (request 4), 8192 MiB (request 8192)']],
    );
    assert.match(String((w.audit[0]!.detail as Record<string, unknown>).resizeRefused), /QOS/);

    const same = await w.ws.setResources(REF, { apply: 'now', cpuRequest: 0.5 });
    assert.equal(same.outcome, 'unchanged');
    assert.deepEqual(pods(w.fake), now, 'no restart for nothing');
    assert.equal(w.audit.length, 1);
  } finally {
    await w.close();
  }
});

type PodView = { spec: { containers: Container[] }; status: { containerStatuses: { name: string; resources?: Container['resources'] }[] } };
const podOf = (fake: FakeKube) => [...fake.pods.values()][0] as unknown as PodView & { metadata: { name: string } };
const replicaSetOf = (fake: FakeKube) => fake.replicaSets.get('ws-box-7d9f6c') as unknown as { spec: { template: { spec: { containers: Container[] } } } };
const BIGGER = { cpus: 4, memoryMb: 10000, cpuRequest: 4, memoryRequestMb: 10000 } as const;
const BIGGER_RESOURCES = { limits: { cpu: '4', memory: '10000Mi' }, requests: { cpu: '4', memory: '10000Mi' } };

test('T-3081: apply now resizes the running pod in place (no restart) and writes the Deployment and its ReplicaSet, so a later restart keeps it', async () => {
  const w = await world();
  try {
    const before = pods(w.fake);
    const podName = before[0]!;
    const done = await w.ws.setResources(REF, { apply: 'now', ...BIGGER });
    assert.deepEqual([done.outcome, done.how, done.resizeRefused, done.running], ['applied', 'resized', null, true]);

    // The resize call: a JSON Patch of the workspace container's resources on the pod's `resize` subresource.
    const calls = w.fake.seen('PATCH', `/api/v1/namespaces/${w.fake.namespace}/pods/${podName}/resize`);
    assert.equal(calls.length, 1, 'one resize call');
    assert.match(String(calls[0]!.headers['content-type']), /^application\/json-patch\+json/);
    assert.deepEqual(JSON.parse(calls[0]!.body.toString('utf8')), [{ op: 'add', path: '/spec/containers/0/resources', value: BIGGER_RESOURCES }]);

    // Live sessions are not interrupted: the same pod, now with the values (spec and what the kubelet reports).
    assert.deepEqual(pods(w.fake), before, 'the same pod: no restart');
    const pod = podOf(w.fake);
    assert.deepEqual(pod.spec.containers.find((c) => c.name === 'workspace')!.resources, BIGGER_RESOURCES);
    assert.deepEqual(pod.status.containerStatuses.find((s) => s.name === 'workspace')!.resources, BIGGER_RESOURCES);

    // Persisted: the Deployment's template and limit label, unpaused again; the ReplicaSet's template the same.
    assert.deepEqual(resourcesOf(w.fake), BIGGER_RESOURCES);
    assert.equal(deploymentOf(w.fake).metadata.labels['claudepilot.memory-mb'], '10000');
    assert.equal(deploymentOf(w.fake).metadata.labels['claudepilot.cpus'], '4');
    assert.equal((deploymentOf(w.fake).spec as { paused?: boolean }).paused, false, 'not left paused');
    assert.deepEqual(replicaSetOf(w.fake).spec.template.spec.containers.find((c) => c.name === 'workspace')!.resources, BIGGER_RESOURCES);
    assert.ok(
      w.fake.requests.some((r) => r.method === 'PUT' && /\/deployments\/ws-box$/.test(r.url) && (JSON.parse(r.body.toString('utf8')) as { spec: { paused?: boolean } }).spec.paused === true),
      'the Deployment was written paused first',
    );
    assert.deepEqual(
      w.audit.map((e) => [(e.detail as Record<string, unknown>).outcome, (e.detail as Record<string, unknown>).restarted, (e.detail as Record<string, unknown>).how, (e.detail as Record<string, unknown>).resizeRefused]),
      [['applied', false, 'resized', null]],
    );
    assert.deepEqual((await w.ws.resourcesOf(REF)).live, BIGGER, 'what the Deployment has');

    // The change survives a restart: the next pod is made with the new values.
    await w.ws.stop('kd-kube', 'box');
    await w.ws.start('kd-kube', 'box');
    assert.notDeepEqual(pods(w.fake), before, 'a new pod after the restart');
    assert.deepEqual(podOf(w.fake).spec.containers.find((c) => c.name === 'workspace')!.resources, BIGGER_RESOURCES);
  } finally {
    await w.close();
  }
});

test('T-3081: the resize refused by the kubelet (Infeasible) or the Role (403) falls back to the roll and says why; Deferred is left to the kubelet', async () => {
  const w = await world();
  try {
    const first = pods(w.fake);
    w.fake.resizeVerdict = () => 'Infeasible';
    const infeasible = await w.ws.setResources(REF, { apply: 'now', ...BIGGER });
    assert.deepEqual([infeasible.how, /the node cannot resize it in place: Node did not have enough resources/.test(infeasible.resizeRefused ?? '')], ['restarted', true]);
    assert.notDeepEqual(pods(w.fake), first, 'the pod restarted');
    assert.deepEqual(podOf(w.fake).spec.containers.find((c) => c.name === 'workspace')!.resources, BIGGER_RESOURCES, 'with the new values');

    w.fake.resizeVerdict = () => null;
    w.fake.resizeRefusal = { code: 403, reason: 'Forbidden', message: 'pods "x" is forbidden: cannot patch resource "pods/resize"' };
    const second = pods(w.fake);
    const forbidden = await w.ws.setResources(REF, { apply: 'now', ...BIGGER, memoryMb: 9000, memoryRequestMb: 9000 });
    assert.equal(forbidden.how, 'restarted');
    assert.match(forbidden.resizeRefused ?? '', /cannot patch resource "pods\/resize"/);
    assert.notDeepEqual(pods(w.fake), second, 'the pod restarted');
    assert.equal(resourcesOf(w.fake)?.limits?.memory, '9000Mi');

    w.fake.resizeRefusal = null;
    w.fake.resizeVerdict = () => 'Deferred';
    const third = pods(w.fake);
    const deferred = await w.ws.setResources(REF, { apply: 'now', ...BIGGER });
    assert.deepEqual([deferred.how, deferred.resizeRefused], ['resized', null], 'accepted: the kubelet applies it when there is room');
    assert.deepEqual(pods(w.fake), third, 'no restart');
    assert.deepEqual(resourcesOf(w.fake), BIGGER_RESOURCES, 'and persisted');
    assert.deepEqual(
      w.audit.map((e) => [(e.detail as Record<string, unknown>).how, (e.detail as Record<string, unknown>).restarted]),
      [['restarted', true], ['restarted', true], ['resized', false]],
    );
  } finally {
    await w.close();
  }
});

test('Kubernetes: refused while a CI run is running there, when it does not fit (the numbers), when the fit cannot be checked; nothing changes', async () => {
  const w = await world();
  try {
    const podsWere = pods(w.fake);
    const spec = JSON.stringify(resourcesOf(w.fake));
    const asked: string[] = [];
    w.ws.hooks.runningCi = (id) => (asked.push(id), 1);
    const ci = await refusal(w.ws.setResources(REF, { apply: 'now', cpuRequest: 1 }));
    assert.equal(ci.code, 'CONFLICT');
    assert.match(ci.message, /A CI run is running in this workspace/);
    assert.deepEqual(asked, [REF], 'asked about the workspace by its key');
    // At the next restart is fine during a run: nothing restarts now.
    assert.equal((await w.ws.setResources(REF, { apply: 'next_restart', cpuRequest: 1 })).outcome, 'pending');
    w.ws.hooks.runningCi = () => 0;

    const big = await refusal(w.ws.setResources(REF, { apply: 'now', cpus: 8, cpuRequest: 6, memoryRequestMb: 2048 }));
    assert.equal(big.code, 'CONFLICT');
    assert.match(big.message, /does not fit on n1 .*the other pods request 3000m and 4096Mi, this one would ask 6000m and 2048Mi, the node can allocate 8000m and 16384Mi/);
    assert.equal(big.details?.fit, big.message);

    w.fake.clusterReads = false;
    const blind = await refusal(w.ws.setResources(REF, { apply: 'now', cpuRequest: 1 }));
    assert.deepEqual([blind.code, /could not be checked: the portal may not read/.test(blind.message)], ['CONFLICT', true], 'unavailable is refused, never guessed');
    assert.deepEqual(pods(w.fake), podsWere);
    assert.equal(JSON.stringify(resourcesOf(w.fake)), spec, 'the Deployment is untouched');
    assert.deepEqual(w.audit.map((e) => (e.detail as Record<string, unknown>).outcome), ['pending'], 'only what was done is audited');

    // A pending change that no longer fits at the start: it starts as it was, the change stays pending with the reason.
    w.fake.clusterReads = true;
    w.fake.otherPods[0]!.spec = { nodeName: 'n1', containers: [{ name: 'db', resources: { requests: { cpu: '7500m', memory: '4Gi' } } }] };
    await w.ws.stop('kd-kube', 'box');
    await w.ws.start('kd-kube', 'box');
    assert.equal(deploymentOf(w.fake).spec.replicas, 1, 'it started');
    assert.deepEqual(resourcesOf(w.fake)?.requests, undefined, 'it started as it was (requests = limits)');
    const state = await w.ws.resourcesOf(REF);
    assert.equal(state.pending, true);
    assert.match(state.problem ?? '', /does not fit on n1/);
  } finally {
    await w.close();
  }
});

test('validation: bounds and requests per field; when must be said; a target without resources says so', async () => {
  const w = await world();
  try {
    const above = await refusal(w.ws.setResources(REF, { apply: 'now', cpuRequest: 5 }));
    assert.deepEqual([above.code, above.details?.cpuRequest], ['VALIDATION_FAILED', 'Not above the CPU limit.']);
    assert.equal((await refusal(w.ws.setResources(REF, { apply: 'now', memoryMb: 100 }))).details?.memoryMb?.startsWith('Whole MiB'), true);
    assert.equal((await refusal(w.ws.setResources(REF, { cpus: 2 } as never))).details?.apply, 'now or next_restart.');
    assert.equal((await refusal(w.ws.setResources(REF, { apply: 'now', cpus: '2' as never }))).code, 'VALIDATION_FAILED');
    assert.equal(resourcesOf(w.fake)?.limits?.cpu, '4');
  } finally {
    await w.close();
  }
  const t: WorkspaceTarget = { id: 'docker', label: 'docker', kind: 'docker', where: '/d', available: true };
  const docker = { target: t, check: async () => undefined, list: async () => [{ id: 'docker/api', name: 'api', target: 'docker', image: 'i', status: 'running', createdAt: '2026-10-01T00:00:00.000Z' }] } as unknown as Runtime;
  const ws = new Workspaces([docker], saved);
  await ws.list();
  assert.match((await refusal(ws.setResources('docker/api', { apply: 'now', cpus: 2 }))).message, /Only a Kubernetes workspace/);
});

test('authz: operate on the workspace through the seam; an agent cannot, even in its own workspace; a read token cannot; not yours is the same 404 as unknown', async () => {
  const w = await world();
  try {
    const agent: Actor = { kind: 'agent', userId: 'u_owner', tokenId: 't2', sessionId: 's1', workspaceId: REF };
    assert.equal((await refusal(w.ws.setResources(REF, { apply: 'now', cpuRequest: 1 }, agent))).code, 'FORBIDDEN');
    const reader: Actor = { kind: 'token', userId: 'u_owner', tokenId: 't1', scope: 'read' };
    assert.equal((await refusal(w.ws.setResources(REF, { apply: 'next_restart', cpuRequest: 1 }, reader))).code, 'FORBIDDEN');
    assert.equal((await w.ws.resourcesOf(REF, reader)).live.cpus, 4, 'a read token may look');
    registerResolver({ type: 'workspace', resolve: (id) => (id === REF ? { ref: workspaceRef(id), owner: { kind: 'user', id: 'u_b' } } : null) });
    try {
      const a: Actor = { kind: 'user', userId: 'u_a', loginSessionId: 'x', via: 'ui' };
      const notYours = await refusal(w.ws.setResources(REF, { apply: 'now', cpuRequest: 1 }, a));
      assert.deepEqual([notYours.code, notYours.message], ['NOT_FOUND', 'Not found.']);
      assert.deepEqual(notYours, await refusal(w.ws.setResources(NOBODY, { apply: 'now', cpuRequest: 1 }, a)));
      assert.deepEqual((await refusal(w.ws.resourcesOf(REF, a))).code, 'NOT_FOUND');
    } finally {
      clearResolvers();
    }
    assert.deepEqual(resourcesOf(w.fake), { limits: { cpu: '4', memory: '8192Mi' } }, 'untouched');
    assert.deepEqual(w.audit, []);
  } finally {
    await w.close();
  }
});

test('REST: GET and PATCH by either form of the id; a workspace named “resources” is still itself; a refusal is a 409 with the numbers', async () => {
  const w = await world();
  try {
    const stub: object = new Proxy(function () {}, {
      get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
      apply: () => stub,
      construct: () => stub,
    });
    const secret = String(97531864);
    const portal = new Portal(secret, 60_000);
    const token = portal.signIn(secret);
    const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
    const app = make(portal, w.ws, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub });
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
      return { status: res.status, body: (await res.json()) as { data?: Record<string, any>; error?: { code: string; message: string; details?: Record<string, string> } } };
    };
    const got = await call('GET', `/api/workspaces/${REF}/resources`);
    assert.deepEqual([got.status, got.body.data!.live.cpus, got.body.data!.pending], [200, 4, false]);
    const stableId = got.body.data!.stableId as string;
    const byId = await call('PATCH', `/api/workspaces/${stableId}/resources`, { apply: 'next_restart', cpuRequest: 1 });
    assert.deepEqual([byId.status, byId.body.data!.outcome, byId.body.data!.pending, byId.body.data!.wanted.cpuRequest], [200, 'pending', true, 1]);
    assert.equal((await call('GET', `/api/workspaces/${stableId}/resources`)).body.data!.pending, true);
    const big = await call('PATCH', `/api/workspaces/${REF}/resources`, { apply: 'now', cpus: 8, cpuRequest: 6 });
    assert.deepEqual([big.status, big.body.error?.code], [409, 'CONFLICT']);
    assert.match(big.body.error!.message, /would ask 6000m/);
    const bad = await call('PATCH', `/api/workspaces/${REF}/resources`, { apply: 'now', cpuRequest: 9 });
    assert.deepEqual([bad.status, typeof bad.body.error?.details?.cpuRequest], [422, 'string']);
    assert.equal((await call('PATCH', `/api/workspaces/${NOBODY}/resources`, { apply: 'now' })).status, 404);
    // `/<target>/resources` is the workspace named "resources" on that target, not a stable id's resources.
    assert.equal((await call('GET', '/api/workspaces/kd-kube/resources')).status, 404, 'no such workspace: the get, not the resources route');
  } finally {
    await w.close();
  }
});
