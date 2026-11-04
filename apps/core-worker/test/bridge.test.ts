// PILOT-1144: GET /bridge and BridgeDO inside workerd. The key pair, node id and bearer token are made at run time by vitest.config.ts.

import { AppError } from '@isnanme/core';
import {
  CONNECT_CLOSE,
  CONNECT_LIMITS,
  CONNECT_PROTOCOL,
  CONNECT_SUBPROTOCOL,
  CONNECT_TEST_VECTORS,
  connectB64u,
  connectPublicKeyProblem,
  connectSignChallenge,
  type ConnectAuth,
  type ConnectChallenge,
} from '@portal/contracts';
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeAuthorize, bridgeRegistry } from '../src/bridge/registry.js';
import { bridgeUpgrade } from '../src/bridge/route.js';
import { BRIDGE_AUDIT_KEEP } from '../src/do/bridge.js';
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
  // Binary messages may arrive as a Blob: read them into an ArrayBuffer, in order.
  let chain = Promise.resolve();
  ws.addEventListener('message', (e) => {
    const data = e.data as string | ArrayBuffer | Blob;
    chain = chain.then(async () => {
      const m = data instanceof Blob ? await data.arrayBuffer() : data;
      const w = waiting.shift();
      if (w) w(m);
      else queue.push(m);
    });
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
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
  return {
    t: 'auth',
    node,
    sig: await connectSignChallenge(opts.key ?? env.TEST_BRIDGE_PRIVATE_KEY, c.connId, c.nonce, node),
    hello: hello(),
  };
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
    for (const bad of [
      new Uint8Array([1, 2, 3]).buffer,
      'not json',
      JSON.stringify({ t: 'auth', pad: 'x'.repeat(CONNECT_LIMITS.preAuth.firstMessageBytes) }),
    ]) {
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
      vi
        .spyOn(console, m)
        .mockImplementation(
          (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
        ),
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

// PILOT-1172 (review of PILOT-1144, minors 1 and 2): the registry is fail closed, and refuses the keys the portal refuses.
describe('BRIDGE_CLUSTERS: absent, not JSON or malformed refuses every dial', () => {
  const good = () => (JSON.parse(env.BRIDGE_CLUSTERS!) as Record<string, Record<string, string>>)[env.TEST_BRIDGE_CLUSTER]!;
  const bytes = (first: number[], fill = 0, last?: number) => {
    const b = new Uint8Array(32).fill(fill);
    first.forEach((v, i) => (b[i] = v));
    if (last !== undefined) b[31] = last;
    return connectB64u(b);
  };
  /** Keys that are 32 bytes of base64url but no usable Ed25519 key: small order (all zero, the identity) and off the curve (y = p). */
  const badKeys: [string, string][] = [
    ['the all-zero key (order 4)', bytes([])],
    ['the identity (y = 1)', bytes([1])],
    ['y = p, not canonical', bytes([0xed], 0xff, 0x7f)],
  ];
  const withEntry = (patch: Record<string, unknown>, name = env.TEST_BRIDGE_CLUSTER) => JSON.stringify({ [name]: { ...good(), ...patch } });
  const cases: [string, string | undefined][] = [
    ['absent', undefined],
    ['empty', ''],
    ['not JSON', '{"test-cluster":'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['an entry that is not an object', JSON.stringify({ [env.TEST_BRIDGE_CLUSTER]: 'x' })],
    ['a node id of the wrong shape', withEntry({ node: 'node-1' })],
    ['a 31-byte key', withEntry({ publicKey: connectB64u(new Uint8Array(31).fill(7)) })],
    ['a key that is not base64url', withEntry({ publicKey: `${'A'.repeat(42)}!` })],
    ['a token hash that is not 64 lowercase hex', withEntry({ tokenSha256: good().tokenSha256!.toUpperCase() })],
    ['a cluster name that is not a DNS label', withEntry({}, 'Test_Cluster')],
    ...badKeys.map(([what, key]): [string, string] => [`a key: ${what}`, withEntry({ publicKey: key })]),
  ];

  it('the real registry opens the test cluster (so the cases below fail on the registry, not on the dial)', async () => {
    expect(await bridgeAuthorize(env.BRIDGE_CLUSTERS, env.TEST_BRIDGE_CLUSTER, env.TEST_BRIDGE_TOKEN)).not.toBeNull();
    expect(connectPublicKeyProblem(good().publicKey)).toBeNull();
  });

  for (const [what, raw] of cases) {
    it(what, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(bridgeRegistry(raw).size).toBe(0);
        expect(await bridgeAuthorize(raw, env.TEST_BRIDGE_CLUSTER, env.TEST_BRIDGE_TOKEN)).toBeNull();
        const res = await bridgeUpgrade(new Request(URL_BRIDGE, { headers: upgradeHeaders() }), { ...env, BRIDGE_CLUSTERS: raw });
        expect(res.status).toBe(404);
        expect(res.webSocket).toBeNull();
        expect(await res.json()).toEqual(new AppError('NOT_FOUND', 'Not found.').toJSON());
      } finally {
        errors.mockRestore();
        warns.mockRestore();
      }
    });
  }

  it('a bad entry is dropped, never the good one beside it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const raw = JSON.stringify({ [env.TEST_BRIDGE_CLUSTER]: good(), 'other-cluster': { ...good(), publicKey: badKeys[0]![1] } });
      expect([...bridgeRegistry(raw).keys()]).toEqual([env.TEST_BRIDGE_CLUSTER]);
      expect(errors.mock.calls.flat().join(' ')).toMatch(/malformed and was dropped/);
    } finally {
      errors.mockRestore();
    }
  });

  it('the shared key check refuses every small-order point (libsodium list, both sign bits) inside workerd', () => {
    const hexKey = (h: string) => connectB64u(new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16))));
    for (const h of [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      '0000000000000000000000000000000000000000000000000000000000000080',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    ]) {
      expect(connectPublicKeyProblem(hexKey(h)), h).not.toBeNull();
    }
  });
});

