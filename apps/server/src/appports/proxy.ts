import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { APP_PORT_AUTH_PATH, isAppPortNext, parseAppPortHost, workspaceRef } from '@portal/contracts';
import { can } from '../authz/seam.js';
import { APP_COOKIE, type AppGrant, type AppPortGrants } from './grants.js';
import { NotOnThisTarget, type Dial } from './dial.js';

/**
 * App ports (docs/prd/app-ports.md §5-§7): the handler of every request and WebSocket upgrade whose Host is an app host
 * (`app-<name>-<port>.<suffix>`). It runs BEFORE the portal's own routes and socket modules, so an app host never reaches them and the portal
 * host never reaches this. Every refusal is the same bare 404, whatever the reason (a bad host, a denied port, no cookie, a cookie for another
 * host, the seam saying no, an ended portal session, a foreign Origin), so nothing tells an outsider which part was wrong.
 */

export interface AppPortProxyDeps {
  /** `PORT_PROXY_HOST_SUFFIX`; undefined: the feature is off and nothing is an app host. */
  suffix: string | undefined;
  grants: AppPortGrants;
  dial: Dial;
  /** Whether the portal session that opened the app is still signed in. */
  sessionValid: (token: string) => boolean;
  /** Ports never opened (the portal's own, the browser's CDP and supervisor, PORT_PROXY_DENY_PORTS). */
  deniedPorts: ReadonlySet<number>;
  /** How long an upgrade may wait for the app's first answer (dial included) before it is a 504; default 30 s. */
  upgradeTimeoutMs?: number;
}

const UPGRADE_TIMEOUT_MS = 30_000;

/** A path as a Location header can carry it: anything outside printable ASCII percent-encoded (isAppPortNext already refuses it; a 2nd guard). */
export const asLocation =(path: string): string => path.replace(/[^!-~]+/gu, (run) => encodeURI(run));

/** Hop-by-hop headers (RFC 9110 §7.6.1) and the ones the proxy sets itself: never copied either way. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
/** Request headers never forwarded to the app: the portal's credentials and what the proxy itself vouches for. */
const STRIP_REQUEST = new Set(['host', 'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip']);
/** Cookies never forwarded: the app host's own and the portal's. */
const PORTAL_COOKIES = new Set([APP_COOKIE, 'portal_session']);

const NOT_FOUND = 'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n\r\nNot found.';

const cookieOf = (header: string | undefined, name: string): string | undefined => {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
};

/** The Cookie header without the portal's cookies; undefined when nothing is left. */
export function appCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !PORTAL_COOKIES.has(p.slice(0, Math.max(0, p.indexOf('='))).trim()));
  return kept.length ? kept.join('; ') : undefined;
}

/** What goes to the app: the browser's headers less hop-by-hop, the portal's cookies and credentials, with the proxy's forwarding headers. */
export function forwardHeaders(headers: IncomingHttpHeaders, opts: { port: number; host: string; scheme: string; upgrade: boolean }): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || STRIP_REQUEST.has(k) || k === 'cookie') continue;
    if (HOP.has(k) && !(opts.upgrade && (k === 'connection' || k === 'upgrade'))) continue;
    out[k] = v;
  }
  const cookie = appCookies(headers.cookie);
  if (cookie) out.cookie = cookie;
  out.host = `127.0.0.1:${opts.port}`;
  out['x-forwarded-host'] = opts.host;
  out['x-forwarded-proto'] = opts.scheme;
  if (!opts.upgrade) out.connection = 'close';
  return out;
}

/** A CSP header without its `frame-ancestors` directives (each comma-separated policy on its own); empty policies dropped. */
const withoutFrameAncestors = (csp: string): string[] =>
  csp
    .split(',')
    .map((policy) =>
      policy
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !/^frame-ancestors\b/i.test(d))
        .join('; '),
    )
    .filter(Boolean);

