// T-976 (QA #11040, mutant C6): the browser's live-view sockets read the session by the same rule as the API: the `__Host-` cookie wins,
// a planted old-name cookie next to a stale `__Host-` one does not open a socket. The handshake is answered before any browser work: a
// session that passes gets 409 (no running container in this fake), one that does not gets 401. Tokens come from Portal.signIn at run time.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import WebSocket from 'ws';
import { Portal } from '../portal.js';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from '../sessionCookie.js';
import type { BrowserService } from './service.js';
import { attachBrowserSockets } from './socket.js';

const CODE = '24681357';
const servers: Server[] = [];
after(() =>
  servers.forEach((s) => {
    s.closeAllConnections();
    s.close();
  }),
);

async function start(portal: Portal) {
  const server = createServer();
  servers.push(server);
  const service = {
    configuration: () => ({ container: 'stopped', error: null, sandbox: null, install: null }),
  } as unknown as BrowserService;
  attachBrowserSockets(server, { portal, service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** The handshake's HTTP status (101 when it opened). */
  const status = (cookie: string | null, view = 'view') =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}/api/workspaces/kubernetes/ws1/browser/${view}?device=device-0001`, {
        headers: { Origin: `http://${host}`, ...(cookie === null ? {} : { Cookie: cookie }) },
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once('open', () => {
        resolve(101);
        ws.terminate();
      });
      ws.once('error', (e) => (e.message.includes('Unexpected server response') ? undefined : reject(e)));
    });
  return { status };
}

test('T-976 browser socket: the __Host- session cookie opens it, none or a dead one does not', async () => {
  const portal = new Portal(CODE, 60_000);
  const mine = portal.signIn(CODE);
  const { status } = await start(portal);
  assert.equal(await status(`${SESSION_COOKIE}=${encodeURIComponent(mine)}`), 409, 'a valid __Host- session passes the session check');
  assert.equal(await status(`${SESSION_COOKIE}=${encodeURIComponent(mine)}`, 'preview'), 409, 'the preview socket reads it the same way');
  assert.equal(await status(null), 401);
  assert.equal(await status(`${SESSION_COOKIE}=dead${Date.now()}`), 401);
  portal.signOut(mine);
  assert.equal(await status(`${SESSION_COOKIE}=${encodeURIComponent(mine)}`), 401, 'a signed-out session no longer opens it');
});

test('T-976 browser socket: a planted old-name session next to a stale __Host- one is refused; the old name alone still works', async () => {
  const portal = new Portal(CODE, 60_000);
  const stale = portal.signIn(CODE);
  const planted = portal.signIn(CODE);
  portal.signOut(stale);
  const { status } = await start(portal);
  assert.equal(
    await status(`${LEGACY_SESSION_COOKIE}=${encodeURIComponent(planted)}; ${SESSION_COOKIE}=${encodeURIComponent(stale)}`),
    401,
    'the stale __Host- cookie decides',
  );
  assert.equal(
    await status(`${SESSION_COOKIE}=${encodeURIComponent(stale)}; ${LEGACY_SESSION_COOKIE}=${encodeURIComponent(planted)}`),
    401,
    'order does not matter',
  );
  assert.equal(
    await status(`${LEGACY_SESSION_COOKIE}=${encodeURIComponent(planted)}`),
    409,
    'until the old name is dropped, a browser with only it stays signed in',
  );
});
