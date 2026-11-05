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
  connectPublicKeyProblem,
  connectSignChallenge,
  type ConnectAuth,
  type ConnectChallenge,
} from '@portal/contracts';
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ByteReader } from '../src/bridge/http1.js';
import {
  BRIDGE_EXEC_HEADER,
  BRIDGE_EXEC_PATH,
  bridgeExecRequest,
  EXEC_LIMITS,
  EXEC_PROTOCOL_HEADER,
  readWsFrame,
  wsAccept,
  wsFrame,
  type KubeExecSpec,
} from '../src/bridge/kubeExec.js';
import { BRIDGE_LINK } from '../src/bridge/link.js';
import { bridgeAuthorize, bridgeRegistry } from '../src/bridge/registry.js';
import { bridgeUpgrade } from '../src/bridge/route.js';
import { BRIDGE_AUDIT_KEEP } from '../src/do/bridge.js';
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
        const auth = rest
          .find((h) => h.toLowerCase().startsWith('authorization:'))
          ?.slice('authorization:'.length)
          .trim();
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
        state
          .getWebSockets()
          .map((ws) => ws.deserializeAttachment())
          .find((a) => a?.connId === link.connId),
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

interface Seen {
  namespace: unknown;
  method: string;
  path: string;
  query: string;
  contentType: string | undefined;
  body: string;
}

/**
 * The test's end of a live link as the agent, with a small API server behind it (PILOT-1171): it records each request and keeps the
 * objects it was given, answering like the API server (201 or 409 AlreadyExists, a Scale, a Status on delete, 404 NotFound).
 */
function apiAgentOn(link: Link, bearer: string): { session: MuxSession; seen: Seen[] } {
  const seen: Seen[] = [];
  const store = new Map<string, Record<string, unknown>>();
  const status = (code: number, reason: string, message: string) => ({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    code,
    reason,
    message,
  });
  const answer = (q: Seen, auth: string | undefined): [number, unknown] => {
    if (auth !== `Bearer ${bearer}`) return [401, status(401, 'Unauthorized', 'Unauthorized')];
    if (q.path.endsWith('/version')) return [200, { gitVersion: 'v1.31.0' }];
    const scale = /\/deployments\/([^/]+)\/scale$/.exec(q.path);
    if (scale) {
      const d = store.get(q.path.slice(0, -'/scale'.length));
      if (!d) return [404, status(404, 'NotFound', `deployments.apps "${scale[1]}" not found`)];
      const replicas = (JSON.parse(q.body) as { spec: { replicas: number } }).spec.replicas;
      (d.spec as { replicas: number }).replicas = replicas;
      return [200, { kind: 'Scale', apiVersion: 'autoscaling/v1', spec: { replicas } }];
    }
    if (q.method === 'POST') {
      const o = JSON.parse(q.body) as { metadata: { name: string } };
      const key = `${q.path}/${o.metadata.name}`;
      if (store.has(key)) return [409, status(409, 'AlreadyExists', `"${o.metadata.name}" already exists`)];
      store.set(key, { ...o, metadata: { ...o.metadata, uid: crypto.randomUUID() } });
      return [201, store.get(key)];
    }
    if (q.method === 'DELETE') {
      if (!store.delete(q.path)) return [404, status(404, 'NotFound', 'not found')];
      return [200, { kind: 'Status', apiVersion: 'v1', status: 'Success' }];
    }
    if (q.path.startsWith('/apis/metrics.k8s.io/'))
      return [200, { kind: 'PodMetricsList', items: [{ metadata: { name: 'ws-0123456789ab-x' } }] }];
    return [200, { kind: 'List', items: [...store].filter(([k]) => k.startsWith(`${q.path}/`)).map(([, v]) => v) }];
  };
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
        const header = (name: string) =>
          rest
            .find((h) => h.toLowerCase().startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        const [method = '', target = ''] = line.split(' ');
        const [path = '', query = ''] = target.split('?');
        const length = Number(header('content-length') ?? 0);
        const body = length ? (await r.take(length)).toString('utf8') : '';
        const namespace = (req.args as { namespace?: unknown } | undefined)?.namespace;
        const q: Seen = { namespace, method, path, query, contentType: header('content-type'), body };
        seen.push(q);
        const [code, doc] = answer(q, header('authorization'));
        const out = JSON.stringify(doc);
        stream.write(`HTTP/1.1 ${code} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(out)}\r\n\r\n${out}`);
      })(),
  });
  return { session, seen };
}

