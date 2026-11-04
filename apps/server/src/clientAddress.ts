// The client's address as the portal sees it (rate limits, the UI reporter's context and the reporterIp it stores). Behind a proxy the portal
// trusts (PORTAL_TRUST_PROXY=true) the LAST X-Forwarded-For entry is the one the proxy itself appended (what a client sends sits before it);
// with trust off the header is ignored entirely, so a client cannot set its own address.

//
// Behind Cloudflare as well (PORTAL_TRUST_CLOUDFLARE=true, the cluster: Cloudflare, its tunnel, then Traefik), the hop Traefik saw is the
// tunnel's pod, a cluster address (10.42.x), for every visitor (audit 2026-11-01: every reporter IP was 10.42.x). Cloudflare puts the
// visitor's address in CF-Connecting-IP, replacing any the client sent. It is read only when the proxy is trusted, Cloudflare is trusted,
// and the hop Traefik saw is on the tunnel's own list (PORTAL_CLOUDFLARE_HOPS, PILOT-1179): any other hop, public or private, is not the
// tunnel, and a CF-Connecting-IP it carries is the sender's own invention, ignored. "Private" alone is not enough: a workspace pod is a
// cluster address too, and could otherwise name any visitor (and lock that visitor out). An empty list trusts no hop. It must be an address.
export function clientAddress(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
  cloudflare?: { connectingIp: string | undefined; trusted: boolean; hops: readonly Cidr[] },
): string {
  const forwarded = trustProxy ? forwardedFor?.split(',').at(-1)?.trim() : undefined;
  const hop = forwarded || remoteAddress || 'unknown';
  if (trustProxy && cloudflare?.trusted && inCidrs(hop, cloudflare.hops)) {
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

/** One address range: its family, its first address as a number, and its prefix length. */
export interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

/** An address as a number (IPv4 in 32 bits, IPv6 in 128), or null when it is not one. */
function ipValue(raw: string): { family: 4 | 6; value: bigint } | null {
  const ip = plainIp(raw.trim());
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { family: 4, value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n) };
  }
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { family: 6, value: groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

/**
 * PORTAL_CLOUDFLARE_HOPS: comma-separated addresses or CIDR ranges (`10.0.0.5`, `10.43.7.0/24`, `fd00::/8`). A bare address is a /32 (or
 * /128). Anything that does not parse is dropped and named in `dropped`, so a typo never widens the list.
 */
export function parseCidrs(raw: string | undefined): { hops: Cidr[]; dropped: string[] } {
  const hops: Cidr[] = [];
  const dropped: string[] = [];
  for (const item of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, len, extra] = item.split('/');
    const ip = ipValue(addr ?? '');
    const max = ip?.family === 6 ? 128 : 32;
    const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
    if (!ip || extra !== undefined || !(bits >= 0 && bits <= max)) {
      dropped.push(item.slice(0, 64));
      continue;
    }
    const shift = BigInt(max - bits);
    hops.push({ family: ip.family, base: (ip.value >> shift) << shift, bits });
  }
  return { hops, dropped };
}

/** What the boot log says about the Cloudflare settings: nothing when they agree (index.ts prints each line). */
export function cloudflareTrustWarnings(c: { trustProxy: boolean; trustCloudflare: boolean; cloudflareHops: { hops: readonly Cidr[]; dropped: readonly string[] } }): string[] {
  const out: string[] = [];
  if (c.cloudflareHops.dropped.length) out.push(`PORTAL_CLOUDFLARE_HOPS: not an address or range, ignored: ${c.cloudflareHops.dropped.join(', ')}`);
  if (c.trustCloudflare && !c.trustProxy) out.push('PORTAL_TRUST_CLOUDFLARE is on but PORTAL_TRUST_PROXY is off: CF-Connecting-IP is never read.');
  else if (c.trustCloudflare && !c.cloudflareHops.hops.length)
    out.push('PORTAL_TRUST_CLOUDFLARE is on but PORTAL_CLOUDFLARE_HOPS lists no hop: CF-Connecting-IP is never read, and every visitor through the tunnel shares its address (one key for every per-address limit).');
  return out;
}

/** Whether an address lies in one of the ranges (never for something that is not an address). */
export function inCidrs(raw: string, cidrs: readonly Cidr[]): boolean {
  const ip = ipValue(raw);
  if (!ip) return false;
  return cidrs.some((c) => {
    if (c.family !== ip.family) return false;
    const shift = BigInt((c.family === 6 ? 128 : 32) - c.bits);
    return (ip.value >> shift) << shift === c.base;
  });
}
