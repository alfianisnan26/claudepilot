// Which page may change state with the session cookie, or open a socket (PILOT-1139, epic PILOT-1131). One rule for every door: the HTTP
// middleware in app.ts and the socket handshakes (live, chat, shell, browser). No `node:` import: it moves to the Worker as is.

/**
 * The page that sent this request is this portal: its Origin, exactly as a browser writes it, is http or https and names the request's own
 * Host. The scheme is not compared, since TLS ends at a proxy and the server sees http (T-143); x-forwarded-* is not trusted.
 */
export function sameHostOrigin(origin: string, host: string | undefined): boolean {
  try {
    const o = new URL(origin);
    return (o.protocol === 'http:' || o.protocol === 'https:') && o.origin === origin && host !== undefined && o.host === host;
  } catch {
    return false;
  }
}

/**
 * `PORTAL_ALLOWED_ORIGINS`: comma-separated origins allowed besides the request's own host (the public host in front of this one, e.g.
 * `https://pilot-next.<zone>`). Only well-formed `http(s)://host[:port]` entries are kept; anything with a path, another scheme or junk is
 * dropped, so a typo never widens the list.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s) out.push(s);
    } catch {
      // dropped
    }
  }
  return out;
}

/** The request's own host, or exactly one of the configured origins (scheme, host and port all equal). */
export function originAllowed(origin: string, host: string | undefined, allowed: readonly string[]): boolean {
  return sameHostOrigin(origin, host) || allowed.includes(origin);
}

/**
 * A browser request from another site. Browsers name the Origin on every request that is not a plain GET: when there is one, it decides.
 * Without one, `Sec-Fetch-Site: cross-site` does. With neither header the caller is not a browser (an agent, a CLI) and carries no
 * ambient cookie a page could ride.
 */
export function crossSite(h: { origin?: string; secFetchSite?: string; host?: string }, allowed: readonly string[]): boolean {
  if (h.origin !== undefined) return !originAllowed(h.origin, h.host, allowed);
  return h.secFetchSite === 'cross-site';
}

/** A socket handshake from a browser always names its Origin: none, or one not allowed, is refused. */
export function socketOriginAllowed(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && originAllowed(origin, host, allowed);
}

/**
 * The doors outside the check, each one cookieless by design: `/mcp` (bearer tokens), `/connect/` (agents: an enrollment token or a signed
 * challenge; it refuses any request with an Origin itself) and `/hooks/` (CI and platform webhooks: a token in the path). The UI reporter's
 * `/reporter/v1/` stays checked: its panel API and connect popup are this portal's own pages. A new entry needs a review: the door must never
 * read the session cookie.
 */
export const ORIGIN_EXEMPT: readonly string[] = ['/mcp', '/connect/', '/hooks/'];

export function originExempt(path: string): boolean {
  return ORIGIN_EXEMPT.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));
}

export const CROSS_SITE_MESSAGE = 'Refused: this request came from another site.';
