// PILOT-1144: the real Connect client (`dialTunnel`, what connect/agent/client.ts and the stub agent use) completes the handshake against the
// Cloudflare Worker's /bridge (apps/core-worker), run locally by wrangler (workerd). It starts a workerd, so it runs only with
// CLAUDEPILOT_WORKER_TESTS=1 (like the Docker tests); the Worker's own suite (apps/core-worker/test) covers the refusals inside workerd.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONNECT_AGENT_VERSION, CONNECT_PROTOCOL, type ConnectAgentHello } from '@portal/contracts';
import { generateNodeKeyPair } from './auth.js';
import { dialTunnel, TunnelConnectError, TunnelRejected } from './ws.js';

const enabled = process.env.CLAUDEPILOT_WORKER_TESTS === '1';
const WORKER_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../core-worker/wrangler.jsonc');

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

  before(async () => {
    // A variable specifier: wrangler is a dependency of apps/core-worker, not of the server, and only this opt-in test loads it.
    const specifier = 'wrangler';
    const { unstable_startWorker } = (await import(specifier)) as { unstable_startWorker(opts: unknown): Promise<DevWorker> };
    worker = await unstable_startWorker({
      config: WORKER_CONFIG,
      bindings: {
        BRIDGE_CLUSTERS: {
          type: 'plain_text',
          value: JSON.stringify({ [cluster]: { node, publicKey: keys.publicKey, tokenSha256: createHash('sha256').update(token).digest('hex') } }),
        },
      },
      dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false },
    });
    await worker.ready;
    const u = await worker.url;
    url = `ws://${u.host}/bridge`;
  });

  after(async () => {
    await worker?.dispose();
  });

  const headers = (t = token) => ({ authorization: `Bearer ${t}`, 'x-pilot-cluster': cluster });

  test('the real client completes the handshake, and the Worker answers its mux pings', async () => {
    const d = await dialTunnel({ url, nodeId: node, privateKey: keys.privateKey, hello, ws: { headers: headers() }, limits: { pingEveryMs: 200 } });
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
