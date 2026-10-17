// T-948 S1 (docs/prd/app-ports.md §4-§7): the app host end to end, on real sockets. A local "app" (HTTP and WebSocket) listens on loopback; a
// local "portal" server routes app hosts to the proxy exactly as index.ts does; the proxy reaches the app through the REAL bridge (the same
// `node -e BRIDGE <port>` the workspaces run, spawned here as the exec session) and the real ExecDuplex. Nothing here talks to a real portal.
// Codes and cookies are made at run time by the code under test.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { FOUNDING_USER_ID, type Actor } from '@portal/contracts';
import { singleOwner, useAuthz } from '../authz/seam.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ExecDuplex, bridgeCommand } from './dial.js';
import { AppPortGrants } from './grants.js';
import { AppPorts, routeAppHostUpgrades } from './index.js';
import { asLocation } from './proxy.js';

const SUFFIX = 'apps.test';
const actor: Actor = { kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'l1', via: 'ui' };
const SESSION = 'portal-session-under-test';

let appPort = 0;
let portalPort = 0;
let appServer: Server;
let portalServer: Server;
let wss: WebSocketServer;
let ports: AppPorts;
let sessionOk = true;
let clockSkew = 0;
/** A workspace that never connects: the dial never settles. */
let hangDial = false;
const dials: { workspaceId: string; port: number }[] = [];
const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let release: () => void = () => undefined;

/** A child process as the runtimes' exec session. */
const sessionOf = (p: ChildProcess): ExecSession => {
  p.stdin!.on('error', () => undefined);
  return {
    write: (d) => void p.stdin!.write(d),
    close: () => void p.kill(),
    onData: (fn) => void p.stdout!.on('data', fn),
    onExit: (fn) => void p.on('close', (c) => fn(c)),
  };
};

before(async () => {
  appServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first|');
        // The second half waits until the client has the first: a proxy that buffered the body would never let it go.
        new Promise<void>((r) => (release = r)).then(() => res.end('second'));
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${appPort}/landed?x=1` }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'set-cookie': ['a=1; Domain=apps.test; Path=/', 'portal_session=planted; Path=/', '__pilot_app=planted; Path=/'],
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  wss = new WebSocketServer({ server: appServer });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${String(m)}`)));
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  appPort = (appServer.address() as AddressInfo).port;

  portalServer = createServer();
  await new Promise<void>((r) => portalServer.listen(0, '127.0.0.1', r));
  portalPort = (portalServer.address() as AddressInfo).port;
  const workspaces = {
    runtimeFor: () => undefined,
    exec: async () => assert.fail('the test dials itself'),
    list: async () => [
      { id: 'docker/ws-1', name: 'ws-1' },
      { id: 'docker/other', name: 'other' },
    ],
    hooks: { audit: () => undefined },
    resolve: () => null,
  } as never;
  ports = new AppPorts({
    suffix: SUFFIX,
    portalPort,
    workspaces,
    sessionValid: (t) => sessionOk && t === SESSION,
    grants: new AppPortGrants({ now: () => Date.now() + clockSkew }),
    upgradeTimeoutMs: 2000,
    dial: async (workspaceId, port) => {
      dials.push({ workspaceId, port });
      if (hangDial) return new Promise<never>(() => undefined);
      const [, ...args] = bridgeCommand(port);
      return new ExecDuplex(sessionOf(spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] })));
    },
  });
  // As index.ts: an app host goes to the proxy first; everything else is the portal.
  portalServer.on('request', (req, res) => {
    if (ports.proxy.owns(req.headers.host)) void ports.proxy.request(req, res);
    else res.end('portal');
  });
  portalServer.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 418 Portal\r\nContent-Length: 0\r\n\r\n'));
  routeAppHostUpgrades(portalServer, ports.proxy);
});

after(async () => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  portalServer.closeAllConnections();
  appServer.closeAllConnections();
  await new Promise((r) => portalServer.close(r));
  await new Promise((r) => appServer.close(r));
});

const hostFor = (name: string, port: number) => `app-${name}-${port}.${SUFFIX}:${portalPort}`;

/** One request to the portal server, Host as given. */
function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: portalPort, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const open = (name: string, port: number, path = '/', origin = `http://pilot.${SUFFIX}:${portalPort}`) =>
  ports.open('docker', name, { port, path }, { actor, actorString: `user:${FOUNDING_USER_ID}`, userId: FOUNDING_USER_ID, sessionToken: SESSION, portalOrigin: origin });

