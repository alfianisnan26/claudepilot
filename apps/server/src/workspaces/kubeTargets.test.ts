// PORTAL_K8S_TARGETS (owner, 2026-10-31: one workspace per org, one namespace per org). The setting's parsing and refusals, the options each
// target's runtime gets, the runtimes on the in-process fake API server (no cluster: KUBERNETES SAFETY RULE; a kubeconfig file in a temporary
// folder points at the fake, so the runtime is made the way index.ts makes it), the manager routing `<target>/<name>` to the right runtime,
// and the deploy/k3s manifests: the value portal.yaml sets parses, its namespaces exist with the old namespace's guard rails and Role.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isAppError } from '@isnanme/core';
import type { Workspace } from '@portal/contracts';
import { loadAll } from 'js-yaml';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import type { JsonFile } from '../jsonFile.js';
import { tempDirectory } from '../store/testTmp.js';
import { KubernetesRuntime, placementOf } from './kubernetes.js';
import { cpuMilli, memoryBytes } from './requests.js';
import { kubeTargetOptions, kubeTargetRuntimes, parseKubeTargets, type KubeTargetSpec } from './kubeTargets.js';
import { Workspaces } from './manager.js';
import type { Runtime } from './runtime.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const refused = (text: string, why: RegExp, taken?: { namespaces?: string[] }) => assert.throws(() => parseKubeTargets(text, taken), (e: Error) => /^PORTAL_K8S_TARGETS is not usable: /.test(e.message) && why.test(e.message), text);

/* ---------- the setting ---------- */

test('unset or blank: no extra targets', () => {
  assert.deepEqual(parseKubeTargets(undefined), []);
  assert.deepEqual(parseKubeTargets('  '), []);
  assert.deepEqual(parseKubeTargets('[]'), []);
});

test('a full entry and a bare one', () => {
  const got = parseKubeTargets(
    JSON.stringify([
      { id: 'isnan', namespace: 'isnan-workspaces', label: ' Isnan ', nodeSelector: { 'isnan.me/pool': 'worker' }, preferredNodes: ['k3s-node2', 'k3s-node3'], cpus: 4, memoryMb: 8192, cpuRequest: '1000m', memoryRequest: '3Gi', storage: '20Gi', storageClass: 'local-path' },
      { id: 'konfersi', namespace: 'konfersi-workspaces', nodeSelector: 'disk=ssd,zone=a' },
    ]),
  );
  assert.deepEqual(got, [
    { id: 'isnan', label: 'Isnan', namespace: 'isnan-workspaces', nodeSelector: { 'isnan.me/pool': 'worker' }, preferredNodes: ['k3s-node2', 'k3s-node3'], defaults: { cpus: 4, memoryMb: 8192 }, requests: { cpu: '1000m', memory: '3Gi' }, storage: '20Gi', storageClass: 'local-path' },
    { id: 'konfersi', label: 'konfersi', namespace: 'konfersi-workspaces', nodeSelector: { disk: 'ssd', zone: 'a' } },
  ]);
});

