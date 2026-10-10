import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isAppError } from '@isnanme/core';
import type { ShellClientMessage, ShellServerMessage } from '@portal/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.js';
import type { Portal } from '../portal.js';
import { runtimeMessage, type Workspaces } from './manager.js';

const SHELL_PATH = /^\/api\/workspaces\/([a-z0-9-]+)\/([a-z0-9-]+)\/shell$/;
const PING_MS = 25_000;

/** One cookie from an upgrade request (WebSocket handshakes carry the session cookie). */
export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

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
export function attachShell(server: Server, portal: Portal, workspaces: Workspaces) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(SHELL_PATH);
    if (!match) return; // not ours (Vite's HMR socket in dev)
    if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
    if (!portal.session(cookie(req, config.session.cookie))) return refuse(socket, 401, 'Unauthorized');

    const [, target, name] = match as unknown as [string, string, string];
    const size = {
      cols: clamp(Number(url.searchParams.get('cols')), 20, 500),
      rows: clamp(Number(url.searchParams.get('rows')), 5, 200),
    };
    wss.handleUpgrade(req, socket, head, (ws) => void run(ws, target, name, size));
  });

  async function run(ws: WebSocket, target: string, name: string, size: { cols: number; rows: number }) {
    const send = (msg: ShellServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    let shell;
    try {
      shell = await workspaces.shell(target, name, size);
    } catch (e) {
      send({ type: 'error', message: isAppError(e) ? e.message : runtimeMessage(e) });
      return ws.close(1011);
    }
    console.log(`[workspaces] shell opened in ${target}/${name}`);
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