/** Opens and swaps the code: the app host's cookie pair (`__pilot_app=<value>`). */
async function signIn(name = 'ws-1', port = appPort): Promise<{ host: string; cookie: string }> {
  const { url, host } = await open(name, port);
  const u = new URL(url);
  const r = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
  assert.equal(r.status, 302);
  const line = String(r.headers['set-cookie']);
  return { host, cookie: line.split(';')[0]! };
}

test('the handoff: the code buys a host-only HttpOnly SameSite=Lax cookie once, then redirects to next; the portal frames it', async () => {
  const { url, host } = await open('ws-1', appPort, '/echo?x=1');
  assert.equal(host, hostFor('ws-1', appPort));
  const u = new URL(url);
  assert.equal(u.pathname, '/__pilot/auth');
  assert.equal(u.searchParams.get('next'), '/echo?x=1');
  const r = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/echo?x=1');
  const cookie = String(r.headers['set-cookie']);
  assert.match(cookie, /^__pilot_app=[A-Za-z0-9_-]{43}; /);
  assert.match(cookie, /; HttpOnly(;|$)/);
  assert.match(cookie, /; SameSite=Lax(;|$)/);
  assert.match(cookie, /; Path=\/(;|$)/);
  assert.doesNotMatch(cookie, /domain=/i, 'host-only: no Domain attribute');
  assert.doesNotMatch(cookie, /secure/i, 'an http portal gets no Secure');
  assert.equal(r.headers['content-security-policy'], `frame-ancestors http://pilot.${SUFFIX}:${portalPort}`);
  assert.equal(r.headers['cache-control'], 'no-store');
  const again = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
  assert.equal(again.status, 404, 'a code is single use');
  assert.equal(again.headers['set-cookie'], undefined);
});

test('an https portal page gets a Secure cookie and frame-ancestors https://<portal host>', async () => {
  const { url } = await open('ws-1', appPort, '/', `https://pilot.${SUFFIX}:${portalPort}`);
  const u = new URL(url);
  assert.equal(u.protocol, 'https:');
  const r = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
  assert.match(String(r.headers['set-cookie']), /; Secure(;|$)/);
  assert.equal(r.headers['content-security-policy'], `frame-ancestors https://pilot.${SUFFIX}:${portalPort}`);
});

test('a code expires after 30 s', async () => {
  const { url } = await open('ws-1', appPort);
  const u = new URL(url);
  clockSkew = 30_001;
  try {
    const r = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
    assert.equal(r.status, 404);
  } finally {
    clockSkew = 0;
  }
});

test('next must be a path: a scheme, // or a backslash is 400, and the code is not spent on it', async () => {
  const { url } = await open('ws-1', appPort);
  const u = new URL(url);
  // '/中': it used to spend the code, then throw in writeHead (ERR_INVALID_CHAR) and hang the request (QA T-948 c10015).
  for (const next of ['https://evil.test/', '//evil.test/', '/\\evil.test', '/javascript:alert(1)', 'evil', '/中']) {
    u.searchParams.set('next', next);
    const r = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
    assert.equal(r.status, 400, next);
    assert.equal(r.headers['set-cookie'], undefined, next);
  }
  u.searchParams.set('next', '/fine');
  const ok = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/fine');
});

test('proxied: the portal cookie and credentials never reach the app; the app cannot frame-deny, plant a portal cookie or a Domain cookie', async () => {
  const { host, cookie } = await signIn();
  seen.length = 0;
  const r = await send('GET', '/echo', { host, cookie: `portal_session=${SESSION}; ${cookie}; theme=dark`, authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`, 'x-forwarded-for': '6.6.6.6' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  const got = seen.at(-1)!;
  assert.equal(got.headers.cookie, 'theme=dark', 'only the app’s own cookies');
  assert.equal(got.headers.authorization, undefined);
  assert.equal(got.headers.host, `127.0.0.1:${appPort}`);
  assert.equal(got.headers['x-forwarded-host'], host);
  assert.equal(got.headers['x-forwarded-proto'], 'http');
  assert.equal(got.headers['x-forwarded-for'], undefined);
  assert.equal(r.headers['x-frame-options'], undefined, 'the app’s X-Frame-Options is dropped');
  assert.equal(r.headers['content-security-policy'], `default-src 'self', frame-ancestors http://pilot.${SUFFIX}:${portalPort}`);
  assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/'], 'Domain stripped, portal-named cookies dropped');
  assert.deepEqual(dials.at(-1), { workspaceId: 'docker/ws-1', port: appPort });
});

test('a POST body reaches the app; the app’s redirect to its loopback stays on the app host', async () => {
  const { host, cookie } = await signIn();
  const r = await send('POST', '/echo', { host, cookie, origin: `http://${host}`, 'content-type': 'text/plain' }, 'hello body');
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1)!.body, 'hello body');
  const redirect = await send('GET', '/redirect', { host, cookie });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/landed?x=1');
});

