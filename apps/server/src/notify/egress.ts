// The one guarded outbound HTTP client of notifications (docs/prd/web-app-pwa.md §11.5): Web Push services, webhooks, Discord, Slack.
//
// - https only; no user info in the URL; never a redirect (a 3xx is the code `redirect`); certificates always verified.
// - The guard has TWO parts, because Node never calls `lookup` for an IP literal (spike, 2026-10-12): (1) the URL's host is parsed with
//   `new URL` (which turns `2130706433` and `0x7f000001` into `127.0.0.1`) and a literal is checked before any connection; (2) a name is
//   resolved AT CONNECT TIME by our own `lookup`, every address is checked, and the connection goes to the address that was checked, so a
//   name that changes its answer between a check and the use (DNS rebinding) cannot slip through.
// - Private, loopback, link-local and metadata addresses are refused (the same `isPrivateAddress` and `embeddedIPv4` the account and MCP
//   checks use). A webhook whose owner ticked "private network" may reach a private address; a metadata address never.
// - 5 s to connect, 10 s in all, at most 4 KB of the reply read (and never stored: the caller keeps a status and a fixed code).
// - `allowHttp` and `allowPrivate` in `EgressOptions` exist for tests (a local stand-in receiver) and are set only where code builds the
//   client; nothing a request carries can set them.

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { NotifyError } from '@portal/contracts';
import { embeddedIPv4, isPrivateAddress } from '../accounts/check.js';

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

export interface EgressOptions {
  /** Name resolution; the system resolver by default. Tests inject one. */
  resolve?: Resolve;
  /** Tests only: plain http to a local stand-in. */
  allowHttp?: boolean;
  /** Tests only: every destination may reach private (never metadata) addresses. */
  allowPrivate?: boolean;
  connectMs?: number;
  totalMs?: number;
  replyMax?: number;
}

export interface EgressRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer | string;
  /** This destination's own tick (a webhook only). */
  allowPrivate?: boolean;
}

export interface EgressResult {
  ok: boolean;
  status: number | null;
  error: NotifyError | null;
  /** Seconds a 429 or 503 asked to wait, at most 300. */
  retryAfterS: number | null;
}

export interface Egress {
  send(req: EgressRequest): Promise<EgressResult>;
  /** The checks that need no connection (scheme, user info, literal addresses, metadata names): null when they pass. */
  precheck(url: string, allowPrivate?: boolean): NotifyError | null;
}

const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);

/** Cloud metadata and other link-local addresses: refused even where private addresses are allowed. */
export function isMetadataAddress(ip: string): boolean {
  const inner = isIP(ip) === 6 ? embeddedIPv4(ip) : null;
  const v4 = isIP(ip) === 4 ? ip : inner;
  if (v4) {
    const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number];
    return (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200) || (a === 192 && b === 0 && c === 0 && d === 192);
  }
  if (isIP(ip) !== 6) return false;
  const lower = ip.toLowerCase();
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  return lower === 'fd00:ec2::254';
}

/** Why an address may not be reached, or null. */
function blocked(ip: string, allowPrivate: boolean): boolean {
  if (isMetadataAddress(ip)) return true;
  return !allowPrivate && isPrivateAddress(ip);
}

class Blocked extends Error {
  readonly code = 'BLOCKED_ADDRESS';
}

function codeOf(e: unknown): NotifyError {
  const err = e as { code?: string; message?: string };
  const code = err?.code ?? '';
  if (e instanceof Blocked || code === 'BLOCKED_ADDRESS') return 'blocked_address';
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA' || code === 'ESERVFAIL' || code === 'DNS') return 'dns';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS|HOSTNAME_MISMATCH|EPROTO/i.test(code)) return 'tls';
  return 'connect';
}

function retryAfter(res: IncomingMessage, now: number): number | null {
  const v = res.headers['retry-after'];
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Math.ceil((Date.parse(v) - now) / 1000);
  if (!Number.isFinite(s)) return null;
  s = Math.max(0, Math.min(300, s));
  return s;
}

