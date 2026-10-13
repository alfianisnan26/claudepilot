// The browser on Kubernetes (browser & desktop PRD §10.2, §14.1, milestone B3), on the in-process fake API server: no cluster, no kubeconfig.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { KubeConfig, type V1Deployment, type V1NetworkPolicy, type V1Node, type V1Pod } from '@kubernetes/client-node';
import { BROWSER_POOL_DEFAULTS } from '@portal/contracts';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { kubeRuntimeOn } from '../workspaces/kubeTestkit.js';
import { KubernetesRuntime } from '../workspaces/kubernetes.js';
import {
  BROWSER_CONTAINER,
  browserContainer,
  configMapName,
  egressPolicy,
  egressPolicyName,
  fitOf,
  K8S_BROWSER_REQUESTS,
  KubeBrowsers,
  parseEgressAllow,
  podRequest,
  PRIVATE_V4,
  type KubePlan,
} from './kube.js';
import { browserHarness, supervisorStatus } from './testkit.js';

type Harness = Awaited<ReturnType<typeof browserHarness>>;

const TARGET = 'kd-kube';
const IMAGE = 'registry.example.test/claudepilot/browser:t1';
const PORTAL = 'http://claudepilot-portal.portal-ns.svc.cluster.local:3000';
const GiB = 1024 ** 3;

let fake: FakeKube;
let rt: KubernetesRuntime;
let h: Harness;
let kb: KubeBrowsers;

function kubeConfigOn(f: FakeKube) {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'fake', server: f.url, skipTLSVerify: true }],
    users: [{ name: 'portal', token: f.token }],
    contexts: [{ name: 'fake', cluster: 'fake', user: 'portal' }],
    currentContext: 'fake',
  });
  return kc;
}

const node = (name: string, cpu: string, memory: string): V1Node => ({ metadata: { name, labels: { 'kubernetes.io/hostname': name } }, status: { allocatable: { cpu, memory } } });
const otherPod = (nodeName: string, cpu: string, memory: string, phase = 'Running'): V1Pod => ({
  metadata: { name: `other-${Math.random().toString(16).slice(2, 8)}`, namespace: 'elsewhere' },
  spec: { nodeName, containers: [{ name: 'c', resources: { requests: { cpu, memory } } }] },
  status: { phase },
});

const deployment = (name = 'dev') => fake.deployments.get(`ws-${name}`) as unknown as V1Deployment;
const template = (name = 'dev') => deployment(name).spec!.template;
const podOf = (name = 'dev') => [...fake.pods.values()].find((p) => p.metadata.name.startsWith(`ws-${name}-`)) as unknown as V1Pod | undefined;
const id = (name = 'dev') => `${TARGET}/${name}`;
const deploymentWrites = () => fake.requests.filter((r) => r.method === 'PUT' && /\/deployments\/ws-[^/]+$/.test(r.url.split('?')[0]!)).length;

async function workspace(name = 'dev', opts: { running?: boolean; cpus?: number; memoryMb?: number } = {}) {
  await rt.create({ name, runtimeName: `ws-${name}`, cpus: opts.cpus ?? 1, memoryMb: opts.memoryMb ?? 2048 }, () => undefined);
  if (opts.running === false) await rt.stop(name);
}

let pools = 0;
function assign(name = 'dev', content = {}) {
  const p = h.create(`Browser ${name} ${++pools}`, content);
  h.pools.setAssignments(id(name), 'browser', [{ poolId: p.id }]);
  return p;
}

before(async () => {
  fake = await FakeKube.start({ namespace: 'rig' });
  rt = kubeRuntimeOn(fake);
});
after(async () => {
  await fake.stop();
});
beforeEach(async () => {
  h?.done();
  for (const m of [fake.deployments, fake.pods, fake.claims, fake.configMaps, fake.networkPolicies, fake.nodes]) m.clear();
  fake.otherPods.length = 0;
  fake.requests.length = 0;
  fake.clusterReads = true;
  fake.nodes.set('n1', node('n1', '8', '16Gi') as never);
  kb = new KubeBrowsers(TARGET, { kubeConfig: kubeConfigOn(fake), namespace: fake.namespace, objectName: (n) => `ws-${n}` }, IMAGE, PORTAL);
  h = await browserHarness({ targets: [], kube: new Map([[TARGET, kb]]) });
});
after(() => h?.done());

