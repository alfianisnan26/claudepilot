// PILOT-1144: the real Connect client (`dialTunnel`, what connect/agent/client.ts and the stub agent use) completes the handshake against the
// Cloudflare Worker's /bridge (apps/core-worker), run locally by wrangler (workerd). It starts a workerd, so it runs only with
// CLAUDEPILOT_WORKER_TESTS=1 (like the Docker tests); the Worker's own suite (apps/core-worker/test) covers the refusals inside workerd.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONNECT_AGENT_VERSION, CONNECT_PROTOCOL, type ConnectAgentHello } from '@portal/contracts';
import { LOCAL_TOKEN, NAMESPACE, startKubeRig } from '../agent/testkit/kubeRig.js';
import { generateNodeKeyPair } from './auth.js';
import type { MuxStream } from './mux.js';
import { acceptService, type OpenDecision } from './open.js';
import { dialTunnel, TunnelConnectError, TunnelRejected } from './ws.js';

const enabled = process.env.CLAUDEPILOT_WORKER_TESTS === '1';
const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../core-worker');
const WORKER_CONFIG = resolve(WORKER_DIR, 'wrangler.jsonc');
/** The real Worker plus one test-only route to BridgeDO's kube RPC (apps/core-worker/test/interop/entry.ts; never deployed). */
const WORKER_ENTRY = resolve(WORKER_DIR, 'test/interop/entry.ts');

interface DevWorker {
  url: Promise<URL>;
  ready: Promise<void>;
  dispose(): Promise<void>;
}

const hello = (): ConnectAgentHello => ({
  agentVersion: CONNECT_AGENT_VERSION,
  agentBuild: 'test00000000',
  protocol: CONNECT_PROTOCOL,
  os: 'linux',
  arch: 'x64',
  hostname: 'cp-bridge-interop',
  mode: 'kubernetes',
  runtime: 'pod',
  services: [{ name: 'kube', ok: true }],
  clock: new Date().toISOString(),
  startedAt: new Date().toISOString(),
});

