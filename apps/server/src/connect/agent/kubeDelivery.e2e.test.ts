// Delivery into a Kubernetes workspace through the REAL agent and hub (targets-connect FR44; foundation PRD §6.2): the agent's kube proxy
// checks every request against its policy (connect/agent/services/kube: exec of the `workspace` container only, commands without NUL and at
// most 64 KiB each, no root in any pod spec), and delivery has to pass it with nothing but `pods/exec`: the wrapper and byte counts on the
// command line, the content on stdin. The pod is the in-memory one (kubeTestkit.ts `memoryPod`) behind the fake API server; no cluster.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { KubeConfig } from '@kubernetes/client-node';
import { KubernetesRuntime } from '../../workspaces/kubernetes.js';
import { memoryPod } from '../../workspaces/kubeTestkit.js';
import { runAgent, type AgentHandle } from './client.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { FakeKube } from './testkit/fakeKube.js';
import { openPortal, type Portal } from './testkit/portalRig.js';

let portal: Portal;
let dir: string;
const agents: AgentHandle[] = [];

before(async () => {
  portal = await openPortal();
  dir = mkdtempSync(join(tmpdir(), 'kd-agent-'));
  mkdirSync(join(dir, 'home'));
});
after(async () => {
  for (const a of agents.splice(0)) await a.stop().catch(() => undefined);
  portal.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

it('put, run and read pass the agent’s kube policy and land in the pod, as root, with owners and modes', async () => {
  const fake = await FakeKube.start();
  const tokenFile = join(dir, 'sa-token');
  writeFileSync(tokenFile, `${fake.token}\n`);
  let listener: net.Server | null = null;
  try {
    const t = portal.target({ id: 'kd-kube', kind: 'kubernetes', options: { namespace: fake.namespace } });
    const h = runAgent({
      config: agentConfig({ home: join(dir, 'home'), url: portal.origin, mode: 'kubernetes', dataDir: join(dir, 'agent'), enrollToken: t.token, kubeNamespace: fake.namespace, identitySecret: 'claudepilot-agent-identity' }),
      log: collectingLogger().logger,
      build: 'ffffffffffff',
      serviceDeps: { kube: { server: fake.url, tokenFile, caFile: null } },
    });
    agents.push(h);
    await h.whenConnected();
    const link = portal.hub.hub.link({ id: h.identity()!.node, targetId: 'kd-kube' });
    listener = net.createServer((socket) => {
      link.open('kube').then(
        (stream) => {
          socket.pipe(stream);
          stream.pipe(socket);
          socket.on('close', () => stream.destroy());
          stream.on('close', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        },
        () => socket.destroy(),
      );
    });
    await new Promise<void>((r) => listener!.listen(0, '127.0.0.1', r));
    await until(() => link.kubeToken() !== null);
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 't', server: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`, skipTLSVerify: true }],
      users: [{ name: 'p', token: link.kubeToken()! }],
      contexts: [{ name: 't', cluster: 't', user: 'p' }],
      currentContext: 't',
    });
    const rt = new KubernetesRuntime({ namespace: fake.namespace, image: 'claudepilot-workspace:latest', storage: '1Gi' }, { kubeConfig: kc, manageNamespace: false, target: { id: 'kd-kube', label: 'Kube', where: 'fake' } });
    await rt.create({ name: 'kw' }, () => undefined);
    const pod = memoryPod(fake);

    // The engine's real folders: what the reconciler writes first in every workspace.
    await rt.delivery.put('kw', [
      { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
      { path: '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json', type: 'file', content: '{"env":{"MCP_TIMEOUT":"60000"}}', mode: 0o644, uid: 0, gid: 0 },
      { path: '/home/node/.claudepilot/outbox', type: 'directory', mode: 0o700, uid: 1000, gid: 1000 },
      { path: '/etc/claudepilot/big.bin', type: 'file', content: 'x'.repeat(256 * 1024), mode: 0o600, uid: 0, gid: 0 },
    ]);
    assert.deepEqual(pod.files.get('/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json'), { content: '{"env":{"MCP_TIMEOUT":"60000"}}', mode: 0o644, uid: 0, gid: 0 });
    assert.deepEqual(pod.dirs.get('/home/node/.claudepilot/outbox'), { mode: 0o700, uid: 1000, gid: 1000 });
    assert.equal(pod.files.get('/etc/claudepilot/big.bin')!.content.length, 256 * 1024, '256 KiB went through, on stdin (an argument may be 64 KiB at most)');
    assert.equal(await rt.delivery.read('kw', '/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json'), '{"env":{"MCP_TIMEOUT":"60000"}}');
    assert.equal(await rt.delivery.read('kw', '/etc/claudepilot/state.json'), null);
    const r = await rt.delivery.run('kw', 'while IFS= read -r f; do [ -r "$f" ] || printf \'%s\\n\' "$f"; done', { user: 'node', stdin: '/etc/claudepilot/big.bin\n/etc/claudepilot/nope\n' });
    assert.deepEqual(r, { code: 0, stdout: '/etc/claudepilot/nope\n', stderr: '' });
    assert.deepEqual(pod.execs.map((e) => [e.kind, e.user]), [['put', 'root'], ['read', 'root'], ['read', 'root'], ['run', 'node']]);

    // The API server only ever saw the exec of the workspace container, with the service account's token.
    const execs = fake.upgrades.map((u) => new URL(u.url, 'http://x'));
    assert.ok(execs.length >= 4 && execs.every((u) => u.searchParams.get('container') === 'workspace' && u.searchParams.getAll('command').every((c) => c.length < 4096)));
    assert.ok(fake.requests.every((q) => q.headers.authorization === `Bearer ${fake.token}`));
  } finally {
    listener?.close();
    await fake.stop();
  }
});
