// Request headers on Kubernetes by exec (browser & desktop PRD §24, T-623 S1b), on the in-process fake API server: no cluster, no
// kubeconfig. The fake answers each exec the way the two delivery scripts do (it keeps the file's state), and records every exec.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { KubeConfig, type V1Deployment, type V1Pod } from '@kubernetes/client-node';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { kubeRuntimeOn } from '../workspaces/kubeTestkit.js';
import type { KubernetesRuntime } from '../workspaces/kubernetes.js';
import { headersFile, type SecretLookup } from './headers.js';
import { BROWSER_CONTAINER, KubeBrowsers, REMOVE_HEADERS_SCRIPT, WRITE_HEADERS_SCRIPT } from './kube.js';
import { browserHarness, supervisorStatus } from './testkit.js';

type Harness = Awaited<ReturnType<typeof browserHarness>>;

const TARGET = 'kd-kube';
const IMAGE = 'registry.example.test/claudepilot/browser:t1';
const PORTAL = 'http://claudepilot-portal.portal-ns.svc.cluster.local:3000';
const RULE = { hosts: ['app.example.com'], name: 'X-Edge-Token', secret: 'EDGE_TOKEN' };

let fake: FakeKube;
let rt: KubernetesRuntime;
let h: Harness | undefined;
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

const id = () => `${TARGET}/dev`;
const template = () => (fake.deployments.get('ws-dev') as unknown as V1Deployment).spec!.template;
const podOf = () => [...fake.pods.values()].find((p) => p.metadata.name.startsWith('ws-dev-')) as unknown as V1Pod;
const deploymentWrites = () => fake.requests.filter((r) => r.method === 'PUT' && /\/deployments\/ws-[^/]+$/.test(r.url.split('?')[0]!)).length;
const fresh = () => `v${randomBytes(14).toString('hex')}`;
const idle = () => supervisorStatus({ activity: { at: Date.now() - 120_000, toolAt: Date.now() - 120_000, tool: null, session: null } });

before(async () => {
  fake = await FakeKube.start({ namespace: 'rig' });
  rt = kubeRuntimeOn(fake);
});
after(async () => {
  h?.done();
  await fake.stop();
});
beforeEach(() => {
  h?.done();
  h = undefined;
  for (const m of [fake.deployments, fake.pods, fake.claims, fake.configMaps, fake.networkPolicies, fake.nodes]) m.clear();
  fake.requests.length = 0;
  fake.upgrades.length = 0;
  fake.clusterReads = false;
  kb = new KubeBrowsers(TARGET, { kubeConfig: kubeConfigOn(fake), namespace: fake.namespace, objectName: (n) => `ws-${n}` }, IMAGE, PORTAL);
});

interface Call {
  command: string[];
  stdin: string;
}

/** A workspace that runs with its browser container, an exec that acts as the scripts do, and every exec recorded. */
async function rig(lookup: SecretLookup) {
  h = await browserHarness({ targets: [], kube: new Map([[TARGET, kb]]), secretByName: lookup });
  await rt.create({ name: 'dev', runtimeName: 'ws-dev', cpus: 1, memoryMb: 2048 }, () => undefined);
  await rt.stop('dev');
  const pool = h.create('Browser dev', { allowedSites: ['app.example.com'], headers: [RULE] });
  h.pools.setAssignments(id(), 'browser', [{ poolId: pool.id }]);
  await h.service.beforeStart(id());
  await rt.start('dev');
  podOf().status = {
    phase: 'Running',
    containerStatuses: [
      { name: 'workspace', ready: true, restartCount: 0, image: 'w', imageID: '', state: { running: {} } },
      { name: BROWSER_CONTAINER, ready: true, restartCount: 0, image: IMAGE, imageID: '', state: { running: {} } },
    ],
  };
  const calls: Call[] = [];
  const state = { file: null as string | null, failWith: null as string | null, busy: false };
  fake.onExec = (io) => {
    const call: Call = { command: io.command, stdin: '' };
    calls.push(call);
    const script = io.command[2];
    if (script === WRITE_HEADERS_SCRIPT) {
      const want = Number(io.command[4]);
      io.onStdin((d) => {
        call.stdin += d.toString();
        if (Buffer.byteLength(call.stdin) < want) return;
        if (state.failWith) {
          io.stderr(`boom ${state.failWith}`);
          io.exit(1);
          return;
        }
        io.stdout(state.file !== call.stdin ? 'changed\n' : 'same\n');
        state.file = call.stdin;
        io.exit(0);
      });
    } else if (script === REMOVE_HEADERS_SCRIPT) {
      io.stdout(state.file === null ? 'same\n' : 'changed\n');
      state.file = null;
      io.exit(0);
    } else if (io.command.includes('status')) {
      const busy = supervisorStatus({ control: { held: true } });
      io.stdout(JSON.stringify({ ok: true, result: state.busy ? busy : idle() }));
      io.exit(0);
    } else io.exit(0);
  };
  return { calls, state };
}

const headerCalls = (calls: Call[]) => calls.filter((c) => c.command[2] === WRITE_HEADERS_SCRIPT || c.command[2] === REMOVE_HEADERS_SCRIPT);
const chromeStops = (calls: Call[]) => calls.filter((c) => c.command.includes('chrome') && c.command.includes('stop'));

