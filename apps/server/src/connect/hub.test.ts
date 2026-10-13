// T-AUTH, T-FAIL (hub part), T-SEC (hub part) (docs/prd/targets-connect.md §19.3): the handshake, one live connection per node, the control stream,
// rotation, revocation, pre-auth bounds and the failures of a dropped socket, over real WebSockets on loopback with the real tunnel library.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { CONNECT_LIMITS, CONNECT_REJECT_FATAL } from '@portal/contracts';
import { WebSocket } from 'ws';
import { ConnectError } from './seams.js';
import { helloFor, openCore, openHub, TIME_SCALE, withTimeout, type Core, type TestHub } from './testkit.js';
import { TunnelConnectError, TunnelRejected, acceptService, generateNodeKeyPair, readLine, signRekey, writeLine, type MuxStream } from './tunnel/index.js';

/** Provider-shaped text for the redaction checks, built at runtime so no token-shaped literal sits in the source. */
const ANTHROPIC_CANARY = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwx'].join('-');

async function rig(opts: Parameters<typeof openHub>[1] = {}, coreOpts: Parameters<typeof openCore>[0] = {}) {
  const core = await openCore(coreOpts);
  const h = await openHub(core, opts);
  return { core, h };
}
const rejected = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TunnelRejected) return `${e.code}${e.retryAfterS !== undefined ? `:${e.retryAfterS}` : ''}`;
    if (e instanceof TunnelConnectError) return `http:${e.status ?? 'none'}`;
    return `other:${(e as Error).message}`;
  }
  return 'connected';
};
const types = (core: Core, target: string) => core.events.list(target, { limit: 100 }).map((e) => e.type);

