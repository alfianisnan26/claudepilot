// T-RT (d) / T-KUBE for the runtime side: KubernetesRuntime over the tunnel (docs/prd/targets-connect.md §12.6). The portal's loopback
// listener (127.0.0.1 only) turns each connection into a `kube` stream; here the agent end pipes to an in-process fake API server
// (no cluster: KUBERNETES SAFETY RULE). It lists, creates, scales, execs and removes without ever creating a namespace, carries the
// per-connection bearer, and a reconnect brings a new listener and token. KUBECONFIG is never read: the KubeConfig is made from options.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { isTargetUnreachable } from '../runtime.js';
import { ConnectKubeRuntime } from './kube.js';
import { FakeLink, fakeKubeApi, memoryDeps, targetRecord } from './testkit.js';

let api: Awaited<ReturnType<typeof fakeKubeApi>>;
let link: FakeLink;
let rt: ConnectKubeRuntime;
let hold: NodeJS.Timeout;
const saved = process.env.KUBECONFIG;

before(async () => {
  hold = setInterval(() => undefined, 1000);
  // Anything that still called loadFromDefault() would read this, and fail: nothing must.
  process.env.KUBECONFIG = '/nonexistent/cx3-kubeconfig';
  api = await fakeKubeApi();
  link = new FakeLink('k1', 'cx3-kube', { kubePort: api.port }).connect();
  rt = new ConnectKubeRuntime(targetRecord({ id: 'cx3-kube', kind: 'kubernetes', settings: { namespace: 'cx3-ns' } }), { record: { id: 'k1', targetId: 'cx3-kube', name: 'k', drained: false, keyFingerprint: 'x' }, link }, memoryDeps());
});
after(async () => {
  clearInterval(hold);
  rt.dispose();
  link.drop();
  await api.close();
  if (saved === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = saved;
});

describe('ConnectKubeRuntime', () => {
  it('creates, lists, scales, execs and removes in the fake, never creating a namespace', async () => {
    await rt.check();
    await rt.create({ name: 'k1', cpus: 1, memoryMb: 512 }, () => undefined);
    assert.ok(api.deployments.has('ws-k1'));
    assert.ok(api.claims.has('ws-k1-home'));
    let [w] = await rt.list();
    assert.equal(w!.id, 'cx3-kube/k1');
    assert.equal(w!.status, 'running');
    await rt.stop('k1');
    assert.equal(api.deployments.get('ws-k1')!.spec.replicas, 0);
    await rt.start('k1');
    const ex = await rt.exec('k1', ['echo', 'hi']);
    let out = '';
    ex.onData((d) => (out += d.toString()));
    const code = await new Promise<number | null>((r) => ex.onExit(r));
    assert.equal(code, 0);
    assert.equal(out, 'exec: echo hi\n');
    await rt.remove('k1');
    assert.equal(api.deployments.size, 0);
    assert.equal(api.requests.some((r) => r.path === '/api/v1/namespaces' && r.method === 'POST'), false);
    // Every call carried this connection's bearer (the agent's proxy checks and drops it).
    assert.ok(api.requests.every((r) => r.auth === `Bearer ${link.kubeToken()}`));
    assert.ok(api.requests.every((r) => r.path.includes('/namespaces/cx3-ns/') || r.path.endsWith('/namespaces/cx3-ns')));
    [w] = await rt.list();
    assert.equal(w, undefined);
  });

  it('an outage: unreachable, the last list kept; a reconnect brings a new token', async () => {
    await rt.create({ name: 'k2' }, () => undefined);
    await rt.list();
    const first = link.kubeToken();
    link.drop();
    await assert.rejects(rt.list(), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.check(), (e) => isTargetUnreachable(e));
    assert.deepEqual(rt.listLastKnown().map((w) => [w.name, w.status]), [['k2', 'unreachable']]);
    link.connect();
    assert.notEqual(link.kubeToken(), first);
    const before = api.requests.length;
    assert.equal((await rt.list())[0]!.status, 'running');
    assert.ok(api.requests.slice(before).every((r) => r.auth === `Bearer ${link.kubeToken()}`));
    await rt.remove('k2');
  });
});
