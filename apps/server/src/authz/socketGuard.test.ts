// T-1043 S0b (D-82): the socket guard. Every WebSocket upgrade goes through `onSocket` and its declared socket policy, for the real actor:
// nothing listens for `upgrade` by itself (a source scan and the listeners on a server wired like index.ts), a member is refused a socket or
// a message its declaration does not allow with exactly what an unknown target gets, the founding owner goes on untouched, an open door
// (the agents' tunnel) is its own check, and a member's sockets end when its sign-in ends (an admin made a member too).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHAT_SOCKET_PATH, CONNECT_PUBLIC, LIVE_PATH } from '@portal/contracts';
import WebSocket, { WebSocketServer } from 'ws';
import { attachBrowserSockets } from '../browser/socket.js';
import { attachChat } from '../chat/socket.js';
import { openCore, openHub } from '../connect/testkit.js';
import { LiveHub } from '../live.js';
import { Portal } from '../portal.js';
import { SocketGuard, fullSessionOf, signedInOf } from '../sockets.js';
import { attachShell } from '../workspaces/shell.js';
import { SHELL_SOCKET_PATH } from '../workspaces/authz.js';
import type { SignedIn } from './routeGuard.js';
import { SOCKET_GUARD_NAME, UPGRADE_NOT_FOUND, attachedSockets, declareSocketPolicies, declaredSockets, onSocket, socketPolicyFor, type SocketGrant } from './socketGuard.js';

const MEMBER = 'u_member1';
const COOKIE = 'portal_session';
const CODE = '24681357';
const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

/** Who a handshake is, for the tests that do not need a real sign-in: the `x-who` header. */
const fakeSignedIn = (req: IncomingMessage): SignedIn => {
  const who = req.headers['x-who'];
  return who === 'owner' ? { full: true } : who === 'member' ? { full: false, userId: MEMBER } : null;
};

/** Everything a module may touch, recorded: a refused member must touch nothing. */
const touched: string[] = [];
const spy = (what: string): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : (touched.push(`${what}.${String(p)}`), spy(`${what}.${String(p)}`))),
    apply: () => spy(`${what}()`),
  });

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** A raw WebSocket handshake; resolves with the answer's head (status line and headers), as the client reads it. */
function handshake(port: number, path: string, o: { who?: 'owner' | 'member'; origin?: string | false; headers?: string[] } = {}): Promise<string> {
  const origin = o.origin === undefined ? `http://127.0.0.1:${port}` : o.origin;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    ...(origin ? [`Origin: ${origin}`] : []),
    ...(o.who ? [`x-who: ${o.who}`] : []),
    ...(o.headers ?? []),
  ];
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(`${lines.join('\r\n')}\r\n\r\n`));
    let got = '';
    const done = () => {
      s.destroy();
      resolve(got);
    };
    s.on('data', (d) => {
      got += String(d);
      if (got.includes('\r\n\r\n')) done();
    });
    s.on('close', done);
    s.on('error', reject);
    s.setTimeout(3000, () => reject(new Error(`no answer for ${path}`)));
  });
}

const ALLOWED = 'HTTP/1.1 299 Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const status = (head: string): string => head.split('\r\n')[0] ?? '';

/** A server with the test sockets behind the guard, and the tracker in front (it answers an upgrade nobody took with the same 404). */
async function testSockets() {
  declareSocketPolicies('t', {
    '/t/sock/:id': { connect: { kind: 'signed-in' }, messages: { ok: { kind: 'signed-in' }, admin: { kind: 'platform', area: 'users', verb: 'view' } } },
    '/t/admin': { connect: { kind: 'platform', area: 'users', verb: 'view' }, messages: {} },
    '/t/open': { connect: { kind: 'handler', checks: ['a test door'] }, messages: {} },
  });
  const server = createServer();
  new SocketGuard(new Portal(CODE, 60_000), COOKIE, 100).attach(server);
  const grants: { path: string; grant: SocketGrant }[] = [];
  for (const path of ['/t/sock/:id', '/t/admin', '/t/open', '/t/undeclared'])
    onSocket(server, path, { signedIn: fakeSignedIn }, (_req, socket, _head, grant) => {
      grants.push({ path, grant });
      socket.end(ALLOWED);
    });
  const port = await listen(server);
  return { server, port, grants };
}

