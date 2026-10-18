// A session token turned into a sign-in (T-1043, D-82). The token itself is read by ONE reader, sessionCookie.ts (T-976:
// `__Host-portal_session` wins, the old `portal_session` only when it is absent): the HTTP route guard, the session guard, the sign-in
// routes (app.ts) and every socket (sockets.ts, the shell, the browser view, chat, live) read it through the two thin callers below.
import type { IncomingMessage } from 'node:http';
import type { SignedIn } from './authz/routeGuard.js';
import type { Portal } from './portal.js';
import { sessionFromCookies, sessionOfRequest } from './sessionCookie.js';

/** The session token in a `Cookie` header: sessionCookie.ts's read rule. */
export const sessionTokenFrom = (header: string | null | undefined): string | undefined => sessionFromCookies(header ?? undefined).token || undefined;

/** The session token of a socket's handshake (WebSocket handshakes carry the session cookie): sessionCookie.ts's read rule. */
export const sessionTokenOf = (req: IncomingMessage): string | undefined => sessionOfRequest(req) || undefined;

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
