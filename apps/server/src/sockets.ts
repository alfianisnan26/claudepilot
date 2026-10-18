import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SignedIn } from './authz/routeGuard.js';
import type { Portal } from './portal.js';
import { sessionTokenOf, signedInFor } from './sessionToken.js';

/** How often sessions are re-checked, for the ones that end by expiring (sign-out and a new code cut at once). */
const SWEEP_MS = 15_000;
/** An upgrade request nobody has answered by then is dropped (a path no module owns would otherwise hang for ever). */
const UNANSWERED_MS = 5_000;

<<<<<<< HEAD
/**
 * Who a handshake's cookie signs in, exactly as the HTTP guard reads it (app.ts; both through sessionToken.ts): a full session (the server
 * code, an admin account), a member account, or nobody. The socket guard (authz/socketGuard.ts, T-1043 S0b) decides for it.
 */
export const signedInOf =
  (portal: Pick<Portal, 'session' | 'anySession'>, cookie: string) =>
  (req: IncomingMessage): SignedIn =>
    signedInFor(portal, sessionTokenOf(req, cookie));

/** Whether a handshake carries a full session (the server code, an admin account): a module's own check (the shell, the browser, chat). */
export const fullSessionOf =
  (portal: Pick<Portal, 'session'>, cookie: string) =>
  (req: IncomingMessage): boolean =>
    !!portal.session(sessionTokenOf(req, cookie));

=======
>>>>>>> origin/ticket/T-976-merge
/**
 * Ties the sockets a signed-in tab opens (live updates, chat, terminals) to its session. Each module checks the
 * session once, at the handshake; this keeps the connection with its session token and cuts it when that
 * session ends: sign-out, a new server code (everyone else is signed out) or expiry. Attach it BEFORE the
 * modules' own `upgrade` listeners. It also answers 404 to an upgrade nobody answered, so such a request can't
 * hold a connection open without signing in.
 */
export class SocketGuard {
  /** By token: the sockets it opened, and whether it was a full sign-in then (T-1043 S0b: a member's sockets are tracked too). */
  readonly #open = new Map<string, { full: boolean; sockets: Set<Duplex> }>();
  readonly #timer: NodeJS.Timeout;

  constructor(
<<<<<<< HEAD
    private readonly portal: Pick<Portal, 'session'> & Partial<Pick<Portal, 'anySession'>>,
    private readonly cookie: string,
=======
    private readonly portal: Pick<Portal, 'session'>,
    /** The session token of a handshake (sessionCookie.ts `sessionOfRequest`: the same read rule as the API). */
    private readonly tokenOf: (req: IncomingMessage) => string | undefined,
>>>>>>> origin/ticket/T-976-merge
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

<<<<<<< HEAD
      const token = sessionTokenOf(req, this.cookie);
      if (!token) return; // the owner of the path answers 401
      const full = !!this.portal.session(token);
      if (!full && !this.portal.anySession?.(token)) return;
      let entry = this.#open.get(token);
      // Once any socket of this sign-in opened as a full one, all of them must stay full (the stricter mark: an admin made a member is cut).
      if (!entry) this.#open.set(token, (entry = { full, sockets: new Set() }));
      else entry.full ||= full;
      const tracked = entry;
      tracked.sockets.add(socket);
=======
      const token = this.tokenOf(req);
      if (!token || !this.portal.session(token)) return; // the owner of the path answers 401
      let sockets = this.#open.get(token);
      if (!sockets) this.#open.set(token, (sockets = new Set()));
      sockets.add(socket);
>>>>>>> origin/ticket/T-976-merge
      socket.once('close', () => {
        tracked.sockets.delete(socket);
        if (tracked.sockets.size === 0 && this.#open.get(token) === tracked) this.#open.delete(token);
      });
    });
  }

  /** Whether the sign-in is still what it was: a full one must still be full (an admin made a member is cut), a member's still live. */
  #stillSignedIn(token: string, full: boolean): boolean {
    return full ? !!this.portal.session(token) : !!this.portal.anySession?.(token);
  }

  /** Cuts every tracked socket whose session has ended (or is no longer full). Called on sign-out, on a new code and on a timer. */
  sweep() {
    for (const [token, { full, sockets }] of this.#open) {
      if (this.#stillSignedIn(token, full)) continue;
      for (const socket of sockets) socket.destroy();
      this.#open.delete(token);
    }
  }

  /** Open tracked sockets, for tests and diagnostics. */
  get size() {
    let n = 0;
    for (const { sockets } of this.#open.values()) n += sockets.size;
    return n;
  }

  close() {
    clearInterval(this.#timer);
  }
}
