// /api/* of cp-next-core to a SCRATCH portal through the bridge (PILOT-1149). The Worker route checks the request and hands it to the
// configured cluster's BridgeDO, which opens an `http` stream (packages/contracts ConnectHttpOpen) and writes HTTP/1.1 on it:
//
//   browser --HTTPS--> Worker /api/*  --(internal fetch BRIDGE_API_PATH)-->  BridgeDO  --`http` stream-->  agent  --TCP-->  scratch portal
//
// The one target comes from Worker config (CP_API_PROXY: `{"cluster":"<name>","target":"http://<svc>.dev-rig-<x>.svc:<port>"}`), parsed
// by `connectHttpTargetOf`: only a Service in a `dev-rig-*` namespace by its cluster DNS name and an explicit port, so the live portal
// (pilot.ai.isnan.me, the `claudepilot` namespaces, any IP) can never be one. No config, or a config that does not parse: every /api path is
// the plain 404, as before. BridgeDO parses the target again with the same rule, so a forged internal header cannot widen it.
//
// What goes onward (`forwardHeaders`): no Cloudflare Access JWT or service-token header, no `cf-*`, no Authorization, no forwarding headers,
// no `x-cp-*` / `x-pilot-*`, no hop-by-hop header; cookies without Cloudflare's own (CF_Authorization and the rest); Host is the target, and
// an Origin that is this Worker's own is rewritten to the target's (a foreign Origin passes as is, so the portal's CSRF check still refuses
// it). The bridge's own token never travels on: it lives on the /bridge link, not on a request. Back to the browser (`responseHeaders`):
// Set-Cookie without a Domain attribute, a Location on the target made path-only, no hop-by-hop header.

import { AppError, codeForStatus } from '@isnanme/core';
import { connectHttpTargetOf, type ApiErrorBody, type ConnectHttpTarget } from '@portal/contracts';
import type { Env } from '../env.js';
import { locate } from '../locate.js';
import type { ByteReader, Http1Head } from './http1.js';
import { BRIDGE_CLUSTER_RE, bridgeRegistry } from './registry.js';
import { notFound } from './route.js';

/** The path of BridgeDO's API proxy. Only Worker code reaches it: the /bridge route always sends `/bridge` (src/bridge/route.ts). */
export const BRIDGE_API_PATH = '/__api';
/** Headers the Worker route sets for BridgeDO; whatever a caller sent under any `x-cp-*` name is dropped first. */
export const API_INTERNAL = { target: 'x-cp-api-target', path: 'x-cp-api-path' } as const;

export const API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const API_LIMITS = {
  /** The request target, path and query. */
  maxTargetBytes: 8 * 1024,
  /** A request body is read into the object before it is written (with its Content-Length): past this, 413. */
  maxRequestBytes: 16 * 1024 * 1024,
  /** The answer's head must arrive within this. The body then streams for as long as it takes. */
  headMs: 30_000,
  /** Requests and sockets proxied at once on one link (BRIDGE_LINK.maxStreams is 32; execs take up to 16, REST calls need some). */
  maxOpen: 12,
  /** Unread answer bytes held before the stream is paused (the mux then stops granting the agent window). */
  pauseAtBytes: 256 * 1024,
  /** One WebSocket message either way (Cloudflare's limit). */
  maxMessageBytes: 1024 * 1024,
  /** A body piece handed to the caller. */
  chunkBytes: 64 * 1024,
} as const;

export interface ApiProxyConfig {
  cluster: string;
  target: ConnectHttpTarget;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The proxy's config from CP_API_PROXY, or null (absent, not JSON, a cluster name or a target that is not allowed). */
export function apiProxyConfigOf(raw: string | undefined): ApiProxyConfig | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v) || typeof v.cluster !== 'string' || !BRIDGE_CLUSTER_RE.test(v.cluster)) return null;
  const target = connectHttpTargetOf(v.target);
  return target ? { cluster: v.cluster, target } : null;
}

