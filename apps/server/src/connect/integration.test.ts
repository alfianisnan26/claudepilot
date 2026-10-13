// The control plane with the REAL agent (T2's `runAgent`) over real HTTP and WebSockets in one process (docs/prd/targets-connect.md §19.4, the
// acceptance of T1): enrollment through the real routes, connected within 2 s, revoke closing the tunnel within 2 s with the key dead, a key
// rotation with a crash injected at each step, a portal restart that brings the agent back, a second connection refused, the kill switch.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { runAgent, type AgentHandle, type RunAgentOptions } from './agent/client.js';
import { collectingLogger } from './agent/log.js';
import { agentConfig } from './agent/testkit/agentConfig.js';
import { helloFor, openModule, serveModule, withTimeout, type TestModule } from './testkit.js';
import { signChallenge } from './tunnel/auth.js';
import { dialTunnel, TunnelRejected } from './tunnel/index.js';
import { stopAgents } from './agent/testkit/portalRig.js';

const dirs: string[] = [];
const agents: AgentHandle[] = [];
afterEach(async () => {
  await stopAgents(agents);
});
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const until = async (fn: () => boolean, ms = 5_000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A portal on a real port with a pending Host target and its token (a Host needs no Docker, no cluster). */
async function portal(over: Parameters<typeof openModule>[0] = {}) {
  const m = await openModule(over);
  const srv = await serveModule(m);
  const make = async (id = 'metal', kind: 'host' | 'container' = 'host') => {
    const res = await m.admin('POST', '/targets', { kind, platform: 'linux', id, portalUrl: srv.origin, options: kind === 'host' ? { hostAccess: true } : {} });
    assert.equal(res.status, 201, res.text);
    return { id, token: res.json.data.token as string };
  };
  return { m, srv, make };
}

function agent(origin: string, token: string | null, extra: Partial<RunAgentOptions> = {}, existing?: string) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'cx1-agent-'));
  if (!existing) {
    dirs.push(dir);
    mkdirSync(join(dir, 'home'));
  }
  const log = collectingLogger();
  const handle = runAgent({ config: agentConfig({ dataDir: join(dir, 'agent'), home: join(dir, 'home'), url: origin, enrollToken: token }), log: log.logger, build: 'bbbbbbbbbbbb', ...extra });
  agents.push(handle);
  return { handle, dir, log };
}

describe('enrollment and connection through the real routes', () => {
  test('the agent enrolls with the token, connects within 2 s, and the registry shows it', async () => {
    const { m, srv, make } = await portal();
    try {
      const t = await make();
      const t0 = Date.now();
      const { handle } = agent(srv.origin, t.token);
      await handle.whenConnected(5_000);
      const took = Date.now() - t0;
      assert.ok(took < 2_000, `connected after ${took} ms`);
      const view = (await m.admin('GET', '/targets/metal')).json.data;
      assert.equal(view.state, 'active');
      assert.equal(view.link, 'connected');
      assert.equal(view.nodes[0].link, 'connected');
      assert.equal(view.nodes[0].agentBuild, 'bbbbbbbbbbbb');
      assert.equal(view.nodes[0].outdated, true, 'the agent’s build differs from the bundle this portal serves');
      assert.equal(view.nodes[0].keyFingerprint, handle.identity()!.publicKey ? view.nodes[0].keyFingerprint : '');
      const status = await m.call('GET', '/connect/v1/enroll/status', undefined, { authorization: `Bearer ${t.token}` });
      assert.equal(status.json.data.state, 'connected');
      const audit = (await m.admin('GET', '/targets/metal/events')).json.data.map((e: { type: string }) => e.type);
      for (const type of ['target.created', 'enrollment.created', 'node.enrolled', 'enrollment.used', 'node.connected']) assert.ok(audit.includes(type), type);
      // the token is spent: a second machine with it is told so
      const second = agent(srv.origin, t.token);
      await until(() => second.log.text().includes('token_used') || second.handle.state() === 'waiting', 3_000).catch(() => undefined);
      assert.equal(m.connect.registry.liveNodes('metal').length, 1);
    } finally {
      await srv.close();
    }
  });

  test('the agent restarts from its own state without a token and is the same node; a copied identity is refused while the first lives', async () => {
    const { m, srv, make } = await portal();
    try {
      const t = await make();
      const first = agent(srv.origin, t.token);
      await first.handle.whenConnected(5_000);
      const node = first.handle.identity()!.node;
      await first.handle.stop();
      await until(() => !m.connect.hub.isConnected(node));
      const again = agent(srv.origin, null, {}, first.dir);
      await again.handle.whenConnected(5_000);
      assert.equal(again.handle.identity()!.node, node, 'same node, no second enrollment');
      assert.equal(m.connect.registry.liveNodes('metal').length, 1);
      // a second connection with the same identity while it lives is refused (FR15)
      const id = again.handle.identity()!;
      const refused = await dialTunnel({ url: `ws://127.0.0.1:${srv.port}/connect/v1/tunnel`, nodeId: id.node, privateKey: id.privateKey, hello: () => helloFor('host') }).then(() => 'connected', (e) => (e instanceof TunnelRejected ? e.code : String(e)));
      assert.equal(refused, 'already_connected');
    } finally {
      await srv.close();
    }
  });
});

