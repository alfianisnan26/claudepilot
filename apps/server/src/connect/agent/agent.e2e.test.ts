// C2's gate, "agent and hub in one process" (docs/prd/targets-connect.md §20), for the Docker and Kubernetes services: the agent enrolls and
// connects to the real hub with fake upstreams, and the portal's side uses the tunnel the way T3's runtimes will: a raw HTTP client over a `docker`
// stream (acceptance A10: every attack refused with its rule id, never seen by the daemon, counted and audited), the real DockerRuntime over the
// tunnel, and the real KubernetesRuntime over a loopback listener whose connections are `kube` streams (A6 in its fake form).
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { KubeConfig } from '@kubernetes/client-node';
import Docker from 'dockerode';
import { DockerRuntime } from '../../workspaces/docker.js';
import { KubernetesRuntime } from '../../workspaces/kubernetes.js';
import type { NodeLink } from '../seams.js';
import type { MuxStream } from '../tunnel/index.js';
import { runAgent, type AgentHandle, type RunAgentOptions } from './client.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { FakeDocker } from './testkit/fakeDocker.js';
import { FakeKube } from './testkit/fakeKube.js';
import { openPortal, type Portal } from './testkit/portalRig.js';

let portal: Portal;
let dir: string;
const agents: AgentHandle[] = [];
const IMAGE = 'claudepilot-workspace:latest';

before(async () => {
  portal = await openPortal();
});
after(() => portal.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx2-e2e-'));
  mkdirSync(join(dir, 'home'));
});
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const start = (over: Parameters<typeof agentConfig>[0], extra: Partial<RunAgentOptions> = {}) => {
  const log = collectingLogger();
  const h = runAgent({ config: agentConfig({ home: join(dir, 'home'), url: portal.origin, ...over }), log: log.logger, build: 'ffffffffffff', ...extra });
  agents.push(h);
  return { h, log };
};

/** What T3's TunnelAgent does: an http.Agent whose connection is a `docker` stream of the node's link. */
class TunnelAgent extends http.Agent {
  constructor(private readonly link: NodeLink) {
    super({ keepAlive: true, maxSockets: 16 });
  }
  override createConnection(_o: http.ClientRequestArgs, cb?: (err: Error | null, s: never) => void) {
    this.link.open('docker').then((s) => cb?.(null, s as never), (e: Error) => cb?.(e, undefined as never));
    return undefined;
  }
}

async function rawOverTunnel(link: NodeLink, bytes: string | Buffer, quietMs = 200): Promise<string> {
  const stream = (await link.open('docker')) as MuxStream;
  const parts: Buffer[] = [];
  stream.on('data', (c: Buffer) => parts.push(c));
  stream.write(bytes);
  let seen = -1;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, quietMs));
    const size = parts.reduce((n, p) => n + p.length, 0);
    if (size === seen || stream.destroyed) break;
    seen = size;
  }
  stream.destroy();
  return Buffer.concat(parts).toString('latin1');
}