test('nothing in the server listens for `upgrade` but the socket guard and the session tracker (source scan)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      // The agent runs on the remote host (its own proxies), never in the portal; tests and their kits build their own servers.
      if (e.isDirectory()) {
        if (rel !== join('connect', 'agent')) walk(p);
      } else if (/\.ts$/.test(e.name) && !/\.test\.ts$|testkit\.ts$|\.generated\.ts$/.test(e.name) && /\.on\(\s*['"]upgrade['"]/.test(readFileSync(p, 'utf8'))) found.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(found.sort(), [join('authz', 'socketGuard.ts'), 'sockets.ts'].sort(), 'a module that needs a socket calls onSocket (authz/socketGuard.ts)');
});

test('every socket module of index.ts attaches through the guard, each with a declaration, and every declaration has its socket', async () => {
  const server = createServer();
  const portal = new Portal(CODE, 60_000);
  new SocketGuard(portal, COOKIE).attach(server);
  attachShell(server, portal, spy('workspaces') as never, fakeSignedIn);
  attachBrowserSockets(server, { portal, service: spy('browser') as never, signedIn: fakeSignedIn });
  new LiveHub({ workspaces: async () => [], usage: async () => [] }, () => false).attach(server, fakeSignedIn);
  attachChat(server, spy('chat') as never, () => false, fakeSignedIn);
  const names = server.listeners('upgrade').map((l) => l.name);
  assert.equal(names.filter((n) => n !== SOCKET_GUARD_NAME).length, 1, `only the session tracker is not the guard (${names.join(', ')})`);
  assert.ok(names.filter((n) => n === SOCKET_GUARD_NAME).length >= 5, 'shell, two browser views, live and chat');

  const core = await openCore();
  const hub = await openHub(core);
  try {
    assert.deepEqual(
      hub.server.listeners('upgrade').map((l) => l.name),
      [SOCKET_GUARD_NAME],
      'the agents’ tunnel too',
    );
  } finally {
    await hub.close();
  }

  const real = (p: string) => !p.startsWith('/t/');
  for (const p of attachedSockets().filter(real)) assert.ok(socketPolicyFor(p), `${p}: attached with no declaration`);
  assert.deepEqual(declaredSockets().filter(real).sort(), attachedSockets().filter(real).sort(), 'no declaration for a socket nobody serves');
  for (const p of [SHELL_SOCKET_PATH, LIVE_PATH, CHAT_SOCKET_PATH, CONNECT_PUBLIC.tunnel]) assert.ok(attachedSockets().includes(p), p);
});

test('the handshake: the owner goes on, a member as declared, nobody 401, another site 403, a refusal reads like an unknown path', async () => {
  const { port, grants } = await testSockets();
  const unknown = await handshake(port, '/t/nobody-serves-this', { who: 'member' });
  assert.equal(unknown, UPGRADE_NOT_FOUND, 'the tracker answers an upgrade nobody took');

  assert.equal(await handshake(port, '/t/sock/a1', { who: 'owner' }), ALLOWED);
  assert.equal(await handshake(port, '/t/sock/a1', { who: 'member' }), ALLOWED, '`signed-in`: a member goes on');
  assert.equal(status(await handshake(port, '/t/sock/a1')), 'HTTP/1.1 401 Unauthorized');
  assert.equal(status(await handshake(port, '/t/sock/a1', { who: 'owner', origin: 'https://evil.example' })), 'HTTP/1.1 403 Forbidden');
  assert.equal(status(await handshake(port, '/t/sock/a1', { who: 'owner', origin: false })), 'HTTP/1.1 403 Forbidden', 'no Origin is no page of ours');

  const before = grants.length;
  assert.equal(await handshake(port, '/t/admin', { who: 'member' }), unknown, 'a platform socket refuses a member like an unknown path');
  assert.equal(await handshake(port, '/t/undeclared', { who: 'member' }), unknown, 'a socket with no declaration too');
  assert.equal(grants.length, before, 'and the module never ran');
  assert.equal(await handshake(port, '/t/admin', { who: 'owner' }), ALLOWED, 'the founding owner goes on untouched');
  assert.equal(await handshake(port, '/t/undeclared', { who: 'owner' }), ALLOWED);

  assert.equal(await handshake(port, '/t/open', { origin: false }), ALLOWED, 'an open door is its own check: no cookie, no Origin');
  assert.equal(grants.at(-1)?.grant.actor.kind, 'anonymous', 'and it gets nobody, never a user');
  assert.equal(grants.find((g) => g.path === '/t/sock/:id')?.grant.params.id, 'a1');
});

test('each message: the owner goes on, a member only with a type its declaration allows', async () => {
  const { port, grants } = await testSockets();
  await handshake(port, '/t/sock/m1', { who: 'member' });
  const member = grants.at(-1)!.grant;
  assert.equal(await member.allows('ok', {}), true);
  assert.equal(await member.allows('admin', {}), false, 'a platform message refuses a member');
  assert.equal(await member.allows('no-such-type', {}), false, 'a type with no declaration is refused');
  await handshake(port, '/t/sock/o1', { who: 'owner' });
  const owner = grants.at(-1)!.grant;
  for (const t of ['ok', 'admin', 'no-such-type']) assert.equal(await owner.allows(t, {}), true, `the owner: ${t}`);
});

test('the real modules: a member gets the unknown path’s 404 from the terminal and the live socket, and they never run', async () => {
  const server = createServer();
  const portal = new Portal(CODE, 60_000);
  new SocketGuard(portal, COOKIE, 100).attach(server);
  attachShell(server, portal, spy('workspaces') as never, fakeSignedIn);
  new LiveHub({ workspaces: async () => (touched.push('live.workspaces'), []), usage: async () => [] }, () => true).attach(server, fakeSignedIn);
  const port = await listen(server);
  const unknown = await handshake(port, '/api/no-such-socket', { who: 'member' });
  assert.equal(unknown, UPGRADE_NOT_FOUND);
  const before = touched.length;
  assert.equal(await handshake(port, '/api/workspaces/docker/w1/shell', { who: 'member' }), unknown, '`operate` on a workspace the member has no right to');
  assert.equal(await handshake(port, '/api/workspaces/docker/w1/shell?term=t1', { who: 'member' }), unknown);
  assert.equal(await handshake(port, LIVE_PATH, { who: 'member' }), unknown, 'the live socket is the platform’s until it filters per person');
  assert.deepEqual(touched.slice(before), [], 'no module touched anything for the member');
  assert.equal(status(await handshake(port, LIVE_PATH, { who: 'owner' })), 'HTTP/1.1 101 Switching Protocols', 'the owner still opens it');
});

test('T-976 `__Host-` cookie: the sockets read the session through the shared reader, the guard, the module and the tracker alike', async () => {
  const name = ['__Host', 'portal_session'].join('-');
  const portal = new Portal(CODE, 60_000);
  portal.roleOf = (id) => (id === MEMBER ? 'member' : null);
  const server = createServer();
  const tracker = new SocketGuard(portal, name, 100);
  tracker.attach(server);
  attachShell(server, portal, spy('workspaces') as never, signedInOf(portal, name));
  new LiveHub({ workspaces: async () => [], usage: async () => [] }, fullSessionOf(portal, name)).attach(server, signedInOf(portal, name));
  const port = await listen(server);
  const as = (token: string, cookie = name) => ({ headers: [`Cookie: theme=dark; ${cookie}=${token}`] });
  const unknown = await handshake(port, '/api/no-such-socket');
  const owner = portal.signIn(CODE);
  const member = portal.openSession(MEMBER);
  const before = touched.length;
  assert.equal(await handshake(port, '/api/workspaces/docker/w1/shell', as(member)), unknown, 'a member under that name is signed in: the 404, never the 401 of nobody');
  assert.equal(await handshake(port, LIVE_PATH, as(member)), unknown);
  assert.deepEqual(touched.slice(before), []);
  assert.match(status(await handshake(port, LIVE_PATH, as(owner, COOKIE))), /^HTTP\/1\.1 401 /, 'the old name is not the session any more');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: `${name}=${owner}` } });
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  assert.equal(tracker.size, 1, 'the tracker ties the socket to the `__Host-` sign-in');
  const gone = new Promise<void>((r) => ws.once('close', () => r()));
  portal.signOut(owner);
  tracker.sweep();
  await gone;
  assert.equal(tracker.size, 0);
  tracker.close();
});

