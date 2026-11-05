// PILOT-1149: /api/* to a scratch portal over the bridge, inside workerd. The link's agent is this test (a client MuxSession, as in
// bridge.test.ts) and its `http` service is a stub portal: no live portal, no network. The bridge key pair and token are made at run time
// by vitest.config.ts; the proxy's config is passed per request (`createApp().fetch(req, { ...env, CP_API_PROXY })`).

import { MuxSession } from '@portal/connect-tunnel/mux';
import { acceptService } from '@portal/connect-tunnel/open';
import { CONNECT_PROTOCOL, CONNECT_SUBPROTOCOL, connectHttpTargetOf, connectSignChallenge, type ConnectChallenge } from '@portal/contracts';
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  API_INTERNAL,
  apiProxyConfigOf,
  apiTargetOk,
  BRIDGE_API_PATH,
  cookieOnward,
  forwardHeaders,
  locationOnward,
  responseHeaders,
  setCookieOnward,
} from '../src/bridge/apiProxy.js';
import { ByteReader } from '../src/bridge/http1.js';
import { readWsFrame, wsAccept, wsFrame } from '../src/bridge/kubeExec.js';
import { locate } from '../src/locate.js';
import { cfMuxSocket } from './spike/wire.js';

const TARGET = 'http://scratch.dev-rig-t3707.svc:8080';
const AUTHORITY = 'scratch.dev-rig-t3707.svc:8080';
const config = (target = TARGET, cluster = env.TEST_BRIDGE_CLUSTER) => JSON.stringify({ cluster, target });
const stub = () => locate(env.BRIDGE, env.TEST_BRIDGE_CLUSTER);
const app = createApp();
const call = (path: string, init: RequestInit = {}, proxy: string | undefined = config()) =>
  app.fetch(new Request(`https://core.test${path}`, init), { ...env, CP_API_PROXY: proxy });

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

interface Sock {
  ws: WebSocket;
  next(): Promise<string | ArrayBuffer>;
  closed: Promise<{ code: number; reason: string }>;
}

