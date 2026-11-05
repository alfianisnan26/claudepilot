// PILOT-1167 (portal side of G1, docs/prd/cf-bridge.md): several Kubernetes targets on ONE connector node. Each target's runtime is built
// on the same link (what Connect's runtimes hand the factory for a rider: the host's node), and each one's kube streams name only its own
// namespace (T-3720 open args), so the agent applies that namespace's allowlist. Its API calls stay inside its namespace, and a namespace
// the agent does not serve is refused at the open, not reached. In-process fake API server only (KUBERNETES SAFETY RULE).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ConnectOpenArgs } from '@portal/contracts';
import { ConnectError, type TunnelStream } from '../../connect/seams.js';
import type { Runtime } from '../runtime.js';
import { createTunnelRuntime, disposeRuntime } from './factory.js';
import { FakeLink, fakeKubeApi, memoryDeps, targetRecord } from './testkit.js';

/** The bridge's agent: serves the namespaces it was given (PILOT_KUBE_NAMESPACES) and refuses a kube open naming any other. */
class BridgeLink extends FakeLink {
  constructor(
    nodeId: string,
    targetId: string,
    kubePort: number,
    readonly served: string[],
  ) {
    super(nodeId, targetId, { kubePort });
  }

  override async open(service: 'docker' | 'kube' | 'host', args?: ConnectOpenArgs, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TunnelStream> {
    const ns = (args as { namespace?: string } | undefined)?.namespace;
    if (service === 'kube' && (!ns || !this.served.includes(ns))) {
      this.opened.push({ service, ...(args ? { args } : {}) });
      throw new ConnectError('denied', 'That namespace is not served here.');
    }
    return super.open(service, args, opts);
  }
}

let api: Awaited<ReturnType<typeof fakeKubeApi>>;
let link: BridgeLink;
let hold: NodeJS.Timeout;
const runtimes: Runtime[] = [];
const saved = process.env.KUBECONFIG;

/** A runtime for one target on the bridge node, as Connect's runtimes build it (the rider's own record; the host's node and link). */
function runtimeFor(id: string, namespace: string, via?: string): Runtime {
  const record = targetRecord({ id, kind: 'kubernetes', settings: { namespace, ...(via ? { via } : {}) } });
  const rt = createTunnelRuntime(record, [{ record: { id: 'nd-bridge', targetId: 'cpb', name: 'cp-bridge', drained: false, keyFingerprint: 'x' }, link }], memoryDeps());
  runtimes.push(rt);
  return rt;
}

before(async () => {
  hold = setInterval(() => undefined, 1000);
  process.env.KUBECONFIG = '/nonexistent/pilot-1167-kubeconfig';
  api = await fakeKubeApi();
  link = new BridgeLink('nd-bridge', 'cpb', api.port, ['ws-a', 'ws-b']).connect();
});
after(async () => {
  clearInterval(hold);
  runtimes.forEach((r) => disposeRuntime(r));
  link.drop();
  await api.close();
  if (saved === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = saved;
});

describe('namespace targets on one bridge node (PILOT-1167)', () => {
  it('each target’s streams carry only its own namespace, and its API calls stay inside it', async () => {
    const host = runtimeFor('cpb', 'ws-a');
    const rider = runtimeFor('cpb-1', 'ws-b', 'cpb');
    const steps: [Runtime, string, string][] = [
      [host, 'ws-a', 'h1'],
      [rider, 'ws-b', 'r1'],
      [host, 'ws-a', 'h2'],
    ];
    for (const [rt, ns, name] of steps) {
      const opened = link.opened.length;
      const requests = api.requests.length;
      await rt.create({ name, cpus: 1, memoryMb: 512 }, () => undefined);
      const list = await rt.list();
      assert.ok(list.some((w) => w.name === name), `${name} is listed by its own target`);
      const kube = link.opened.slice(opened).filter((o) => o.service === 'kube');
      assert.ok(kube.length > 0, `${name}: streams were opened`);
      assert.ok(kube.every((o) => JSON.stringify(o.args) === JSON.stringify({ namespace: ns })), `${name}: only ${ns} — ${JSON.stringify(kube)}`);
      const calls = api.requests.slice(requests);
      assert.ok(calls.length > 0);
      assert.ok(calls.every((r) => r.path.includes(`/namespaces/${ns}/`)), `${name}: every call under ${ns} — ${JSON.stringify(calls.map((r) => r.path))}`);
    }
    // each lists only its own namespace's workspaces, though both run on the one node
    assert.deepEqual((await host.list()).map((w) => w.name).sort(), ['h1', 'h2']);
    assert.deepEqual((await rider.list()).map((w) => w.name), ['r1']);
    assert.equal(api.deployments.get('ws-r1')!.metadata.namespace, 'ws-b');
    assert.equal(api.deployments.get('ws-h1')!.metadata.namespace, 'ws-a');
    assert.equal(api.requests.some((r) => r.path === '/api/v1/namespaces' && r.method === 'POST'), false, 'no namespace is ever created');
  });

  it('a target naming a namespace the bridge does not serve is refused at the open: nothing reaches the API', async () => {
    const stray = runtimeFor('cpb-9', 'ws-c', 'cpb');
    const requests = api.requests.length;
    await assert.rejects(stray.list());
    assert.equal(api.requests.length, requests, 'no API call was made');
    const last = link.opened.at(-1)!;
    assert.deepEqual([last.service, last.args], ['kube', { namespace: 'ws-c' }]);
  });
});
