import type { IncomingMessage } from 'node:http';
import { config } from './config.js';

/**
 * The portal session cookie (docs/prd/authorization.md, "The session cookie"; T-976). Over https it is `__Host-portal_session`: Secure,
 * Path=/, no Domain, so a page on a sibling host (an app host of T-948, `app-<ws>-<port>.<suffix>`) can neither read it nor set one that
 * replaces it: browsers refuse a `__Host-` cookie that has a Domain or no Secure. Over plain http (a dev or scratch portal) a Secure cookie is
 * not stored, so the name stays `portal_session`.
 *
 * The read rule, the same for the API and every socket: the `__Host-` name wins whenever it is there; the old name is read only when it is
 * absent. A `portal_session` planted with `Domain=<parent>` by a sibling host therefore never overrides the real session. The old name is
 * read on https for one release (a session from before the change is re-issued under the new name, so a deploy signs nobody out); a
 * follow-up ticket drops it there (T-976).
 */
export const SESSION_COOKIE = '__Host-portal_session';
export const LEGACY_SESSION_COOKIE = 'portal_session';

/** Every value of one cookie name in a Cookie header (a browser sends the same name twice when two cookies of different scope match). */
function values(header: string | undefined, name: string): string[] {
  const out: string[] = [];
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try {
      out.push(decodeURIComponent(part.slice(i + 1).trim()));
    } catch {
      /* not a value we made */
    }
  }
  return out;
}

/** The session token a Cookie header carries, and whether it came under the old name. */
export function sessionFromCookies(header: string | undefined): { token: string | undefined; legacy: boolean } {
  const current = values(header, SESSION_COOKIE);
  if (current.length) return { token: current[0], legacy: false };
  return { token: values(header, LEGACY_SESSION_COOKIE)[0], legacy: true };
}

/** The session token of a socket handshake (or any raw request). */
export function sessionOfRequest(req: IncomingMessage): string | undefined {
  return sessionFromCookies(req.headers.cookie).token;
}

/** Whether the browser reached the portal over https: TLS here, or (behind a trusted proxy) the last `X-Forwarded-Proto` says so. */
export function overHttps(url: string, forwardedProto: string | undefined): boolean {
  if (url.startsWith('https:')) return true;
  return config.trustProxy && forwardedProto?.split(',').at(-1)?.trim() === 'https';
}

/** The name and attributes the session cookie is set with. */
export function sessionCookieSpec(https: boolean, ttlMs: number) {
  return {
    name: https ? SESSION_COOKIE : LEGACY_SESSION_COOKIE,
    options: { httpOnly: true, sameSite: 'Strict' as const, path: '/', maxAge: Math.floor(ttlMs / 1000), ...(https ? { secure: true } : {}) },
  };
}