function socketOf(ws: WebSocket): Sock {
  open.push(ws);
  const queue: (string | ArrayBuffer)[] = [];
  const waiting: ((m: string | ArrayBuffer) => void)[] = [];
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

/** A live link through the whole handshake (bridge.test.ts does the same, with every refusal). */
async function connect(): Promise<Sock> {
  const res = await SELF.fetch('https://core.test/bridge', {
    headers: {
      upgrade: 'websocket',
      'sec-websocket-protocol': CONNECT_SUBPROTOCOL,
      'x-pilot-cluster': env.TEST_BRIDGE_CLUSTER,
      authorization: `Bearer ${env.TEST_BRIDGE_TOKEN}`,
    },
  });
  expect(res.status).toBe(101);
  const link = socketOf(res.webSocket!);
  const c = JSON.parse((await link.next()) as string) as ConnectChallenge;
  const now = new Date().toISOString();
  link.ws.send(
    JSON.stringify({
      t: 'auth',
      node: env.TEST_BRIDGE_NODE,
      sig: await connectSignChallenge(env.TEST_BRIDGE_PRIVATE_KEY, c.connId, c.nonce, env.TEST_BRIDGE_NODE),
      hello: {
        agentVersion: 'test',
        agentBuild: 'test00000000',
        protocol: CONNECT_PROTOCOL,
        os: 'linux',
        arch: 'x64',
        hostname: 'cp-bridge-test',
        mode: 'kubernetes',
        runtime: 'pod',
        services: [{ name: 'kube', ok: true }],
        clock: now,
        startedAt: now,
      },
    }),
  );
  expect(JSON.parse((await link.next()) as string)).toMatchObject({ t: 'welcome' });
  return link;
}

interface Seen {
  target: unknown;
  line: string;
  /** Every header line as sent. */
  raw: string;
  headers: Map<string, string>;
  body: string;
  ws: string[];
}

/**
 * The agent's `http` service and a stub portal behind it. It accepts only `serves` as the target (the agent's own wall, to come), and
 * answers by path: /api/hello (two cookies), /api/echo (the body back, chunked), /api/redirect, /api/big (1 MiB), /api/live (a
 * WebSocket that upper-cases text and reverses binary).
 */
function portalOn(link: Sock, serves = AUTHORITY): { session: MuxSession; seen: Seen[] } {
  const seen: Seen[] = [];
  const session = new MuxSession({
    role: 'client',
    socket: cfMuxSocket(link.ws),
    onStream: (stream) =>
      void (async () => {
        const req = await acceptService(stream, (r) =>
          r.service !== 'http'
            ? { ok: false, code: 'service_unavailable', message: 'Only http here.' }
            : (r.args as { target?: unknown } | undefined)?.target === serves
              ? { ok: true }
              : { ok: false, code: 'denied', message: 'Not this target.' },
        );
        if (!req) return;
        const r = new ByteReader(stream);
        const raw = (await r.until('\r\n\r\n')).toString('latin1');
        const [line = '', ...rest] = raw.split('\r\n');
        const headers = new Map(rest.map((h) => [h.slice(0, h.indexOf(':')).toLowerCase(), h.slice(h.indexOf(':') + 1).trim()]));
        const length = Number(headers.get('content-length') ?? 0);
        const body = length > 0 ? (await r.take(length)).toString('utf8') : '';
        const one: Seen = { target: (req.args as { target?: unknown }).target, line, raw, headers, body, ws: [] };
        seen.push(one);
        const path = line.split(' ')[1] ?? '';
        const answer = (head: string, payload = '') => {
          stream.write(`HTTP/1.1 ${head}\r\n\r\n${payload}`);
          stream.end();
        };
        if (path.startsWith('/api/hello')) {
          const b = JSON.stringify({ hello: path });
          return answer(
            `200 OK\r\nContent-Type: application/json\r\nSet-Cookie: sid=s1; Path=/; Domain=${AUTHORITY.split(':')[0]}; HttpOnly\r\nSet-Cookie: theme=dark; Path=/\r\nContent-Length: ${Buffer.byteLength(b)}`,
            b,
          );
        }
        if (path === '/api/echo') {
          const half = Math.ceil(body.length / 2);
          const chunk = (s: string) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;
          return answer(
            '201 Created\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked',
            `${chunk(body.slice(0, half))}${chunk(body.slice(half))}0\r\n\r\n`,
          );
        }
        if (path === '/api/redirect') return answer(`302 Found\r\nLocation: http://${AUTHORITY}/api/next?a=1\r\nContent-Length: 0`);
        if (path === '/api/big') {
          stream.write(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${1024 * 1024}\r\n\r\n`);
          for (let i = 0; i < 16; i++) stream.write(Buffer.alloc(64 * 1024, i));
          return void stream.end();
        }
        if (path === '/api/live') {
          const key = headers.get('sec-websocket-key') ?? '';
          const protocol = (headers.get('sec-websocket-protocol') ?? '').split(',')[0]?.trim();
          stream.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${await wsAccept(key)}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`,
          );
          try {
            for (;;) {
              const f = await readWsFrame(r);
              if (!f.masked) throw new Error('an unmasked client frame');
              if (f.opcode === 8) {
                one.ws.push(`close ${f.payload.readUInt16BE(0)}`);
                stream.write(wsFrame(8, f.payload, false));
                return void stream.end();
              }
              if (f.opcode === 1) {
                one.ws.push(`text ${f.payload.toString('utf8')}`);
                if (f.payload.toString('utf8') === 'bye') {
                  stream.write(wsFrame(8, Buffer.from([0x0f, 0xa0]), false)); // 4000
                  return void stream.end();
                }
                stream.write(wsFrame(1, Buffer.from(f.payload.toString('utf8').toUpperCase()), false));
              } else if (f.opcode === 2) {
                one.ws.push(`binary ${[...f.payload].join(',')}`);
                // fragmented on purpose: the relay joins it
                const back = Buffer.from([...f.payload].reverse());
                stream.write(wsFrame(2, back.subarray(0, 1), false, false));
                stream.write(wsFrame(9, Buffer.from('p'), false));
                stream.write(wsFrame(0, back.subarray(1), false, true));
              }
            }
          } catch {
            return; // the stream ended
          }
        }
        return answer('404 Not Found\r\nContent-Length: 0');
      })(),
  });
  return { session, seen };
}

/** Waits until the cluster's object holds no live link (a closed one is let go asynchronously). */
async function noLiveLink(): Promise<void> {
  for (let i = 0; i < 100 && (await stub().links()).live > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('the target: only a scratch portal in a dev-rig namespace (connectHttpTargetOf, apiProxyConfigOf)', () => {
  it('takes a dev-rig Service by its cluster DNS name and port', () => {
    expect(connectHttpTargetOf(TARGET)).toEqual({ hostname: 'scratch.dev-rig-t3707.svc', namespace: 'dev-rig-t3707', port: 8080, authority: AUTHORITY });
    expect(connectHttpTargetOf('http://portal.dev-rig-a.svc.cluster.local:3000/')?.authority).toBe('portal.dev-rig-a.svc.cluster.local:3000');
    expect(apiProxyConfigOf(config())).toEqual({ cluster: env.TEST_BRIDGE_CLUSTER, target: connectHttpTargetOf(TARGET) });
  });

  it('refuses the live portal and everything that is not a dev-rig Service', () => {
    for (const t of [
      'https://pilot.ai.isnan.me',
      'http://pilot.ai.isnan.me:80',
      'http://portal.claudepilot.svc:3000',
      'http://portal.isnan-claudepilot.svc:3000',
      'http://portal.claudepilot.svc.cluster.local:3000',
      'http://portal.dev-rig-a.svc.claudepilot.svc:3000',
      'http://10.43.0.10:3000',
      'http://[::1]:3000',
      'https://portal.dev-rig-a.svc:3000',
      'http://portal.dev-rig-a.svc',
      'http://portal.dev-rig-a.svc:0',
      'http://portal.dev-rig-a.svc:70000',
      'http://user@portal.dev-rig-a.svc:3000',
      'http://portal.dev-rig-a.svc:3000/api',
      'http://portal.dev-rig-a.svc:3000?x=1',
      'http://Portal.dev-rig-a.svc:3000',
      'http://portal.dev-rig-a.svc.:3000',
      'http://portal.dev-rig-a.svc:3000\\@pilot.ai.isnan.me',
      'http://portal%2edev-rig-a.svc:3000',
      'http://portal.dev-rig-a.svc:3000 ',
      'http://portal.dev-rig-.svc:3000',
      '',
      42,
      null,
    ]) {
      expect(connectHttpTargetOf(t), String(t)).toBeNull();
      expect(apiProxyConfigOf(JSON.stringify({ cluster: 'test-cluster', target: t })), String(t)).toBeNull();
    }
    expect(apiProxyConfigOf(undefined)).toBeNull();
    expect(apiProxyConfigOf('not json')).toBeNull();
    expect(apiProxyConfigOf(JSON.stringify({ cluster: 'Bad_Name', target: TARGET }))).toBeNull();
    expect(apiProxyConfigOf(JSON.stringify([TARGET]))).toBeNull();
  });

  it('sends only request targets under /api, printable and bounded', () => {
    for (const ok of ['/api', '/api/x', '/api/x?y=1', '/api?x=1']) expect(apiTargetOk(ok), ok).toBe(true);
    for (const bad of ['/apix', '/', '/bridge', '/api/x y', '/api/é', `/api/${'a'.repeat(9000)}`, null]) expect(apiTargetOk(bad)).toBe(false);
  });
});

describe('headers onward and back', () => {
  const target = connectHttpTargetOf(TARGET)!;

  it('drops Cloudflare Access, Authorization, forwarding and internal headers; keeps the rest', () => {
    const jwt = ['eyJ', 'hbGciOiJSUzI1NiJ9', '.', 'e30', '.', 'c2ln'].join('');
    const h = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-requested-with': 'fetch',
      authorization: `Bearer ${crypto.randomUUID()}`,
      'cf-access-jwt-assertion': jwt,
      'cf-access-client-id': crypto.randomUUID(),
      'cf-access-client-secret': crypto.randomUUID(),
      'cf-connecting-ip': '203.0.113.9',
      'cf-ray': 'abc',
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
      forwarded: 'for=203.0.113.9',
      'x-real-ip': '203.0.113.9',
      'true-client-ip': '203.0.113.9',
      'x-pilot-cluster': 'test-cluster',
      [API_INTERNAL.target]: 'http://portal.claudepilot.svc:3000',
      'x-cp-bridge-key': 'k',
      host: 'core.test',
      connection: 'keep-alive',
      'proxy-authorization': 'Basic x',
      referer: 'https://core.test/chat',
      'sec-websocket-key': 'k',
      cookie: `CF_Authorization=${jwt}; sid=abc; cf_clearance=x; __cf_bm=y; CF_AppSession=z; theme=dark`,
      origin: 'https://core.test',
    });
    const out = forwardHeaders(h, target, 'https://core.test');
    expect(out).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-requested-with': 'fetch',
      cookie: 'sid=abc; theme=dark',
      origin: `http://${AUTHORITY}`,
    });
    expect(JSON.stringify(out)).not.toContain(jwt);
  });

  it('rewrites only this Worker’s own Origin; a foreign one passes so the portal’s CSRF check refuses it', () => {
    expect(forwardHeaders(new Headers({ origin: 'https://evil.test' }), target, 'https://core.test').origin).toBe('https://evil.test');
    expect(forwardHeaders(new Headers({ origin: 'https://core.test' }), target, null).origin).toBe('https://core.test');
  });

  it('drops every Cloudflare cookie and leaves no empty Cookie', () => {
    expect(cookieOnward('CF_Authorization=a; CF_Binding=b; cf_x=c; __cflb=d')).toBeNull();
    expect(cookieOnward(null)).toBeNull();
    expect(cookieOnward('a=1;b=2')).toBe('a=1; b=2');
  });

  it('back: Set-Cookie without Domain, a Location on the target made path-only, no hop-by-hop header', () => {
    expect(setCookieOnward('sid=1; Path=/; Domain=scratch.dev-rig-t3707.svc; HttpOnly')).toBe('sid=1; Path=/; HttpOnly');
    expect(setCookieOnward('domain=1; Path=/')).toBe('domain=1; Path=/');
    expect(locationOnward(`http://${AUTHORITY}/api/x?y=1`, target)).toBe('/api/x?y=1');
    expect(locationOnward('http://scratch.dev-rig-t3707.svc/login', target)).toBe('/login');
    expect(locationOnward(`http://${AUTHORITY}`, target)).toBe('/');
    expect(locationOnward(`http://${AUTHORITY}.evil.test/x`, target)).toBe(`http://${AUTHORITY}.evil.test/x`);
    expect(locationOnward('https://elsewhere.test/x', target)).toBe('https://elsewhere.test/x');
    const out = responseHeaders(
      {
        status: 200,
        headers: new Map(),
        list: [
          ['Content-Type', 'text/plain'],
          ['Set-Cookie', 'a=1; Domain=x'],
          ['Set-Cookie', 'b=2'],
          ['Connection', 'close'],
          ['Transfer-Encoding', 'chunked'],
          ['Content-Length', '5'],
          ['Keep-Alive', 'timeout=5'],
        ],
      },
      target,
    );
    expect(out.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect([...out.keys()].sort()).toEqual(['content-type', 'set-cookie']);
  });
});