test('streaming: the first chunk arrives before the response ends', { timeout: 15_000 }, async () => {
  const { host, cookie } = await signIn();
  const parts = await new Promise<string[]>((resolve, reject) => {
    const got: string[] = [];
    const r = request({ host: '127.0.0.1', port: portalPort, path: '/stream', headers: { host, cookie } }, (res) => {
      res.on('data', (c: Buffer) => {
        got.push(c.toString());
        if (got.join('') === 'first|') release();
      });
      res.on('end', () => resolve(got));
    });
    r.on('error', reject);
    r.end();
  });
  assert.equal(parts[0], 'first|', 'the first chunk came alone, before the end');
  assert.equal(parts.join(''), 'first|second');
});

test('a WebSocket works end to end through the bridge', { timeout: 15_000 }, async () => {
  const { host, cookie } = await signIn();
  const ws = new WebSocket(`ws://127.0.0.1:${portalPort}/live`, { headers: { host, cookie }, origin: `http://${host}` });
  const reply = await new Promise<string>((resolve, reject) => {
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (m) => resolve(String(m)));
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  ws.close();
  assert.equal(reply, 'echo:ping');
});

/** A WebSocket attempt's HTTP status (101 when it opened). */
function wsStatus(headers: Record<string, string>, origin?: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${portalPort}/live`, { headers, ...(origin ? { origin } : {}) });
    ws.on('open', () => (ws.close(), resolve(101)));
    ws.on('unexpected-response', (_q, res) => (res.resume(), resolve(res.statusCode ?? 0)));
    ws.on('error', () => resolve(-1));
  });
}

test('a foreign Origin is refused on a mutation and on a WebSocket of the app host', { timeout: 15_000 }, async () => {
  const { host, cookie } = await signIn();
  const n = seen.length;
  for (const origin of ['http://evil.test', `http://${hostFor('other', appPort)}`, 'null']) {
    const r = await send('POST', '/echo', { host, cookie, origin }, 'x');
    assert.equal(r.status, 404, origin);
    assert.equal(await wsStatus({ host, cookie }, origin), 404, origin);
  }
  const site = await send('POST', '/echo', { host, cookie, 'sec-fetch-site': 'cross-site' }, 'x');
  assert.equal(site.status, 404);
  assert.equal(seen.length, n, 'nothing reached the app');
});

test('the seam is asked on every proxied request: a denial (or an ended portal session) is 404 and dials nothing', async () => {
  const { host, cookie } = await signIn();
  const { url } = await open('ws-1', appPort);
  const u = new URL(url);
  const before = dials.length;
  const was = useAuthz({ ...singleOwner, can: (a, v, o) => (o.type === 'workspace' ? { allow: false, reason: 'not_found', level: 'none' } : singleOwner.can(a, v, o)) });
  try {
    assert.equal((await send('GET', '/echo', { host, cookie })).status, 404);
    assert.equal(await wsStatus({ host, cookie }, `http://${host}`), 404);
    assert.equal((await send('GET', `${u.pathname}${u.search}`, { host: u.host })).status, 404, 'no cookie for a denied actor');
  } finally {
    useAuthz(was);
  }
  sessionOk = false;
  try {
    assert.equal((await send('GET', '/echo', { host, cookie })).status, 404);
  } finally {
    sessionOk = true;
  }
  assert.equal(dials.length, before);
  assert.equal((await send('GET', '/echo', { host, cookie })).status, 200, 'allowed again');
});

