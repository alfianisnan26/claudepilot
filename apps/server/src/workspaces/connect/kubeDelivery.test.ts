// Delivery into an enrolled Kubernetes cluster (targets-connect FR43, FR44): ConnectKubeRuntime exposes the KubernetesRuntime's delivery through
// the tunnel (a FakeLink whose `kube` streams reach the in-process fake API server; no cluster, KUBERNETES SAFETY RULE), switched off by
// `settings.delivery: false`; an outage is "unreachable", never a failure; the start watch outlives a reconnect.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeKube } from '../../connect/agent/testkit/fakeKube.js';
import { localPod } from '../kubeTestkit.js';
import { isTargetUnreachable } from '../runtime.js';
import { ConnectKubeRuntime } from './kube.js';
import { FakeLink, memoryDeps, targetRecord } from './testkit.js';

let fake: FakeKube;
let link: FakeLink;
let dir: string;
const runtimes: ConnectKubeRuntime[] = [];
const saved = process.env.KUBECONFIG;

before(() => {
  process.env.KUBECONFIG = '/nonexistent/kd-kubeconfig';
});
after(() => {
  if (saved === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = saved;
});
beforeEach(async () => {
  fake = await FakeKube.start({ namespace: 'kd-ns' });
  dir = mkdtempSync(join(tmpdir(), 'kd-connect-'));
  link = new FakeLink('kd-node', 'kd-kube', { kubePort: Number(new URL(fake.url).port) }).connect();
  // The agent's proxy swaps the per-connection bearer for the service account's; here the fake accepts the connection's own.
  fake.token = link.kubeToken()!;
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) r.dispose();
  link.drop();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const make = (settings: Record<string, unknown> = {}, roots?: string[]) => {
  const rt = new ConnectKubeRuntime(
    targetRecord({ id: 'kd-kube', kind: 'kubernetes', settings: { namespace: 'kd-ns', ...settings } }),
    { record: { id: 'kd-node', targetId: 'kd-kube', name: 'k', drained: false, keyFingerprint: 'x' }, link },
    memoryDeps(),
    { startPollMs: 40, ...(roots ? { deliveryRoots: roots } : {}) },
  );
  runtimes.push(rt);
  return rt;
};
const until = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('ConnectKubeRuntime delivery', () => {
  it('is there by default and gone when the target switches it off (FR43)', () => {
    assert.equal(make().delivery?.needsRunning, true);
    assert.equal(make({ delivery: false }).delivery, undefined);
    assert.ok(make({ delivery: true }).delivery);
  });

  it('runs, writes and reads through the tunnel exactly as in-cluster, as root through sudo -n', async () => {
    const root = join(dir, 'root');
    mkdirSync(root);
    const rt = make({}, [root]);
    const pod = localPod(fake, dir);
    await rt.create({ name: 'kw' }, () => undefined);
    const d = rt.delivery!;
    assert.deepEqual(await d.state('kw'), { exists: true, running: true, portal: null });
    assert.deepEqual(await d.run('kw', 'cat; echo; exit 3', { stdin: 'via the tunnel' }), { code: 3, stdout: 'via the tunnel\n', stderr: '' });
    await d.put('kw', [
      { path: `${root}/etc`, type: 'directory', mode: 0o750, uid: 0, gid: 1000 },
      { path: `${root}/etc/a.json`, type: 'file', content: '{"via":"tunnel"}', mode: 0o640, uid: 0, gid: 1000 },
    ]);
    assert.equal(statSync(`${root}/etc`).mode & 0o7777, 0o750);
    assert.equal(statSync(`${root}/etc/a.json`).mode & 0o7777, 0o640);
    assert.equal(await d.read('kw', `${root}/etc/a.json`), '{"via":"tunnel"}');
    assert.equal(await d.read('kw', `${root}/etc/missing`), null);
    // A path outside the folders delivery writes never reaches the pod.
    await assert.rejects(d.put('kw', [{ path: join(dir, 'x'), type: 'file', content: 'x', mode: 0o644, uid: 0, gid: 0 }]), /outside the folders delivery writes/);
    assert.match(readFileSync(pod.sudoLog, 'utf8'), /-n sh -c/);
    assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${link.kubeToken()}`));
  });

  it('an outage is "unreachable" (pending, never failed), and the start watch picks up a start that happened meanwhile', async () => {
    const rt = make();
    localPod(fake, dir);
    await rt.create({ name: 'kw' }, () => undefined);
    const seen: string[] = [];
    const stop = rt.delivery!.watchStarts((n) => seen.push(n));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(seen, []);
    link.drop();
    await assert.rejects(rt.delivery!.state('kw'), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.delivery!.run('kw', 'true'), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.delivery!.put('kw', []), (e) => isTargetUnreachable(e));
    // The pod restarts while the tunnel is down.
    const pod = [...fake.pods.values()][0]!;
    (pod.status as { containerStatuses: { restartCount?: number }[] }).containerStatuses[0]!.restartCount = 1;
    await new Promise((r) => setTimeout(r, 150));
    link.connect();
    fake.token = link.kubeToken()!;
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['kw']);
    stop();
  });
});