describe('BridgeDO: the REST client by RPC (PILOT-1171)', () => {
  const NS = 'claudepilot-workspaces';
  const WS = 'ws-0123456789ab';
  const labels = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'demo' };

  it('creates, lists, scales and deletes a workspace’s claim and Deployment, each a checked request with the managed selector', async () => {
    const link = await connect();
    const bearer = crypto.randomUUID();
    const agent = apiAgentOn(link, bearer);
    const auth = { namespace: NS, bearer };
    try {
      const claim = await stub().kubeCreate({ ...auth, kind: 'claim', object: { metadata: { name: `${WS}-home`, labels }, spec: {} } });
      expect(claim).toMatchObject({ ok: true, object: { kind: 'PersistentVolumeClaim', metadata: { name: `${WS}-home`, namespace: NS } } });
      const deployment = { metadata: { name: WS, labels }, spec: { replicas: 1 } };
      expect(await stub().kubeCreate({ ...auth, kind: 'deployment', object: deployment })).toMatchObject({ ok: true });
      expect(await stub().kubeCreate({ ...auth, kind: 'deployment', object: deployment })).toMatchObject({
        ok: false,
        code: 'kube_status',
        status: 409,
        reason: 'AlreadyExists',
      });

      const list = await stub().kubeList({ ...auth, kind: 'deployments', workspace: 'demo' });
      expect(list).toMatchObject({ ok: true, items: [{ metadata: { name: WS } }] });
      expect(await stub().kubeScale({ ...auth, name: WS, replicas: 0 })).toEqual({ ok: true, replicas: 0 });
      expect(await stub().kubeScale({ ...auth, name: 'ws-ffffffffffff', replicas: 1 })).toMatchObject({
        ok: false,
        status: 404,
        reason: 'NotFound',
      });
      expect(await stub().kubeMetrics(auth)).toMatchObject({ ok: true, items: [{ metadata: { name: 'ws-0123456789ab-x' } }] });
      expect(await stub().kubeDelete({ ...auth, kind: 'deployment', name: WS })).toEqual({ ok: true, deleted: true });
      expect(await stub().kubeDelete({ ...auth, kind: 'deployment', name: WS })).toEqual({ ok: true, deleted: false });
      expect(await stub().kubeDelete({ ...auth, kind: 'claim', name: `${WS}-home` })).toEqual({ ok: true, deleted: true });
      expect(await stub().kubeList({ ...auth, kind: 'claims' })).toEqual({ ok: true, items: [] });

      const by = (m: string) => agent.seen.filter((s) => s.method === m);
      expect(new Set(agent.seen.map((s) => s.namespace))).toEqual(new Set([NS]));
      expect(by('POST').map((s) => [s.path, s.contentType])).toEqual([
        [`/api/v1/namespaces/${NS}/persistentvolumeclaims`, 'application/json'],
        [`/apis/apps/v1/namespaces/${NS}/deployments`, 'application/json'],
        [`/apis/apps/v1/namespaces/${NS}/deployments`, 'application/json'],
      ]);
      expect(JSON.parse(by('POST')[1]!.body)).toMatchObject({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace: NS } });
      for (const s of by('GET')) expect(new URLSearchParams(s.query).get('labelSelector'), s.path).toMatch(/^claudepilot\.managed=true/);
      expect(by('GET')[0]!.query).toBe('labelSelector=claudepilot.managed%3Dtrue%2Cclaudepilot.workspace%3Ddemo');
      expect(by('PUT')[0]).toMatchObject({
        path: `/apis/apps/v1/namespaces/${NS}/deployments/${WS}/scale`,
        contentType: 'application/json',
      });
      expect(by('DELETE').map((s) => s.query)).toEqual(['propagationPolicy=Foreground', 'propagationPolicy=Foreground', '']);
      expect(JSON.stringify(await stub().audit(500))).not.toContain(bearer);
    } finally {
      agent.session.destroy();
    }
  });

  it('refuses a bad call before anything reaches the agent', async () => {
    const link = await connect();
    const bearer = crypto.randomUUID();
    const agent = apiAgentOn(link, bearer);
    const auth = { namespace: NS, bearer };
    try {
      const refusals = [
        stub().kubeList({ ...auth, kind: 'secrets' as never }),
        stub().kubeList({ ...auth, kind: 'pods', workspace: 'a,claudepilot.managed!=true' }),
        stub().kubeList({ namespace: '..', bearer, kind: 'pods' }),
        stub().kubeList({ namespace: NS, bearer: 'with space', kind: 'pods' }),
        stub().kubeCreate({ ...auth, kind: 'deployment', object: { metadata: { name: 'ws-a/../x', labels } } }),
        stub().kubeCreate({ ...auth, kind: 'deployment', object: { metadata: { name: WS, namespace: 'kube-system', labels } } }),
        stub().kubeCreate({ ...auth, kind: 'deployment', object: { metadata: { name: WS, labels: {} } } }),
        stub().kubeScale({ ...auth, name: WS, replicas: 2 }),
        stub().kubeScale({ ...auth, name: '%2e%2e', replicas: 0 }),
        stub().kubeDelete({ ...auth, kind: 'claim', name: '../../secrets/x' }),
      ];
      for (const r of await Promise.all(refusals)) expect(r).toMatchObject({ ok: false, code: 'bad_request' });
      expect(agent.seen).toEqual([]);
    } finally {
      agent.session.destroy();
    }
  });

  it('kube() refuses `..`, percent-encoded dots and a query string in the path (T-3737 comment 59417); a plain path goes through', async () => {
    const link = await connect();
    const bearer = crypto.randomUUID();
    const agent = apiAgentOn(link, bearer);
    try {
      for (const path of [
        `/api/v1/namespaces/${NS}/../../secrets`,
        '/api/v1/namespaces/x/pods/..',
        '/api/%2e%2e/v1/secrets',
        '/api/%2E%2E/v1/secrets',
        `/api/v1/namespaces/${NS}/pods%2f..%2fsecrets`,
        `/api/v1/namespaces/${NS}/pods?watch=true`,
        `/api/v1/namespaces/${NS}/pods?labelSelector=`,
        '/version#x',
        '//version',
      ])
        expect(await stub().kube({ path, namespace: NS, bearer }), path).toMatchObject({ ok: false, code: 'bad_request' });
      expect(agent.seen).toEqual([]);
      expect(await stub().kube({ path: '/version', namespace: NS, bearer })).toMatchObject({ ok: true, status: 200 });
      expect(agent.seen.map((s) => [s.method, s.path, s.query])).toEqual([['GET', '/version', '']]);
    } finally {
      agent.session.destroy();
    }
  });
});

