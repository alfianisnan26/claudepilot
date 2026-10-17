import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SignedIn } from './authz/routeGuard.js';
import type { Portal } from './portal.js';

/** How often sessions are re-checked, for the ones that end by expiring (sign-out and a new code cut at once). */
const SWEEP_MS = 15_000;
/** An upgrade request nobody has answered by then is dropped (a path no module owns would otherwise hang for ever). */
const UNANSWERED_MS = 5_000;

const tokenOf = (req: IncomingMessage, name: string): string | undefined => {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

/**
 * Who a handshake's cookie signs in, as the HTTP guard reads it (app.ts): a full session (the server code, an admin account), a member
 * account, or nobody. The socket guard (authz/socketGuard.ts, T-1043 S0b) decides for it; a module's own check still asks `session()`.
 */
export const signedInOf =
  (portal: Pick<Portal, 'session' | 'anySession'>, cookie: string) =>
  (req: IncomingMessage): SignedIn => {
    const token = tokenOf(req, cookie);
    if (!token) return null;
    if (portal.session(token)) return { full: true };
    const s = portal.anySession(token);
    return s?.userId ? { full: false, userId: s.userId } : null;
  };

/**
 * Ties the sockets a signed-in tab opens (live updates, chat, terminals) to its session. Each module checks the
 * session once, at the handshake; this keeps the connection with its session token and cuts it when that
 * session ends: sign-out, a new server code (everyone else is signed out) or expiry. Attach it BEFORE the
 * modules' own `upgrade` listeners. It also answers 404 to an upgrade nobody answered, so such a request can't
 * hold a connection open without signing in.
 */
export class SocketGuard {
  readonly #open = new Map<string, Set<Duplex>>();
  readonly #timer: NodeJS.Timeout;

  constructor(
    private readonly portal: Pick<Portal, 'session'>,
    private readonly cookie: string,
    private readonly unansweredMs = UNANSWERED_MS,
  ) {
    this.#timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.#timer.unref();
  }

  attach(server: Server) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      const unanswered = setTimeout(() => {
        if (socket.destroyed || socket.writableEnded || ((socket as { bytesWritten?: number }).bytesWritten ?? 0) > 0) return;
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }, this.unansweredMs);
      unanswered.unref();
      socket.once('close', () => clearTimeout(unanswered));

      const token = tokenOf(req, this.cookie);
      if (!token || !this.portal.session(token)) return; // the owner of the path answers 401
      let sockets = this.#open.get(token);
      if (!sockets) this.#open.set(token, (sockets = new Set()));
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        if (sockets.size === 0 && this.#open.get(token) === sockets) this.#open.delete(token);
      });
    });
  }

  /** Cuts every tracked socket whose session has ended. Called on sign-out, on a new code and on a timer. */
  sweep() {
    for (const [token, sockets] of this.#open) {
      if (this.portal.session(token)) continue;
      for (const socket of sockets) socket.destroy();
      this.#open.delete(token);
    }
  }

  /** Open tracked sockets, for tests and diagnostics. */
  get size() {
    let n = 0;
    for (const sockets of this.#open.values()) n += sockets.size;
    return n;
  }

  close() {
    clearInterval(this.#timer);
  }
}
