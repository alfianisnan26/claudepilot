import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SignedIn } from '../authz/routeGuard.js';
import { UPGRADE_NOT_FOUND, declareSocketPolicies, onSocket } from '../authz/socketGuard.js';
import { config } from '../config.js';
import type { Portal } from '../portal.js';
import { signedInOf } from '../sockets.js';
import { BROWSER_SOCKET_POLICIES } from './authz.js';
import { cookie } from '../workspaces/shell.js';
import { DEVICE_ID, deviceLabel } from './control.js';
import { secureContext } from './routes.js';
import type { BrowserService } from './service.js';
import { PreviewSession } from './preview.js';
import { VncSession } from './view.js';

/**
 * The live-view sockets: `GET /api/workspaces/<target>/<name>/browser/view?device=<id>` upgrades to the VNC bridge
 * (browser PRD §12.1) and `…/browser/preview?device=<id>` to the proxy view (§22). Checked like the shell socket: the
 * Origin must be this host, the session cookie must be valid (the socket guard then cuts it when that session ends),
 * and the device must name itself, so a lease can follow the person from app to app. Nothing is published on a host
 * port, and nothing but these reaches the display or the browser's debugging port.
 */

const PATH = /^\/api\/workspaces\/([a-z0-9-]+)\/([a-z0-9-]+)\/browser\/(view|preview)$/;

/** Browsers send cookies on cross-site WebSocket handshakes, so the Origin must be this host. */
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

export function attachBrowserSockets(server: Server, deps: { portal: Portal; service: BrowserService; signedIn?: (req: IncomingMessage) => SignedIn }) {
  const vnc = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  // The preview's messages from a page are small JSON (16 KB at most, validated again after); frames only go out.
  const preview = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });

  // T-1043 S0b: both behind the socket guard, with their declarations (`operate` on the workspace, as the browser's control route).
  declareSocketPolicies('browser', BROWSER_SOCKET_POLICIES);
  const guarded = { signedIn: deps.signedIn ?? signedInOf(deps.portal, config.session.cookie) };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = PATH.exec(url.pathname);
    if (!match) return void socket.end(UPGRADE_NOT_FOUND); // a name no workspace can have
    if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
    if (!deps.portal.session(cookie(req, config.session.cookie))) return refuse(socket, 401, 'Unauthorized');
    const device = url.searchParams.get('device') ?? '';
    if (!DEVICE_ID.test(device)) return refuse(socket, 400, 'Bad Request');
    const workspaceId = `${match[1]}/${match[2]}`;
    if (deps.service.configuration(workspaceId).container !== 'running') return refuse(socket, 409, 'Conflict');
    const secure = secureContext(req, req.headers['x-forwarded-proto'] as string | undefined);
    deviceLabel(url.searchParams.get('label')); // validated where it is used (the control route)
    const failed = (ws: WebSocket) => (e: unknown) => {
      console.error(`[browser] live view of ${workspaceId}: ${(e as Error).message}`);
      ws.close(1011, 'Something went wrong.');
    };
    if (match[3] === 'preview')
      preview.handleUpgrade(req, socket, head, (ws) => void new PreviewSession({ ws, service: deps.service, workspaceId, device, secure }).run().catch(failed(ws)));
    else vnc.handleUpgrade(req, socket, head, (ws) => void new VncSession({ ws, service: deps.service, workspaceId, device, secure }).run().catch(failed(ws)));
  };
  for (const path of Object.keys(BROWSER_SOCKET_POLICIES)) onSocket(server, path, guarded, upgrade);

  return {
    close: () => {
      vnc.close();
      preview.close();
    },
  };
}