describe('a docker agent against the real hub (A1 and A10 in their test form)', () => {
  it('enrolls, connects, lists containers over a docker stream, and every attack of A10 is refused with its rule, never seen by the daemon, counted and audited', async () => {
    const fake = await FakeDocker.start();
    try {
      const t = portal.target({ id: 'e2e-dock', kind: 'docker', options: {} });
      const { h } = start({ mode: 'docker', dataDir: join(dir, 'agent'), enrollToken: t.token, dockerSocket: fake.socketPath, images: [IMAGE] });
      await h.whenConnected();
      const id = h.identity()!;
      const link = portal.hub.hub.link({ id: id.node, targetId: 'e2e-dock' });
      await until(() => !!portal.hub.hub.connection(id.node)?.status?.docker);
      const conn = portal.hub.hub.connection(id.node)!;
      assert.equal(conn.status!.docker!.engine, '27.3.1');
      assert.deepEqual(conn.status!.docker!.images, [IMAGE]);
      assert.deepEqual(conn.hello.services.map((s) => [s.name, s.ok]), [['docker', true]]);

      // The portal's own use: a managed workspace container, listed over the tunnel.
      const portalId = portal.core.store.portalId!;
      const mine = fake.addContainer({ name: 'claudepilot-w1', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'w1', 'claudepilot.portal': portalId } });
      const agentOwn = fake.addContainer({ name: 'claudepilot-agent-e2e-dock', labels: { 'claudepilot.connect': 'agent' } });
      const agent = new TunnelAgent(link);
      const listed = await new Promise<string>((resolve, reject) => {
        http.get({ host: 'tunnel.invalid', port: 2375, path: '/containers/json?all=true', agent }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => resolve(Buffer.concat(parts).toString()));
        }).on('error', reject);
      });
      assert.deepEqual((JSON.parse(listed) as { Names: string[] }[]).flatMap((c) => c.Names), ['/claudepilot-w1'], 'the agent’s own container is not a workspace');
      agent.destroy();

      // The A10 list, over the tunnel as an attacker with a compromised portal would send it.
      const before = fake.requests.length;
      const body = (v: unknown) => JSON.stringify(v);
      const post = (path: string, payload: unknown) => `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body(payload))}\r\n\r\n${body(payload)}`;
      const labels = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'x', 'claudepilot.portal': portalId };
      const attacks: [string, string, string][] = [
        ['a privileged create', post('/containers/create?name=claudepilot-x', { Image: IMAGE, Labels: labels, HostConfig: { Privileged: true } }), 'create.privileged'],
        ['a bind of /', post('/containers/create?name=claudepilot-x', { Image: IMAGE, Labels: labels, HostConfig: { Binds: ['/:/host'] } }), 'create.bind'],
        ['an o=bind volume', post('/volumes/create', { Name: 'claudepilot-x-home', DriverOpts: { o: 'bind', device: '/', type: 'none' } }), 'volume.options'],
        ['deleting the agent’s own container', `DELETE /containers/${agentOwn.name}?force=1 HTTP/1.1\r\nHost: x\r\n\r\n`, 'unmanaged'],
        ['an exec in an unmanaged container', post(`/containers/${agentOwn.name}/exec`, { Cmd: ['sh'] }), 'unmanaged'],
        ['an absolute-form target', 'GET http://evil.example/containers/json HTTP/1.1\r\nHost: x\r\n\r\n', 'path'],
        ['//containers/json', 'GET //containers/json HTTP/1.1\r\nHost: x\r\n\r\n', 'path'],
      ];
      for (const [what, bytes, rule] of attacks) {
        const answer = await rawOverTunnel(link, bytes);
        assert.match(answer, /^HTTP\/1\.1 403 /, what);
        assert.match(answer, new RegExp(`denied by claudepilot policy \\(${rule.replace('.', '\\.')}\\)`), what);
      }
      // A second request smuggled behind an allowed one: the DELETE is just the archive's bytes.
      const hidden = `DELETE /containers/${mine.name}?force=1 HTTP/1.1\r\nHost: x\r\n\r\n`;
      await rawOverTunnel(link, `PUT /containers/${mine.name}/archive?path=/ HTTP/1.1\r\nHost: x\r\nContent-Length: ${hidden.length}\r\n\r\n${hidden}`);
      assert.ok(fake.containers.has(mine.id), 'the smuggled DELETE never happened');
      assert.equal(fake.requests.slice(before).filter((r) => r.method === 'DELETE' || r.method === 'POST').length, 0, 'the daemon saw none of the attacks');
      assert.ok(fake.containers.has(agentOwn.id));

      // Counted in the status the portal got, and audited with the rule.
      await until(() => portal.events('e2e-dock').filter((e) => e.type === 'policy.denied').length >= 6, 15_000);
      const rules = new Set(portal.events('e2e-dock').filter((e) => e.type === 'policy.denied').map((e) => String(e.detail.rule)));
      for (const rule of ['create.privileged', 'create.bind', 'volume.options', 'unmanaged', 'path']) assert.ok(rules.has(rule), `${rule} was audited: ${[...rules]}`);
    } finally {
      await fake.stop();
    }
  });

  it('the real DockerRuntime works through the real tunnel: create, list, exec with stdin, put and read, remove', async () => {
    const fake = await FakeDocker.start();
    try {
      const t = portal.target({ id: 'e2e-rt', kind: 'docker', options: {} });
      const { h } = start({ mode: 'docker', dataDir: join(dir, 'agent'), enrollToken: t.token, dockerSocket: fake.socketPath, images: [IMAGE] });
      await h.whenConnected();
      const link = portal.hub.hub.link({ id: h.identity()!.node, targetId: 'e2e-rt' });
      const agent = new TunnelAgent(link);
      const docker = new Docker({ protocol: 'http', host: 'tunnel.invalid', port: 2375, agent } as never);
      const rt = new DockerRuntime({ id: 'e2e-rt', label: 'E2E', socket: fake.socketPath }, IMAGE, '/nonexistent', () => portal.core.store.portalId, docker, { tunnel: { reach: async () => void (await docker.ping()), where: 'fake' } });
      await rt.check();
      await rt.create({ name: 'tw1', cpus: 1, memoryMb: 256 }, () => undefined);
      assert.deepEqual((await rt.list()).map((w) => [w.name, w.status]), [['tw1', 'running']]);
      fake.onExec = (_cmd, { stdin }) => ({ stdout: `got ${stdin.toString()}`, exitCode: 5 });
      const r = await rt.delivery!.run('tw1', 'cat', { stdin: 'hello', user: 'node' });
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 5, stdout: 'got hello' });
      await rt.delivery!.put('tw1', [{ path: '/home/node/note', type: 'file', content: 'kept', mode: 0o600, uid: 1000, gid: 1000 }]);
      assert.equal(await rt.delivery!.read('tw1', '/home/node/note'), 'kept');
      await rt.remove('tw1');
      assert.deepEqual(await rt.list(), []);
      assert.equal(h.connected(), true);
      agent.destroy();
    } finally {
      await fake.stop();
    }
  });

  it('a swarm node says which swarm it is in', async () => {
    const fake = await FakeDocker.start();
    fake.info.Swarm = { LocalNodeState: 'active', NodeID: 'swarmnode123', ControlAvailable: true };
    try {
      const t = portal.target({ id: 'e2e-swarm', kind: 'swarm', options: {} });
      const { h } = start({ mode: 'swarm', dataDir: join(dir, 'agent'), enrollToken: t.token, dockerSocket: fake.socketPath, images: [IMAGE], nodeName: 'manager-1' });
      await h.whenConnected();
      const conn = portal.hub.hub.connection(h.identity()!.node)!;
      assert.deepEqual(conn.hello.swarm, { nodeId: 'swarmnode123', role: 'manager' });
      await until(() => !!conn.status?.swarm);
      assert.deepEqual(conn.status!.swarm, { nodeId: 'swarmnode123', role: 'manager' });
    } finally {
      await fake.stop();
    }
  });

  it('says so when Docker goes away: the service turns not ok, and a docker stream is refused', async () => {
    const fake = await FakeDocker.start();
    const t = portal.target({ id: 'e2e-away', kind: 'docker', options: {} });
    const { h } = start({ mode: 'docker', dataDir: join(dir, 'agent'), enrollToken: t.token, dockerSocket: fake.socketPath, images: [IMAGE] });
    await h.whenConnected();
    const node = h.identity()!.node;
    const link = portal.hub.hub.link({ id: node, targetId: 'e2e-away' });
    await until(() => !!portal.hub.hub.connection(node)?.status);
    await fake.stop();
    // The first request on a stream accepted a moment ago finds out: 502, and the agent looks again at once.
    assert.match(await rawOverTunnel(link, 'GET /_ping HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1\.1 502 /);
    await assert.rejects(link.open('docker'), (e: { code?: string }) => e.code === 'upstream_unreachable');
    await until(() => portal.hub.hub.connection(node)?.status?.services[0]?.ok === false, 20_000);
    assert.match(portal.hub.hub.connection(node)!.status!.services[0]!.error ?? '', /Docker socket|not accepting|did not answer/);
  });
});

