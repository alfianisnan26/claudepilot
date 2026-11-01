// A fetch that connects to the address it checked (organizations PRD §9.8, P6; the DNS-rebinding window `assertPublicUrl` accepts "for an
// admin-only portal"). `assertPublicUrl` resolves a name, checks the answer, and the fetch that follows resolves the name AGAIN: a name that
// answers a public address to the check and a private one to the fetch (a rebinding DNS server, a TTL of 0) reaches the private network.
// Here the name is resolved ONCE, every answer is checked (a cloud metadata address never, a private one only when allowed), and the
// connection is made to the first checked address through the socket's `lookup`, so nothing resolves the name a second time. TLS still
// checks the certificate against the host name (SNI and verification use the URL's host, not the address).
//
// For URLs that people other than the instance admin may set (an org's OIDC issuer), and for every call of the OIDC client. Redirects are
// never followed (a 3xx is an error), the answer is capped and timed. Notifications' egress (notify/egress.ts) pins the same way for sends;
// this one returns the answer, which the OIDC client reads.

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { AppError } from '@isnanme/core';
import { isPrivateAddress } from '../accounts/check.js';
import { isMetadataAddress } from '../notify/egress.js';
import { isMetadata } from './spec.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
/** Every address a name has, as `dns.lookup(name, { all: true })` answers. Tests pass a fake one. */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

export interface PinnedOptions {
  allowPrivate: boolean;
  resolve?: Resolver;
  /** The most bytes of the answer read (more is refused). */
  maxBytes?: number;
  timeoutMs?: number;
}

const refused = (message: string) => new AppError('VALIDATION_FAILED', message, { details: { url: message } });

/**
 * Resolves `url`'s host once and checks every answer. Returns the address to connect to. Throws the guard's refusal (metadata always,
 * private unless allowed) or BAD_GATEWAY when the name does not resolve.
 */
export async function resolvePinned(url: URL, allowPrivate: boolean, resolve: Resolver = systemResolver): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isMetadata(host)) throw refused('That is a cloud metadata address.');
  const kind = isIP(host);
  let addresses: ResolvedAddress[];
  if (kind) addresses = [{ address: host, family: kind === 6 ? 6 : 4 }];
  else {
    addresses = await resolve(host).catch(() => []);
    if (!addresses.length) throw new AppError('BAD_GATEWAY', `${host} does not resolve.`);
  }
  // Metadata and link-local addresses never, even where a private network is allowed (the rule notifications' egress has: notify/egress.ts).
  if (addresses.some((a) => isMetadata(a.address) || isMetadataAddress(a.address))) throw refused('That name points at a cloud metadata address.');
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) throw refused(`${host} is a private address.`);
  return addresses[0]!;
}

/** The socket's lookup: always the checked address, whatever the name is asked for (it is asked for exactly one name). */
export function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) (callback as (e: null, a: ResolvedAddress[]) => void)(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
}

/** `fetch`'s shape for the few things the OIDC client sends: a method, headers, a string body. */
export async function pinnedFetch(rawUrl: string, init: RequestInit | undefined, opts: PinnedOptions): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw refused('Use an https URL.');
  const pinned = await resolvePinned(url, opts.allowPrivate, opts.resolve);
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const body = typeof init?.body === 'string' ? init.body : init?.body == null ? undefined : String(init.body);
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = send(url, { method: init?.method ?? 'GET', headers, lookup: pinnedLookup(pinned), timeout: timeoutMs, signal: init?.signal ?? undefined }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return reject(new AppError('BAD_GATEWAY', 'The server answered with a redirect, which is not followed.'));
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          return reject(new AppError('BAD_GATEWAY', 'The answer is too large.'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks).toString('utf8'), { status, headers: h }));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new AppError('BAD_GATEWAY', 'The server did not answer in time.')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
