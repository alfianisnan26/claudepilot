// PILOT-1144: GET /bridge and BridgeDO inside workerd. The key pair, node id and bearer token are made at run time by vitest.config.ts.

import { AppError } from '@isnanme/core';
import { MuxLimitError, MuxSession } from '@portal/connect-tunnel/mux';
import { acceptService } from '@portal/connect-tunnel/open';
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
import { ByteReader } from '../src/bridge/http1.js';
import { BRIDGE_LINK } from '../src/bridge/link.js';
import { locate } from '../src/locate.js';
import { cfMuxSocket } from './spike/wire.js';

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

/** The test's end of a live link as the agent: a client MuxSession whose `kube` service answers like the agent's proxy (PILOT-1170). */
function agentOn(link: Link, bearer: string): { session: MuxSession; seen: { namespace: unknown; path: string }[] } {
  const seen: { namespace: unknown; path: string }[] = [];
  const session = new MuxSession({
    role: 'client',
    socket: cfMuxSocket(link.ws),
    onStream: (stream) =>
      void (async () => {
        const req = await acceptService(stream, (r) =>
          r.service === 'kube' ? { ok: true } : { ok: false, code: 'service_unavailable', message: 'Only kube here.' },
        );
        if (!req) return;
        const r = new ByteReader(stream);
        const [line = '', ...rest] = (await r.until('\r\n\r\n')).toString('latin1').split('\r\n');
        const path = line.split(' ')[1] ?? '';
        seen.push({ namespace: (req.args as { namespace?: unknown } | undefined)?.namespace, path });
        const auth = rest.find((h) => h.toLowerCase().startsWith('authorization:'))?.slice('authorization:'.length).trim();
        const body =
          auth === `Bearer ${bearer}`
            ? JSON.stringify({ kind: 'PodList', items: [{ metadata: { name: 'ws-a' } }] })
            : JSON.stringify({ kind: 'Status', code: 401 });
        const status = auth === `Bearer ${bearer}` ? '200 OK' : '401 Unauthorized';
        stream.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      })(),
  });
  return { session, seen };
}

/** Runs `fn` on the object's in-memory session of `connId`. */
const onSession = <T>(connId: string, fn: (s: MuxSession | undefined, sessions: Map<string, unknown>) => T): Promise<T> =>
  runInDurableObject(stub(), (instance) => {
    const sessions = (instance as unknown as { sessions: Map<string, { session: MuxSession }> }).sessions;
    return fn(sessions.get(connId)?.session, sessions);
  });

const setAttachment = (connId: string, patch: Record<string, unknown>) =>
  runInDurableObject(stub(), (_i, state) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.connId === connId) ws.serializeAttachment({ ...att, ...patch });
    }
  });

