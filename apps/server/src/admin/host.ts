// The host split of the Admin console (docs/prd/organizations.md §6.11). `PORTAL_ADMIN_HOST` (config.adminHost, the PRD's
// `settings.adminHost`) names the one host the console answers on; unset or not a host name, the console is off (fail closed). On the admin
// host the request goes to the console's own app (its routes, its UI bundle, /healthz; anything else is the console's 404); on every other
// host the console's paths answer the same 404 as an unknown route, and sockets are refused on the admin host. The host is the request's
// `Host`; `X-Forwarded-Host` counts only behind the trusted proxy (PORTAL_TRUST_PROXY, the rule clientAddress.ts uses for
// X-Forwarded-For: the LAST entry is the one the proxy wrote).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

type Headers = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/** A configured admin host as compared: lowercase, no trailing dot; null when unset or not a host name (the console is then off). */
export function normalizeAdminHost(raw: string | null | undefined): string | null {
  const h = raw?.trim().toLowerCase().replace(/\.$/, '');
  return h && HOSTNAME.test(h) ? h : null;
}

/** The console's paths: its API and its UI bundle. On a host that is not the admin host they are the same 404 as an unknown route. */
export const isAdminPath = (path: string): boolean => /^\/admin-(?:api|ui)(?:\/|$)/i.test(path);

function header(headers: Headers, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  const v = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? v.at(-1) : v;
}

export class AdminHostGate {
  readonly host: string | null;

  constructor(
    adminHost: string | null | undefined,
    private readonly trustProxy: boolean,
  ) {
    this.host = normalizeAdminHost(adminHost);
  }

  get enabled(): boolean {
    return this.host !== null;
  }

  /** The host a request is for, as compared with the admin host (the port dropped unless the admin host names one). */
  requestHost(headers: Headers): string | null {
    const forwarded = this.trustProxy ? header(headers, 'x-forwarded-host')?.split(',').at(-1)?.trim() : undefined;
    const raw = (forwarded || header(headers, 'host') || '').trim().toLowerCase();
    if (!raw) return null;
    const noDot = raw.replace(/\.(?=:\d+$|$)/, '');
    return this.host && /:\d+$/.test(this.host) ? noDot : noDot.replace(/:\d{1,5}$/, '');
  }

  isAdmin(headers: Headers): boolean {
    return this.host !== null && this.requestHost(headers) === this.host;
  }

  /** `admin`: the console's app answers; `blocked`: the same 404 as an unknown route; `main`: the portal as before. */
  classify(headers: Headers, path: string): 'admin' | 'blocked' | 'main' {
    if (this.isAdmin(headers)) return 'admin';
    return isAdminPath(path) ? 'blocked' : 'main';
  }
}

/**
 * Sockets (chat, terminals, live, the browser, the agents' tunnel) are never opened on the admin host: its upgrades are refused before any
 * module sees them. Call it after every module attached its `upgrade` listener.
 */
export function routeAdminHostUpgrades(server: Server, gate: AdminHostGate): void {
  if (!gate.enabled) return;
  const others = server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (gate.isAdmin(req.headers)) return void socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    for (const l of others) l.call(server, req, socket, head);
  });
}
