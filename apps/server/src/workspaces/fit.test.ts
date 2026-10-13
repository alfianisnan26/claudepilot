// The node fit check (fit.ts): the rule scripts/ws-resources.sh used, pure on what was read, and read from the in-process fake API server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KubeConfig, CoreV1Api } from '@kubernetes/client-node';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { bytes, checkFit, cores, fit, needOf, type FitPod } from './fit.js';

const GI = 1024 ** 3;
const MI = 1024 ** 2;
const node = { name: 'n1', allocatable: { cpu: '8', memory: '16Gi' } };
const own: FitPod = { namespace: 'ws', labels: { w: 'box' }, nodeName: 'n1', phase: 'Running', requests: [{ cpu: '250m', memory: '1Gi' }] };
const other = (cpu: string, phase = 'Running', extra: Partial<FitPod> = {}): FitPod => ({ namespace: 'other', nodeName: 'n1', phase, requests: [{ cpu, memory: '4Gi' }], ...extra });
const isSelf = (p: FitPod) => p.labels?.w === 'box';
const need = (cpuMilli: number, memoryBytes: number) => ({ cpuMilli, memoryBytes });

test('quantities: CPU in cores, memory in bytes', () => {
  assert.deepEqual(['250m', '1', '0.5'].map(cores), [0.25, 1, 0.5]);
  assert.ok(Math.abs(cores('123456789n') - 0.123456789) < 1e-12);
  assert.deepEqual(['512Mi', '2Gi', '1048576Ki', '1G', '1048576'].map(bytes), [512 * MI, 2 * GI, GI, 1e9, MI]);
  assert.deepEqual(needOf([{ resources: { requests: { cpu: '250m', memory: '1Gi' } } }, { resources: { limits: { cpu: '1', memory: '512Mi' } } }]), need(1250, GI + 512 * MI), 'a request left out is its limit');
});

test('the script’s rule and words: the other pods’ requests on the node plus the new ones within allocatable; the pod replaced left out', () => {
  const ok = fit({ need: need(1000, 2 * GI), node: 'n1', isSelf }, { nodes: [node], pods: [own, other('3')] });
  assert.deepEqual([ok.fits, ok.checked], [true, true]);
  assert.match(ok.reason, /^It fits on n1: the other pods request 3000m and 4096Mi, this one would ask 1000m and 2048Mi, the node can allocate 8000m and 16384Mi\.$/);
  assert.deepEqual(ok.nodes, [{ node: 'n1', allocatable: need(8000, 16 * GI), used: need(3000, 4 * GI), free: need(5000, 12 * GI), fits: true }]);
  const tight = fit({ need: need(1000, 2 * GI), node: 'n1', isSelf }, { nodes: [node], pods: [own, other('7500m')] });
  assert.equal(tight.fits, false);
  assert.match(tight.reason, /does not fit on n1 \(the pod would stay Pending\): the other pods request 7500m/);
  assert.equal(fit({ need: need(1000, 2 * GI), node: 'n1' }, { nodes: [node], pods: [own, other('6900m')] }).fits, false, 'without isSelf the pod itself counts');
  for (const gone of [other('7500m', 'Succeeded'), other('7500m', 'Failed'), other('7500m', 'Running', { deleting: true }), other('7500m', 'Running', { nodeName: 'n2' })])
    assert.equal(fit({ need: need(1000, 2 * GI), node: 'n1', isSelf }, { nodes: [node], pods: [gone] }).fits, true, JSON.stringify(gone));
  assert.equal(fit({ need: need(1000, 13 * GI), node: 'n1', isSelf }, { nodes: [node], pods: [other('1')] }).fits, false, 'memory counts too');
});

test('no node given: any node it may go to (selector matched, not cordoned); the fitting one first, else the one with the most CPU left', () => {
  const nodes = [
    { name: 'a', labels: { pool: 'ws' }, allocatable: { cpu: '2', memory: '4Gi' } },
    { name: 'b', labels: { pool: 'ws' }, unschedulable: true, allocatable: { cpu: '64', memory: '256Gi' } },
    { name: 'c', labels: { pool: 'other' }, allocatable: { cpu: '64', memory: '256Gi' } },
    { name: 'd', labels: { pool: 'ws' }, allocatable: { cpu: '3', memory: '4Gi' } },
  ];
  const no = fit({ need: need(4000, GI), nodeSelector: { pool: 'ws' } }, { nodes, pods: [] });
  assert.deepEqual([no.fits, no.nodes.map((n) => n.node)], [false, ['d', 'a']]);
  assert.match(no.reason, /does not fit on d/);
  const yes = fit({ need: need(2500, GI), nodeSelector: { pool: 'ws' } }, { nodes, pods: [] });
  assert.deepEqual([yes.fits, yes.nodes[0]!.node], [true, 'd']);
  assert.equal(fit({ need: need(4000, GI) }, { nodes, pods: [] }).nodes[0]!.node, 'c');
  const none = fit({ need: need(1, 1), nodeSelector: { pool: 'gpu' } }, { nodes, pods: [] });
  assert.deepEqual([none.fits, none.checked], [false, false]);
  assert.deepEqual([fit({ need: need(1, 1), node: 'zz' }, { nodes, pods: [] }).checked], [false]);
});

test('checkFit reads the cluster (the node, its pods across namespaces) and never throws: a cluster it may not read is checked: false', async () => {
  const fake = await FakeKube.start();
  try {
    fake.nodes.set('n1', { metadata: { name: 'n1' }, status: { allocatable: { cpu: '8', memory: '16Gi' } } } as never);
    fake.otherPods.push({ metadata: { name: 'db-0', namespace: 'other' }, spec: { nodeName: 'n1', containers: [{ name: 'db', resources: { requests: { cpu: '3', memory: '4Gi' } } }] }, status: { phase: 'Running' } } as never);
    const kc = new KubeConfig();
    kc.loadFromOptions({ clusters: [{ name: 'f', server: fake.url, skipTLSVerify: true }], users: [{ name: 'u', token: fake.token }], contexts: [{ name: 'f', cluster: 'f', user: 'u' }], currentContext: 'f' });
    const core = kc.makeApiClient(CoreV1Api);
    const onNode = await checkFit(core, { need: need(1000, 2 * GI), node: 'n1' });
    assert.deepEqual([onNode.fits, onNode.nodes[0]!.used], [true, need(3000, 4 * GI)]);
    assert.ok(fake.seen('GET', /^\/api\/v1\/pods\?.*fieldSelector=spec\.nodeName%3Dn1/).length, 'only the pods on that node are asked for');
    assert.equal((await checkFit(core, { need: need(6000, GI) })).fits, false, 'any node: n1 has 5000m free');
    fake.clusterReads = false;
    const blind = await checkFit(core, { need: need(1000, GI), node: 'n1' });
    assert.deepEqual([blind.fits, blind.checked, blind.nodes], [false, false, []]);
    assert.match(blind.reason, /could not be checked: the portal may not read the cluster’s nodes and pods/);
  } finally {
    await fake.stop();
  }
});