describe('dialTunnel against the Worker /bridge (workerd)', { skip: enabled ? false : 'set CLAUDEPILOT_WORKER_TESTS=1' }, () => {
  const keys = generateNodeKeyPair();
  const token = randomBytes(32).toString('base64url');
  const node = `nd_${randomBytes(6).toString('hex')}`;
  const cluster = 'interop-cluster';
  let worker: DevWorker;
  let url: string;
  let httpUrl: string;

  before(async () => {
    // A variable specifier: wrangler is a dependency of apps/core-worker, not of the server, and only this opt-in test loads it.
    const specifier = 'wrangler';
    const { unstable_startWorker } = (await import(specifier)) as { unstable_startWorker(opts: unknown): Promise<DevWorker> };
    worker = await unstable_startWorker({
      config: WORKER_CONFIG,
      entrypoint: WORKER_ENTRY,
      bindings: {
        BRIDGE_CLUSTERS: {
          type: 'plain_text',
          value: JSON.stringify({
            [cluster]: { node, publicKey: keys.publicKey, tokenSha256: createHash('sha256').update(token).digest('hex') },
          }),
        },
      },
      dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false },
    });
    await worker.ready;
    const u = await worker.url;
    url = `ws://${u.host}/bridge`;
    httpUrl = `http://${u.host}`;
  });

  after(async () => {
    await worker?.dispose();
  });

  const headers = (t = token) => ({ authorization: `Bearer ${t}`, 'x-pilot-cluster': cluster });

  test('the real client completes the handshake, and the Worker answers its mux pings', async () => {
    const d = await dialTunnel({
      url,
      nodeId: node,
      privateKey: keys.privateKey,
      hello,
      ws: { headers: headers() },
      limits: { pingEveryMs: 200 },
    });
    try {
      assert.equal(d.welcome.node, node);
      assert.equal(d.welcome.target, cluster);
      assert.equal(d.welcome.protocol, CONNECT_PROTOCOL);
      const rtt = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no ping answer from the Worker')), 5_000);
        d.session.onRtt((ms) => (clearTimeout(t), resolve(ms)));
      });
      assert.ok(rtt >= 0);
    } finally {
      d.session.close(1000, 'test over');
    }
  });

  test('a wrong token is an HTTP 404 at the upgrade', async () => {
    await assert.rejects(
      dialTunnel({ url, nodeId: node, privateKey: keys.privateKey, hello, ws: { headers: headers(`${token}x`) } }),
      (e: unknown) => e instanceof TunnelConnectError && e.status === 404,
    );
  });

  test('a wrong key is refused with bad_signature', async () => {
    const other = generateNodeKeyPair();
    await assert.rejects(
      dialTunnel({ url, nodeId: node, privateKey: other.privateKey, hello, ws: { headers: headers() } }),
      (e: unknown) => e instanceof TunnelRejected && e.code === 'bad_signature',
    );
  });

  test('the DO lists pods through /bridge: the real dialTunnel agent, the real KubeProxy, a fake API server (PILOT-1170, the G6 exit)', async () => {
    const rig = await startKubeRig();
    rig.fake.pods.set('ws-a', {
      metadata: { name: 'ws-a', namespace: NAMESPACE, labels: { 'claudepilot.managed': 'true' } },
      status: { phase: 'Running' },
    });
    const accepted: string[] = [];
    // What connect/agent/client.ts #dispatch does for a stream the portal opens, reduced to the kube service.
    const onStream = (stream: MuxStream) =>
      void (async () => {
        const req = await acceptService(stream, async (r): Promise<OpenDecision> => {
          if (r.service !== 'kube') return { ok: false, code: 'service_unavailable', message: 'Only kube here.' };
          const refusal = await rig.service.accept!(r.args);
          return refusal ? { ok: false, code: refusal.code, message: refusal.message } : { ok: true };
        });
        if (!req) return;
        accepted.push(JSON.stringify(req.args ?? null));
        rig.service.handle(stream, req.trace ?? '--------', req.args);
      })();
    const d = await dialTunnel({ url, nodeId: node, privateKey: keys.privateKey, hello, ws: { headers: headers() }, onStream });
    const ask = async (body: { path: string; namespace?: string; bearer: string }) => {
      const res = await fetch(`${httpUrl}/__interop/kube`, { method: 'POST', body: JSON.stringify({ cluster, ...body }) });
      assert.equal(res.status, 200);
      return (await res.json()) as { ok: boolean; status?: number; body?: string; code?: string };
    };
    try {
      const pods = `/api/v1/namespaces/${NAMESPACE}/pods`;
      const list = await ask({ path: pods, namespace: NAMESPACE, bearer: LOCAL_TOKEN });
      assert.equal(list.ok, true, JSON.stringify(list));
      assert.equal(list.status, 200);
      const items = (JSON.parse(list.body!) as { items: { metadata: { name: string } }[] }).items;
      assert.deepEqual(
        items.map((p) => p.metadata.name),
        ['ws-a'],
      );
      // The API server saw the service account's token and the managed selector the proxy adds, never the bridge's bearer.
      const seen = rig.fake.requests.find((r) => r.url.startsWith(pods));
      assert.equal(seen?.headers.authorization, `Bearer ${rig.fake.token}`);
      assert.match(seen?.url ?? '', /claudepilot\.managed/);
      assert.deepEqual(accepted, [JSON.stringify({ namespace: NAMESPACE })]);

      // The agent's walls hold through the bridge: another namespace's path, a wrong bearer, a namespace it does not serve.
      assert.equal((await ask({ path: '/api/v1/namespaces/kube-system/pods', namespace: NAMESPACE, bearer: LOCAL_TOKEN })).status, 403);
      assert.equal((await ask({ path: pods, namespace: NAMESPACE, bearer: `${LOCAL_TOKEN}x` })).status, 401);
      const denied = await ask({ path: pods, namespace: 'kube-system', bearer: LOCAL_TOKEN });
      assert.deepEqual([denied.ok, denied.code], [false, 'denied']);
    } finally {
      d.session.close(1000, 'test over');
      await rig.stop();
    }
  });

  test('the DO’s REST client runs a workspace’s life through /bridge: create, list, scale, metrics, delete (PILOT-1171)', async () => {
    const rig = await startKubeRig();
    const onStream = (stream: MuxStream) =>
      void (async () => {
        const req = await acceptService(stream, async (r): Promise<OpenDecision> => {
          if (r.service !== 'kube') return { ok: false, code: 'service_unavailable', message: 'Only kube here.' };
          const refusal = await rig.service.accept!(r.args);
          return refusal ? { ok: false, code: refusal.code, message: refusal.message } : { ok: true };
        });
        if (req) rig.service.handle(stream, req.trace ?? '--------', req.args);
      })();
    const d = await dialTunnel({ url, nodeId: node, privateKey: keys.privateKey, hello, ws: { headers: headers() }, onStream });
    type Answer = { ok: boolean; code?: string; status?: number; reason?: string; items?: { metadata: { name: string } }[] } & Record<string, unknown>;
    const rpc = async (name: string, body: Record<string, unknown>) => {
      const res = await fetch(`${httpUrl}/__interop/kube/${name}`, {
        method: 'POST',
        body: JSON.stringify({ cluster, namespace: NAMESPACE, bearer: LOCAL_TOKEN, ...body }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as Answer;
    };
    const ws = `ws-${randomBytes(6).toString('hex')}`;
    const labels = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'interop' };
    const podLabels = { ...labels, app: ws };
    const deployment = (extra: Record<string, unknown> = {}) => ({
      metadata: { name: ws, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: podLabels },
        template: {
          metadata: { labels: podLabels },
          spec: {
            securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            containers: [{ name: 'workspace', image: 'ghcr.io/example/workspace:1', volumeMounts: [{ name: 'home', mountPath: '/home/node' }] }],
            volumes: [{ name: 'home', persistentVolumeClaim: { claimName: `${ws}-home` } }],
            ...extra,
          },
        },
      },
    });
    try {
      const claim = await rpc('kubeCreate', {
        kind: 'claim',
        object: { metadata: { name: `${ws}-home`, labels }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
      });
      assert.equal(claim.ok, true, JSON.stringify(claim));
      const created = await rpc('kubeCreate', { kind: 'deployment', object: deployment() });
      assert.equal(created.ok, true, JSON.stringify(created));
      const again = await rpc('kubeCreate', { kind: 'deployment', object: deployment() });
      assert.deepEqual([again.ok, again.code, again.status, again.reason], [false, 'kube_status', 409, 'AlreadyExists']);

      const listed = await rpc('kubeList', { kind: 'deployments', workspace: 'interop' });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      assert.deepEqual(
        listed.items!.map((x) => x.metadata.name),
        [ws],
      );
      const claims = await rpc('kubeList', { kind: 'claims' });
      assert.ok(claims.items!.some((x) => x.metadata.name === `${ws}-home`));
      assert.deepEqual(await rpc('kubeScale', { name: ws, replicas: 0 }), { ok: true, replicas: 0 });
      assert.equal((rig.fake.deployments.get(ws)?.spec as { replicas?: number } | undefined)?.replicas, 0);
      assert.deepEqual(await rpc('kubeScale', { name: ws, replicas: 1 }), { ok: true, replicas: 1 });
      const metrics = await rpc('kubeMetrics', {});
      assert.equal(metrics.ok, true, JSON.stringify(metrics));
      assert.ok(Array.isArray(metrics.items));

      // The second wall: the agent's schema scan refuses what leaves the sandbox, and the Worker reports it as the proxy's Status.
      const escaped = await rpc('kubeCreate', {
        kind: 'deployment',
        object: { ...deployment({ hostNetwork: true }), metadata: { name: `${ws}0`, labels } },
      });
      assert.deepEqual([escaped.ok, escaped.code, escaped.status], [false, 'kube_status', 403]);
      // The first wall: the Worker refuses a dot segment, an encoded dot or a query before anything reaches the agent.
      const before = rig.fake.requests.length;
      for (const path of [`/api/v1/namespaces/${NAMESPACE}/../kube-system/pods`, '/api/%2e%2e/v1', `/api/v1/namespaces/${NAMESPACE}/pods?watch=1`]) {
        const res = await fetch(`${httpUrl}/__interop/kube`, {
          method: 'POST',
          body: JSON.stringify({ cluster, path, namespace: NAMESPACE, bearer: LOCAL_TOKEN }),
        });
        assert.deepEqual(((await res.json()) as Answer).code, 'bad_request', path);
      }
      assert.deepEqual(await rpc('kubeScale', { name: '../x', replicas: 0 }), {
        ok: false,
        code: 'bad_request',
        message: 'The name is not one of the portal’s workspaces.',
      });
      assert.equal(rig.fake.requests.length, before);

      assert.deepEqual(await rpc('kubeDelete', { kind: 'deployment', name: ws }), { ok: true, deleted: true });
      const del = rig.fake.requests.find((r) => r.method === 'DELETE' && r.url.includes(`/deployments/${ws}`));
      assert.match(del?.url ?? '', /propagationPolicy=Foreground/);
      assert.deepEqual(await rpc('kubeDelete', { kind: 'claim', name: `${ws}-home` }), { ok: true, deleted: true });
      assert.deepEqual(await rpc('kubeDelete', { kind: 'claim', name: `${ws}-home` }), { ok: true, deleted: false });
      assert.equal(rig.fake.deployments.has(ws), false);
    } finally {
      d.session.close(1000, 'test over');
      await rig.stop();
    }
  });

  test('a second client replaces the first', async () => {
    const a = await dialTunnel({ url, nodeId: node, privateKey: keys.privateKey, hello, ws: { headers: headers() } });
    const closed = new Promise<number>((resolve) => a.ws.on('close', (code) => resolve(code)));
    const b = await dialTunnel({ url, nodeId: node, privateKey: keys.privateKey, hello, ws: { headers: headers() } });
    try {
      assert.equal(await closed, 4409);
    } finally {
      b.session.close(1000, 'test over');
    }
  });
});