describe('the handshake', () => {
  test('a node connects: welcome, a live node within a moment, the audit row, the live topic fired', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const before = h.notified.n;
      const d = await h.dial(n.nodeId, n.keys);
      assert.equal(d.welcome.node, n.nodeId);
      assert.equal(d.welcome.target, 'lab');
      assert.equal(d.welcome.portalId, core.store.portalId);
      assert.equal(d.welcome.protocol, 1);
      assert.deepEqual(d.welcome.heartbeat, { pingEveryMs: 15_000, deadAfterMs: 45_000 });
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      const view = core.registry.view(core.registry.requireTarget('lab'));
      assert.equal(view.link, 'connected');
      assert.equal(view.nodes[0]!.link, 'connected');
      assert.equal(view.nodes[0]!.lastSeenIp, '198.51.100.20');
      assert.ok(types(core, 'lab').includes('node.connected'));
      assert.ok(h.notified.n > before, 'pages are told');
      assert.equal(h.hub.link({ id: n.nodeId, targetId: 'lab' }).connected(), true);
      const info = h.hub.link({ id: n.nodeId, targetId: 'lab' }).info()!;
      assert.equal(info.hello.hostname, 'lab-box');
      assert.equal(info.ip, '198.51.100.20');
    } finally {
      await h.close();
    }
  });

  test('link listeners hear connect and disconnect; the registry marks the node offline at once', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const link = h.hub.link({ id: n.nodeId, targetId: 'lab' });
      const heard: boolean[] = [];
      link.onChange((c) => heard.push(c));
      const returned: string[] = [];
      h.hub.onConnected((t) => returned.push(t));
      const d = await h.dial(n.nodeId, n.keys);
      assert.ok(await h.waitFor(() => link.connected()));
      d.session.close(1000, 'bye');
      assert.ok(await h.waitFor(() => !link.connected()));
      assert.deepEqual(heard, [true, false]);
      assert.deepEqual(returned, ['lab']);
      assert.equal(core.registry.view(core.registry.requireTarget('lab')).link, 'offline');
      assert.ok(types(core, 'lab').includes('node.disconnected'));
      assert.equal(h.hub.hasConnectedSinceStart(n.nodeId), true);
    } finally {
      await h.close();
    }
  });

  test('refusals carry their typed codes: unknown node, bad signature, revoked, target removed, protocol, hello', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      assert.equal(await rejected(h.dial('nd_000000000000', n.keys)), 'unknown_node');
      assert.equal(await rejected(h.dial('not a node id', n.keys)), 'unknown_node');
      assert.equal(await rejected(h.dial(n.nodeId, generateNodeKeyPair())), 'bad_signature');
      assert.equal(await rejected(h.dial(n.nodeId, n.keys, { hello: { protocol: 0 } })), 'upgrade_required');
      assert.equal(await rejected(h.dial(n.nodeId, n.keys, { hello: { protocol: 99 } })), 'bad_request');
      core.registry.revokeNode(n.nodeId, 'test', core.ctx);
      assert.equal(await rejected(h.dial(n.nodeId, n.keys)), 'revoked');
      const gone = h.enrollNode({ id: 'gone' });
      const ids = core.registry.forgetTarget('gone', core.ctx, { workspaces: 'none' });
      assert.deepEqual(ids, [gone.nodeId]);
      assert.equal(await rejected(h.dial(gone.nodeId, gone.keys)), 'target_removed');
      const failures = core.events.list('lab', { limit: 50 }).filter((e) => e.type === 'node.auth_failed');
      assert.deepEqual(failures.map((e) => e.detail.reason).sort(), ['bad_signature', 'bad_request', 'revoked', 'upgrade_required'].sort());
      assert.ok(failures.every((e) => e.ip === '198.51.100.20'));
      assert.ok(CONNECT_REJECT_FATAL.includes('unknown_node') && CONNECT_REJECT_FATAL.includes('revoked'));
    } finally {
      await h.close();
    }
  });

  test('a signature made for one challenge does not work on another connection (replay)', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      // capture a valid `auth` from a real handshake, then replay it on a new socket (its challenge differs)
      const first = h.raw();
      const auth = await new Promise<string>((resolve, reject) => {
        first.on('message', (data) => {
          const c = JSON.parse(String(data)) as { connId: string; nonce: string };
          void import('./tunnel/auth.js').then(({ signChallenge }) => {
            const msg = JSON.stringify({ t: 'auth', node: n.nodeId, sig: signChallenge(n.keys.privateKey, c.connId, c.nonce, n.nodeId), hello: helloFor('docker') });
            resolve(msg);
          }, reject);
        });
      });
      first.terminate();
      const second = h.raw();
      const reply = await new Promise<string>((resolve) => {
        second.once('message', () => {
          second.send(auth);
          second.once('message', (data) => resolve(String(data)));
        });
      });
      assert.match(reply, /"code":"bad_signature"/);
      second.terminate();
    } finally {
      await h.close();
    }
  });

  test('revoking a node closes its tunnel within 2 s, tells the agent why, and its key never authenticates again', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      assert.equal(c.config.t, 'config');
      const t0 = Date.now();
      core.registry.revokeNode(n.nodeId, 'lost the laptop', core.ctx);
      const told = c.next();
      await withTimeout(h.hub.disconnect(n.nodeId, 'revoked', 'This node was revoked.'), 'the disconnect');
      assert.deepEqual(await told, { t: 'revoked', reason: 'This node was revoked.' });
      await withTimeout(once(d.ws, 'close'), 'the agent socket to close');
      assert.ok(Date.now() - t0 < 2_000, `closed after ${Date.now() - t0} ms`);
      assert.equal(h.hub.isConnected(n.nodeId), false);
      assert.equal(await rejected(h.dial(n.nodeId, n.keys)), 'revoked');
    } finally {
      await h.close();
    }
  });

  test('a peer that ignores the close is cut off anyway at the grace', async () => {
    const { h, core } = await rig({ timing: { revokeGraceMs: 100 } });
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      d.ws.pause(); // the agent no longer reads: it will not answer the close handshake
      core.registry.revokeNode(n.nodeId, 'x', core.ctx);
      await withTimeout(h.hub.disconnect(n.nodeId, 'revoked'), 'the disconnect');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId), 1_500));
    } finally {
      await h.close();
    }
  });
});

