// PILOT-1144: GET /bridge and BridgeDO inside workerd. The key pair, node id and bearer token are made at run time by vitest.config.ts.

import { AppError } from '@isnanme/core';
import {
  CONNECT_CLOSE,
  CONNECT_LIMITS,
  CONNECT_PROTOCOL,
  CONNECT_SUBPROTOCOL,
  CONNECT_TEST_VECTORS,
  connectB64u,
  connectSignChallenge,
  type ConnectAuth,
  type ConnectChallenge,
} from '@portal/contracts';
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { locate } from '../src/locate.js';

const URL_BRIDGE = 'https://core.test/bridge';
const stub = () => locate(env.BRIDGE, env.TEST_BRIDGE_CLUSTER);

interface Link {
  ws: WebSocket;
  /** The next message, in order. */
  next(): Promise<string | ArrayBuffer>;
  closed: Promise<{ code: number; reason: string }>;
}

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) {
    try {
      ws.close(1000, 'test over');
    } catch {
      // already closed
    }
  }
});

function upgradeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    upgrade: 'websocket',
    'sec-websocket-protocol': CONNECT_SUBPROTOCOL,
    'x-pilot-cluster': env.TEST_BRIDGE_CLUSTER,
    authorization: `Bearer ${env.TEST_BRIDGE_TOKEN}`,
    ...extra,
  };
}

async function dial(): Promise<Link> {
  const res = await SELF.fetch(URL_BRIDGE, { headers: upgradeHeaders() });
  expect(res.status).toBe(101);
  expect(res.headers.get('sec-websocket-protocol')).toBe(CONNECT_SUBPROTOCOL);
  const ws = res.webSocket!;
  open.push(ws);
  const queue: (string | ArrayBuffer)[] = [];
  const waiting: ((m: string | ArrayBuffer) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const w = waiting.shift();
    if (w) w(e.data as string | ArrayBuffer);
    else queue.push(e.data as string | ArrayBuffer);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  ws.accept();
  return { ws, closed, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiting.push(r))) };
}

async function challengeOf(link: Link): Promise<ConnectChallenge> {
  const m = await link.next();
  expect(typeof m).toBe('string');
  const c = JSON.parse(m as string) as ConnectChallenge;
  expect(c).toMatchObject({ t: 'challenge', v: 1, protocol: { min: 1, max: CONNECT_PROTOCOL } });
  return c;
}

const hello = () => ({
  agentVersion: 'test',
  agentBuild: 'test00000000',
  protocol: CONNECT_PROTOCOL,
  os: 'linux',
  arch: 'x64',
  hostname: 'cp-bridge-test',
  mode: 'kubernetes' as const,
  runtime: 'pod' as const,
  services: [{ name: 'kube' as const, ok: true }],
  clock: new Date().toISOString(),
  startedAt: new Date().toISOString(),
});

async function authFor(c: ConnectChallenge, opts: { key?: string; node?: string } = {}): Promise<ConnectAuth> {
  const node = opts.node ?? env.TEST_BRIDGE_NODE;
  return { t: 'auth', node, sig: await connectSignChallenge(opts.key ?? env.TEST_BRIDGE_PRIVATE_KEY, c.connId, c.nonce, node), hello: hello() };
}

/** A link through the whole handshake. */
async function connect(): Promise<Link & { connId: string }> {
  const link = await dial();
  const c = await challengeOf(link);
  link.ws.send(JSON.stringify(await authFor(c)));
  const w = JSON.parse((await link.next()) as string);
  expect(w).toMatchObject({ t: 'welcome', v: 1, node: env.TEST_BRIDGE_NODE, target: env.TEST_BRIDGE_CLUSTER, protocol: CONNECT_PROTOCOL });
  expect(w.heartbeat).toEqual({ pingEveryMs: CONNECT_LIMITS.pingEveryMs, deadAfterMs: CONNECT_LIMITS.deadAfterMs });
  return { ...link, connId: c.connId };
}

async function expectReject(link: Link, code: string, closeCode: number): Promise<string> {
  const m = JSON.parse((await link.next()) as string) as { t: string; code: string; message: string };
  expect(m.t).toBe('reject');
  expect(m.code).toBe(code);
  expect((await link.closed).code).toBe(closeCode);
  return m.message;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16))).buffer;

describe('GET /bridge: refused before the upgrade, always the plain 404', () => {
  const cases: [string, Record<string, string>][] = [
    ['no token', { authorization: '' }],
    ['a wrong token', { authorization: `Bearer ${env.TEST_BRIDGE_TOKEN}x` }],
    ['not a bearer', { authorization: `Basic ${env.TEST_BRIDGE_TOKEN}` }],
    ['an unknown cluster', { 'x-pilot-cluster': 'other-cluster' }],
    ['no cluster', { 'x-pilot-cluster': '' }],
    ['a browser origin', { origin: 'https://evil.test' }],
    ['no subprotocol', { 'sec-websocket-protocol': 'chat' }],
    ['no upgrade', { upgrade: '' }],
  ];
  for (const [what, extra] of cases) {
    it(what, async () => {
      const res = await SELF.fetch(URL_BRIDGE, { headers: upgradeHeaders(extra) });
      expect(res.status).toBe(404);
      expect(res.webSocket).toBeNull();
      expect(await res.json()).toEqual(new AppError('NOT_FOUND', 'Not found.').toJSON());
    });
  }
});

