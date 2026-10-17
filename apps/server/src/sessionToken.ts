// The one place a session token is read and turned into a sign-in (T-1043, D-82). The HTTP route guard, the session guard, the sign-in
// routes (app.ts) and every socket (sockets.ts, the shell, the browser view, chat, live) read the cookie here, with Hono's own parser
// (what `getCookie` uses), so a renamed cookie (T-976: `__Host-portal_session`) is read the same way on every door.
import type { IncomingMessage } from 'node:http';
import { parse } from 'hono/utils/cookie';
import type { SignedIn } from './authz/routeGuard.js';
import type { Portal } from './portal.js';

/** The session token in a `Cookie` header, under the cookie `name` (config.session.cookie). */
export function sessionTokenFrom(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  return parse(header, name)[name] || undefined;
}

/** The session token of a socket's handshake (WebSocket handshakes carry the session cookie). */
export const sessionTokenOf = (req: IncomingMessage, name: string): string | undefined => sessionTokenFrom(req.headers.cookie, name);

/**
 * Who a session token signs in: a full session (the server code, an admin account), a member account, or nobody. Both guards decide for
 * this (the HTTP route guard in app.ts, the socket guard through `signedInOf`); only a full session is the founding owner.
 */
export function signedInFor(portal: Pick<Portal, 'session' | 'anySession'>, token: string | undefined): SignedIn {
  if (!token) return null;
  if (portal.session(token)) return { full: true };
  const s = portal.anySession(token);
  return s?.userId ? { full: false, userId: s.userId } : null;
}
