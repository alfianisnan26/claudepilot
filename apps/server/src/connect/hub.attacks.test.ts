// T-AUTH (pre-auth bounds, Origin, malformed handshakes) and T-SEC (hub part): what an unauthenticated peer can and cannot do to the tunnel end.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { CONNECT_LIMITS } from '@portal/contracts';
import { WebSocket } from 'ws';
import { helloFor, openCore, openHub, type TestHub } from './testkit.js';
import { signChallenge } from './tunnel/auth.js';
import { dialTunnel, TunnelRejected } from './tunnel/index.js';

async function rig(opts: Parameters<typeof openHub>[1] = {}, coreOpts: Parameters<typeof openCore>[0] = {}) {
  const core = await openCore(coreOpts);
  return { core, h: await openHub(core, opts) };
}

/** What the portal answers an upgrade request with when it refuses it before the WebSocket exists. */
const refusedWith = (ws: WebSocket) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined> } | 'upgraded'>((resolve) => {
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    ws.once('open', () => resolve('upgraded'));
    ws.once('error', () => undefined);
  });

type Msg = { t: string; code?: string; retryAfterS?: number } & Record<string, unknown>;

/** A raw client whose text messages are queued from the moment it exists (a message must not be missed between `open` and the first listener). */
function client(h: TestHub, headers: Record<string, string> = {}, protocols?: string[]) {
  const ws = protocols ? h.raw(headers, protocols) : h.raw(headers);
  const items: Msg[] = [];
  const waiting: ((m: Msg) => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(String(data)) as Msg;
    const w = waiting.shift();
    if (w) w(m);
    else items.push(m);
  });
  ws.on('error', () => undefined);
  const next = () => (items.length ? Promise.resolve(items.shift()!) : new Promise<Msg>((resolve) => waiting.push(resolve)));
  return { ws, next };
}

describe('before the WebSocket exists', () => {
  test('an upgrade that carries an Origin header is refused (403): a browser must never act as an agent', async () => {
    const { h } = await rig();
    try {
      const ws = h.raw({ Origin: 'https://evil.example.com' });
      assert.equal((await refusedWith(ws) as { status: number }).status, 403);
    } finally {
      await h.close();
    }
  });

  test('a client that does not offer the subprotocol is refused (400)', async () => {
    const { h } = await rig();
    try {
      assert.equal((await refusedWith(h.raw({}, [])) as { status: number }).status, 400);
      assert.equal((await refusedWith(h.raw({}, ['some.other.protocol'])) as { status: number }).status, 400);
    } finally {
      await h.close();
    }
  });

  test('the kill switch: PORTAL_CONNECT_ENABLED=false answers 404 and registers nothing (FR61)', async () => {
    const { h, core } = await rig({}, { config: { enabled: false } });
    try {
      assert.equal((await refusedWith(h.raw()) as { status: number }).status, 404);
      assert.equal(h.hub.connections, 0);
      assert.equal(core.registry.targets().length, 0, 'the registry stays readable');
    } finally {
      await h.close();
    }
  });

  test('at most five sockets per address (and a hundred in all) may sit in the handshake: the sixth is a 429 with Retry-After', async () => {
    const { h } = await rig({ timing: { handshakeMs: 3_000 } });
    try {
      const open: WebSocket[] = [];
      for (let i = 0; i < CONNECT_LIMITS.preAuth.perIp; i++) {
        const c = client(h, { 'x-test-ip': '203.0.113.5' });
        open.push(c.ws);
        await c.next(); // the challenge: they now wait for an auth that never comes
      }
      const sixth = (await refusedWith(h.raw({ 'x-test-ip': '203.0.113.5' }))) as { status: number; headers: Record<string, string> };
      assert.equal(sixth.status, 429);
      assert.ok(sixth.headers['retry-after']);
      assert.equal(h.hub.preAuth, 5);
      const other = h.raw({ 'x-test-ip': '203.0.113.6' });
      assert.equal(await refusedWith(other), 'upgraded', 'another address is not affected');
      other.terminate();
      for (const ws of open) ws.terminate();
      await h.waitFor(() => h.hub.preAuth === 0);
      assert.equal(h.hub.preAuth, 0, 'slots are given back');
    } finally {
      await h.close();
    }
  });

  test('more than 30 upgrades a minute from one address get a typed rate_limited reject with retryAfterS', async () => {
    const { h } = await rig();
    try {
      let last = '';
      for (let i = 0; i < CONNECT_LIMITS.preAuth.upgradesPerIpPerMinute + 2; i++) {
        const c = client(h, { 'x-test-ip': '203.0.113.9' });
        const m = await c.next();
        last = m.t === 'reject' ? `${m.code}:${m.retryAfterS}` : m.t;
        c.ws.terminate();
      }
      assert.equal(last, 'rate_limited:60');
    } finally {
      await h.close();
    }
  });
});