describe('BridgeDO: the Connect handshake', () => {
  it('a bridge with the right key completes it, and it is audited', async () => {
    const link = await connect();
    expect(await stub().links()).toEqual({ live: 1, pending: 0 });
    const audit = await stub().audit();
    expect(audit.some((r) => r.event === 'bridge.connected' && r.connId === link.connId)).toBe(true);
  });

  it('answers a mux ping with the same value, and the frame bytes are the contract’s', async () => {
    const link = await connect();
    link.ws.send(fromHex(CONNECT_TEST_VECTORS.frames.pingSynValue01020304));
    const ack = await link.next();
    expect(hex(ack as ArrayBuffer)).toBe('000200020000000001020304');
  });

  it('a forged signature (another key) is refused: bad_signature, 4401', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const forger = connectB64u(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer));
    const link = await dial();
    link.ws.send(JSON.stringify(await authFor(await challengeOf(link), { key: forger })));
    await expectReject(link, 'bad_signature', CONNECT_CLOSE.unauthorized);
  });

  it('another node id, even signed by the cluster’s key, is refused: unknown_node', async () => {
    const link = await dial();
    link.ws.send(JSON.stringify(await authFor(await challengeOf(link), { node: 'nd_someoneelse' })));
    await expectReject(link, 'unknown_node', CONNECT_CLOSE.unauthorized);
  });

  it('an expired challenge is refused: bad_request, 4408', async () => {
    const link = await dial();
    const c = await challengeOf(link);
    await runInDurableObject(stub(), (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment();
        if (att?.connId === c.connId) ws.serializeAttachment({ ...att, issuedAt: Date.now() - CONNECT_LIMITS.handshakeMs - 1 });
      }
    });
    link.ws.send(JSON.stringify(await authFor(c)));
    expect(await expectReject(link, 'bad_request', CONNECT_CLOSE.timeout)).toMatch(/expired/);
  });

  it('a replayed auth (captured from another link) is refused: bad_signature', async () => {
    const first = await dial();
    const captured = await authFor(await challengeOf(first));
    const second = await dial();
    await challengeOf(second);
    second.ws.send(JSON.stringify(captured));
    await expectReject(second, 'bad_signature', CONNECT_CLOSE.unauthorized);
  });

  it('a nonce already answered is refused, even with a good signature', async () => {
    const link = await dial();
    const c = await challengeOf(link);
    await runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec('INSERT INTO used_nonce (nonce, at) VALUES (?, ?)', c.nonce, Date.now());
    });
    link.ws.send(JSON.stringify(await authFor(c)));
    expect(await expectReject(link, 'bad_request', CONNECT_CLOSE.timeout)).toMatch(/already answered/);
  });

  it('a first message that is binary, not JSON or too large is refused: bad_request', async () => {
    for (const bad of [new Uint8Array([1, 2, 3]).buffer, 'not json', JSON.stringify({ t: 'auth', pad: 'x'.repeat(CONNECT_LIMITS.preAuth.firstMessageBytes) })]) {
      const link = await dial();
      await challengeOf(link);
      link.ws.send(bad);
      await expectReject(link, 'bad_request', CONNECT_CLOSE.timeout);
    }
  });

  it('a second link replaces the first: the old one is closed 4409 and the replacement is audited', async () => {
    const a = await connect();
    const b = await connect();
    expect((await a.closed).code).toBe(CONNECT_CLOSE.alreadyConnected);
    expect(await stub().links()).toEqual({ live: 1, pending: 0 });
    const audit = await stub().audit();
    const replaced = audit.find((r) => r.event === 'bridge.replaced' && r.connId === a.connId);
    expect(replaced?.detail).toBe(`by ${b.connId}`);
  });

  it('text after the handshake ends the link (1002)', async () => {
    const link = await connect();
    link.ws.send('{"t":"auth"}');
    expect((await link.closed).code).toBe(1002);
  });
});

describe('BridgeDO: liveness', () => {
  it('the alarm pings a live link, and ends one that stopped answering (4408, audited)', async () => {
    const link = await connect();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const ping = (await link.next()) as ArrayBuffer;
    expect(hex(ping).slice(0, 16)).toBe('0002000100000000'); // PING, SYN, stream 0
    await runInDurableObject(stub(), (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment();
        if (att?.connId === link.connId) ws.serializeAttachment({ ...att, lastReceived: Date.now() - CONNECT_LIMITS.deadAfterMs - 1_000 });
      }
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await link.closed).code).toBe(CONNECT_CLOSE.timeout);
    expect((await stub().audit()).some((r) => r.event === 'bridge.dead' && r.connId === link.connId)).toBe(true);
  });

  it('the alarm ends a handshake that never sent auth (bad_request, 4408)', async () => {
    const link = await dial();
    const c = await challengeOf(link);
    await runInDurableObject(stub(), (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment();
        if (att?.connId === c.connId) ws.serializeAttachment({ ...att, issuedAt: Date.now() - CONNECT_LIMITS.handshakeMs });
      }
    });
    await runDurableObjectAlarm(stub());
    expect(await expectReject(link, 'bad_request', CONNECT_CLOSE.timeout)).toMatch(/in time/);
  });
});

describe('redaction', () => {
  it('the bearer token appears in no log line and no audit row', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))),
    );
    try {
      await SELF.fetch(URL_BRIDGE, { headers: upgradeHeaders({ 'x-pilot-cluster': 'other-cluster' }) });
      await SELF.fetch(URL_BRIDGE, { headers: upgradeHeaders({ origin: 'https://evil.test' }) });
      await SELF.fetch(URL_BRIDGE, { headers: upgradeHeaders({ authorization: `Bearer ${env.TEST_BRIDGE_TOKEN}x` }) });
      const bad = await dial();
      bad.ws.send('not json');
      await bad.closed;
      await connect();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0); // the refusals were logged, so the check below looked at something
    for (const line of lines) expect(line).not.toContain(env.TEST_BRIDGE_TOKEN);
    expect(JSON.stringify(await stub().audit(500))).not.toContain(env.TEST_BRIDGE_TOKEN);
  });
});