// PILOT-1172 (review of PILOT-1144, nit 3): bridge_audit is pruned by the alarm, by age and by row count.
describe('BridgeDO: the audit is pruned', () => {
  it('the alarm drops rows older than the keep time and keeps the younger ones', async () => {
    await runInDurableObject(stub(), async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec('DELETE FROM bridge_audit');
      const now = Date.now();
      sql.exec("INSERT INTO bridge_audit (at, event) VALUES (?, 'test.old')", now - BRIDGE_AUDIT_KEEP.ms - 60_000);
      sql.exec("INSERT INTO bridge_audit (at, event) VALUES (?, 'test.young')", now - BRIDGE_AUDIT_KEEP.ms + 60_000);
      sql.exec("INSERT INTO bridge_audit (at, event) VALUES (?, 'test.now')", now);
      await state.storage.setAlarm(now);
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await stub().audit()).map((r) => r.event)).toEqual(['test.now', 'test.young']);
  });

  it('the alarm keeps at most the newest rows', async () => {
    const extra = 5;
    await runInDurableObject(stub(), async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec('DELETE FROM bridge_audit');
      const now = Date.now();
      sql.exec("INSERT INTO bridge_audit (at, event) VALUES (?, 'test.old')", now - BRIDGE_AUDIT_KEEP.ms - 60_000);
      sql.exec(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO bridge_audit (at, event, detail) SELECT ?, 'test.row', i FROM n",
        BRIDGE_AUDIT_KEEP.rows + extra,
        now,
      );
      await state.storage.setAlarm(now);
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    await runInDurableObject(stub(), (_i, state) => {
      const r = state.storage.sql
        .exec<{ n: number; old: number; first: number }>(
          "SELECT COUNT(*) AS n, SUM(event = 'test.old') AS old, MIN(CAST(detail AS INTEGER)) AS first FROM bridge_audit",
        )
        .one();
      expect(r.n).toBe(BRIDGE_AUDIT_KEEP.rows);
      expect(r.old).toBe(0);
      expect(r.first).toBe(extra + 1); // the oldest `extra` recent rows went, the newest `rows` stayed
    });
  });
});
