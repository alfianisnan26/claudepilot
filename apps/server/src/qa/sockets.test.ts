// QA regression (QA-001, QA-005): sockets end with the session that opened them, and an unanswered upgrade does not hang.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Portal } from '../portal.js';
import { SocketGuard } from '../sockets.js';

const CODE = '24681357';
const COOKIE = 'portal_session';
const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

/** A server whose `/ok` path upgrades for any caller (like the live socket after its own checks), guarded by SocketGuard. */
async function start(portal: Portal, unansweredMs = 150) {
  const server = createServer();
  servers.push(server);
  const guard = new SocketGuard(portal, COOKIE, unansweredMs);
  guard.attach(server);
  portal.onRevoked = () => guard.sweep();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ok') wss.handleUpgrade(req, socket, head, () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const open = (token: string, path = '/ok') =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Cookie: `${COOKIE}=${token}` } });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  return { server, guard, port, open };
}
const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('signing out cuts that session’s sockets and leaves the others', async () => {
  const portal = new Portal(CODE, 60_000);
  const [mine, theirs] = [portal.signIn(CODE), portal.signIn(CODE)];
  const { guard, open } = await start(portal);
  const a = await open(mine);
  const b = await open(theirs);
  const gone = closed(a);
  assert.equal(guard.size, 2);
  portal.signOut(mine);
  await gone;
  assert.equal(b.readyState, WebSocket.OPEN, 'another session’s socket is untouched');
  assert.equal(guard.size, 1);
  b.close();
  guard.close();
});

test('a new server code cuts every socket but the one that changed it', async () => {
  const portal = new Portal(CODE, 60_000);
  const [keeper, other] = [portal.signIn(CODE), portal.signIn(CODE)];
  const { guard, open } = await start(portal);
  const keep = await open(keeper);
  const drop = await open(other);
  const gone = closed(drop);
  portal.rotate(keeper, 'ABCD2345');
  await gone;
  assert.equal(keep.readyState, WebSocket.OPEN);
  keep.close();
  guard.close();
});

test('a session that expires loses its sockets on the next sweep', async () => {
  const portal = new Portal(CODE, 120);
  const token = portal.signIn(CODE);
  const { guard, open } = await start(portal);
  const ws = await open(token);
  const gone = closed(ws);
  await pause(160);
  guard.sweep();
  await gone;
  guard.close();
});

test('an upgrade for a path nobody owns is answered 404 instead of hanging', async () => {
  const portal = new Portal(CODE, 60_000);
  const token = portal.signIn(CODE);
  const { guard, open } = await start(portal, 100);
  await assert.rejects(() => open(token, '/nobody'), /404/);
  await assert.rejects(() => open('not-a-session', '/nobody'), /404/, 'a caller that is not signed in gets the same answer, not a hang');
  guard.close();
});