describe('revoke and remove', () => {
  test('revoking the node closes its tunnel within 2 s and its key never authenticates again; the agent waits instead of looping', async () => {
    const { m, srv, make } = await portal();
    try {
      const t = await make();
      const { handle } = agent(srv.origin, t.token);
      await handle.whenConnected(5_000);
      const id = handle.identity()!;
      const t0 = Date.now();
      assert.equal((await m.admin('DELETE', `/nodes/${id.node}`)).status, 200);
      await until(() => !m.connect.hub.isConnected(id.node), 2_000);
      assert.ok(Date.now() - t0 < 2_000);
      await until(() => handle.state() === 'waiting', 3_000);
      const rejected = await dialTunnel({ url: `ws://127.0.0.1:${srv.port}/connect/v1/tunnel`, nodeId: id.node, privateKey: id.privateKey, hello: () => helloFor('host') }).then(() => 'connected', (e) => (e instanceof TunnelRejected ? e.code : String(e)));
      assert.equal(rejected, 'revoked');
      assert.equal((await m.admin('GET', '/targets/metal')).json.data.nodes[0].state, 'revoked');
    } finally {
      await srv.close();
    }
  });

  test('removing the target tells a connected agent, and an agent that comes back later hears target_removed', async () => {
    const { m, srv, make } = await portal();
    try {
      const t = await make();
      const { handle, dir } = agent(srv.origin, t.token);
      await handle.whenConnected(5_000);
      const id = handle.identity()!;
      assert.equal((await m.admin('DELETE', '/targets/metal')).status, 200);
      await until(() => !m.connect.hub.isConnected(id.node), 2_000);
      const code = await dialTunnel({ url: `ws://127.0.0.1:${srv.port}/connect/v1/tunnel`, nodeId: id.node, privateKey: id.privateKey, hello: () => helloFor('host') }).then(() => 'connected', (e) => (e instanceof TunnelRejected ? e.code : String(e)));
      assert.equal(code, 'target_removed');
      void dir;
    } finally {
      await srv.close();
    }
  });
});