test('a bad host, a bad or denied port, or a foreign slug is 404; another suffix is the portal', async () => {
  const { host, cookie } = await signIn();
  const before = dials.length;
  for (const h of [
    `app-ws-1-80.${SUFFIX}`, // below 1024
    `app-ws-1-99999.${SUFFIX}`,
    `app-x.${SUFFIX}`,
    `app-ws-1.${SUFFIX}`,
    hostFor('other', appPort), // another workspace: the cookie is not its
    hostFor('ws-1', appPort === 65535 ? 65534 : appPort + 1), // another port of the same workspace
    hostFor('ws-1', portalPort), // the portal's own port is never an app
  ]) {
    const r = await send('GET', '/echo', { host: h, cookie });
    assert.equal(r.status, 404, h);
    assert.equal(r.body, 'Not found.', h);
  }
  assert.equal((await send('GET', '/echo', { host })).status, 404, 'no cookie');
  assert.equal((await send('GET', '/echo', { host, cookie: '__pilot_app=forged' })).status, 404, 'a made-up cookie');
  assert.equal(dials.length, before, 'nothing was dialed');
  assert.equal((await send('GET', '/echo', { host: `app-ws-1-${appPort}.evil.test`, cookie })).body, 'portal');
  assert.equal((await send('GET', '/', { host: `pilot.${SUFFIX}` })).body, 'portal');
  assert.equal(await wsStatus({ host: `pilot.${SUFFIX}` }), 418, 'the portal’s own sockets still get their upgrades');
});

test('open refuses the portal’s own port, a bad path, and is off without a suffix', async () => {
  await assert.rejects(open('ws-1', portalPort), /port/i);
  await assert.rejects(open('ws-1', 80), /port/i);
  await assert.rejects(open('ws-1', appPort, '//evil.test'), /path/i);
  await assert.rejects(open('ws-1', appPort, '/中'), /path/i);
  await assert.rejects(open('nope', appPort), /Not found/);
  const off = new AppPorts({ suffix: undefined, portalPort, workspaces: {} as never, sessionValid: () => true, dial: async () => assert.fail('off') });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.list('docker', 'ws-1'), { enabled: false, ports: [] });
  await assert.rejects(off.open('docker', 'ws-1', { port: 8080 }, { actor, actorString: 'x', userId: null, sessionToken: SESSION, portalOrigin: 'http://p' }), /Not found/);
});

test('an exception inside a request is a 502, never a hung request', { timeout: 15_000 }, async () => {
  const { url } = await open('ws-1', appPort);
  const u = new URL(url);
  const redeem = ports.grants.redeem;
  ports.grants.redeem = () => {
    throw new Error('boom');
  };
  try {
    const r = await send('GET', `${u.pathname}${u.search}`, { host: u.host });
    assert.equal(r.status, 502);
    assert.equal(r.headers['set-cookie'], undefined);
  } finally {
    ports.grants.redeem = redeem;
  }
});

test('the Location is percent-encoded outside printable ASCII (a second guard behind isAppPortNext)', () => {
  assert.equal(asLocation('/中?q=é#x'), '/%E4%B8%AD?q=%C3%A9#x');
  assert.equal(asLocation('/a b'), '/a%20b');
  assert.equal(asLocation('/a%20b?c=d'), '/a%20b?c=d', 'what is already encoded stays as it is');
});

test('an upgrade whose workspace never connects ends in 504 after the timeout, not a socket held for ever', { timeout: 15_000 }, async () => {
  const { host, cookie } = await signIn();
  hangDial = true;
  try {
    const t0 = Date.now();
    assert.equal(await wsStatus({ host, cookie }, `http://${host}`), 504);
    assert.ok(Date.now() - t0 >= 1900, 'not before the timeout');
  } finally {
    hangDial = false;
  }
});

test('two workspaces with one name on different targets: CONFLICT, and no code is minted', async () => {
  const grants = new AppPortGrants();
  const twins = new AppPorts({
    suffix: SUFFIX,
    portalPort,
    workspaces: { list: async () => [{ id: 'docker/twin', name: 'twin' }, { id: 'kubernetes/twin', name: 'Twin' }], hooks: {}, resolve: () => null } as never,
    sessionValid: () => true,
    grants,
    dial: async () => assert.fail('no dial'),
  });
  await assert.rejects(
    twins.open('docker', 'twin', { port: appPort }, { actor, actorString: 'x', userId: null, sessionToken: SESSION, portalOrigin: `http://pilot.${SUFFIX}` }),
    (e: Error & { code?: string }) => e.code === 'CONFLICT' && /same name/.test(e.message),
  );
  assert.equal(grants.size.codes, 0);
});
