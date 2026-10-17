// T-948 review 10219 / decision 10220: every bridge into a workspace is bounded. An idle request is a 504, an idle socket is closed, a socket
// never outlives its app-host cookie, live connections end with the portal session, the right or the workspace, and the bridges open at once
// are capped per cookie and per workspace (503 + Retry-After). A local "app" and a local "portal" on loopback; the dial is a plain TCP connect
// to the app (the bridge itself is proven in proxy.test.ts). Codes and cookies are made at run time by the code under test.
import assert from 'node:assert/strict';
import { createServer, request, type ClientRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { FOUNDING_USER_ID, type Actor } from '@portal/contracts';
import { config } from '../config.js';
import { AppPortGrants } from './grants.js';
import { AppPorts, routeAppHostUpgrades } from './index.js';
import { appCookies, PORTAL_COOKIES, type ProxyLimits } from './proxy.js';

const SUFFIX = 'apps.test';
const actor: Actor = { kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'l1', via: 'ui' };
const SESSION = `session-${process.pid}-${Date.now()}`;

let appServer: Server;
let appPort = 0;
let wss: WebSocketServer;
let sessionOk = true;
const hanging = new Set<import('node:http').ServerResponse>();
const portals: Server[] = [];
const all: AppPorts[] = [];

before(async () => {
  appServer = createServer((req, res) => {
    if (req.url === '/hang') return void hanging.add(res); // never answers
    if (req.url === '/drip') {
      // Four chunks 150 ms apart: longer in total than a 300 ms idle limit, but never idle that long.
      res.writeHead(200, { 'content-type': 'text/plain' });
      let n = 0;
      const t = setInterval(() => {
        res.write(`${n}|`);
        if (++n === 4) (clearInterval(t), res.end('end'));
      }, 150);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  wss = new WebSocketServer({ server: appServer });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${String(m)}`)));
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  appPort = (appServer.address() as AddressInfo).port;
});

after(async () => {
  for (const p of all) p.close();
  for (const r of hanging) r.destroy();
  for (const c of wss.clients) c.terminate();
  wss.close();
  for (const s of portals) {
    s.closeAllConnections();
    s.close();
  }
  appServer.closeAllConnections();
  await new Promise((r) => appServer.close(r));
});

/** A portal server routing app hosts to a fresh AppPorts with these limits (as index.ts does). */
async function setup(limits: ProxyLimits, grants = new AppPortGrants()) {
  const server = createServer();
  portals.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const portalPort = (server.address() as AddressInfo).port;
  const ports = new AppPorts({
    suffix: SUFFIX,
    portalPort,
    workspaces: { list: async () => [{ id: 'docker/ws-1', name: 'ws-1' }], hooks: {}, resolve: () => null } as never,
    sessionValid: (t) => sessionOk && t === SESSION,
    grants,
    limits,
    dial: (_ws, port) =>
      new Promise((resolve, reject) => {
        const s = connect(port, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
      }),
  });
  all.push(ports);
  server.on('request', (req, res) => void (ports.proxy.owns(req.headers.host) ? ports.proxy.request(req, res) : res.end('portal')));
  routeAppHostUpgrades(server, ports.proxy);

  /** Opens the app and swaps the code: a fresh app-host cookie (`__pilot_app=<value>`). */
  const signIn = async (): Promise<{ host: string; cookie: string }> => {
    const { url, host } = await ports.open('docker', 'ws-1', { port: appPort }, { actor, actorString: 'x', userId: null, sessionToken: SESSION, portalOrigin: `http://pilot.${SUFFIX}:${portalPort}` });
    const u = new URL(url);
    const r = await send(`${u.pathname}${u.search}`, { host: u.host });
    assert.equal(r.status, 302);
    return { host, cookie: String(r.headers['set-cookie']).split(';')[0]! };
  };
  /** A GET whose client request can be cut (`sent.req.destroy()`). */
  const start = (path: string, headers: Record<string, string>) => {
    let req!: ClientRequest;
    const done = new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      req = request({ host: '127.0.0.1', port: portalPort, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    done.catch(() => undefined);
    return { req, done };
  };
  const send = (path: string, headers: Record<string, string>) => start(path, headers).done;
  const ws = (host: string, cookie: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${portalPort}/live`, { headers: { host, cookie }, origin: `http://${host}` });
      w.once('open', () => resolve(w));
      w.once('error', reject);
      w.once('unexpected-response', (_q, res) => (res.resume(), reject(new Error(`status ${res.statusCode}`))));
    });
  return { ports, signIn, start, send, ws };
}

const closed = (w: WebSocket) => new Promise<void>((r) => (w.readyState === WebSocket.CLOSED ? r() : w.once('close', () => r())));
async function until(what: string, ok: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('an HTTP request whose app never answers is a 504 after the idle limit, and its bridge is released', { timeout: 10_000 }, async () => {
  const { ports, signIn, send } = await setup({ idleMs: 300 });
  const { host, cookie } = await signIn();
  const t0 = Date.now();
  const r = await send('/hang', { host, cookie });
  assert.equal(r.status, 504);
  assert.ok(Date.now() - t0 >= 250, 'not before the limit');
  await until('the bridge to be released', () => ports.proxy.open === 0);
});

test('a response that keeps moving is not cut by the idle limit (it streams past it)', { timeout: 10_000 }, async () => {
  const { signIn, send } = await setup({ idleMs: 300 });
  const { host, cookie } = await signIn();
  const t0 = Date.now();
  const r = await send('/drip', { host, cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body, '0|1|2|3|end');
  assert.ok(Date.now() - t0 >= 450, 'longer in total than the idle limit');
});

test('open bridges are capped per app-host cookie and per workspace: 503 with Retry-After, free again when they close', { timeout: 10_000 }, async () => {
  const { ports, signIn, start, send } = await setup({ maxPerGrant: 2, maxPerWorkspace: 3, idleMs: 8000 });
  const a = await signIn();
  const b = await signIn();
  const held = [start('/hang', a), start('/hang', a)];
  await until('two bridges', () => ports.proxy.open === 2);
  const overGrant = await send('/ok', a);
  assert.equal(overGrant.status, 503, 'the third of one cookie');
  assert.equal(overGrant.headers['retry-after'], '5');
  held.push(start('/hang', b));
  await until('three bridges', () => ports.proxy.open === 3);
  const overWorkspace = await send('/ok', b);
  assert.equal(overWorkspace.status, 503, 'another cookie, but the workspace is full');
  assert.equal(overWorkspace.headers['retry-after'], '5');
  for (const h of held) h.req.destroy();
  await until('the bridges to close', () => ports.proxy.open === 0);
  assert.equal((await send('/ok', a)).status, 200, 'free again');
  assert.equal((await send('/ok', b)).status, 200);
});

test('an upgrade past the cap is a 503 too', { timeout: 10_000 }, async () => {
  const { ports, signIn, start, ws } = await setup({ maxPerGrant: 1, idleMs: 8000 });
  const a = await signIn();
  const held = start('/hang', a);
  await until('one bridge', () => ports.proxy.open === 1);
  await assert.rejects(ws(a.host, a.cookie), /status 503/);
  held.req.destroy();
  await until('the bridge to close', () => ports.proxy.open === 0);
  const w = await ws(a.host, a.cookie);
  w.close();
});

test('an upgraded socket idle past its limit is closed; one that talks stays open', { timeout: 10_000 }, async () => {
  const { ports, signIn, ws } = await setup({ socketIdleMs: 300 });
  const { host, cookie } = await signIn();
  const talking = await ws(host, cookie);
  const quiet = await ws(host, cookie);
  const t0 = Date.now();
  // unref: when a broken limit leaves the socket open, the test times out and must not hold the process open (it hung proof Job b5537ad1).
  const chatter = setInterval(() => talking.readyState === WebSocket.OPEN && talking.send('hi'), 100).unref();
  await closed(quiet);
  assert.ok(Date.now() - t0 >= 250, 'not before the limit');
  assert.equal(talking.readyState, WebSocket.OPEN, 'a socket that moves bytes is not idle');
  clearInterval(chatter);
  talking.close();
  await closed(talking);
  await until('the bridges to be released', () => ports.proxy.open === 0);
});

test('an upgraded socket ends when its app-host cookie does, even while it talks', { timeout: 10_000 }, async () => {
  const { signIn, ws } = await setup({}, new AppPortGrants({ cookieTtlMs: 700 }));
  const { host, cookie } = await signIn();
  const w = await ws(host, cookie);
  const t0 = Date.now();
  const chatter = setInterval(() => w.readyState === WebSocket.OPEN && w.send('hi'), 100).unref(); // unref: see the idle test
  await closed(w);
  clearInterval(chatter);
  const took = Date.now() - t0;
  assert.ok(took >= 500 && took < 3000, `closed at the cookie's end (${took} ms)`);
});

test('signing out cuts the live sockets and requests of that session at once', { timeout: 10_000 }, async () => {
  const { ports, signIn, start, ws } = await setup({ idleMs: 8000 });
  const { host, cookie } = await signIn();
  const w = await ws(host, cookie);
  const held = start('/hang', { host, cookie });
  await until('two bridges', () => ports.proxy.open === 2);
  sessionOk = false;
  try {
    ports.proxy.sweep(); // what portal.onRevoked calls (index.ts)
    await closed(w);
    await assert.rejects(held.done);
    await until('the bridges to be released', () => ports.proxy.open === 0);
  } finally {
    sessionOk = true;
  }
});

test('removing the workspace (grants.forgetWorkspace) closes its live sockets without waiting for the timer', { timeout: 10_000 }, async () => {
  const { ports, signIn, ws } = await setup({ sweepMs: 60_000 });
  const { host, cookie } = await signIn();
  const w = await ws(host, cookie);
  ports.grants.forgetWorkspace('docker/ws-1');
  await closed(w);
  await until('the bridge to be released', () => ports.proxy.open === 0);
});

test('closing the proxy (server shutdown) cuts its live sockets, so no timer holds the process', { timeout: 10_000 }, async () => {
  const { ports, signIn, ws } = await setup({});
  const { host, cookie } = await signIn();
  const w = await ws(host, cookie);
  ports.proxy.close();
  await closed(w);
  await until('the bridge to be released', () => ports.proxy.open === 0);
});

test('the portal cookie names come from config, with the __Host- form, and never reach an app', () => {
  const name = config.session.cookie;
  assert.ok(PORTAL_COOKIES.has(name));
  assert.ok(PORTAL_COOKIES.has(`__Host-${name}`));
  const v = `v${Date.now()}`;
  assert.equal(appCookies(`${name}=${v}; __Host-${name}=${v}; theirs=1`), 'theirs=1');
});