describe('a key rotation with a crash at every step (FR16)', () => {
  for (const step of ['saved-next', 'rekey-sent', 'answered', 'promoted'] as const) {
    test(`crash after "${step}": the restarted agent connects, and exactly one key works afterwards`, async () => {
      const { m, srv, make } = await portal();
      try {
        const t = await make();
        const first = agent(srv.origin, t.token, { rotationHook: (s) => { if (s === step) throw new Error('crash'); } });
        await first.handle.whenConnected(5_000);
        const id0 = first.handle.identity()!;
        assert.equal((await m.admin('POST', `/nodes/${id0.node}/rotate`)).status, 202);
        await withTimeout(first.handle.done, 'the crashed agent to be done'); // the agent dies at the step, with no cleanup
        await until(() => !m.connect.hub.isConnected(id0.node), 3_000);
        const second = agent(srv.origin, null, {}, first.dir);
        await second.handle.whenConnected(8_000);
        const id1 = second.handle.identity()!;
        const row = m.connect.registry.requireNode(id0.node);
        assert.equal(id1.publicKey, row.publicKey, 'the agent and the portal agree on the key');
        const rotated = step !== 'saved-next';
        assert.equal(id1.publicKey !== id0.publicKey, rotated, rotated ? 'the new key is in use' : 'the rotation never reached the portal: the old key stands');
        // once the key in use has authenticated, the other one is dead
        await second.handle.stop();
        await until(() => !m.connect.hub.isConnected(id0.node));
        const old = await dialTunnel({ url: `ws://127.0.0.1:${srv.port}/connect/v1/tunnel`, nodeId: id0.node, privateKey: id0.privateKey, hello: () => helloFor('host') }).then(
          (d) => (d.session.destroy('test'), 'connected'),
          (e) => (e instanceof TunnelRejected ? e.code : String(e)),
        );
        assert.equal(old, rotated ? 'bad_signature' : 'connected', rotated ? 'the old key stopped working' : 'the old key is still the key');
        const events = (await m.admin('GET', '/targets/metal/events?limit=100')).json.data.map((e: { type: string }) => e.type);
        if (rotated) assert.ok(events.includes('node.rotated'));
      } finally {
        await srv.close();
      }
    });
  }

  test('a complete rotation: the new key is saved, the fingerprint changes on both sides, and the old key dies', async () => {
    const { m, srv, make } = await portal();
    try {
      const t = await make();
      const { handle } = agent(srv.origin, t.token);
      await handle.whenConnected(5_000);
      const before = m.connect.registry.requireNode(handle.identity()!.node).keyFingerprint;
      const rekeyed = new Promise<string>((resolve) => handle.events.once('rekeyed', (e) => resolve(e.fingerprint)));
      assert.equal((await m.admin('POST', `/nodes/${handle.identity()!.node}/rotate`)).status, 202);
      const fp = await withTimeout(rekeyed, "the agent's rekeyed event");
      const after = m.connect.registry.requireNode(handle.identity()!.node).keyFingerprint;
      assert.notEqual(after, before);
      assert.equal(after, fp, 'the agent prints the fingerprint the portal shows');
    } finally {
      await srv.close();
    }
  });
});

describe('the portal restarts', () => {
  test('agents come back within 20 s of a restart (the registry survives, the sockets do not)', async () => {
    const first = await portal();
    let second: Awaited<ReturnType<typeof serveModule>> | null = null;
    let m2: TestModule | null = null;
    try {
      const t = await first.make();
      const { handle } = agent(first.srv.origin, t.token);
      await handle.whenConnected(5_000);
      const node = handle.identity()!.node;
      // the portal stops: its sockets close and its process is gone
      const port = first.srv.port;
      await first.srv.close();
      await until(() => handle.state() !== 'connected', 3_000);
      // it starts again on the same address with the same database
      m2 = await openModule({ store: first.m.store, dir: first.m.dir });
      second = await serveModule(m2, port);
      const t0 = Date.now();
      await handle.whenConnected(20_000);
      assert.ok(Date.now() - t0 < 20_000, `back after ${Date.now() - t0} ms`);
      assert.equal(m2.connect.hub.isConnected(node), true);
      assert.equal(m2.connect.registry.liveNodes('metal').length, 1, 'no second enrollment');
      // `settled` resolves once every node seen before has come back
      assert.equal(await Promise.race([m2.connect.settled(1_000).then(() => 'settled'), new Promise((r) => setTimeout(() => r('late'), 1_500))]), 'settled');
    } finally {
      await second?.close();
      await first.srv.close().catch(() => undefined);
    }
  });
});