interface ExecSeen {
  namespace: unknown;
  target: string;
  headers: Map<string, string>;
  /** Each message from the bridge after the 101 (channel byte first), and `close <code>` for its close frame. */
  messages: (number[] | string)[];
}

/**
 * The test's end of a live link as the agent and the API server's exec (PILOT-1171 slice 2): it answers the upgrade with the first offered
 * protocol it `speaks`, then echoes stdin upper-cased on stdout, records resizes, and on `exit` or a closed stdin sends the status and a
 * close frame. `answer` replaces the 101 (a refusal, or a broken upgrade).
 */
function execAgentOn(
  link: Link,
  opts: { speaks?: string[]; answer?: (key: string) => Promise<string> | string } = {},
): { session: MuxSession; seen: ExecSeen[] } {
  const speaks = opts.speaks ?? ['v5.channel.k8s.io', 'v4.channel.k8s.io'];
  const seen: ExecSeen[] = [];
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
        const headers = new Map(rest.map((h) => [h.slice(0, h.indexOf(':')).toLowerCase(), h.slice(h.indexOf(':') + 1).trim()]));
        const namespace = (req.args as { namespace?: unknown } | undefined)?.namespace;
        const one: ExecSeen = { namespace, target: line.split(' ')[1] ?? '', headers, messages: [] };
        seen.push(one);
        const key = headers.get('sec-websocket-key') ?? '';
        if (opts.answer) return void stream.write(await opts.answer(key));
        const offered = (headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
        const protocol = offered.find((p) => speaks.includes(p))!;
        stream.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${await wsAccept(key)}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
        );
        const send = (ch: number, s: string) => stream.write(wsFrame(2, new Uint8Array([ch, ...new TextEncoder().encode(s)]), false));
        const end = () => {
          send(3, '{"metadata":{},"status":"Success"}');
          stream.write(wsFrame(8, new Uint8Array([0x03, 0xe8]), false));
        };
        // The API server opens each output channel with an empty message (the bridge drops them).
        stream.write(wsFrame(2, new Uint8Array([1]), false));
        try {
          for (;;) {
            const f = await readWsFrame(r);
            if (!f.masked) throw new Error('an unmasked client frame');
            if (f.opcode === 8) {
              one.messages.push(`close ${f.payload.readUInt16BE(0)}`);
              return void stream.end();
            }
            const msg = [...f.payload];
            one.messages.push(msg);
            const text = new TextDecoder().decode(new Uint8Array(msg.slice(1)));
            if (msg[0] === 0 && text === 'exit') end();
            else if (msg[0] === 0) send(1, text.toUpperCase());
            else if (msg[0] === 255) end();
          }
        } catch {
          // the stream ended
        }
      })(),
  });
  return { session, seen };
}