/** A request target the proxy sends: printable ASCII, under /api, at most API_LIMITS.maxTargetBytes. */
export const apiTargetOk = (t: unknown): t is string =>
  typeof t === 'string' &&
  t.length <= API_LIMITS.maxTargetBytes &&
  /^[\x21-\x7e]+$/.test(t) &&
  (t === '/api' || t.startsWith('/api/') || t.startsWith('/api?'));

// Never forwarded. `cf-*` covers cf-access-jwt-assertion, cf-access-client-id and -secret (a service token), cf-connecting-ip, cf-ray.
const DROP_EXACT = new Set([
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'authorization',
  'forwarded',
  'x-real-ip',
  'true-client-ip',
  'cdn-loop',
  'referer',
  'origin',
  'cookie',
]);
const DROP_PREFIX = ['cf-', 'proxy-', 'x-forwarded-', 'x-cp-', 'x-pilot-', 'sec-websocket-'];

/** Cloudflare's own cookies (Access, the edge): never sent to the portal. */
const cfCookie = (name: string): boolean => {
  const n = name.toLowerCase();
  return n === 'cf_authorization' || n === 'cf_appsession' || n === 'cf_binding' || n.startsWith('cf_') || n.startsWith('__cf');
};

/** The Cookie header without Cloudflare's cookies, or null when none is left. */
export function cookieOnward(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !cfCookie(p.slice(0, p.indexOf('=') >= 0 ? p.indexOf('=') : p.length).trim()));
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * The request headers sent to the target, Host first. `publicOrigin` is this Worker's own origin: an Origin equal to it becomes the target's
 * (`http://<authority>`); null (in BridgeDO, after the Worker did it) keeps an Origin as it is.
 */
export function forwardHeaders(h: Headers, target: ConnectHttpTarget, publicOrigin: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROP_EXACT.has(k) || DROP_PREFIX.some((p) => k.startsWith(p))) return;
    if (!/^[\x20-\x7e\t]*$/.test(value)) return;
    out[k] = value;
  });
  const cookie = cookieOnward(h.get('cookie'));
  if (cookie) out.cookie = cookie;
  const origin = h.get('origin');
  if (origin && /^[\x21-\x7e]+$/.test(origin)) out.origin = publicOrigin !== null && origin === publicOrigin ? `http://${target.authority}` : origin;
  return out;
}

const HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'proxy-connection']);

/** A Set-Cookie value without its Domain attribute: the cookie belongs to whatever host the browser asked. */
export const setCookieOnward = (v: string): string =>
  v
    .split(';')
    .filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part))
    .join(';');

/** The answer's headers for the browser (a repeated Set-Cookie stays several). */
export function responseHeaders(head: Http1Head, target: ConnectHttpTarget): Headers {
  const out = new Headers();
  const list = head.list ?? [...head.headers.entries()];
  for (const [name, value] of list) {
    const k = name.toLowerCase();
    if (HOP.has(k) || k.startsWith('proxy-') || k.startsWith('sec-websocket-')) continue;
    if (k === 'set-cookie') out.append('set-cookie', setCookieOnward(value));
    else if (k === 'location') out.set('location', locationOnward(value, target));
    else {
      try {
        out.append(k, value);
      } catch {
        // a value the runtime refuses: dropped
      }
    }
  }
  return out;
}