/** A Set-Cookie without a Domain attribute (so an app can't plant a cookie on the portal's site), or null for one named like the portal's. */
const hostOnlyCookie = (line: string): string | null => {
  const name = line.slice(0, Math.max(0, line.indexOf('='))).trim();
  if (PORTAL_COOKIES.has(name)) return null;
  return line
    .split(';')
    .filter((a, i) => i === 0 || !/^\s*domain\s*=/i.test(a))
    .join(';');
};

/** An absolute redirect to the app's own loopback address becomes a path on the app host. */
const rewriteLocation = (location: string, port: number): string => {
  try {
    const u = new URL(location);
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port)
      return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    /* relative: as it is */
  }
  return location;
};

/** The app's response headers as the browser gets them: framed by the portal only, cookies host-only, its own redirects kept on the app host. */
export function responseHeaders(headers: IncomingHttpHeaders, grant: Pick<AppGrant, 'portalOrigin' | 'port'>): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const csp: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP.has(k) || k === 'x-frame-options') continue;
    if (k === 'content-security-policy') csp.push(...(Array.isArray(v) ? v : [v]).flatMap(withoutFrameAncestors));
    else if (k === 'set-cookie') {
      const kept = (Array.isArray(v) ? v : [v]).map(hostOnlyCookie).filter((c): c is string => c !== null);
      if (kept.length) out[k] = kept;
    } else if (k === 'location' && typeof v === 'string') out[k] = rewriteLocation(v, grant.port);
    else out[k] = v;
  }
  // One header line: comma-joined policies are the same as several CSP headers (each is enforced).
  out['content-security-policy'] = [...csp, `frame-ancestors ${grant.portalOrigin}`].join(', ');
  return out;
}

/** The Origin of a request that changes state (or opens a socket) names another site's page: refused. Absent is a non-browser client. */
const foreignOrigin = (req: IncomingMessage, host: string): boolean => {
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true;
  }
};

export class AppPortProxy {
  constructor(private readonly d: AppPortProxyDeps) {}

  get enabled(): boolean {
    return !!this.d.suffix;
  }

  /**
   * Whether the proxy owns this Host: one label under the suffix that starts with `app-`. A malformed one (`app-x.suffix`) is still the
   * proxy's, and gets its 404, never the portal.
   */
  owns(host: string | undefined): boolean {
    if (!this.d.suffix || !host) return false;
    const h = host.toLowerCase().replace(/:\d{1,5}$/, '');
    const tail = `.${this.d.suffix}`;
    return h.endsWith(tail) && h.slice(0, -tail.length).startsWith('app-');
  }

  /** The app host's grant for this request (cookie for this exact host, the portal session alive, the seam still says `operate`); else null. */
  #authorized(req: IncomingMessage): { grant: AppGrant; host: string; port: number } | null {
    const host = (req.headers.host ?? '').toLowerCase();
    const parsed = parseAppPortHost(host, this.d.suffix);
    if (!parsed || this.d.deniedPorts.has(parsed.port)) return null;
    const grant = this.d.grants.lookup(cookieOf(req.headers.cookie, APP_COOKIE), host);
    if (!grant || grant.port !== parsed.port || !this.#allowed(grant)) return null;
    return { grant, host, port: parsed.port };
  }