test('bad JSON and wrong shapes are refused with a clear reason, never half understood', () => {
  refused('[{"id":"isnan",', /it is not JSON/);
  refused('{"id":"isnan","namespace":"isnan-workspaces"}', /JSON array/);
  refused('["isnan"]', /target 1 is not an object/);
  refused('[{"namespace":"a"}]', /target 1 needs an "id"/);
  refused('[{"id":"isnan"}]', /target "isnan" needs a "namespace"/);
  refused('[{"id":"isnan","namespace":"Isnan_WS"}]', /needs a "namespace"/);
  refused('[{"id":"isnan","namespace":"a","nodeselector":{}}]', /unknown key\(s\) "nodeselector"/);
  refused('[{"id":"Isnan","namespace":"a"}]', /id "Isnan": Lowercase/);
  refused('[{"id":"isnan","namespace":"a","label":""}]', /"label" is text/);
  refused('[{"id":"isnan","namespace":"a","nodeSelector":["x"]}]', /"nodeSelector" is/);
  refused('[{"id":"isnan","namespace":"a","nodeSelector":{"a":1}}]', /values are strings/);
  refused('[{"id":"isnan","namespace":"a","nodeSelector":"k3s-node2"}]', /"nodeSelector": "k3s-node2" is not key=value/);
  refused('[{"id":"isnan","namespace":"a","preferredNodes":[]}]', /"preferredNodes" is a non-empty list/);
  refused('[{"id":"isnan","namespace":"a","preferredNodes":["a b"]}]', /"preferredNodes" is a non-empty list/);
  refused('[{"id":"isnan","namespace":"a","preferredNodes":["n1","n1"]}]', /names a node twice/);
  refused('[{"id":"isnan","namespace":"a","cpus":0}]', /"cpus"/);
  refused('[{"id":"isnan","namespace":"a","memoryMb":100}]', /"memoryMb"/);
  refused('[{"id":"isnan","namespace":"a","storage":"lots"}]', /"storage"/);
  refused('[{"id":"isnan","namespace":"a","cpuRequest":"lots"}]', /"cpuRequest"/);
  refused('[{"id":"isnan","namespace":"a","memoryRequest":2}]', /"memoryRequest"/);
});

test('the built-in ids, duplicate ids and namespaces, and the `kubernetes` target’s namespace are refused', () => {
  for (const id of ['kubernetes', 'docker', 'docker-host', 'local']) refused(`[{"id":"${id}","namespace":"a"}]`, /taken by a built-in target/);
  refused('[{"id":"isnan","namespace":"a"},{"id":"isnan","namespace":"b"}]', /id "isnan" is used twice/);
  refused('[{"id":"isnan","namespace":"a"},{"id":"konfersi","namespace":"a"}]', /namespace "a" is used by two targets/);
  // Same namespace as PORTAL_K8S_NAMESPACE: the same Deployments would be listed under two ids.
  refused('[{"id":"isnan","namespace":"isnan-claudepilot-workspaces"}]', /used by two targets/, { namespaces: ['isnan-claudepilot-workspaces'] });
});

/* ---------- the options and the runtimes ---------- */

const BASE = { image: 'reg/workspace:1', imagePullSecret: 'pull', storage: '10Gi', storageClass: 'local-path', nodeSelector: { 'isnan.me/pool': 'worker' }, requests: { cpu: '1', memory: '2Gi' } };

test('each target inherits the `kubernetes` settings and puts its own on top; it never creates its namespace', () => {
  const targets: KubeTargetSpec[] = [
    { id: 'isnan', label: 'isnan', namespace: 'isnan-workspaces' },
    { id: 'konfersi', label: 'Konfersi', namespace: 'konfersi-workspaces', nodeSelector: { zone: 'b' }, preferredNodes: ['n3'], defaults: { cpus: 2 }, requests: { memory: '5Gi' }, storage: '5Gi', storageClass: 'fast' },
  ];
  const [a, b] = kubeTargetOptions({ ...BASE, targets });
  assert.deepEqual(a, { ...BASE, namespace: 'isnan-workspaces', target: { id: 'isnan', label: 'isnan' }, manageNamespace: false });
  assert.deepEqual(b, { ...BASE, requests: { cpu: '1', memory: '5Gi' }, namespace: 'konfersi-workspaces', storage: '5Gi', storageClass: 'fast', nodeSelector: { zone: 'b' }, target: { id: 'konfersi', label: 'Konfersi' }, manageNamespace: false, preferredNodes: ['n3'], defaults: { cpus: 2 } });
});

test('a target whose runtime cannot be made is left out, the others stay', () => {
  const failed: string[] = [];
  const made = kubeTargetRuntimes(
    { ...BASE, targets: [{ id: 'a', label: 'a', namespace: 'a' }, { id: 'b', label: 'b', namespace: 'b' }] },
    (o) => {
      if (o.target!.id === 'a') throw new Error('no kubeconfig');
      return o.target!.id;
    },
    (id, e) => failed.push(`${id}: ${e.message}`),
  );
  assert.deepEqual(made, ['b']);
  assert.deepEqual(failed, ['a: no kubeconfig']);
});

