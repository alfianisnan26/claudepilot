import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isAppError } from '@isnanme/core';
import type { ShellClientMessage, ShellServerMessage } from '@portal/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
<<<<<<< HEAD
import type { SignedIn } from '../authz/routeGuard.js';
import { UPGRADE_NOT_FOUND, declareSocketPolicies, onSocket } from '../authz/socketGuard.js';
import { config } from '../config.js';
import type { Portal } from '../portal.js';
import { sessionTokenOf } from '../sessionToken.js';
import { signedInOf } from '../sockets.js';
import { SHELL_SOCKET_PATH, SHELL_SOCKET_POLICIES } from './authz.js';
=======
import type { Portal } from '../portal.js';
import { sessionOfRequest } from '../sessionCookie.js';
>>>>>>> origin/ticket/T-976-merge
import { runtimeMessage, type Workspaces } from './manager.js';
import { attachCommand, TERMINAL_ID } from './terminals.js';

const SHELL_PATH = /^\/api\/workspaces\/([a-z0-9-]+)\/([a-z0-9-]+)\/shell$/;
const PING_MS = 25_000;

/** Browsers send cookies on cross-site WebSocket handshakes, so the origin must be this host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

/**
 * `GET /api/workspaces/<target>/<name>/shell` upgrades to a WebSocket running a login shell in the
 * workspace. Binary frames are terminal bytes both ways; text frames are JSON control messages.
 */
export function attachShell(server: Server, portal: Portal, workspaces: Workspaces, signedIn: (req: IncomingMessage) => SignedIn = signedInOf(portal, config.session.cookie)) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  // T-1043 S0b: behind the socket guard, with its declaration (`operate` on the workspace, and on the terminal `?term=` names).
  declareSocketPolicies('workspaces', SHELL_SOCKET_POLICIES);
  onSocket(server, SHELL_SOCKET_PATH, { signedIn }, (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(SHELL_PATH);
    if (!match) return void socket.end(UPGRADE_NOT_FOUND); // a name no workspace can have
    if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
<<<<<<< HEAD
    if (!portal.session(sessionTokenOf(req, config.session.cookie))) return refuse(socket, 401, 'Unauthorized');
=======
    if (!portal.session(sessionOfRequest(req))) return refuse(socket, 401, 'Unauthorized');
>>>>>>> origin/ticket/T-976-merge

    const [, target, name] = match as unknown as [string, string, string];
    const size = {
      cols: clamp(Number(url.searchParams.get('cols')), 20, 500),
      rows: clamp(Number(url.searchParams.get('rows')), 5, 200),
    };
    // `?term=claude-1`: attach to that terminal (a tmux session that outlives this socket).
    const term = url.searchParams.get('term');
    if (term !== null && !TERMINAL_ID.test(term)) return refuse(socket, 400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, (ws) => void run(ws, target, name, size, term ?? undefined));
  });

  async function run(ws: WebSocket, target: string, name: string, size: { cols: number; rows: number }, term?: string) {
    const send = (msg: ShellServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    let shell;
    try {
      shell = await workspaces.shell(target, name, size, term ? attachCommand(term) : undefined);
    } catch (e) {
      send({ type: 'error', message: isAppError(e) ? e.message : runtimeMessage(e) });
      return ws.close(1011);
    }
    console.log(`[workspaces] shell opened in ${target}/${name}${term ? ` (${term})` : ''}`);
    send({ type: 'ready' });

    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on('pong', () => (alive = true));

    shell.onData((data) => ws.readyState === ws.OPEN && ws.send(data, { binary: true }));
    shell.onExit((code) => {
      send({ type: 'exit', code });
      ws.close(1000);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return shell.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      try {
        const msg = JSON.parse(String(data)) as ShellClientMessage;
        if (msg.type === 'resize') shell.resize(clamp(msg.cols, 20, 500), clamp(msg.rows, 5, 200));
      } catch {
        // ignore malformed control frames
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      shell.close();
      console.log(`[workspaces] shell closed in ${target}/${name}`);
    });
  }
}
