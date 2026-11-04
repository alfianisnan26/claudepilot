// The visitor's address, the ONE key of every per-address limit (PILOT-1168): the edge ceilings, the code sign-in lock, the email
// lockout's per-address count, connect, the VS Code API, /mcp, the triggers' and the CI hooks' receivers.
//
// Behind the Cloudflare tunnel the hop the proxy saw is the cloudflared pod for every visitor, so a limit keyed on the hop lets one stranger
// lock everyone out. clientAddress.ts reads CF-Connecting-IP only with PORTAL_TRUST_PROXY and PORTAL_TRUST_CLOUDFLARE on, when that hop is
// on PORTAL_CLOUDFLARE_HOPS (the tunnel's own addresses) and the header holds an address; otherwise the hop (or the socket) is the key.
//
// PILOT-1179 narrowed PILOT-1168's option b: a private hop is no longer enough (a workspace pod is private too, and could name any
// visitor to lock it out or spread its own count). The limits per token, per account and per session do not read the address at all.
import type { IncomingMessage } from 'node:http';
import { clientAddress } from './clientAddress.js';
import { config } from './config.js';

type HeaderOf = (name: string) => string | undefined;

/** The address from a header reader and the socket's address; `trustProxy` defaults to the portal's setting (config is read per call). */
export function visitorFrom(header: HeaderOf, remoteAddress: string | undefined, trustProxy: boolean = config.trustProxy): string {
  return clientAddress(header('x-forwarded-for'), remoteAddress, trustProxy, {
    connectingIp: header('cf-connecting-ip'),
    trusted: config.trustCloudflare,
    hops: config.cloudflareHops.hops,
  });
}

/** A Hono request (the node server puts the socket in `c.env.incoming`). */
export function visitorAddress(c: { req: { header(name: string): string | undefined }; env?: unknown }): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return visitorFrom((name) => c.req.header(name), incoming?.socket?.remoteAddress);
}

/** A node request (connect's tunnel upgrade and routes). */
export function visitorOfRequest(req: IncomingMessage, trustProxy: boolean = config.trustProxy): string {
  const one = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v.at(-1) : v;
  };
  return visitorFrom(one, req.socket?.remoteAddress, trustProxy);
}