test('placement: node selector hard, preferred nodes soft in order, a named node required', () => {
  assert.deepEqual(placementOf({}), {});
  assert.deepEqual(placementOf({ nodeSelector: { p: 'w' } }), { nodeSelector: { p: 'w' } });
  const soft = placementOf({ nodeSelector: { p: 'w' }, preferredNodes: ['n2', 'n3'] });
  assert.deepEqual(soft.nodeSelector, { p: 'w' });
  assert.deepEqual(soft.affinity, {
    nodeAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        { weight: 100, preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['n2'] }] } },
        { weight: 90, preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['n3'] }] } },
      ],
    },
  });
  // A named node replaces the target's usual node (a hostname in its selector); the rest of the selector holds.
  assert.deepEqual(placementOf({ nodeSelector: { 'kubernetes.io/hostname': 'n2', p: 'w' }, preferredNodes: ['n2', 'n3'] }, 'n3').nodeSelector, { p: 'w' });
  assert.equal(placementOf({ nodeSelector: { 'kubernetes.io/hostname': 'n2' }, preferredNodes: ['n2', 'n3'] }, 'n3').nodeSelector, undefined);
  assert.deepEqual(placementOf({ preferredNodes: ['n2', 'n3'] }, 'n3').affinity, {
    nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['n3'] }] }] } },
  });
});

// Two org namespaces, each its own fake API server (a fake serves one namespace), reached through a kubeconfig file as in the cluster.
const savedKubeconfig = process.env.KUBECONFIG;
let isnan: FakeKube;
let konfersi: FakeKube;
before(async () => {
  isnan = await FakeKube.start({ namespace: 'isnan-workspaces' });
  konfersi = await FakeKube.start({ namespace: 'konfersi-workspaces' });
});
after(async () => {
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
  await Promise.all([isnan?.stop(), konfersi?.stop()]);
});

/** A runtime made like index.ts makes one (loadFromDefault), its kubeconfig pointing at `fake`. */
function runtimeOn(fake: FakeKube, spec: KubeTargetSpec): KubernetesRuntime {
  const dir = tempDirectory('cp-kubetargets-');
  const file = join(dir, 'config');
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'fake', cluster: { server: fake.url, 'insecure-skip-tls-verify': true } }],
      users: [{ name: 'portal', user: { token: fake.token } }],
      contexts: [{ name: 'fake', context: { cluster: 'fake', user: 'portal' } }],
      'current-context': 'fake',
    }),
  );
  process.env.KUBECONFIG = file;
  const [opts] = kubeTargetOptions({ image: 'reg/workspace:1', storage: '10Gi', storageClass: 'local-path', nodeSelector: { 'isnan.me/pool': 'worker' }, targets: [spec] });
  return new KubernetesRuntime({ ...opts!, fitCheck: false });
}

type Obj = { metadata: { name: string; labels?: Record<string, string> }; spec: Record<string, unknown> };
const deployment = (fake: FakeKube, name: string) => fake.deployments.get(name) as unknown as Obj & { spec: { template: { spec: Record<string, unknown> & { containers: { resources?: unknown }[] } } } };