describe('one live connection per node (FR15)', () => {
  test('a second connection for a healthy node is refused and audited; the first carries on', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const a = await h.dial(n.nodeId, n.keys);
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      assert.equal(await rejected(h.dial(n.nodeId, n.keys, { ip: '198.51.100.99' })), 'already_connected');
      const refused = core.events.list('lab', { limit: 50 }).find((e) => e.type === 'node.duplicate_refused')!;
      assert.equal(refused.ip, '198.51.100.99');
      assert.equal(a.session.closed, false);
      assert.equal(h.hub.isConnected(n.nodeId), true);
    } finally {
      await h.close();
    }
  });

  test('it takes over only once the first has been silent for the dead-after time', async () => {
    const { h } = await rig({ timing: { pingEveryMs: 60_000, deadAfterMs: 250 } });
    try {
      const n = h.enrollNode();
      // a connection that completes the handshake and then says nothing at all: it never answers a mux ping
      const quiet = new Promise<WebSocket>((resolve, reject) => {
        const ws = h.raw({ 'x-test-ip': '198.51.100.30' });
        ws.once('error', reject);
        ws.once('message', (data) => {
          void import('./tunnel/auth.js').then(({ signChallenge }) => {
            const c = JSON.parse(String(data)) as { connId: string; nonce: string };
            ws.send(JSON.stringify({ t: 'auth', node: n.nodeId, sig: signChallenge(n.keys.privateKey, c.connId, c.nonce, n.nodeId), hello: helloFor('docker') }));
            ws.once('message', () => resolve(ws)); // welcome
          });
        });
      });
      const old = await quiet;
      assert.equal(await rejected(h.dial(n.nodeId, n.keys)), 'already_connected', 'not silent long enough yet');
      await new Promise((r) => setTimeout(r, 300 * TIME_SCALE));
      const taken = await h.dial(n.nodeId, n.keys);
      assert.equal(taken.welcome.node, n.nodeId);
      await withTimeout(once(old, 'close'), 'the old socket to close');
      assert.equal(h.hub.isConnected(n.nodeId), true, 'the new one is the live one');
    } finally {
      await h.close();
    }
  });
});