describe('BridgeDO: the mux on the live link (PILOT-1170)', () => {
  it('a live link has a server MuxSession with the bridge’s stream cap; the 33rd stream is refused', async () => {
    const link = await connect();
    await onSession(link.connId, (s) => {
      expect(s?.role).toBe('server');
      expect(s?.limits.maxStreams).toBe(BRIDGE_LINK.maxStreams);
      expect(BRIDGE_LINK.maxQueuedBytes).toBe(BRIDGE_LINK.maxStreams * CONNECT_LIMITS.initialWindow);
      expect(BRIDGE_LINK.maxQueuedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      const opened = Array.from({ length: BRIDGE_LINK.maxStreams }, () => s!.open());
      expect(() => s!.open()).toThrow(MuxLimitError);
      for (const x of opened) x.destroy();
    });
  });

  it('GETs through the agent’s kube stream (RPC kube): bearer and namespace reach the agent; the attachment keeps the ids', async () => {
    const link = await connect();
    const bearer = crypto.randomUUID();
    const agent = agentOn(link, bearer);
    try {
      const ok = await stub().kube({ path: '/api/v1/namespaces/ns-a/pods', namespace: 'ns-a', bearer });
      expect(ok).toMatchObject({ ok: true, status: 200, contentType: 'application/json' });
      expect(JSON.parse((ok as { body: string }).body).items[0].metadata.name).toBe('ws-a');
      expect(agent.seen).toEqual([{ namespace: 'ns-a', path: '/api/v1/namespaces/ns-a/pods' }]);
      expect(await stub().kube({ path: '/api/v1/namespaces/ns-a/pods', namespace: 'ns-a', bearer: 'wrong' })).toMatchObject({
        ok: true,
        status: 401,
      });
      const att = await runInDurableObject(stub(), (_i, state) =>
        state.getWebSockets().map((ws) => ws.deserializeAttachment()).find((a) => a?.connId === link.connId),
      );
      expect(att).toMatchObject({ stage: 'live', ids: { nextId: 6, lastRemoteId: 0 }, streams: 0 });
      // the bearer is in no audit row
      expect(JSON.stringify(await stub().audit(500))).not.toContain(bearer);
    } finally {
      agent.session.destroy();
    }
  });

  it('refuses a malformed request, and answers agent_offline with no live link', async () => {
    expect(await stub().kube({ path: 'api/v1/pods', bearer: 'b' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await stub().kube({ path: '/a b', bearer: 'b' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await stub().kube({ path: '/api', namespace: 'Bad_NS', bearer: 'b' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await stub().kube({ path: '/api', bearer: 'with space' })).toMatchObject({ ok: false, code: 'bad_request' });
    const link = await connect();
    link.ws.close(1000, 'bye');
    await link.closed;
    await vi.waitFor(async () => expect((await stub().links()).live).toBe(0));
    expect(await stub().kube({ path: '/api', bearer: 'b' })).toMatchObject({ ok: false, code: 'agent_offline' });
  });

  it('a woken object (session gone from memory) with no stream open rebuilds it from the attachment’s ids and keeps the link', async () => {
    const link = await connect();
    await setAttachment(link.connId, { ids: { nextId: 10, lastRemoteId: 0 }, streams: 0 });
    await onSession(link.connId, (_s, sessions) => sessions.clear());
    link.ws.send(fromHex(CONNECT_TEST_VECTORS.frames.pingSynValue01020304));
    expect(hex((await link.next()) as ArrayBuffer)).toBe('000200020000000001020304');
    expect(await onSession(link.connId, (s) => s?.ids)).toEqual({ nextId: 10, lastRemoteId: 0 });
    expect(await stub().links()).toEqual({ live: 1, pending: 0 });
  });

  it('a woken object whose link had streams open closes it 1011 (the agent reconnects), audited', async () => {
    const link = await connect();
    await setAttachment(link.connId, { ids: { nextId: 4, lastRemoteId: 0 }, streams: 1 });
    await onSession(link.connId, (_s, sessions) => sessions.clear());
    link.ws.send(fromHex(CONNECT_TEST_VECTORS.frames.pingSynValue01020304));
    expect((await link.closed).code).toBe(1011);
    const lost = (await stub().audit()).find((r) => r.event === 'bridge.lost' && r.connId === link.connId);
    expect(lost?.detail).toBe('1 streams lost');
  });

  it('the alarm also rebuilds a session lost to hibernation, then pings', async () => {
    const link = await connect();
    await onSession(link.connId, (_s, sessions) => sessions.clear());
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(hex((await link.next()) as ArrayBuffer).slice(0, 16)).toBe('0002000100000000');
  });

  it('a frame of an unknown version is a protocol error: GO_AWAY(1), close 1002, audited', async () => {
    const link = await connect();
    const bad = new Uint8Array(12);
    bad[0] = 1;
    link.ws.send(bad.buffer);
    const goAway = (await link.next()) as ArrayBuffer;
    expect(hex(goAway)).toBe('000300000000000000000001');
    expect((await link.closed).code).toBe(1002);
    expect((await stub().audit()).some((r) => r.event === 'bridge.protocol' && r.connId === link.connId)).toBe(true);
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