interface ExecCaller {
  res: Response;
  ws: WebSocket;
  next(): Promise<[number, string]>;
  closed: Promise<{ code: number; reason: string }>;
}

/** The caller's side: the exec's 101 and its WebSocket, messages decoded as [channel, text]. */
async function execCall(spec: KubeExecSpec): Promise<ExecCaller> {
  const res = await stub().fetch(bridgeExecRequest(spec));
  if (res.status !== 101) throw new Error(`exec answered ${res.status}: ${await res.text()}`);
  const ws = res.webSocket!;
  open.push(ws);
  const queue: [number, string][] = [];
  const waiting: ((m: [number, string]) => void)[] = [];
  let chain = Promise.resolve();
  ws.addEventListener('message', (e) => {
    const data = e.data as string | ArrayBuffer | Blob;
    chain = chain.then(async () => {
      const b = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : typeof data === 'string' ? new ArrayBuffer(0) : data);
      const m: [number, string] = [b[0] ?? -1, new TextDecoder().decode(b.subarray(1))];
      const w = waiting.shift();
      if (w) w(m);
      else queue.push(m);
    });
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
  ws.accept();
  return { res, ws, closed, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiting.push(r))) };
}

const frame = (ch: number, s: string) => new Uint8Array([ch, ...new TextEncoder().encode(s)]);