describe('the control stream', () => {
  test('the portal sends config first; only a Kubernetes target gets a local bearer, new at every connect', async () => {
    const { core, h } = await rig();
    try {
      const dock = h.enrollNode();
      const kube = h.enrollNode({ id: 'kube', kind: 'kubernetes' });
      const d1 = await h.dial(dock.nodeId, dock.keys);
      const c1 = await h.control(d1);
      assert.deepEqual(Object.keys(c1.config).sort(), ['agentBuild', 'limits', 'portalId', 'statusEveryS', 't']);
      assert.deepEqual(c1.config.limits, { docker: 64, kube: 64, host: 32 });
      assert.equal(c1.config.portalId, core.store.portalId);
      const k1 = await h.dial(kube.nodeId, kube.keys, { kind: 'kubernetes' });
      const kubeCtl1 = await h.control(k1);
      const firstBearer = kubeCtl1.config.kubeLocalToken as string;
      assert.match(firstBearer, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(h.hub.link({ id: kube.nodeId, targetId: 'kube' }).kubeToken(), firstBearer);
      k1.session.close(1000, 'x');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(kube.nodeId)));
      assert.equal(h.hub.link({ id: kube.nodeId, targetId: 'kube' }).kubeToken(), null);
      const k2 = await h.dial(kube.nodeId, kube.keys, { kind: 'kubernetes' });
      const kubeCtl2 = await h.control(k2);
      assert.notEqual(kubeCtl2.config.kubeLocalToken, firstBearer);
    } finally {
      await h.close();
    }
  });

  test('the agent opens control and nothing else; a second control, or any other service, is bad_open', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      await h.control(d);
      for (const service of ['docker', 'host', 'kube', 'control']) {
        const s = d.session.open();
        s.on('error', () => undefined);
        await writeLine(s, { v: 1, service });
        const answer = JSON.parse((await readLine(s, 1000)) ?? '{}') as { ok: boolean; code?: string };
        assert.deepEqual([answer.ok, answer.code], [false, 'bad_open'], service);
        s.destroy();
      }
    } finally {
      await h.close();
    }
  });

  test('status is ingested clean: known fields only, text cleaned and redacted, numbers clamped, counted denials audited once per rule', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      await c.send({
        t: 'status',
        at: '2026-10-12T09:00:01.000Z',
        services: [{ name: 'docker', ok: false, error: `denied: ${ANTHROPIC_CANARY} and \u001b[31mred\u001b[0m`, version: '29.0.0', extra: 'dropped' }, { name: 'nonsense', ok: true }],
        usage: { cpuPercent: 12.5, memoryBytes: 1e30, cores: -3, memoryTotalBytes: 8e9 },
        docker: { engine: '29.0.0', apiVersion: '1.51', os: 'linux', arch: 'x86_64', ncpu: 8, memTotal: 1.2e10, containers: 3, running: 2, desktop: false, images: ['ghcr.io/x/y:latest'], evil: 'dropped' },
        denied: [{ rule: 'create.privileged', count: 2 }, { rule: 'path', count: 1 }, { rule: 'Not A Rule!', count: 5 }],
        streams: { docker: 1, kube: 0, host: 0 },
        surprise: { nested: true },
      });
      assert.ok(await h.waitFor(() => h.hub.state(n.nodeId)?.status !== null));
      const st = h.hub.state(n.nodeId)!.status!;
      assert.deepEqual(st.services.map((s) => s.name), ['docker']);
      assert.equal(st.services[0]!.error, 'denied: [redacted] and red');
      assert.equal(st.usage!.memoryBytes, 2 ** 50);
      assert.equal(st.usage!.cores, 0);
      assert.ok(!('evil' in (st.docker as object)));
      assert.deepEqual(st.denied, [{ rule: 'create.privileged', count: 2 }, { rule: 'path', count: 1 }]);
      const view = core.registry.view(core.registry.requireTarget('lab'));
      assert.equal(view.nodes[0]!.docker!.running, 2);
      assert.equal(view.problem, 'docker: denied: [redacted] and red');
      await c.send({ t: 'status', at: '2026-10-12T09:00:03.000Z', services: [{ name: 'docker', ok: true }], denied: [{ rule: 'path', count: 4 }] });
      await new Promise((r) => setTimeout(r, 50 * TIME_SCALE));
      const denied = core.events.list('lab', { limit: 50 }).filter((e) => e.type === 'policy.denied');
      assert.deepEqual(denied.map((e) => e.detail.rule).sort(), ['create.privileged', 'path'], 'one audit row per rule, not per status');
    } finally {
      await h.close();
    }
  });

  test('logs land in the audit as agent.log, at most twenty a minute, never a secret', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      for (let i = 0; i < 30; i++) await c.send({ t: 'log', level: 'warn', message: `line ${i} cpen_${'Z'.repeat(43)}`, at: '2026-10-12T09:00:00.000Z' });
      // The hub reads the thirty lines at its own pace (a loaded machine needs more than a fixed 100 ms: that failed the deploy gate with 10 instead of 20): wait for
      // the twenty, then give any twenty-first a moment to show up, which the limit must have refused.
      const agentLogs = () => core.events.list('lab', { limit: 100 }).filter((e) => e.type === 'agent.log');
      assert.ok(await h.waitFor(() => agentLogs().length >= 20, 10_000), 'twenty rows within the wait');
      await new Promise((r) => setTimeout(r, 150 * TIME_SCALE));
      const logs = agentLogs();
      assert.equal(logs.length, 20);
      assert.ok(logs.every((e) => !JSON.stringify(e).includes('ZZZZZ')));
      assert.ok(logs.every((e) => e.detail.level === 'warn'));
    } finally {
      await h.close();
    }
  });

  test('an unknown control message is ignored; a line that is not JSON closes the connection', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      await c.send({ t: 'from-the-future', x: 1 });
      assert.ok(await h.waitFor(() => h.logs.some((l) => /does not know \(from-the-future\)/.test(l)), 6_000), 'the unknown message is logged');
      assert.equal(d.session.closed, false);
      c.stream.write('{not json\n');
      await withTimeout(once(d.ws, 'close'), 'the agent socket to close');
      assert.equal(h.hub.isConnected(n.nodeId), false);
    } finally {
      await h.close();
    }
  });

  test('a control line over 256 KiB closes the connection', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      c.stream.write(`${'x'.repeat(CONNECT_LIMITS.maxControlLine + 100)}\n`);
      await withTimeout(once(d.ws, 'close'), 'the agent socket to close');
      assert.equal(h.hub.isConnected(n.nodeId), false);
    } finally {
      await h.close();
    }
  });

  test('a goodbye is remembered: the audit row says why the node left, and an uninstall is kept on the node', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      await c.send({ t: 'bye', reason: 'uninstall' });
      await new Promise((r) => setTimeout(r, 250 * TIME_SCALE));
      d.session.close(1000, 'bye');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
      const left = core.events.list('lab', { limit: 50 }).find((e) => e.type === 'node.disconnected')!;
      assert.equal(left.detail.bye, 'uninstall');
      assert.equal(core.registry.requireNode(n.nodeId).info.bye, 'uninstall');
    } finally {
      await h.close();
    }
  });
});

