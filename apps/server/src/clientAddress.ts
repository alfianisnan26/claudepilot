// The client's address as the portal sees it (rate limits, the UI reporter's context and the reporterIp it stores). Behind a proxy the portal
// trusts (PORTAL_TRUST_PROXY=true) the LAST X-Forwarded-For entry is the one the proxy itself appended (what a client sends sits before it);
// with trust off the header is ignored entirely, so a client cannot set its own address.

//
// Behind Cloudflare as well (PORTAL_TRUST_CLOUDFLARE=true, the cluster: Cloudflare, its tunnel, then Traefik), the hop Traefik saw is the
// tunnel's pod, a cluster address (10.42.x), for every visitor (audit 2026-11-01: every reporter IP was 10.42.x). Cloudflare puts the
// visitor's address in CF-Connecting-IP, replacing any the client sent. It is read only when the proxy is trusted, Cloudflare is trusted,
// and the hop Traefik saw is a private address (the tunnel inside the cluster or the network): a request that reached Traefik straight
// from the internet has a public hop, and a CF-Connecting-IP it carries is the client's own invention, ignored. It must be an address.
export function clientAddress(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
  cloudflare?: { connectingIp: string | undefined; trusted: boolean },
): string {
  const forwarded = trustProxy ? forwardedFor?.split(',').at(-1)?.trim() : undefined;
  const hop = forwarded || remoteAddress || 'unknown';
  if (trustProxy && cloudflare?.trusted && isPrivateIp(hop)) {
    const cf = cloudflare.connectingIp?.trim();
    if (cf && ipFamily(cf)) return cf;
  }
  return hop;
}

/** A loopback, private (RFC 1918), shared (100.64/10, CGNAT and tunnels), link-local or unique-local address: a hop inside our networks. */
export function isPrivateIp(ip: string): boolean {
  const v = plainIp(ip);
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (ipFamily(v) !== 6) return false;
  const l = v.toLowerCase();
  return l === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(l) || /^fe[89ab][0-9a-f]?:/.test(l);
}

/** `4`, `6`, or null for something that is not an address ("unknown"). An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is IPv4. */
export function ipFamily(ip: string): 4 | 6 | null {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^::ffff:(?:\d{1,3}\.){3}\d{1,3}$/i.test(ip)) return 4;
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) return 6;
  return null;
}

/** An IPv4-mapped IPv6 address as the IPv4 address it is; anything else as it is. */
export const plainIp = (ip: string): string => ip.replace(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i, '$1');