describe('BridgeDO: exec in a workspace pod (PILOT-1171 slice 2)', () => {
  const NS = 'claudepilot-workspaces';
  const POD = 'ws-0123456789ab-5d8f7c9b4-x2x7q';
  const execSpec = (bearer: string, over: Partial<KubeExecSpec> = {}): KubeExecSpec => ({
    namespace: NS,
    bearer,
    pod: POD,
    command: ['sh', '-c', 'cat'],
    ...over,
  });

  it('v5: stdin echoes, a resize is checked and passed, a closed stdin ends it with the status and a 1000 close', async () => {
    const link = await connect();
    const bearer = crypto.randomUUID();
    const agent = execAgentOn(link);
    try {
      const c = await execCall(execSpec(bearer));
      expect(c.res.headers.get(EXEC_PROTOCOL_HEADER)).toBe('v5.channel.k8s.io');
      c.ws.send(frame(0, 'hi\n'));
      expect(await c.next()).toEqual([1, 'HI\n']);
      c.ws.send(frame(4, '{"Width":120,"Height":40,"Other":1}'));
      c.ws.send(new Uint8Array([255, 0]));
      expect(await c.next()).toEqual([3, '{"metadata":{},"status":"Success"}']);
      expect((await c.closed).code).toBe(1000);

      const [one] = agent.seen;
      expect(one?.namespace).toBe(NS);
      const [path, query] = (one?.target ?? '').split('?');
      expect(path).toBe(`/api/v1/namespaces/${NS}/pods/${POD}/exec`);
      expect(query).toBe('container=workspace&command=sh&command=-c&command=cat&stdin=true&stdout=true&stderr=true&tty=false');
      expect(one?.headers.get('authorization')).toBe(`Bearer ${bearer}`);
      expect(one?.headers.get('sec-websocket-protocol')).toBe('v5.channel.k8s.io, v4.channel.k8s.io');
      expect([one?.headers.get('upgrade'), one?.headers.get('connection'), one?.headers.get('sec-websocket-version')]).toEqual([
        'websocket',
        'Upgrade',
        '13',
      ]);
      expect(one?.messages.slice(0, 3)).toEqual([[...frame(0, 'hi\n')], [...frame(4, '{"Width":120,"Height":40}')], [255, 0]]);
      const audit = await stub().audit(500);
      expect(JSON.stringify(audit)).not.toContain(bearer);
      expect(audit.find((r) => r.event === 'bridge.exec')?.detail).toBe(`${POD} 3 args v5.channel.k8s.io`);
    } finally {
      agent.session.destroy();
    }
  });

  it('v4 fallback: an API server without v5 is answered on v4, and a stdin close (v5 only) is not sent', async () => {
    const link = await connect();
    const agent = execAgentOn(link, { speaks: ['v4.channel.k8s.io'] });
    try {
      const c = await execCall(execSpec(crypto.randomUUID(), { tty: true }));
      expect(c.res.headers.get(EXEC_PROTOCOL_HEADER)).toBe('v4.channel.k8s.io');
      c.ws.send(new Uint8Array([255, 0]));
      c.ws.send(frame(4, '{"Width":80,"Height":24}'));
      c.ws.send(frame(0, 'exit'));
      expect(await c.next()).toEqual([3, '{"metadata":{},"status":"Success"}']);
      expect((await c.closed).code).toBe(1000);
      expect(agent.seen[0]?.messages).toEqual([[...frame(4, '{"Width":80,"Height":24}')], [...frame(0, 'exit')]]);
      expect(new URLSearchParams(agent.seen[0]?.target.split('?')[1]).get('tty')).toBe('true');
    } finally {
      agent.session.destroy();
    }
  });

  it('the caller closing sends the pod a close frame, and the exec’s stream is released', async () => {
    const link = await connect();
    const agent = execAgentOn(link);
    try {
      const c = await execCall(execSpec(crypto.randomUUID()));
      c.ws.send(frame(0, 'a'));
      expect(await c.next()).toEqual([1, 'A']);
      c.ws.close(1000, 'done');
      await vi.waitFor(() => expect(agent.seen[0]?.messages.at(-1)).toBe('close 1000'));
      await vi.waitFor(async () => expect(await onSession(link.connId, (s) => s?.openStreams)).toBe(0));
    } finally {
      agent.session.destroy();
    }
  });

  it('a caller sending on an output channel is closed 1008', async () => {
    const link = await connect();
    const agent = execAgentOn(link);
    try {
      const c = await execCall(execSpec(crypto.randomUUID()));
      c.ws.send(frame(1, 'x'));
      expect((await c.closed).code).toBe(1008);
      await vi.waitFor(() => expect(agent.seen[0]?.messages).toEqual(['close 1000']));
    } finally {
      agent.session.destroy();
    }
  });

  it('a refusal by the API server or the agent’s proxy is JSON, not an upgrade: kube_status with its reason', async () => {
    const link = await connect();
    const body = JSON.stringify({ kind: 'Status', status: 'Failure', code: 403, reason: 'Forbidden', message: 'exec is not allowed' });
    const agent = execAgentOn(link, {
      answer: () => `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    });
    try {
      const res = await stub().fetch(bridgeExecRequest(execSpec(crypto.randomUUID())));
      expect(res.status).toBe(502);
      expect(res.webSocket).toBeNull();
      expect(await res.json()).toEqual({
        ok: false,
        code: 'kube_status',
        status: 403,
        reason: 'Forbidden',
        message: 'exec is not allowed',
      });
      await vi.waitFor(async () => expect(await onSession(link.connId, (s) => s?.openStreams)).toBe(0));
    } finally {
      agent.session.destroy();
    }
  });

  it('a 101 with the wrong accept, or a protocol not offered, is bad_response', async () => {
    const link = await connect();
    const answers = [
      async (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${await wsAccept(`${key}x`)}\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n\r\n`,
      async (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${await wsAccept(key)}\r\nSec-WebSocket-Protocol: base64.channel.k8s.io\r\n\r\n`,
    ];
    let n = 0;
    const agent = execAgentOn(link, { answer: (key) => answers[n++]!(key) });
    try {
      for (let i = 0; i < answers.length; i++) {
        const res = await stub().fetch(bridgeExecRequest(execSpec(crypto.randomUUID())));
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ ok: false, code: 'bad_response' });
      }
      expect(agent.seen).toHaveLength(2);
      await vi.waitFor(async () => expect(await onSession(link.connId, (s) => s?.openStreams)).toBe(0));
    } finally {
      agent.session.destroy();
    }
  });

  it('the 17th exec at once is busy (429); nothing of it reaches the agent (PILOT-1188)', async () => {
    const link = await connect();
    const agent = execAgentOn(link);
    try {
      const running: ExecCaller[] = [];
      for (let i = 0; i < EXEC_LIMITS.maxExecs; i++) running.push(await execCall(execSpec(crypto.randomUUID())));
      expect(agent.seen).toHaveLength(EXEC_LIMITS.maxExecs);
      const res = await stub().fetch(bridgeExecRequest(execSpec(crypto.randomUUID())));
      expect(res.status).toBe(429);
      expect(res.webSocket).toBeNull();
      expect(await res.json()).toMatchObject({ ok: false, code: 'busy' });
      expect(agent.seen).toHaveLength(EXEC_LIMITS.maxExecs);
      // The running ones still work.
      running[0]!.ws.send(frame(0, 'still'));
      expect(await running[0]!.next()).toEqual([1, 'STILL']);
    } finally {
      agent.session.destroy();
    }
  });

  it('an internal failure answers fixed text; the cause is in the audit, never in the answer (PILOT-1188)', async () => {
    const link = await connect();
    const agent = execAgentOn(link, { answer: () => 'garbage\r\n\r\n' });
    try {
      const res = await stub().fetch(bridgeExecRequest(execSpec(crypto.randomUUID())));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, code: 'internal', message: 'The exec could not be started.' });
      const audit = await stub().audit(500);
      expect(audit.find((r) => r.event === 'bridge.internal')?.detail).toBe('not an HTTP/1.1 response');
    } finally {
      agent.session.destroy();
    }
  });

  it('refuses a bad exec with 400 before anything reaches the agent; no link is 503; not an upgrade is the plain 404', async () => {
    const link = await connect();
    const bearer = crypto.randomUUID();
    const agent = execAgentOn(link);
    try {
      const bad: KubeExecSpec[] = [
        execSpec(bearer, { pod: 'kube-apiserver-node1' }),
        execSpec(bearer, { namespace: 'kube_system' }),
        execSpec(bearer, { command: [] }),
        execSpec(bearer, { command: ['sh', 'a\0b'] }),
        execSpec(bearer, { command: ['sh', 'x'.repeat(9000)] }),
        execSpec(bearer, { tty: true, stderr: true }),
        execSpec('with space'),
      ];
      for (const s of bad) {
        const res = await stub().fetch(bridgeExecRequest(s));
        expect(res.status, JSON.stringify(s).slice(0, 80)).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, code: 'bad_request' });
      }
      const notJson = new Request(`https://bridge.internal${BRIDGE_EXEC_PATH}`, {
        headers: { upgrade: 'websocket', [BRIDGE_EXEC_HEADER]: '{' },
      });
      expect((await stub().fetch(notJson)).status).toBe(400);
      const noUpgrade = new Request(`https://bridge.internal${BRIDGE_EXEC_PATH}`, {
        headers: { [BRIDGE_EXEC_HEADER]: JSON.stringify(execSpec(bearer)) },
      });
      expect((await stub().fetch(noUpgrade)).status).toBe(404);
      expect(agent.seen).toEqual([]);
    } finally {
      agent.session.destroy();
    }
    link.ws.close(1000, 'bye');
    await link.closed;
    await vi.waitFor(async () => expect((await stub().links()).live).toBe(0));
    const res = await stub().fetch(bridgeExecRequest(execSpec(bearer)));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: 'agent_offline' });
  });

  it('the public route never reaches the exec: /bridge with the exec header is the Connect handshake, and the exec path is not served', async () => {
    const link = await SELF.fetch(URL_BRIDGE, {
      headers: upgradeHeaders({ [BRIDGE_EXEC_HEADER]: JSON.stringify(execSpec(crypto.randomUUID())) }),
    });
    expect(link.status).toBe(101);
    expect(link.headers.get('sec-websocket-protocol')).toBe(CONNECT_SUBPROTOCOL);
    expect(link.headers.get(EXEC_PROTOCOL_HEADER)).toBeNull();
    open.push(link.webSocket!);
    link.webSocket!.accept();
    const direct = await SELF.fetch(`https://core.test${BRIDGE_EXEC_PATH}`, {
      headers: upgradeHeaders({ [BRIDGE_EXEC_HEADER]: JSON.stringify(execSpec(crypto.randomUUID())) }),
    });
    expect(direct.status).not.toBe(101);
    expect(direct.webSocket).toBeNull();
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
      // In the future: an alarm in the past may fire by itself first, and runDurableObjectAlarm would find none (PILOT-1181).
      await state.storage.setAlarm(now + 60_000);
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
      await state.storage.setAlarm(now + 60_000);
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