describe('streams to the agent (NodeLink.open)', () => {
  test('the portal opens docker, kube and host streams; the agent accepts them and the bytes flow both ways', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const seen: string[] = [];
      const d = await h.dial(n.nodeId, n.keys, {
        onStream: (s: MuxStream) =>
          void acceptService(s, (req) => (seen.push(req.service + (req.args ? `:${(req.args as { op: string }).op}` : '')), { ok: true })).then((req) => req && s.pipe(s)),
      });
      void d;
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      const link = h.hub.link({ id: n.nodeId, targetId: 'lab' });
      const docker = await link.open('docker');
      docker.write('GET /_ping HTTP/1.1\r\n\r\n');
      assert.equal((await withTimeout(once(docker, 'data'), 'data on the docker stream'))[0].toString(), 'GET /_ping HTTP/1.1\r\n\r\n');
      const host = await link.open('host', { op: 'exec', argv: ['echo'] });
      host.write('x');
      assert.equal((await withTimeout(once(host, 'data'), 'data on the host stream'))[0].toString(), 'x');
      await assert.rejects(link.open('host'), (e) => e instanceof ConnectError && e.code === 'bad_open');
      assert.deepEqual(seen, ['docker', 'host:exec']);
      docker.destroy();
      host.destroy();
    } finally {
      await h.close();
    }
  });

  test('an agent’s refusal arrives as a typed ConnectError; an offline node is agent_offline', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      await h.dial(n.nodeId, n.keys, { onStream: (s: MuxStream) => void acceptService(s, () => ({ ok: false, code: 'service_unavailable', message: 'no docker socket' })) });
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      const link = h.hub.link({ id: n.nodeId, targetId: 'lab' });
      await assert.rejects(link.open('docker'), (e) => e instanceof ConnectError && e.code === 'service_unavailable' && /no docker socket/.test(e.message));
      const other = h.enrollNode({ id: 'offline' });
      await assert.rejects(h.hub.link({ id: other.nodeId, targetId: 'offline' }).open('docker'), (e) => e instanceof ConnectError && e.code === 'agent_offline');
    } finally {
      await h.close();
    }
  });

  test('killing the socket mid-stream fails the stream with agent_offline and marks the node offline (T-FAIL)', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys, { onStream: (s: MuxStream) => void acceptService(s, () => ({ ok: true })).then((req) => req && s.resume()) });
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      const link = h.hub.link({ id: n.nodeId, targetId: 'lab' });
      const stream = await link.open('docker');
      const failed = new Promise<Error>((resolve) => stream.once('error', resolve));
      stream.write(Buffer.alloc(100_000));
      d.ws.terminate(); // the network drops
      const e = await failed;
      assert.ok(e instanceof ConnectError && e.code === 'agent_offline', String(e));
      assert.ok(await h.waitFor(() => !link.connected()));
      await assert.rejects(link.open('docker'), (err) => err instanceof ConnectError && err.code === 'agent_offline');
    } finally {
      await h.close();
    }
  });
});