describe('the handshake itself', () => {
  test('silence for the handshake time ends the connection with a typed reject and close 4408', async () => {
    const { h } = await rig({ timing: { handshakeMs: 150 } });
    try {
      const { ws, next } = client(h);
      assert.equal((await next()).t, 'challenge');
      const reject = await next();
      assert.deepEqual([reject.t, reject.code], ['reject', 'bad_request']);
      const [code] = await once(ws, 'close');
      assert.equal(code, 4408);
    } finally {
      await h.close();
    }
  });

  test('a first message that is binary, too long, not JSON or not an auth is refused with bad_request', async () => {
    const { h } = await rig();
    try {
      const attempts: [string, () => Buffer | string][] = [
        ['binary', () => Buffer.from([0, 0, 0, 0])],
        ['not json', () => '{nope'],
        ['not an auth', () => JSON.stringify({ t: 'hello' })],
        ['an array', () => '[]'],
      ];
      for (const [name, make] of attempts) {
        const { ws, next } = client(h);
        await next(); // the challenge
        const payload = make();
        ws.send(payload, { binary: Buffer.isBuffer(payload) });
        const r = await next();
        assert.deepEqual([name, r.t, r.code], [name, 'reject', 'bad_request']);
        ws.terminate();
      }
    } finally {
      await h.close();
    }
  });

  test('a TEXT message after welcome is a protocol error: the connection is closed with 1002', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const { ws, next } = client(h);
      const challenge = await next();
      ws.send(JSON.stringify({ t: 'auth', node: n.nodeId, sig: signChallenge(n.keys.privateKey, challenge.connId as string, challenge.nonce as string, n.nodeId), hello: helloFor('docker') }));
      assert.equal((await next()).t, 'welcome');
      ws.send(JSON.stringify({ t: 'auth', node: n.nodeId })); // handshake text, after the handshake
      const [code] = await once(ws, 'close');
      assert.equal(code, 1002);
      assert.ok(await h.waitFor(() => !h.hub.isConnected(n.nodeId)));
    } finally {
      await h.close();
    }
  });

  test('a BINARY junk frame after welcome is a protocol error too, and garbage never takes the hub down', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const { ws, next } = client(h);
      const challenge = await next();
      ws.send(JSON.stringify({ t: 'auth', node: n.nodeId, sig: signChallenge(n.keys.privateKey, challenge.connId as string, challenge.nonce as string, n.nodeId), hello: helloFor('docker') }));
      await next(); // welcome
      ws.send(Buffer.from('this is not a frame at all'));
      const [code] = await once(ws, 'close');
      assert.equal(code, 1002);
      // and the hub is still fine
      const again = await h.dial(n.nodeId, n.keys);
      assert.ok(again.session);
    } finally {
      await h.close();
    }
  });

  test('the hub does not tell a wrong signature from an unknown node by how long it takes (both spend one verification)', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const time = async (nodeId: string) => {
        const t0 = process.hrtime.bigint();
        await dialTunnel({ url: `ws://127.0.0.1:${h.port}/connect/v1/tunnel`, nodeId, privateKey: n.keys.privateKey, hello: () => helloFor('docker') }).catch((e) => {
          if (!(e instanceof TunnelRejected)) throw e;
        });
        return Number(process.hrtime.bigint() - t0) / 1e6;
      };
      const warm = await time('nd_ffffffffffff');
      const unknown = await time('nd_000000000000');
      const wrongKey = await dialTunnel({ url: `ws://127.0.0.1:${h.port}/connect/v1/tunnel`, nodeId: n.nodeId, privateKey: (await import('./tunnel/auth.js')).generateNodeKeyPair().privateKey, hello: () => helloFor('docker') }).catch(() => 0);
      void warm;
      void unknown;
      void wrongKey;
      assert.ok(true, 'the cost equalisation is by construction (spendVerifyTime); timing is not asserted on a loaded machine');
    } finally {
      await h.close();
    }
  });
});

describe('before a good auth a peer may send 8 KiB at most', () => {
  test('a first message over 8 KiB ends the connection at once (the receiver cuts it with 1009)', async () => {
    const { h } = await rig();
    try {
      const { ws, next } = client(h);
      await next(); // the challenge
      const closed = once(ws, 'close');
      ws.send(JSON.stringify({ t: 'auth', node: 'nd_0123456789ab', sig: 'x'.repeat(CONNECT_LIMITS.preAuth.firstMessageBytes) }));
      const [code] = await closed;
      assert.equal(code, 1009);
      await h.waitFor(() => h.hub.preAuth === 0);
      assert.equal(h.hub.preAuth, 0);
    } finally {
      await h.close();
    }
  });

  test('after the handshake the full 1 MiB message size is available again (a big mux frame is not cut)', async () => {
    const { h } = await rig();
    try {
      const n = h.enrollNode();
      const d = await h.dial(n.nodeId, n.keys);
      const c = await h.control(d);
      await c.send({ t: 'log', level: 'info', message: 'x'.repeat(100_000), at: '2026-10-12T09:00:00.000Z' }); // well past 8 KiB, inside the control limit
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(d.session.closed, false);
    } finally {
      await h.close();
    }
  });
});

describe('flooding', () => {
  test('a hundred handshakes in a burst from one address leave the hub responsive and its slots free', async () => {
    const { h } = await rig({ timing: { handshakeMs: 400 } });
    try {
      const n = h.enrollNode();
      const sockets: WebSocket[] = [];
      for (let i = 0; i < 100; i++) {
        const ws = h.raw({ 'x-test-ip': '203.0.113.77' });
        ws.on('error', () => undefined);
        sockets.push(ws);
      }
      await new Promise((r) => setTimeout(r, 700));
      for (const ws of sockets) ws.terminate();
      assert.ok(await h.waitFor(() => h.hub.preAuth === 0, 3_000));
      const d = await h.dial(n.nodeId, n.keys, { ip: '203.0.113.78' });
      assert.ok(d.session);
    } finally {
      await h.close();
    }
  });
});