describe('the pod template', () => {
  test('a stopped workspace takes the browser: a second container after `workspace`, its ConfigMap and its egress policy', async () => {
    await workspace('dev', { running: false });
    assign();
    await h.service.converge(id(), 'test');
    const t = template();
    assert.deepEqual(
      t.spec!.containers.map((c) => c.name),
      ['workspace', BROWSER_CONTAINER],
    );
    const c = t.spec!.containers[1]!;
    assert.equal(c.image, IMAGE);
    assert.deepEqual(c.resources?.requests, { cpu: K8S_BROWSER_REQUESTS.cpu, memory: K8S_BROWSER_REQUESTS.memory });
    assert.deepEqual(c.resources?.limits, { cpu: '2', memory: '3072Mi' }, 'limits are the pool’s');
    assert.equal(t.spec!.automountServiceAccountToken, false);
    assert.match(t.spec!.initContainers![0]!.command!.join(' '), /mkdir -p .*\.claudepilot\/browser\/profile.*Downloads.* && chmod 0700/, 'seed-home makes the subpaths');
    assert.equal(c.securityContext?.readOnlyRootFilesystem, true);
    assert.deepEqual(c.securityContext?.capabilities, { drop: ['ALL'], add: ['SETUID', 'SETGID'] });
    assert.equal(c.securityContext?.seccompProfile?.type, 'RuntimeDefault');
    assert.equal(c.readinessProbe, undefined, 'the pod’s readiness follows `workspace`');
    assert.equal(t.spec!.volumes!.find((v) => v.name === 'cpb-shm')?.emptyDir?.medium, 'Memory');

    const cm = fake.configMaps.get(configMapName('ws-dev')) as unknown as { data: Record<string, string> };
    assert.ok(cm, 'the ConfigMap is there');
    assert.equal(JSON.parse(cm.data['config.json']!).sandbox, 'auto');
    assert.ok(JSON.parse(cm.data['policy.json']!).URLBlocklist.includes('claudepilot-portal.portal-ns.svc.cluster.local:3000'), 'the portal is blocked');
    assert.ok(fake.networkPolicies.get(egressPolicyName('ws-dev')), 'the egress policy is there');
    assert.equal((await h.service.status(id())).state, 'workspace_stopped');

    // Starting: the template already matches, so nothing is written again.
    const writes = deploymentWrites();
    await h.service.beforeStart(id());
    await rt.start('dev');
    assert.equal(deploymentWrites(), writes);
  });

  test('just before a start: an assignment made while stopped lands in the template before the pod is made', async () => {
    await workspace('dev', { running: false });
    assign();
    assert.equal(template().spec!.containers.length, 1, 'nothing yet');
    await h.service.beforeStart(id());
    assert.equal(template().spec!.containers.length, 2);
    await rt.start('dev');
    assert.ok(podOf(), 'the pod comes up from the new template');
  });

  test('a running workspace is never restarted for its browser: it shows Restart needed until its next start', async () => {
    await workspace('dev');
    assign();
    const writes = deploymentWrites();
    await h.service.converge(id(), 'assigned');
    assert.equal(deploymentWrites(), writes, 'the template is not touched');
    assert.equal(template().spec!.containers.length, 1);
    const st = await h.service.status(id());
    assert.equal(st.state, 'restart_needed');
    assert.match(st.detail ?? '', /Restart the workspace/);
    assert.equal(h.service.configuration(id()).container, 'stopped');

    await rt.stop('dev');
    await h.service.beforeStart(id());
    await rt.start('dev');
    assert.equal(template().spec!.containers.length, 2, 'applied at the restart');
  });

  test('a workspace still coming up (no workspace container running yet: a new one, an image pulling) takes it at once', async () => {
    fake.clusterReads = false;
    await workspace('dev');
    podOf()!.status = { phase: 'Pending', containerStatuses: [{ name: 'workspace', ready: false, restartCount: 0, image: 'w', imageID: '', state: { waiting: { reason: 'ContainerCreating' } } }] } as never;
    assign();
    await h.service.converge(id(), 'assigned');
    assert.equal(template().spec!.containers.length, 2);
    assert.equal(h.service.configuration(id()).container, 'starting');
  });

  test('a pool change while the browser runs: it keeps working (the live view stays) and says the change waits for a restart', async () => {
    fake.clusterReads = false;
    await workspace('dev', { running: false });
    const p = assign();
    await h.service.beforeStart(id());
    await rt.start('dev');
    const pod = podOf()!;
    pod.status = {
      phase: 'Running',
      containerStatuses: [
        { name: 'workspace', ready: true, restartCount: 0, image: 'w', imageID: '', state: { running: {} } },
        { name: BROWSER_CONTAINER, ready: true, restartCount: 0, image: IMAGE, imageID: '', state: { running: {} } },
      ],
    };
    fake.onExec = (io) => {
      io.stdout(JSON.stringify({ ok: true, result: supervisorStatus() }));
      io.exit(0);
    };
    await h.service.converge(id(), 'timer');
    assert.equal((await h.service.status(id())).state, 'ready');
    const before = JSON.stringify(template());
    h.pools.update(p.id, { content: { idleMinutes: 5 } });
    await h.service.converge(id(), 'pool changed');
    assert.equal(JSON.stringify(template()), before, 'not applied while it runs');
    h.service.invalidate(id());
    const st = await h.service.status(id());
    assert.equal(st.state, 'ready', 'still usable');
    assert.equal(st.detail, 'The browser changed: restart the workspace to apply it.');
    await rt.stop('dev');
    await h.service.beforeStart(id());
    assert.notEqual(JSON.stringify(template()), before, 'applied at the next start');
  });

  test('unassigning: a running workspace keeps its browser until it restarts; then the container, ConfigMap and policy go', async () => {
    await workspace('dev', { running: false });
    assign();
    await h.service.converge(id(), 'test');
    await rt.start('dev');
    h.pools.setAssignments(id(), 'browser', []);
    await h.service.converge(id(), 'unassigned');
    assert.equal(template().spec!.containers.length, 2, 'not while it runs');
    assert.equal(h.service.configuration(id()).error, 'Restart the workspace to remove its browser.');
    await rt.stop('dev');
    await h.service.converge(id(), 'stopped');
    assert.deepEqual(
      template().spec!.containers.map((c) => c.name),
      ['workspace'],
    );
    assert.equal(template().spec!.automountServiceAccountToken, false, 'left as it was');
    assert.equal(fake.configMaps.size, 0);
    assert.equal(fake.networkPolicies.size, 0);
  });
});