test('the chat socket: a member’s message on a session it may not see gets what a session that does not exist gets', async () => {
  const server = createServer();
  attachChat(server, spy('chat') as never, () => true, fakeSignedIn);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CHAT_SOCKET_PATH}`, { headers: { Origin: `http://127.0.0.1:${port}`, 'x-who': 'member' } });
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  const before = touched.length;
  const reply = new Promise<Record<string, unknown>>((r) => ws.once('message', (d) => r(JSON.parse(String(d)) as Record<string, unknown>)));
  ws.send(JSON.stringify({ type: 'subscribe', session: 's_other1' }));
  assert.deepEqual(await reply, { type: 'removed', session: 's_other1' });
  assert.deepEqual(touched.slice(before), [], 'the controller was never asked');
  ws.close();
});

test('revocation: a member’s socket ends with its sign-in, an admin made a member loses its full sockets, a live member keeps its own', async () => {
  const portal = new Portal(CODE, 60_000);
  const roles = new Map<string, 'admin' | 'member'>([
    [MEMBER, 'member'],
    ['u_admin1', 'admin'],
    ['u_member2', 'member'],
  ]);
  portal.roleOf = (id) => roles.get(id) ?? null;
  const server = createServer();
  const guard = new SocketGuard(portal, COOKIE, 100);
  guard.attach(server);
  portal.onRevoked = () => guard.sweep();
  declareSocketPolicies('t', { '/t/sock/:id': { connect: { kind: 'signed-in' }, messages: { ok: { kind: 'signed-in' }, admin: { kind: 'platform', area: 'users', verb: 'view' } } } });
  const wss = new WebSocketServer({ noServer: true });
  onSocket(server, '/t/sock/:id', { signedIn: signedInOf(portal, COOKIE) }, (req, socket, head) => wss.handleUpgrade(req, socket, head, () => undefined));
  const port = await listen(server);
  const open = (token: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/t/sock/r1`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: `${COOKIE}=${token}` } });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once('close', () => r())));

  const member = await open(portal.openSession(MEMBER));
  const admin = await open(portal.openSession('u_admin1'));
  const other = await open(portal.openSession('u_member2'));
  assert.equal(guard.size, 3, 'a member’s socket is tracked like a full one');

  roles.delete(MEMBER); // the account is disabled: its sign-in ends
  roles.set('u_admin1', 'member'); // an admin made a member: its sign-in is no longer the full one its socket opened with
  guard.sweep();
  await closed(member);
  await closed(admin);
  assert.equal(other.readyState, WebSocket.OPEN, 'a member still signed in keeps its socket');
  assert.equal(guard.size, 1);

  const token = portal.openSession('u_member2');
  const second = await open(token);
  const gone = closed(second);
  portal.signOut(token);
  await gone;
  assert.equal(other.readyState, WebSocket.OPEN, 'signing out one sign-in leaves the others');
  other.close();
  guard.close();
});