describe('/api/* through the bridge (stub agent and portal)', () => {
  it('is the plain 404 when no proxy is configured, or the config is not allowed, and nothing reaches the agent', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    for (const proxy of [
      undefined,
      'nope',
      config('http://portal.claudepilot.svc:3000'),
      config('https://pilot.ai.isnan.me'),
      config(TARGET, 'unknown-cluster'),
    ]) {
      const res = await call('/api/hello', {}, proxy);
      expect(res.status, String(proxy)).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    // The Worker's own bindings carry no proxy: SELF stays the 404 (assets.test.ts holds the same).
    expect((await SELF.fetch('https://core.test/api/hello')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('BridgeDO refuses a forged internal request for any other target', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    for (const t of ['http://portal.claudepilot.svc:3000', 'http://pilot.ai.isnan.me:443', '', 'http://10.0.0.1:80']) {
      const res = await stub().fetch(
        new Request(`https://bridge.internal${BRIDGE_API_PATH}`, { headers: { [API_INTERNAL.target]: t, [API_INTERNAL.path]: '/api/hello' } }),
      );
      expect(res.status, t).toBe(404);
    }
    const badPath = await stub().fetch(
      new Request(`https://bridge.internal${BRIDGE_API_PATH}`, { headers: { [API_INTERNAL.target]: TARGET, [API_INTERNAL.path]: '/bridge' } }),
    );
    expect(badPath.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('GET: the agent sees the configured target and clean headers; the browser gets the cookies without Domain', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    const jwt = ['eyJ', 'hbGciOiJFUzI1NiJ9', '.', 'e30', '.', 'c2ln'].join('');
    const res = await call('/api/hello?x=1&y=two', {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${env.TEST_BRIDGE_TOKEN}`,
        'cf-access-jwt-assertion': jwt,
        cookie: `CF_Authorization=${jwt}; sid=abc`,
        origin: 'https://core.test',
        'x-forwarded-for': '203.0.113.9',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: '/api/hello?x=1&y=two' });
    expect(res.headers.getSetCookie()).toEqual(['sid=s1; Path=/; HttpOnly', 'theme=dark; Path=/']);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.target).toBe(AUTHORITY);
    expect(s.line).toBe('GET /api/hello?x=1&y=two HTTP/1.1');
    expect(s.headers.get('host')).toBe(AUTHORITY);
    expect(s.headers.get('origin')).toBe(`http://${AUTHORITY}`);
    expect(s.headers.get('cookie')).toBe('sid=abc');
    expect(s.headers.get('connection')).toBe('close');
    for (const name of ['authorization', 'cf-access-jwt-assertion', 'x-forwarded-for', 'x-cp-api-target', 'x-cp-api-path'])
      expect(s.headers.has(name), name).toBe(false);
    expect(s.raw).not.toContain(jwt);
    expect(s.raw).not.toContain(env.TEST_BRIDGE_TOKEN);
    expect(s.raw).not.toContain('CF_Authorization');
  });

  it('POST: the body goes on with its length; a chunked answer comes back whole', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    const body = JSON.stringify({ text: 'héllo', n: [1, 2, 3] });
    const res = await call('/api/echo', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: 'https://core.test' } });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe(body);
    expect(seen[0]!.line).toBe('POST /api/echo HTTP/1.1');
    expect(seen[0]!.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');
    expect(seen[0]!.body).toBe(body);
  });

  it('a foreign Origin reaches the portal as it is', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    await (await call('/api/echo', { method: 'POST', body: 'x', headers: { origin: 'https://evil.test' } })).text();
    expect(seen[0]!.headers.get('origin')).toBe('https://evil.test');
  });

  it('a redirect on the target comes back path-only', async () => {
    const link = await connect();
    portalOn(link);
    const res = await call('/api/redirect', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/api/next?a=1');
  });

  it('a large answer streams through whole (the stream is paused and resumed as it is read)', async () => {
    const link = await connect();
    portalOn(link);
    const res = await call('/api/big');
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(1024 * 1024);
    for (let i = 0; i < 16; i++) expect(bytes[i * 64 * 1024], `piece ${i}`).toBe(i);
  });

  it('the agent refusing the target is a 502; no link is a 503', async () => {
    const link = await connect();
    portalOn(link, 'other.dev-rig-t3707.svc:8080');
    const denied = await call('/api/hello');
    expect(denied.status).toBe(502);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    link.ws.close(1000, 'gone');
    await noLiveLink();
    const offline = await call('/api/hello');
    expect(offline.status).toBe(503);
  });

  it('WebSocket: text and binary pass both ways, a ping is answered, and the portal’s close code reaches the browser', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    const res = await call('/api/live', {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'pilot.live.v1, other', cookie: 'CF_Authorization=x; sid=abc', origin: 'https://core.test' },
    });
    expect(res.status).toBe(101);
    expect(res.headers.get('sec-websocket-protocol')).toBe('pilot.live.v1');
    const ws = socketOf(res.webSocket!);
    ws.ws.send('hello');
    expect(await ws.next()).toBe('HELLO');
    ws.ws.send(new Uint8Array([1, 2, 3]));
    expect([...new Uint8Array((await ws.next()) as ArrayBuffer)]).toEqual([3, 2, 1]);
    ws.ws.send('bye');
    expect((await ws.closed).code).toBe(4000);
    const s = seen[0]!;
    expect(s.line).toBe('GET /api/live HTTP/1.1');
    expect(s.headers.get('upgrade')).toBe('websocket');
    expect(s.headers.get('sec-websocket-protocol')).toBe('pilot.live.v1, other');
    expect(s.headers.get('cookie')).toBe('sid=abc');
    expect(s.headers.get('origin')).toBe(`http://${AUTHORITY}`);
    expect(s.ws).toEqual(['text hello', 'binary 1,2,3', 'text bye']);
  });

  it('WebSocket: the browser’s close reaches the portal with its code', async () => {
    const link = await connect();
    const { seen } = portalOn(link);
    const res = await call('/api/live', { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = socketOf(res.webSocket!);
    ws.ws.send('x');
    expect(await ws.next()).toBe('X');
    ws.ws.close(4001, 'done');
    for (let i = 0; i < 100 && !seen[0]!.ws.includes('close 4001'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]!.ws).toContain('close 4001');
  });

  it('an upgrade the proxy refuses is a normal answer with the app’s headers', async () => {
    const res = await call('/api/live', { headers: { upgrade: 'websocket' } }, undefined);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