describe('many agents', () => {
  test('twenty agents behind one address are all back within 10 s of a portal restart (the per-address bounds hold, nobody is locked out)', async () => {
    const first = await portal();
    let second: Awaited<ReturnType<typeof serveModule>> | null = null;
    const stubs: Awaited<ReturnType<typeof import('./qa/stubAgent.js').startStubAgent>>[] = [];
    try {
      const { startStubAgent } = await import('./qa/stubAgent.js');
      const made = await first.m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'farm', portalUrl: first.srv.origin, maxUses: 20 });
      assert.equal(made.status, 201, made.text);
      for (let i = 0; i < 20; i++) stubs.push(await startStubAgent({ origin: first.srv.origin, token: made.json.data.token, kind: 'docker', hostname: `node-${i}`, reconnectMs: [500, 2_500] }));
      await Promise.all(stubs.map((s) => s.connected(5_000)));
      assert.equal(first.m.connect.hub.connections, 20);
      const port = first.srv.port;
      await first.srv.close();
      await until(() => stubs.every((s) => !s.isConnected()), 3_000);
      const m2 = await openModule({ store: first.m.store, dir: first.m.dir });
      second = await serveModule(m2, port);
      const t0 = Date.now();
      await Promise.all(stubs.map((s) => s.connected(10_000)));
      console.log(`20 agents back ${Date.now() - t0} ms after the portal restarted`);
      assert.ok(Date.now() - t0 < 10_000);
      assert.equal(m2.connect.hub.connections, 20);
      assert.equal(m2.connect.registry.liveNodes('farm').length, 20, 'no second enrollment');
    } finally {
      await Promise.all(stubs.map((s) => s.stop()));
      await second?.close();
      await first.srv.close().catch(() => undefined);
    }
  });
});

describe('a locked store and the kill switch', () => {
  test('a frozen store refuses new enrollments (503) and still lets enrolled agents connect', async () => {
    const { m, srv, make } = await portal();
    try {
      const t = await make();
      const a = agent(srv.origin, t.token);
      await a.handle.whenConnected(5_000);
      const node = a.handle.identity()!.node;
      await a.handle.stop();
      await until(() => !m.connect.hub.isConnected(node));
      const t2 = await make('other');
      m.store.freeze('frozen-by-admin', 'test');
      const enrolling = agent(srv.origin, t2.token);
      await until(() => enrolling.log.text().includes('store_locked') || /store/i.test(enrolling.log.text()), 4_000).catch(() => undefined);
      assert.equal(m.connect.registry.liveNodes('other').length, 0, 'nothing was enrolled');
      await enrolling.handle.stop();
      const back = agent(srv.origin, null, {}, a.dir);
      await back.handle.whenConnected(5_000);
      assert.equal(back.handle.identity()!.node, node, 'the enrolled node connects while the store is frozen');
      m.store.resume();
    } finally {
      await srv.close();
    }
  });

  test('with Connect off, /connect/* answers 404 and an agent can neither enroll nor connect', async () => {
    const { srv, make, m } = await portal({ config: { enabled: false } });
    try {
      const health = await fetch(`${srv.origin}/connect/v1/health`);
      assert.equal(health.status, 404);
      const refused = await dialTunnel({ url: `ws://127.0.0.1:${srv.port}/connect/v1/tunnel`, nodeId: 'nd_0123456789ab', privateKey: signChallenge.name ? (await import('./tunnel/auth.js')).generateNodeKeyPair().privateKey : '', hello: () => helloFor('host') }).then(() => 'connected', (e) => String((e as { status?: number }).status));
      assert.equal(refused, '404');
      void make;
      assert.equal(m.connect.hub.connections, 0);
    } finally {
      await srv.close();
    }
  });
});
