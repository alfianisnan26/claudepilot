// The client's address as the portal sees it (rate limits, the UI reporter's context and the reporterIp it stores). Behind a proxy the portal
// trusts (PORTAL_TRUST_PROXY=true) the LAST X-Forwarded-For entry is the one the proxy itself appended (what a client sends sits before it);
// with trust off the header is ignored entirely, so a client cannot set its own address.

export function clientAddress(forwardedFor: string | undefined, remoteAddress: string | undefined, trustProxy: boolean): string {
  const forwarded = trustProxy ? forwardedFor?.split(',').at(-1)?.trim() : undefined;
  return forwarded || remoteAddress || 'unknown';
}

/** `4`, `6`, or null for something that is not an address ("unknown"). An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is IPv4. */
export function ipFamily(ip: string): 4 | 6 | null {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^::ffff:(?:\d{1,3}\.){3}\d{1,3}$/i.test(ip)) return 4;
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) return 6;
  return null;
}

/** An IPv4-mapped IPv6 address as the IPv4 address it is; anything else as it is. */
export const plainIp = (ip: string): string => ip.replace(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i, '$1');