test('a portal with a namespaced Role only creates workspaces in the namespace made for it (namespace create is 403)', async () => {
  fake.clusterReads = false;
  const own = new KubernetesRuntime({ namespace: fake.namespace, image: 'w', storage: '1Gi' }, { kubeConfig: kubeConfigOn(fake), manageNamespace: true, target: { id: 'k', label: 'K', where: 'fake' } });
  await own.create({ name: 'solo', runtimeName: 'ws-solo' }, () => undefined);
  assert.ok(fake.deployments.has('ws-solo'));
  assert.equal(fake.seen('POST', '/api/v1/namespaces').length, 1, 'it tried');
});

describe('caps and fit', () => {
  test('at most 2 assigned browsers per Kubernetes target: the third is refused with the reason', async () => {
    for (const n of ['a', 'b', 'c']) await workspace(n, { running: false });
    assign('a');
    assign('b');
    assert.throws(() => assign('c'), /2 of 2 browsers are assigned on this Kubernetes target/);
    // A change of pool on one that has a browser is not a new one.
    assert.doesNotThrow(() => assign('a', { idleMinutes: 5 }));
    h.pools.setAssignments(id('b'), 'browser', []);
    assert.doesNotThrow(() => assign('c'));
  });

  test('no node with room: refused with the numbers, the workspace starts without its browser, and the next start tries again', async () => {
    fake.nodes.set('n1', node('n1', '2', '4Gi') as never);
    fake.otherPods.push(otherPod('n1', '1500m', '1Gi') as never, otherPod('n1', '4', '8Gi', 'Succeeded') as never);
    await workspace('dev', { running: false, cpus: 1, memoryMb: 2048 });
    assign();
    await h.service.converge(id(), 'test');
    assert.equal(template().spec!.containers.length, 1, 'no browser in the template');
    const st = await h.service.status(id());
    assert.equal(st.state, 'error');
    assert.match(st.detail ?? '', /Doesn't fit: n1 has 0\.5 CPU and 3\.0 GiB free by requests; the workspace with its browser asks 1\.1 CPU and 2\.5 GiB/);
    const before = fake.requests.length;
    await h.service.converge(id(), 'timer');
    assert.equal(fake.requests.filter((r, i) => i >= before && r.url.startsWith('/api/v1/nodes')).length, 0, 'not checked again until a start');
    // Room appears: the next start adds it.
    fake.otherPods.length = 0;
    await h.service.beforeStart(id());
    assert.equal(template().spec!.containers.length, 2);
  });

  test('a portal that may not read the nodes adds the browser unchecked (the Pending rollback guards it)', async () => {
    fake.clusterReads = false;
    await workspace('dev', { running: false });
    assign();
    await h.service.converge(id(), 'test');
    assert.equal(template().spec!.containers.length, 2);
  });

  test('a pod that stays Pending 5 minutes loses its browser again; under 5 minutes it waits', async () => {
    fake.clusterReads = false;
    await workspace('dev', { running: false });
    assign();
    await h.service.beforeStart(id());
    await rt.start('dev');
    const pod = podOf()!;
    const pending = (minutes: number) => {
      pod.status = {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available: 2 Insufficient cpu.', lastTransitionTime: new Date(Date.now() - minutes * 60_000) }],
      };
    };
    pending(2);
    await h.service.converge(id(), 'timer');
    assert.equal(template().spec!.containers.length, 2, 'two minutes: still waiting');
    pending(6);
    await h.service.converge(id(), 'timer');
    assert.equal(template().spec!.containers.length, 1, 'rolled back');
    const st = await h.service.status(id());
    assert.equal(st.state, 'error');
    assert.match(st.detail ?? '', /stayed Pending 5 minutes with its browser \(0\/2 nodes are available/);
    const writes = deploymentWrites();
    await h.service.converge(id(), 'timer');
    assert.equal(deploymentWrites(), writes, 'and it is not put back until the next start');
  });

  test('the fit rule with the cluster’s numbers (2026-10-13): kohi-event plus a browser fits k3s-node2 only because its own pod is replaced', () => {
    const GiText = (g: number) => `${g * 1024}Mi`;
    const nodes = [node('k3s-master', '8', '15000Mi'), node('k3s-node2', '8', '29500Mi')];
    // k3s-node2 held 7810m and 24572Mi by requests, kohi-event's own 1 CPU and 2 GiB included; k3s-master 3915m and 10432Mi.
    const own: V1Pod = { metadata: { name: 'ws-kohi-event-x', namespace: 'ws', labels: { 'claudepilot.workspace': 'kohi-event' } }, spec: { nodeName: 'k3s-node2', containers: [{ name: 'workspace', resources: { requests: { cpu: '1', memory: GiText(2) } } }] }, status: { phase: 'Running' } };
    const pods = [own, otherPod('k3s-node2', '6810m', '22524Mi'), otherPod('k3s-master', '3915m', '10432Mi')];
    const plan: KubePlan = { workspace: 'kohi-event', poolId: 'p', content: BROWSER_POOL_DEFAULTS, portalHosts: [], image: IMAGE };
    const need = podRequest({ containers: [{ name: 'workspace', resources: { requests: { cpu: '1', memory: GiText(2) } } }, browserContainer(plan)] });
    assert.deepEqual(need, { cpu: 1100, memory: 2.5 * GiB });
    const selector = { 'kubernetes.io/hostname': 'k3s-node2' };
    const fit = fitOf({ need, nodes, pods, nodeSelector: selector, ownPod: (p) => p === own });
    assert.equal(fit.fits, true);
    assert.match(fit.reason, /^Fits on k3s-node2: 1\.19 CPU and 6\.8 GiB free by requests/);
    // Not replacing its own pod (a second workspace on the same node) it does not: 0.19 CPU free.
    const second = fitOf({ need, nodes, pods, nodeSelector: selector });
    assert.equal(second.fits, false);
    assert.match(second.reason, /k3s-node2 has 0\.19 CPU and 4\.8 GiB free by requests/);
    // The browser at the PRD's first 0.5 CPU request would not have fit k3s-node2 even replacing the pod (1.5 > 1.19).
    const big = podRequest({ containers: [{ name: 'workspace', resources: { requests: { cpu: '1', memory: GiText(2) } } }, { name: 'browser', resources: { requests: { cpu: '500m', memory: '1536Mi' } } }] });
    assert.equal(fitOf({ need: big, nodes, pods, nodeSelector: selector, ownPod: (p) => p === own }).fits, false);
  });
});

describe('status, usage and faults', () => {
  test('a browser fault never changes the workspace’s status: an unpullable or crash-looping browser leaves it Running', async () => {
    await workspace('dev', { running: false });
    fake.clusterReads = false;
    assign();
    await h.service.beforeStart(id());
    await rt.start('dev');
    const pod = podOf()!;
    for (const reason of ['ImagePullBackOff', 'CrashLoopBackOff']) {
      // The pod stays Pending while the browser's image can't be pulled: phase is not the workspace's state (PRD §20 A5).
      pod.status = {
        phase: reason === 'ImagePullBackOff' ? 'Pending' : 'Running',
        conditions: [{ type: 'PodScheduled', status: 'True' }],
        containerStatuses: [
          { name: 'workspace', ready: true, restartCount: 0, image: 'w', imageID: '', state: { running: { startedAt: new Date() } } },
          { name: BROWSER_CONTAINER, ready: false, restartCount: 3, image: IMAGE, imageID: '', state: { waiting: { reason, message: 'back-off' } } },
        ],
      };
      const ws = (await rt.list()).find((w) => w.name === 'dev')!;
      assert.equal(ws.status, 'running', reason);
      await h.service.converge(id(), 'timer');
      const st = await h.service.status(id());
      assert.equal(st.state, 'error', reason);
      assert.match(st.detail ?? '', new RegExp(reason));
    }
    // And the workspace's own exec still finds its pod (the workspace container runs).
    assert.equal(template().spec!.containers.length, 2, 'a browser fault does not roll the template back either');
  });

  test('usage is split by container: the workspace’s row counts only its own container', async () => {
    await workspace('dev');
    fake.podMetrics = () => [
      { name: 'workspace', usage: { cpu: '250m', memory: '512Mi' } },
      { name: BROWSER_CONTAINER, usage: { cpu: '900m', memory: '1Gi' } },
    ];
    try {
      const [u] = await rt.usage(['dev']);
      assert.equal(u!.cpuPercent, 25);
      assert.equal(u!.memoryBytes, 512 * 1024 ** 2);
    } finally {
      fake.podMetrics = () => [{ name: 'workspace', usage: { cpu: '250m', memory: '512Mi' } }];
    }
  });

  test('commands reach the browser container as uid 1001, and only once it runs', async () => {
    await workspace('dev');
    await assert.rejects(kb.exec('dev', ['cpb-ctl', 'status']), /browser container isn’t running/);
    const pod = podOf()!;
    pod.status = {
      phase: 'Running',
      containerStatuses: [
        { name: 'workspace', ready: true, restartCount: 0, image: 'w', imageID: '', state: { running: {} } },
        { name: BROWSER_CONTAINER, ready: true, restartCount: 0, image: IMAGE, imageID: '', state: { running: {} } },
      ],
    };
    fake.onExec = (io) => {
      io.stdout(JSON.stringify(io.command));
      io.exit(0);
    };
    const r = await kb.exec('dev', ['cpb-ctl', 'status']);
    assert.deepEqual(JSON.parse(r.stdout), ['setpriv', '--reuid=1001', '--regid=1001', '--clear-groups', '--', 'cpb-ctl', 'status']);
    assert.ok(fake.upgrades.at(-1)!.url.includes('container=browser'));
  });
});

describe('network', () => {
  test('CDP stays on the pod’s loopback: no port, no Service, no host network, and Chrome is told 127.0.0.1', async () => {
    const plan: KubePlan = { workspace: 'dev', poolId: 'p', content: BROWSER_POOL_DEFAULTS, portalHosts: [], image: IMAGE };
    const c = browserContainer(plan);
    assert.equal(c.ports, undefined, 'nothing published');
    assert.ok(!c.livenessProbe?.tcpSocket && !c.livenessProbe?.httpGet, 'an exec probe: kubelet probes hit the pod IP');
    await workspace('dev', { running: false });
    assign();
    await h.service.converge(id(), 'test');
    assert.ok(!template().spec!.hostNetwork);
    assert.equal(fake.requests.filter((r) => /\/services/.test(r.url)).length, 0, 'no Service');
    // The image's own JavaScript (no types): by URL, so the compiler doesn't look for them.
    const libUrl = new URL('../../../../images/browser/cpb/lib.mjs', import.meta.url).href;
    const lib = (await import(libUrl)) as { chromeArgs: (cfg: unknown, o: unknown) => string[]; loadConfig: (p?: string) => unknown };
    const cfg = { ...(lib.loadConfig('/nonexistent') as object), chromeFlags: ['--remote-debugging-address=0.0.0.0', '--lang=en'] };
    const args = lib.chromeArgs(cfg, { headless: false, profileDir: '/data/profile' });
    assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
    assert.ok(!args.includes('--remote-debugging-address=0.0.0.0'), 'a pool flag can’t move it');
  });

  test('the egress policy: the internet, DNS and the portal, never private, link-local or cluster ranges; admin exceptions; the opt-out', async () => {
    const p = egressPolicy('ws-dev', { a: 'b' }, { portal: { namespace: 'portal-ns', port: 3000 }, allow: parseEgressAllow('10.43.0.1/32:443, 192.168.1.10').allow });
    const spec = (p as V1NetworkPolicy).spec!;
    assert.deepEqual(spec.policyTypes, ['Egress']);
    assert.deepEqual(spec.podSelector!.matchLabels, { a: 'b' });
    const [internet, dns, portal, api, lan] = spec.egress!;
    assert.deepEqual(internet!.to![0]!.ipBlock, { cidr: '0.0.0.0/0', except: PRIVATE_V4 });
    for (const r of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8']) assert.ok(PRIVATE_V4.includes(r), r);
    assert.deepEqual(dns!.ports!.map((x) => `${x.protocol}/${x.port}`), ['UDP/53', 'TCP/53']);
    assert.deepEqual(portal!.to![0]!.namespaceSelector?.matchLabels, { 'kubernetes.io/metadata.name': 'portal-ns' });
    assert.deepEqual(portal!.ports, [{ protocol: 'TCP', port: 3000 }]);
    assert.deepEqual(api, { to: [{ ipBlock: { cidr: '10.43.0.1/32' } }], ports: [{ protocol: 'TCP', port: 443 }] });
    assert.deepEqual(lan, { to: [{ ipBlock: { cidr: '192.168.1.10/32' } }] });

    assert.deepEqual(parseEgressAllow('10.0.0.0/8,[fd00::1]/128:443,fd00::/8, 300.1.1.1, example.com, 1.2.3, 10.0.0.1:99999').allow, [
      { cidr: '10.0.0.0/8' },
      { cidr: 'fd00::1/128', port: 443 },
      { cidr: 'fd00::/8' },
    ]);
    assert.deepEqual(parseEgressAllow('300.1.1.1, example.com, 1.2.3,10.0.0.1:99999').bad, ['300.1.1.1', 'example.com', '1.2.3', '10.0.0.1:99999']);

    // On the fake: the workspace's policy selects its pod; with the opt-out it is removed again.
    await workspace('dev', { running: false });
    assign();
    await h.service.converge(id(), 'test');
    const live = fake.networkPolicies.get(egressPolicyName('ws-dev')) as unknown as V1NetworkPolicy;
    assert.deepEqual(live.spec!.podSelector!.matchLabels, { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'dev' });
    assert.equal(live.metadata!.ownerReferences?.[0]?.name, 'ws-dev', 'it goes with the Deployment');
    (kb as unknown as { egress: { mode: string } }).egress.mode = 'off';
    await h.service.converge(id(), 'test');
    assert.equal(fake.networkPolicies.size, 0, 'opted out');
  });
});