describe('rotation (FR16)', () => {
  const rotate = async (h: TestHub, n: ReturnType<TestHub['enrollNode']>, d: Awaited<ReturnType<TestHub['dial']>>) => {
    const c = await h.control(d);
    await withTimeout(h.hub.rotate(n.nodeId), 'the rotate notice to be sent');
    const notice = await c.next();
    const next = generateNodeKeyPair();
    await c.send({ t: 'rekey', publicKey: next.publicKey, sig: signRekey(n.keys.privateKey, n.nodeId, next.publicKey) });
    return { c, notice, next, answer: await c.next() };
  };

  test('an admin asks, the agent proves the new key with the old one, the portal stores it; both keys work for ten minutes', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const { notice, next, answer } = await rotate(h, n, d);
      assert.equal(notice.action, 'rotate');
      assert.deepEqual(answer, { t: 'rekey-answer', ok: true, publicKey: next.publicKey });
      const node = core.registry.requireNode(n.nodeId);
      assert.equal(node.publicKey, next.publicKey);
      assert.equal(node.prevPublicKey, n.keys.publicKey);
      assert.notEqual(node.keyFingerprint, core.registry.requireNode(n.nodeId).prevPublicKey);
      assert.ok(types(core, 'lab').includes('node.rotated'));
      d.session.close(1000, 'x');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
      // a crash before the agent saved the new key: the old one still authenticates; the new one does too (and drops the old)
      const viaOld = await h.dial(n.nodeId, n.keys);
      viaOld.session.close(1000, 'x');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
      const viaNew = await h.dial(n.nodeId, next);
      assert.ok(viaNew);
      assert.equal(core.registry.requireNode(n.nodeId).prevPublicKey, null, 'a good authentication with the new key drops the old');
      viaNew.session.close(1000, 'x');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
      assert.equal(await rejected(h.dial(n.nodeId, n.keys)), 'bad_signature', 'the old key is dead once the new one was used');
    } finally {
      await h.close();
    }
  });

  test('the old key stops working ten minutes after a rotation nobody finished', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      await rotate(h, n, d);
      d.session.close(1000, 'x');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
      core.clock.now = new Date(core.clock.now.getTime() + CONNECT_LIMITS.rekeyGraceMs + 1_000);
      assert.equal(await rejected(h.dial(n.nodeId, n.keys)), 'bad_signature');
    } finally {
      await h.close();
    }
  });

  test('a rekey nobody asked for, a bad signature and a reused key are refused and change nothing; rotating an offline node is 409', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      const next = generateNodeKeyPair();
      await c.send({ t: 'rekey', publicKey: next.publicKey, sig: signRekey(n.keys.privateKey, n.nodeId, next.publicKey) });
      assert.deepEqual(await c.next(), { t: 'rekey-answer', ok: false, reason: 'No rotation was asked for.' });
      await withTimeout(h.hub.rotate(n.nodeId), 'the rotate notice to be sent');
      await c.next(); // the notice
      await c.send({ t: 'rekey', publicKey: next.publicKey, sig: signRekey(next.privateKey, n.nodeId, next.publicKey) });
      assert.deepEqual(await c.next(), { t: 'rekey-answer', ok: false, reason: 'The signature does not match the current key.' });
      await c.send({ t: 'rekey', publicKey: n.keys.publicKey, sig: signRekey(n.keys.privateKey, n.nodeId, n.keys.publicKey) });
      assert.deepEqual(await c.next(), { t: 'rekey-answer', ok: false, reason: 'The new key must be a new one.' });
      await c.send({ t: 'rekey', publicKey: 'short', sig: 'x' });
      assert.deepEqual(await c.next(), { t: 'rekey-answer', ok: false, reason: 'The new key is not valid.' });
      assert.equal(core.registry.requireNode(n.nodeId).publicKey, n.keys.publicKey);
      assert.equal(core.events.list('lab', { limit: 50 }).filter((e) => e.type === 'node.rotation_failed').length, 4);
      d.session.close(1000, 'x');
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
      await assert.rejects(h.hub.rotate(n.nodeId), (e) => e instanceof ConnectError && e.code === 'agent_offline');
    } finally {
      await h.close();
    }
  });
});

describe('a locked or read-only store (FR19)', () => {
  test('enrolled nodes still connect; their last_seen is not written', async () => {
    const { core, h } = await rig();
    try {
      const n = h.enrollNode();
      const before = core.registry.requireNode(n.nodeId).lastSeenAt;
      core.store.freeze('frozen-by-admin', 'test');
      const d = await h.dial(n.nodeId, n.keys);
      assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
      assert.equal(core.registry.requireNode(n.nodeId).lastSeenAt, before, 'no write while the store is frozen');
      assert.equal(core.registry.view(core.registry.requireTarget('lab')).link, 'connected', 'the live view does not need the database');
      d.session.close(1000, 'x');
    } finally {
      await h.close();
    }
  });
});
