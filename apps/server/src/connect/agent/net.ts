// How the agent talks to the portal over HTTP and WebSocket (docs/prd/targets-connect.md §11.3, §13.7, FR53).
//  - Proxies: `ws` uses the `https` module and ignores `NODE_USE_ENV_PROXY` (PRD Q5, observed), so the agent dials a CONNECT proxy
//    itself, from HTTPS_PROXY / HTTP_PROXY and NO_PROXY, and uses the same agent for its enrollment request.
//  - TLS: certificate verification is ALWAYS on. A private CA (PILOT_CA) is added to Node's roots, never instead of verification.
//  - Headers: PILOT_HEADERS (`Name: value` per line, e.g. an Access service token) go on every request; they are never logged.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export interface NetConfig {
  /** PEM text of an extra CA that signs the portal's certificate (the content of PILOT_CA's file). */
  ca?: string | null;
  /** Extra request headers (PILOT_HEADERS). */
  headers?: Record<string, string>;
  /** Where HTTPS_PROXY, HTTP_PROXY and NO_PROXY come from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test hooks: force a proxy URL / NO_PROXY list instead of reading the environment. */
  proxy?: string | null;
  noProxy?: string | null;
}

/** `Name: value` lines. A line that isn't a valid header is dropped (the value is never echoed back). */
export function parseHeaders(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 1) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name) || /[\0\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

export const isLoopbackHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
};

const ipv4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
};

/** NO_PROXY: `*`, `host`, `.suffix`, `host:port`, an IPv4 address or an IPv4 CIDR, comma or space separated. */
export function bypassProxy(host: string, port: string, noProxy: string | null | undefined): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopbackHost(h)) return true;
  for (const entry of (noProxy ?? '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    if (entry === '*') return true;
    let pattern = entry;
    const portAt = /^(.+):(\d+)$/.exec(entry);
    if (portAt && !entry.includes('::')) {
      if (portAt[2] !== port) continue;
      pattern = portAt[1]!;
    }
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(pattern);
    if (cidr) {
      const base = ipv4(cidr[1]!);
      const addr = ipv4(h);
      const bits = Number(cidr[2]);
      if (base === null || addr === null || bits > 32) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((base & mask) >>> 0 === (addr & mask) >>> 0) return true;
      continue;
    }
    const bare = pattern.replace(/^\*?\./, '');
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** The proxy to use for `target`, or null: HTTPS_PROXY for https, HTTP_PROXY for http (either case), unless NO_PROXY says no. */
export function proxyFor(target: URL, cfg: NetConfig = {}): URL | null {
  const env = cfg.env ?? process.env;
  const raw = cfg.proxy !== undefined ? cfg.proxy : target.protocol === 'https:' ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return null;
  const noProxy = cfg.noProxy !== undefined ? cfg.noProxy : (env.NO_PROXY ?? env.no_proxy);
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (bypassProxy(target.hostname, port, noProxy)) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** A proxy URL for a log line: the credentials removed. */
export const proxyLabel = (proxy: URL): string => `${proxy.protocol}//${proxy.host}`;

/** TLS options for every connection the agent makes: verification on, the private CA added to Node's roots. */
export function tlsOptions(cfg: NetConfig = {}): tls.ConnectionOptions {
  return { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(cfg.ca ? { ca: [...tls.rootCertificates, cfg.ca] } : {}) };
}

const connectTimeoutMs = 15_000;

/** Opens a CONNECT tunnel through `proxy` to host:port and resolves with the raw socket. */
function connectThrough(proxy: URL, host: string, port: number, cfg: NetConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
    const headers: Record<string, string> = { Host: authority };
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    const request = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      timeout: connectTimeoutMs,
      ...(proxy.protocol === 'https:' ? tlsOptions(cfg) : {}),
    });
    request.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return void reject(new Error(`The proxy refused the connection (${res.statusCode}).`));
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.on('timeout', () => request.destroy(new Error('The proxy did not answer in time.')));
    request.on('error', reject);
    request.end();
  });
}

type CreateConnection = (options: tls.ConnectionOptions & { host?: string; port?: number }, cb: (err: Error | null, socket?: net.Socket) => void) => void;

class ProxyHttpsAgent extends https.Agent {
  constructor(private readonly proxy: URL, private readonly cfg: NetConfig) {
    super({ keepAlive: false });
  }
  // The callback form of createConnection is what the HTTP stack supports for an asynchronous connect.
  override createConnection = ((options, cb) => {
    const host = String(options.host ?? 'localhost');
    const port = Number(options.port ?? 443);
    connectThrough(this.proxy, host, port, this.cfg).then(
      (socket) => {
        const secure = tls.connect({
          ...options,
          ...tlsOptions(this.cfg),
          socket,
          servername: options.servername ?? (net.isIP(host) ? undefined : host),
        });
        cb(null, secure);
      },
      (e: Error) => cb(e),
    );
  }) as CreateConnection as never;
}

class ProxyHttpAgent extends http.Agent {
  constructor(private readonly proxy: URL, private readonly cfg: NetConfig) {
    super({ keepAlive: false });
  }
  override createConnection = ((options, cb) => {
    connectThrough(this.proxy, String(options.host ?? 'localhost'), Number(options.port ?? 80), this.cfg).then((socket) => cb(null, socket), (e: Error) => cb(e));
  }) as CreateConnection as never;
}

/** The agent to give `ws` or `https.request` for `target`: direct, or through the CONNECT proxy the environment names. Verification is always on. */
export function transportAgent(target: URL, cfg: NetConfig = {}): http.Agent | https.Agent {
  const proxy = proxyFor(target, cfg);
  if (target.protocol === 'https:' || target.protocol === 'wss:') return proxy ? new ProxyHttpsAgent(proxy, cfg) : new https.Agent({ ...tlsOptions(cfg), keepAlive: false });
  return proxy ? new ProxyHttpAgent(proxy, cfg) : new http.Agent({ keepAlive: false });
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** One request, no redirects, the response body capped. Used for enrollment and by `doctor`. */
export function httpRequest(
  target: URL,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number } = {},
  cfg: NetConfig = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const secure = target.protocol === 'https:';
    const headers: Record<string, string> = { ...(cfg.headers ?? {}), ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = (secure ? https : http).request(
      target,
      { method: opts.method ?? 'GET', headers, agent: transportAgent(target, cfg), ...(secure ? tlsOptions(cfg) : {}) },
      (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > (opts.maxBytes ?? 1_048_576)) return void req.destroy(new Error('The portal’s answer is too large.'));
          parts.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(Object.assign(new Error('The portal did not answer in time.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** What a failed connection says in plain words, with a hint where there is one. Never includes a URL's credentials or headers. */
export function describeNetError(e: unknown): { code: string; message: string; hint?: string } {
  const err = e as NodeJS.ErrnoException & { reason?: string };
  const code = err.code ?? 'ERR';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code, message: 'The portal’s name does not resolve.', hint: 'Check the address and this machine’s DNS.' };
    case 'ECONNREFUSED':
      return { code, message: 'The portal refused the connection.', hint: 'Check the address and port, and that the portal is running.' };
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { code, message: 'The portal did not answer.', hint: 'Check the firewall and the proxy (HTTPS_PROXY).' };
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return { code, message: `The portal’s certificate is not trusted (${code}).`, hint: 'For a private CA use the wizard’s Private CA option (PILOT_CA).' };
    default:
      return { code, message: err.message ? err.message.slice(0, 160) : 'The connection failed.' };
  }
}