test('a target runtime: its id, label, namespace and nodes; a create places the pod, the claim follows it; defaults fill CPU and memory', async () => {
  const rt = runtimeOn(isnan, { id: 'isnan', label: 'Isnan', namespace: 'isnan-workspaces', preferredNodes: ['k3s-node2', 'k3s-node3'], defaults: { cpus: 2, memoryMb: 4096 } });
  assert.equal(rt.target.id, 'isnan');
  assert.equal(rt.target.label, 'Isnan');
  assert.equal(rt.target.kind, 'kubernetes');
  assert.match(rt.target.where, /isnan-workspaces$/);
  assert.deepEqual(rt.target.nodes?.map((n) => n.id), ['k3s-node2', 'k3s-node3']);
  assert.deepEqual(rt.target.defaults, { cpus: 2, memoryMb: 4096 }, 'the dialog presets these');
  assert.equal(rt.browserAccess()?.namespace, 'isnan-workspaces', 'the browser pool works in the target’s own namespace');

  await rt.create({ name: 'dev', runtimeName: 'ws-aaaaaaaaaaaa' }, () => undefined);
  assert.equal(isnan.seen('POST', /\/api\/v1\/namespaces$/).length, 0, 'the namespace comes from git, never from a create');
  const d = deployment(isnan, 'ws-aaaaaaaaaaaa');
  assert.deepEqual(d.spec.template.spec.nodeSelector, { 'isnan.me/pool': 'worker' });
  assert.deepEqual(
    (d.spec.template.spec.affinity as { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: { preference: { matchExpressions: { values: string[] }[] } }[] } }).nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution.map((p) => p.preference.matchExpressions[0]!.values[0]),
    ['k3s-node2', 'k3s-node3'],
  );
  assert.deepEqual(d.spec.template.spec.containers[0]!.resources, { limits: { cpu: '2', memory: '4096Mi' } });
  assert.equal(d.metadata.labels?.['claudepilot.cpus'], '2');
  // The claim: in the target's namespace, on the storage class, no node of its own (WaitForFirstConsumer binds it where the pod lands).
  const claim = isnan.claims.get('ws-aaaaaaaaaaaa-home') as unknown as Obj;
  assert.equal((claim.spec as { storageClassName?: string }).storageClassName, 'local-path');
  assert.ok(isnan.seen('POST', '/api/v1/namespaces/isnan-workspaces/persistentvolumeclaims').length === 1);

  const list = await rt.list();
  assert.deepEqual(list.map((w) => [w.id, w.target]), [['isnan/dev', 'isnan']]);
});

test('a create naming a node pins the pod there; a node the target does not list is refused; the CPU asked for wins over the default', async () => {
  const rt = runtimeOn(isnan, { id: 'isnan', label: 'isnan', namespace: 'isnan-workspaces', preferredNodes: ['k3s-node2', 'k3s-node3'], defaults: { cpus: 2 } });
  await rt.create({ name: 'pinned', runtimeName: 'ws-bbbbbbbbbbbb', node: 'k3s-node3', cpus: 1 }, () => undefined);
  const d = deployment(isnan, 'ws-bbbbbbbbbbbb');
  assert.deepEqual(d.spec.template.spec.affinity, {
    nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['k3s-node3'] }] }] } },
  });
  assert.deepEqual((d.spec.template.spec.containers[0]!.resources as { limits: unknown }).limits, { cpu: '1' });
  await assert.rejects(rt.create({ name: 'elsewhere', runtimeName: 'ws-cccccccccccc', node: 'k3s-master' }, () => undefined), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED');
  assert.equal(isnan.deployments.has('ws-cccccccccccc'), false);
});

test('migration plan B.5: the target’s node and sizes reach the Deployment; a create naming another of its nodes moves only that workspace', async () => {
  const konf: KubeTargetSpec = { id: 'konfersi', label: 'konfersi', namespace: 'isnan-workspaces', nodeSelector: { 'kubernetes.io/hostname': 'k3s-node2' }, preferredNodes: ['k3s-node2', 'k3s-node3'], defaults: { cpus: 4, memoryMb: 12288 }, requests: { cpu: '1500m', memory: '5Gi' } };
  const rt = runtimeOn(isnan, konf);
  await rt.create({ name: 'konf', runtimeName: 'ws-dddddddddddd' }, () => undefined);
  const d = deployment(isnan, 'ws-dddddddddddd');
  assert.deepEqual(d.spec.template.spec.nodeSelector, { 'kubernetes.io/hostname': 'k3s-node2' }, 'the target’s node, not PORTAL_K8S_NODE_SELECTOR');
  assert.deepEqual(d.spec.template.spec.containers[0]!.resources, { limits: { cpu: '4', memory: '12288Mi' }, requests: { cpu: '1500m', memory: '5Gi' } });
  await rt.create({ name: 'konf-n3', runtimeName: 'ws-eeeeeeeeeeee', node: 'k3s-node3' }, () => undefined);
  const moved = deployment(isnan, 'ws-eeeeeeeeeeee').spec.template.spec;
  assert.equal(moved.nodeSelector, undefined);
  assert.deepEqual((moved.affinity as { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: { matchExpressions: { values: string[] }[] }[] } } }).nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0]!.matchExpressions[0]!.values, ['k3s-node3']);
});