  #allowed(grant: AppGrant): boolean {
    return this.d.sessionValid(grant.sessionToken) && can(grant.actor, 'operate', workspaceRef(grant.workspaceId)).allow;
  }

  /** An HTTP request on an app host. Never rejects: an exception is a 502 (or a cut connection once headers went), never a hung request. */
  async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#request(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('The app isn’t answering.');
    }
  }

  async #request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const notFound = () => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Not found.');
    };
    const host = (req.headers.host ?? '').toLowerCase();
    const parsed = parseAppPortHost(host, this.d.suffix);
    if (!parsed || this.d.deniedPorts.has(parsed.port)) return notFound();
    const url = new URL(req.url ?? '/', 'http://app.invalid');
    if (url.pathname === APP_PORT_AUTH_PATH) return this.#auth(req, res, url, host, notFound);

    const ok = this.#authorized(req);
    if (!ok || (!/^(GET|HEAD|OPTIONS)$/.test(req.method ?? '') && foreignOrigin(req, host))) return notFound();
    const { grant, port } = ok;

    let upstream: Duplex;
    try {
      upstream = await this.d.dial(grant.workspaceId, port);
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      const status = e instanceof NotOnThisTarget ? 501 : 502;
      res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(status === 501 ? 'Not available on this target yet.' : 'The app isn’t answering.');
      return;
    }
    upstream.on('error', () => undefined);
    const up = httpRequest({
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, { port, host, scheme: grant.scheme, upgrade: false }),
      // No `agent` (not even `false`: that makes a fresh Agent, which ignores createConnection and dials localhost:80 itself).
      createConnection: () => upstream as never,
    });
    up.on('response', (r) => {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, responseHeaders(r.headers, grant));
      res.flushHeaders();
      r.pipe(res);
      r.on('error', () => res.destroy());
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('The app isn’t answering.');
      else res.destroy();
      upstream.destroy();
    });
    res.on('close', () => {
      up.destroy();
      upstream.destroy();
    });
    req.pipe(up);
  }

  /** `/__pilot/auth?code=&next=`: the code for this host's cookie, then a redirect to `next` (a path). */
  #auth(req: IncomingMessage, res: ServerResponse, url: URL, host: string, notFound: () => void) {
    if (req.method !== 'GET') return notFound();
    const next = url.searchParams.get('next') ?? '/';
    if (!isAppPortNext(next)) {
      res.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Not a path.');
      return;
    }
    const redeemed = this.d.grants.redeem(url.searchParams.get('code') ?? '', host);
    if (!redeemed || !this.#allowed(redeemed.grant)) return notFound();
    const { cookie, grant, maxAgeS } = redeemed;
    const attrs = [`${APP_COOKIE}=${cookie}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`, ...(grant.scheme === 'https' ? ['Secure'] : [])];
    res
      .writeHead(302, {
        location: asLocation(next),
        'set-cookie': attrs.join('; '),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `frame-ancestors ${grant.portalOrigin}`,
      })
      .end();
  }

  /**
   * A WebSocket (any upgrade) on an app host: the same checks, then the raw bytes both ways. The dial and the app's first answer are bounded
   * (`upgradeTimeoutMs`): a workspace that never connects, or an app that never answers, is a 504, not a socket held open for ever.
   */
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => undefined);
    const ok = this.#authorized(req);
    if (!ok || foreignOrigin(req, ok.host)) return void socket.end(NOT_FOUND);
    const fail = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    let upstream: Duplex | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      upstream?.destroy();
      fail('504 Gateway Timeout');
    }, this.d.upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS);
    socket.on('close', () => clearTimeout(timer));
    try {
      upstream = await this.d.dial(ok.grant.workspaceId, ok.port);
    } catch (e) {
      clearTimeout(timer);
      if (!timedOut) fail(e instanceof NotOnThisTarget ? '501 Not Implemented' : '502 Bad Gateway');
      return;
    }
    if (timedOut) return void upstream.destroy();
    upstream.once('data', () => clearTimeout(timer));
    upstream.on('error', () => socket.destroy());
    const headers = forwardHeaders(req.headers, { port: ok.port, host: ok.host, scheme: ok.grant.scheme, upgrade: true });
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${String(one)}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => (clearTimeout(timer), socket.destroy()));
  }
}

/**
 * Puts the proxy in front of the server's other `upgrade` listeners: an app host's upgrade goes to the proxy alone, everything else to them as
 * before. Call it after every module attached its listener.
 */
export function routeAppHostUpgrades(server: Server, proxy: AppPortProxy): void {
  const others = server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (proxy.owns(req.headers.host)) return void proxy.upgrade(req, socket, head);
    for (const l of others) l.call(server, req, socket, head);
  });
}