describe('a kubernetes agent against the real hub (A6 in its fake form)', () => {
  it('enrolls with the Secret’s token, keeps its identity in a Secret, and the real KubernetesRuntime lists, creates, execs and removes through the tunnel', async () => {
    const fake = await FakeKube.start();
    const tokenFile = join(dir, 'sa-token');
    writeFileSync(tokenFile, `${fake.token}\n`);
    const loopbacks: net.Server[] = [];
    try {
      const t = portal.target({ id: 'e2e-kube', kind: 'kubernetes', options: { namespace: fake.namespace } });
      const cfg = { mode: 'kubernetes' as const, dataDir: join(dir, 'agent-kube'), enrollToken: t.token, kubeNamespace: fake.namespace, identitySecret: 'claudepilot-agent-identity' };
      const kube = { server: fake.url, tokenFile, caFile: null };
      const first = start(cfg, { serviceDeps: { kube } });
      await first.h.whenConnected();
      const node = first.h.identity()!.node;
      assert.ok(fake.secrets.has('claudepilot-agent-identity'), 'the identity was written to its Secret');
      assert.equal(portal.hub.hub.connection(node)!.hello.runtime, 'pod');
      assert.deepEqual(portal.hub.hub.connection(node)!.hello.services.map((s) => [s.name, s.ok, s.version]), [['kube', true, 'v1.30.1+fake']]);

      // The portal's loopback listener: every accepted connection is a `kube` stream; the bearer is the one the hub gave this connection.
      const link = portal.hub.hub.link({ id: node, targetId: 'e2e-kube' });
      const listener = net.createServer((socket) => {
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
      loopbacks.push(listener);
      await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
      await until(() => link.kubeToken() !== null);
      const kc = new KubeConfig();
      kc.loadFromOptions({
        clusters: [{ name: 't', server: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`, skipTLSVerify: true }],
        users: [{ name: 'p', token: link.kubeToken()! }],
        contexts: [{ name: 't', cluster: 't', user: 'p', namespace: fake.namespace }],
        currentContext: 't',
      });
      const rt = new KubernetesRuntime({ namespace: fake.namespace, image: 'ghcr.io/example/claudepilot-workspace:latest', storage: '1Gi' }, { kubeConfig: kc, manageNamespace: false, target: { id: 'e2e-kube', label: 'Kube', where: 'fake' } });
      await rt.check();
      await rt.create({ name: 'kw1', cpus: 1, memoryMb: 512 }, () => undefined);
      assert.deepEqual((await rt.list()).map((w) => [w.name, w.status]), [['kw1', 'running']]);
      assert.equal(fake.seen('POST', '/api/v1/namespaces').length, 0, 'no namespace was created');
      fake.onExec = (io) => io.onStdin((d) => (io.stdout(`echo:${d}`), io.exit(3)));
      const session = await rt.exec('kw1', ['cat']);
      const out: Buffer[] = [];
      session.onData((d) => out.push(d));
      const exited = new Promise<number | null>((resolve) => session.onExit(resolve));
      session.write('hello');
      assert.equal(await exited, 3);
      assert.match(Buffer.concat(out).toString(), /echo:hello/);
      await rt.remove('kw1');
      assert.deepEqual(await rt.list(), []);
      // The API server only ever saw the service account's token.
      assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${fake.token}`));

      // A restart finds the identity Secret and does not enroll again, with the token still in its environment.
      await first.h.stop();
      await until(() => !portal.hub.hub.isConnected(node));
      const second = start(cfg, { serviceDeps: { kube } });
      await second.h.whenConnected();
      assert.equal(second.h.identity()!.node, node);
      assert.equal(portal.core.registry.liveNodes('e2e-kube').length, 1);
    } finally {
      for (const l of loopbacks) l.close();
      await fake.stop();
    }
  });
});