/** A Location on the target (`http://<authority>/x`, or the Service name without the port) made path-only; any other is kept. */
export function locationOnward(v: string, target: ConnectHttpTarget): string {
  for (const base of [`http://${target.authority}`, `http://${target.hostname}`]) {
    if (v === base) return '/';
    if (v.toLowerCase().startsWith(base) && /^[/?#]/.test(v.slice(base.length))) return v.slice(base.length);
  }
  return v;
}

/** An answer of the proxy's own (not the portal's), in the portal's error body. */
export const apiRefused = (status: number, message: string): Response =>
  Response.json(new AppError(codeForStatus(status), message, { status }).toJSON() satisfies ApiErrorBody, { status });

/** The status of a refused open: 429 at the cap, 503 no link, 504 a timeout, 502 anything else (the agent said no, the portal is down). */
export const apiStatusOf = (code: string): number =>
  code === 'busy' ? 429 : code === 'agent_offline' ? 503 : code === 'timeout' ? 504 : 502;

/** A WebSocket subprotocol list a caller offers, when every entry is a token; otherwise null (dropped). */
export function wsProtocolsOf(header: string | null): string | null {
  if (!header) return null;
  const list = header.split(',').map((p) => p.trim());
  return list.length <= 16 && list.every((p) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(p)) ? list.join(', ') : null;
}

export const isWsUpgrade = (h: Headers): boolean => (h.get('upgrade') ?? '').toLowerCase() === 'websocket';

/** The Worker route of /api/*: the plain 404 unless the proxy is configured, else the request handed to the cluster's BridgeDO. */
export async function apiProxy(req: Request, env: Env): Promise<Response> {
  const config = apiProxyConfigOf(env.CP_API_PROXY);
  // The cluster must be one that may dial /bridge at all.
  if (!config || !bridgeRegistry(env.BRIDGE_CLUSTERS).has(config.cluster)) return notFound();
  const url = new URL(req.url);
  const path = url.pathname + url.search;
  if (!apiTargetOk(path) || !(API_METHODS as readonly string[]).includes(req.method)) return notFound();
  const upgrade = isWsUpgrade(req.headers);
  if (upgrade && req.method !== 'GET') return notFound();

  const headers = new Headers(forwardHeaders(req.headers, config.target, url.origin));
  headers.set(API_INTERNAL.target, `http://${config.target.authority}`);
  headers.set(API_INTERNAL.path, path);
  if (upgrade) {
    headers.set('upgrade', 'websocket');
    const protocols = wsProtocolsOf(req.headers.get('sec-websocket-protocol'));
    if (protocols) headers.set('sec-websocket-protocol', protocols);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null;
  const res = await locate(env.BRIDGE, config.cluster).fetch(
    new Request(`https://bridge.internal${BRIDGE_API_PATH}`, { method: req.method, headers, ...(hasBody ? { body: req.body } : {}) }),
  );
  // A 101 carries its socket and cannot be copied; anything else is copied so the app's middleware can set its headers.
  return res.status === 101 ? res : new Response(res.body, res);
}

/** The body of a request, at most `max` bytes; null when it is larger. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** True when an answer to `method` with `status` has no body (RFC 9112 §6.3). */
export const noBody = (method: string, status: number): boolean =>
  method === 'HEAD' || (status >= 100 && status < 200) || status === 204 || status === 304;

/**
 * The answer's body as a stream, read from the agent only as the caller pulls (chunked, Content-Length, or until the stream ends).
 * `done` runs once, when the body ended, failed or was cancelled.
 */
export function bodyStream(r: ByteReader, head: Http1Head, done: () => void): ReadableStream<Uint8Array> {
  const chunked = head.headers.get('transfer-encoding')?.toLowerCase().includes('chunked') ?? false;
  const lengthRaw = head.headers.get('content-length');
  let left = chunked ? 0 : lengthRaw !== undefined ? Number(lengthRaw) : Infinity;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  if (!chunked && (!Number.isSafeInteger(left) || left < 0) && left !== Infinity) left = -1;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (left === -1) throw new Error('bad content length');
        if (chunked && left === 0) {
          const size = parseInt((await r.until('\r\n')).toString('latin1'), 16);
          if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
          if (size === 0) {
            // trailers, then the blank line
            while ((await r.until('\r\n')).length > 0);
            controller.close();
            return finish();
          }
          left = size;
        }
        if (left === 0) {
          controller.close();
          return finish();
        }
        const piece = await r.some(Math.min(left, API_LIMITS.chunkBytes));
        if (piece === null) {
          if (left === Infinity) {
            controller.close();
            return finish();
          }
          throw new Error('the stream ended in the body');
        }
        controller.enqueue(new Uint8Array(piece));
        if (left !== Infinity) left -= piece.length;
        if (chunked && left === 0) await r.until('\r\n');
      } catch (e) {
        controller.error(e instanceof Error ? new Error('The answer broke off.') : e);
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
}