export function statusCode(status: number): NotifyError | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 429) return 'rate_limited';
  if (status === 413) return 'payload_too_large';
  if (status >= 500) return 'http_5xx';
  return 'http_4xx';
}

export function createEgress(opts: EgressOptions = {}): Egress {
  const resolve: Resolve = opts.resolve ?? (async (host) => dnsLookup(host, { all: true, verbatim: true }));
  const connectMs = opts.connectMs ?? 5_000;
  const totalMs = opts.totalMs ?? 10_000;
  const replyMax = opts.replyMax ?? 4_096;

  const parse = (raw: string, allowPrivate: boolean): { url: URL; host: string } | NotifyError => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'invalid_url';
    }
    if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) return 'invalid_url';
    if (url.username || url.password) return 'invalid_url';
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return 'invalid_url';
    if (METADATA_NAMES.has(host.replace(/\.$/, ''))) return 'blocked_address';
    if (isIP(host) && blocked(host, allowPrivate)) return 'blocked_address';
    return { url, host };
  };

  return {
    precheck(raw, allowPrivate = false) {
      const p = parse(raw, allowPrivate || !!opts.allowPrivate);
      return typeof p === 'string' ? p : null;
    },

    send(req) {
      const allowPrivate = !!req.allowPrivate || !!opts.allowPrivate;
      const p = parse(req.url, allowPrivate);
      if (typeof p === 'string') return Promise.resolve({ ok: false, status: null, error: p, retryAfterS: null });
      const { url } = p;

      // Connect-time resolution: every address checked, the connection made to one of them.
      const lookup: LookupFunction = (hostname, options, cb) => {
        resolve(hostname).then(
          (addrs) => {
            if (!addrs.length) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException, '', 0);
            if (addrs.some((a) => blocked(a.address, allowPrivate))) return cb(new Blocked('blocked_address') as unknown as NodeJS.ErrnoException, '', 0);
            if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
            cb(null, addrs[0]!.address, addrs[0]!.family);
          },
          (e: unknown) => cb(Object.assign(new Error('dns'), { code: (e as { code?: string }).code ?? 'ENOTFOUND' }) as NodeJS.ErrnoException, '', 0),
        );
      };

      return new Promise<EgressResult>((done) => {
        let settled = false;
        const finish = (r: EgressResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(total);
          clearTimeout(connect);
          done(r);
        };
        const body = typeof req.body === 'string' ? Buffer.from(req.body) : req.body;
        const make = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const r = make(
          {
            protocol: url.protocol,
            hostname: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: { ...req.headers, 'Content-Length': String(body.length) },
            agent: false,
            // A literal was checked above; a name is checked here, at connect time.
            lookup,
            ...(url.protocol === 'https:' ? { servername: isIP(p.host) ? undefined : p.host, rejectUnauthorized: true } : {}),
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const error = statusCode(status);
            const after = retryAfter(res, Date.now());
            let read = 0;
            res.on('data', (chunk: Buffer) => {
              read += chunk.length;
              if (read >= replyMax) {
                res.destroy();
                finish({ ok: !error, status, error, retryAfterS: after });
              }
            });
            res.on('end', () => finish({ ok: !error, status, error, retryAfterS: after }));
            res.on('error', () => finish({ ok: !error, status, error, retryAfterS: after }));
            res.on('close', () => finish({ ok: !error, status, error, retryAfterS: after }));
          },
        );
        const connect = setTimeout(() => r.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), connectMs);
        const total = setTimeout(() => r.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), totalMs);
        r.on('socket', (s) => {
          const connected = () => clearTimeout(connect);
          if (!s.connecting) connected();
          s.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
        });
        r.on('error', (e) => finish({ ok: false, status: null, error: codeOf(e), retryAfterS: null }));
        r.end(body);
      });
    },
  };
}

/** The host a URL goes to, safe to show (`hint`): never a path, a query or a key. */
export function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}