describe('request headers by exec (PRD §24)', () => {
  test('the value goes into the browser container by exec on stdin: never in an argv, no Secret object, the folder 0700 and the file 0400', async () => {
    const value = fresh();
    const { calls, state } = await rig(() => ({ ok: true, value, version: 'v1' }));
    await h!.service.converge(id(), 'test');
    const sent = headerCalls(calls);
    assert.equal(sent.length, 1);
    const c = sent[0]!;
    assert.equal(c.command[0], 'sh', 'run as the container’s own user (root): no setpriv');
    assert.equal(c.stdin, headersFile([{ name: RULE.name, hosts: RULE.hosts, secret: RULE.secret, value, version: 'v1' }]));
    assert.equal(state.file, c.stdin);
    assert.ok(!JSON.stringify(calls.map((x) => x.command)).includes(value), 'no value in any argv');
    assert.ok(!WRITE_HEADERS_SCRIPT.includes(value));
    assert.match(WRITE_HEADERS_SCRIPT, /chmod 0700 "\$d"/);
    assert.match(WRITE_HEADERS_SCRIPT, /umask 277/);
    assert.equal(c.command[4], String(Buffer.byteLength(c.stdin)), 'the byte count is the only argument');
    assert.ok(fake.upgrades.some((u) => u.url.includes('container=browser')));
    assert.equal(fake.requests.filter((r) => /\/secrets/.test(r.url)).length, 0, 'no Secret is created, read or deleted');
    assert.ok(!JSON.stringify(template()).includes(value), 'not in the template');
    assert.ok(!JSON.stringify(h!.store.db!.prepare('SELECT * FROM browser_events').all()).includes(value), 'not in the audit');
    // The same content again is not sent again.
    await h!.service.converge(id(), 'again');
    assert.equal(headerCalls(calls).length, 1);
  });

  test('a rotated secret is written again and Chrome is stopped to read it, with no pod restart; a removed one deletes the file', async () => {
    let value = fresh();
    let version = 'v1';
    let present = true;
    const { calls, state } = await rig(() => (present ? { ok: true, value, version } : { ok: false, why: 'not found' }));
    await h!.service.converge(id(), 'test');
    const writes = deploymentWrites();
    assert.equal(chromeStops(calls).length, 1, 'the first file stops a Chrome that may have started without it');

    value = fresh();
    version = 'v2';
    await h!.service.converge(id(), 'rotated');
    assert.equal(headerCalls(calls).length, 2);
    assert.ok(state.file!.includes(value), 'the new value is the file');
    assert.equal(chromeStops(calls).length, 2, 'Chrome restarts to read it');
    assert.ok(chromeStops(calls).at(-1)!.command.includes('--reuid=1001'), 'cpb-ctl as the supervisor’s user');

    present = false;
    await h!.service.converge(id(), 'removed');
    const last = headerCalls(calls).at(-1)!;
    assert.equal(last.command[2], REMOVE_HEADERS_SCRIPT);
    assert.equal(last.command.length, 4, 'no argument at all');
    assert.equal(state.file, null, 'the file is gone');
    assert.equal(chromeStops(calls).length, 3);
    assert.equal(deploymentWrites(), writes, 'neither change touched the Deployment: no restart');
    assert.ok(!JSON.stringify(calls.map((x) => x.command)).includes(value));
  });

  test('a Chrome in use is not stopped; it is stopped at the next pass once idle', async () => {
    const value = fresh();
    const { calls, state } = await rig(() => ({ ok: true, value, version: 'v1' }));
    state.busy = true;
    await h!.service.converge(id(), 'test');
    assert.ok(state.file, 'delivered');
    assert.equal(chromeStops(calls).length, 0, 'someone has control');
    state.busy = false;
    await h!.service.converge(id(), 'later');
    assert.equal(chromeStops(calls).length, 1);
    assert.equal(headerCalls(calls).length, 1, 'not delivered twice');
  });

  test('a delivery that fails is audited without the value and never fails the convergence; the next pass tries again', async () => {
    const value = fresh();
    const { calls, state } = await rig(() => ({ ok: true, value, version: 'v1' }));
    state.failWith = value;
    await h!.service.converge(id(), 'test');
    const rows = h!.store.db!.prepare("SELECT details FROM browser_events WHERE kind = 'headers_failed'").all() as { details: string }[];
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(value), 'the error never carries what the container wrote to stderr');
    state.failWith = null;
    await h!.service.converge(id(), 'retry');
    assert.ok(state.file?.includes(value));
    assert.equal(headerCalls(calls).length, 2);
  });

  test('a new pod (its memory folder is empty) gets the file again', async () => {
    const value = fresh();
    const { calls } = await rig(() => ({ ok: true, value, version: 'v1' }));
    await h!.service.converge(id(), 'test');
    assert.equal(headerCalls(calls).length, 1);
    podOf().metadata!.uid = `new-${fresh()}`;
    await h!.service.converge(id(), 'pod replaced');
    assert.equal(headerCalls(calls).length, 2);
  });

  test('while the browser container is not running the delivery waits quietly', async () => {
    const value = fresh();
    const { calls } = await rig(() => ({ ok: true, value, version: 'v1' }));
    podOf().status!.containerStatuses![1]!.state = { waiting: { reason: 'ContainerCreating' } };
    await h!.service.converge(id(), 'test');
    assert.equal(headerCalls(calls).length, 0);
    assert.equal((h!.store.db!.prepare("SELECT 1 FROM browser_events WHERE kind = 'headers_failed'").all() as unknown[]).length, 0);
  });
});