/* ---------- the manager ---------- */

const saved = (() => {
  let v: Workspace[] = [];
  return { read: () => v, write: (x: Workspace[]) => void (v = x) } as unknown as JsonFile<Workspace[]>;
})();

test('the manager lists every target, routes `<target>/<name>` to its runtime, creates where asked, and keeps a configured id from Connect', async () => {
  const a = runtimeOn(isnan, { id: 'isnan', label: 'isnan', namespace: 'isnan-workspaces' });
  const b = runtimeOn(konfersi, { id: 'konfersi', label: 'konfersi', namespace: 'konfersi-workspaces' });
  const ws = new Workspaces([a, b], saved);
  assert.deepEqual((await ws.targets()).map((t) => [t.id, t.kind, t.available]), [['isnan', 'kubernetes', true], ['konfersi', 'kubernetes', true]]);
  assert.equal(ws.runtimeFor('isnan'), a);
  assert.equal(ws.runtimeFor('konfersi'), b);

  const made = await ws.create({ name: 'office', target: 'konfersi' });
  assert.equal(made.id, 'konfersi/office');
  for (let i = 0; i < 100 && !(await b.list()).some((w) => w.name === 'office'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok([...konfersi.deployments.values()].some((d) => (d as unknown as Obj).metadata.labels?.['claudepilot.workspace'] === 'office'), 'made in the konfersi namespace');
  assert.ok(![...isnan.deployments.values()].some((d) => (d as unknown as Obj).metadata.labels?.['claudepilot.workspace'] === 'office'), 'not in isnan’s');
  const ids = (await ws.list()).map((w) => w.id);
  assert.ok(ids.includes('konfersi/office') && ids.includes('isnan/dev'), ids.join(' '));

  // An enrolled target named like a configured one would hide its workspaces: the manager refuses it (Connect logs and goes on).
  assert.throws(() => ws.addRuntime({ ...a, target: { ...a.target } } as unknown as Runtime), (e) => isAppError(e) && e.code === 'CONFLICT');
  assert.equal(ws.runtimeFor('isnan'), a);
});

/* ---------- deploy/k3s ---------- */

type Doc = { kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; rules?: unknown; roleRef?: { name: string }; subjects?: { kind: string; name: string; namespace: string }[]; spec?: Record<string, unknown> };
const docs = (path: string) => loadAll(readFileSync(join(REPO, path), 'utf8')).filter(Boolean) as Doc[];

test('deploy/k3s: PORTAL_K8S_TARGETS in portal.yaml parses, and each of its namespaces has the guard rails and the old namespace’s Role', () => {
  const portal = docs('deploy/k3s/portal.yaml').find((d) => d.kind === 'Deployment')!;
  const env = (portal.spec as { template: { spec: { containers: { env?: { name: string; value?: string }[] }[] } } }).template.spec.containers.flatMap((c) => c.env ?? []);
  const value = env.find((e) => e.name === 'PORTAL_K8S_TARGETS')?.value;
  const oldNs = env.find((e) => e.name === 'PORTAL_K8S_NAMESPACE')?.value;
  assert.equal(oldNs, 'isnan-claudepilot-workspaces', 'the old target stays as it is');
  const targets = parseKubeTargets(value, { namespaces: [oldNs!] });
  assert.deepEqual(targets.map((t) => [t.id, t.namespace]), [['isnan', 'isnan-pilot-ws-isnan'], ['konfersi', 'isnan-pilot-ws-konfersi'], ['kohilabs', 'isnan-pilot-ws-kohilabs']]);
  // Migration plan B.5 (2026-10-31): placement and sizes per org, set by the portal at every create (no hand patch on a Deployment).
  assert.deepEqual(
    targets.map((t) => [t.id, t.nodeSelector?.['kubernetes.io/hostname'], t.defaults, t.requests]),
    [
      ['isnan', 'k3s-node2', { cpus: 4, memoryMb: 8192 }, { cpu: '1000m', memory: '3Gi' }],
      ['konfersi', 'k3s-node2', { cpus: 4, memoryMb: 12288 }, { cpu: '1500m', memory: '5Gi' }],
      ['kohilabs', 'k3s-master', { cpus: 4, memoryMb: 6144 }, { cpu: '500m', memory: '2Gi' }],
    ],
  );

  const oldRole = docs('deploy/k3s/rbac.yaml').find((d) => d.kind === 'Role' && d.metadata.namespace === oldNs)!;
  assert.ok(docs('deploy/k3s/namespace.yaml').some((d) => d.kind === 'Namespace' && d.metadata.name === oldNs), 'the old namespace is kept');
  const orgs = docs('deploy/k3s/workspace-orgs.yaml');
  for (const { namespace } of targets) {
    const of = (kind: string) => orgs.filter((d) => d.kind === kind && (kind === 'Namespace' ? d.metadata.name === namespace : d.metadata.namespace === namespace));
    const [ns] = of('Namespace');
    assert.ok(ns, `${namespace}: Namespace`);
    assert.equal(ns.metadata.annotations?.['argocd.argoproj.io/sync-options'], 'Delete=false,Prune=false', `${namespace}: never pruned or deleted with the app`);
    assert.equal(of('LimitRange').length, 1, `${namespace}: LimitRange`);
    const quotas = of('ResourceQuota');
    assert.equal(quotas.length, 1, `${namespace}: ResourceQuota`);
    // The quota holds the target's workspace and its browser container (limits 3Gi, requests 100m): else the create or the browser is refused.
    const t = targets.find((x) => x.namespace === namespace)!;
    const hard = (quotas[0]!.spec as { hard: Record<string, string> }).hard;
    assert.ok(memoryBytes(hard['limits.memory']!)! >= (t.defaults!.memoryMb! + 3 * 1024) * 1024 ** 2, `${namespace}: limits.memory`);
    assert.ok(cpuMilli(hard['requests.cpu']!)! >= cpuMilli(t.requests!.cpu!)! + 100, `${namespace}: requests.cpu`);
    const [role] = of('Role');
    assert.deepEqual(role?.rules, oldRole.rules, `${namespace}: the same rules as the old namespace's Role`);
    const [binding] = of('RoleBinding');
    assert.equal(binding?.roleRef?.name, role?.metadata.name);
    assert.deepEqual(binding?.subjects, [{ kind: 'ServiceAccount', name: 'claudepilot-portal', namespace: 'isnan-claudepilot' }]);
  }
});

test('deploy/k3s-build: the heavy Jobs keep away from workspace pods in every workspace namespace', () => {
  for (const file of ['job-run.yaml', 'image-build-job.yaml', 'gate-job.yaml']) {
    const text = readFileSync(join(REPO, 'deploy/k3s-build', file), 'utf8');
    for (const ns of ['isnan-claudepilot-workspaces', 'isnan-pilot-ws-isnan', 'isnan-pilot-ws-konfersi', 'isnan-pilot-ws-kohilabs'])
      assert.match(text, new RegExp(`namespaces: \\[[^\\]]*\\b${ns}\\b`), `${file}: ${ns}`);
  }
});
