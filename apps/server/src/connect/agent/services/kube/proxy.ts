// The Kubernetes service's proxy (docs/prd/targets-connect.md §11.5). Each `kube` stream is the server side of an HTTP connection that the
// portal's loopback listener opened for its Kubernetes client. For every request the proxy:
//   1. requires `Authorization: Bearer <kubeLocalToken>` (the per-connection value from `config`: a process on the portal's machine that
//      finds the loopback port can't use the connector) and then DROPS that header, every `Impersonate-*` and `X-Remote-*` header, and
//      anything else the client sent that it doesn't know: the request to the API server is built from scratch;
//   2. matches the method and path against the allowlist of appendix B (the connector's namespace, a fixed list of resources, the
//      names workspaces use), rebuilds the query from checked keys and adds the managed label selector to lists and watches;
//   3. sets the service account's token (re-read from its file at most every 60 s: bound tokens rotate) and forwards with the pod's CA
//      and verification on; bodies are limited to 1 MiB, responses and watches stream, a WebSocket upgrade is allowed for `pods/exec` only.
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { CONNECT_LIMITS } from '@portal/contracts';
import type { TunnelStream } from '../../../seams.js';
import type { Logger } from '../../log.js';
import { framingProblem, relayHeaders } from '../httpcommon.js';
import { NAMES, classifyKube, mayUpgrade, rebuildQuery, type KubeRoute } from './rules.js';
import { deniedStatus, isKubeRefusal, refuseKube, statusBody, type KubeRefusal } from './status.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_TYPES = /^application\/(?:json|merge-patch\+json|strategic-merge-patch\+json|json-patch\+json)(?:\s*;.*)?$/i;
const SUBPROTOCOL = /^[A-Za-z0-9.+_-]{1,64}(?:\s*,\s*[A-Za-z0-9.+_-]{1,64}){0,7}$/;

export interface KubeProxyOptions {
  /** The API server: `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT` in a pod; `http://` only for a test's fake. */
  server: string;
  /** The service account's token file, and the CA that signs the API server's certificate. */
  tokenFile: string;
  caFile: string | null;
  /** The connector's namespace: the only one the proxy lets anything through to. */
  namespace: string;
  /** The bearer the portal's loopback listener sends; null before `config` arrives. */
  localToken(): string | null;
  log: Logger;
  tokenRereadMs?: number;
  idleMs?: number;
  now?: () => number;
  readFile?: (path: string) => string;
  onChange?: (why: 'denied' | 'upstream') => void;
}

interface Conn {
  trace: string;
  inflight: number;
  timer?: NodeJS.Timeout;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export class KubeProxy {
  readonly #server: http.Server;
  readonly #conns = new Map<Duplex, Conn>();
  readonly #denied = new Map<string, number>();
  readonly #target: URL;
  readonly #agent: http.Agent | https.Agent;
  #token: { value: string; at: number } | null = null;
  #ca: string | undefined;
  #closed = false;

  constructor(private readonly opts: KubeProxyOptions) {
    this.#target = new URL(opts.server);
    this.#ca = this.#target.protocol === 'https:' && opts.caFile ? (opts.readFile ?? ((p) => readFileSync(p, 'utf8')))(opts.caFile) : undefined;
    this.#agent =
      this.#target.protocol === 'https:'
        ? new https.Agent({ keepAlive: true, maxSockets: 128, rejectUnauthorized: true, ...(this.#ca ? { ca: this.#ca } : {}) })
        : new http.Agent({ keepAlive: true, maxSockets: 128 });
    this.#server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 0 }, (req, res) => void this.#onRequest(req, res));
    this.#server.on('upgrade', (req, socket, head) => void this.#onUpgrade(req, socket as Duplex, head));
    this.#server.on('clientError', (err, socket) => this.#onClientError(err as NodeJS.ErrnoException, socket as Duplex));
  }

  serve(stream: TunnelStream, trace: string): void {
    if (this.#closed) return void stream.destroy();
    const conn: Conn = { trace, inflight: 0 };
    this.#conns.set(stream, conn);
    stream.on('error', () => undefined);
    stream.on('close', () => {
      clearTimeout(conn.timer);
      this.#conns.delete(stream);
    });
    this.#armIdle(stream, conn);
    this.#server.emit('connection', stream);
  }

  get openStreams(): number {
    return this.#conns.size;
  }

  takeDenied(): { rule: string; count: number }[] {
    const out = [...this.#denied].map(([rule, count]) => ({ rule, count }));
    this.#denied.clear();
    return out;
  }

  close(): void {
    this.#closed = true;
    for (const [stream, conn] of this.#conns) {
      clearTimeout(conn.timer);
      stream.destroy();
    }
    this.#conns.clear();
    this.#agent.destroy();
  }

  /** The service account's token, read from its file and kept for at most `tokenRereadMs` (60 s). */
  token(): string {
    const now = (this.opts.now ?? Date.now)();
    if (!this.#token || now - this.#token.at >= (this.opts.tokenRereadMs ?? 60_000)) {
      const value = (this.opts.readFile ?? ((p) => readFileSync(p, 'utf8')))(this.opts.tokenFile).trim();
      if (!value) throw new Error('the service account token is empty');
      this.#token = { value, at: now };
    }
    return this.#token.value;
  }

  /** A call to the API server on the agent's own account (health, the identity Secret): not a client request. */
  api(method: string, path: string, opts: { body?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const lib = this.#target.protocol === 'https:' ? https : http;
      const headers: http.OutgoingHttpHeaders = { accept: 'application/json', authorization: `Bearer ${this.token()}`, ...(opts.headers ?? {}) };
      if (opts.body !== undefined) headers['content-length'] = Buffer.byteLength(opts.body);
      const req = lib.request(this.#requestOptions(method, path, headers), (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) return void req.destroy(new Error('answer too large'));
          parts.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
        res.on('error', reject);
      });
      req.setTimeout(opts.timeoutMs ?? 8000, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  #requestOptions(method: string, path: string, headers: http.OutgoingHttpHeaders): https.RequestOptions {
    return {
      host: this.#target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(this.#target.port) || (this.#target.protocol === 'https:' ? 443 : 80),
      method,
      path,
      headers,
      agent: this.#agent,
      ...(this.#target.protocol === 'https:' ? { rejectUnauthorized: true, ...(this.#ca ? { ca: this.#ca } : {}) } : {}),
    };
  }

  /* ------------------------------------------------------------------------------------------------------------------------ */

  #armIdle(stream: Duplex, conn: Conn) {
    clearTimeout(conn.timer);
    if (conn.inflight > 0) return;
    conn.timer = setTimeout(() => {
      if (conn.inflight === 0) stream.end();
    }, this.opts.idleMs ?? 60_000);
    conn.timer.unref();
  }

  #begin(socket: Duplex): Conn {
    const conn = this.#conns.get(socket) ?? { trace: '--------', inflight: 0 };
    conn.inflight++;
    clearTimeout(conn.timer);
    return conn;
  }

  #end(socket: Duplex, conn: Conn) {
    conn.inflight = Math.max(0, conn.inflight - 1);
    if (this.#conns.has(socket)) this.#armIdle(socket, conn);
  }

  #count(rule: string, trace: string) {
    this.#denied.set(rule, (this.#denied.get(rule) ?? 0) + 1);
    this.opts.log.warn('policy.denied', { service: 'kube', rule, trace });
    this.opts.onChange?.('denied');
  }

  #onClientError(err: NodeJS.ErrnoException, socket: Duplex) {
    this.#count('body', this.#conns.get(socket)?.trace ?? '--------');
    const body = deniedStatus('body');
    if (socket.writable) {
      const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else socket.destroy();
  }

  /** The local bearer: the portal's loopback listener knows it, another process on the portal's machine does not. */
  #authorized(req: IncomingMessage): boolean {
    const expected = this.opts.localToken();
    if (!expected) return false;
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    return !!match && timingSafeEqual(digest(match[1]!), digest(expected));
  }

  /** Framing, the bearer, the method, a clean path and the allowlist: the same for a request and for an upgrade. */
  #preflight(req: IncomingMessage): KubeRefusal | { method: string; route: KubeRoute; path: string; query: string } {
    if (!this.#authorized(req)) return refuseKube('auth', 'The request does not carry this connection’s bearer.');
    const framing = framingProblem(req);
    if (framing) return refuseKube('body', framing);
    const method = req.method ?? '';
    if (!METHODS.has(method)) return refuseKube('method', `${method.slice(0, 16)} is not allowed.`);
    const raw = req.url ?? '';
    const q = raw.indexOf('?');
    const path = q < 0 ? raw : raw.slice(0, q);
    // eslint-disable-next-line no-control-regex
    if (!path.startsWith('/') || path.startsWith('//') || /[\0-\x1f\x7f-￿\\%]/.test(path) || path.includes('//') || /(^|\/)\.\.?(\/|$)/.test(path) || (path.length > 1 && path.endsWith('/')) || path.length > 2048) {
      return refuseKube('path', 'The path is not allowed.');
    }
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
    } catch {
      return refuseKube('path', 'The query is not valid.');
    }
    const route = classifyKube(method, path, this.opts.namespace);
    if (isKubeRefusal(route)) return route;
    const query = rebuildQuery(route, method, params);
    if (isKubeRefusal(query)) return query;
    return { method, route, path, query: query.query };
  }

  #deny(res: ServerResponse, conn: Conn, why: KubeRefusal) {
    this.#count(why.rule, conn.trace);
    const unauthorized = why.rule === 'auth';
    this.#answer(res, unauthorized ? 401 : 403, unauthorized ? statusBody(401, 'Unauthorized', 'Unauthorized') : deniedStatus(why.rule), true);
  }

  #answer(res: ServerResponse, status: number, body: string, close: boolean) {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(close ? { Connection: 'close' } : {}) });
    res.end(body);
    if (close) {
      const socket = res.req.socket;
      res.once('finish', () => setTimeout(() => socket.destroy(), 2000).unref());
    }
  }

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const socket = req.socket as unknown as Duplex;
    const conn = this.#begin(socket);
    res.once('close', () => this.#end(socket, conn));
    try {
      const pre = this.#preflight(req);
      if ('rule' in pre) return this.#deny(res, conn, pre);
      // An exec is a WebSocket (the portal's client library asks for one); a plain request to it is refused, not forwarded.
      if (mayUpgrade(pre.route)) return this.#deny(res, conn, refuseKube('upgrade', 'An exec is only available as a WebSocket upgrade.'));
      const body = await this.#body(req, pre);
      if ('rule' in body) return this.#deny(res, conn, body);
      this.opts.log.debug('kube.request', { trace: conn.trace, kind: pre.route.kind });
      this.#forward(res, pre, body.data);
    } catch (e) {
      this.opts.log.error('kube.proxy.failed', { trace: conn.trace, code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
      this.#answer(res, 500, statusBody(500, 'InternalError', 'The agent could not handle the request.'), true);
    }
  }

  /** Reads the body (at most 1 MiB) and, for what creates or replaces an object, checks the object's name and namespace. */
  async #body(req: IncomingMessage, pre: { method: string; route: KubeRoute }): Promise<{ data: Buffer | null } | KubeRefusal> {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(pre.method)) {
      req.resume();
      return { data: null };
    }
    const limit = CONNECT_LIMITS.maxJsonBody;
    if (Number(req.headers['content-length'] ?? '0') > limit) return refuseKube('body', 'The body is too large.');
    const parts: Buffer[] = [];
    let size = 0;
    const ok = await new Promise<boolean>((resolve) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          resolve(false);
          return void req.destroy();
        }
        parts.push(c);
      });
      req.on('end', () => resolve(true));
      req.on('error', () => resolve(false));
    });
    if (!ok) return refuseKube('body', 'The body is too large or could not be read.');
    if (size === 0) return { data: null };
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !JSON_TYPES.test(type)) return refuseKube('body', 'Only JSON bodies are allowed.');
    const data = Buffer.concat(parts);
    // A new object, or a replaced one, must be one of the portal's (its name) and in the connector's namespace.
    if (pre.method === 'POST' || pre.method === 'PUT') {
      let doc: { metadata?: { name?: unknown; namespace?: unknown } };
      try {
        doc = JSON.parse(data.toString('utf8')) as typeof doc;
      } catch {
        return refuseKube('body', 'The body is not JSON.');
      }
      const meta = doc?.metadata;
      if (pre.method === 'POST' && pre.route.kind !== 'secretCreate' && pre.route.kind !== 'pvcList' && pre.route.kind !== 'deploymentList') return { data };
      const pattern = pre.route.kind === 'secretCreate' || pre.route.kind === 'secret' ? NAMES.secret : pre.route.kind === 'pvcList' || pre.route.kind === 'pvc' ? NAMES.pvc : NAMES.deployment;
      if (typeof meta?.name !== 'string' || !pattern.test(meta.name)) return refuseKube('name', 'The object’s name is not one of the portal’s workspaces.');
      if (pre.method === 'PUT' && pre.route.name && meta.name !== pre.route.name) return refuseKube('name', 'The object’s name differs from the path.');
      if (meta.namespace !== undefined && meta.namespace !== this.opts.namespace) return refuseKube('namespace', 'The object names another namespace.');
    }
    return { data };
  }

  #forward(res: ServerResponse, pre: { method: string; route: KubeRoute; path: string; query: string }, body: Buffer | null) {
    let auth: string;
    try {
      auth = `Bearer ${this.token()}`;
    } catch {
      return this.#answer(res, 503, statusBody(503, 'ServiceUnavailable', 'The service account token could not be read.'), false);
    }
    const headers: http.OutgoingHttpHeaders = { accept: 'application/json', authorization: auth, 'user-agent': 'claudepilot-agent' };
    const req = res.req;
    const accept = req.headers.accept;
    if (typeof accept === 'string' && /^[\w/+.;=, *-]{1,200}$/.test(accept)) headers.accept = accept;
    if (body) {
      headers['content-type'] = req.headers['content-type'];
      headers['content-length'] = body.length;
    }
    const lib = this.#target.protocol === 'https:' ? https : http;
    const up = lib.request(this.#requestOptions(pre.method, pre.query ? `${pre.path}?${pre.query}` : pre.path, headers), (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, relayHeaders(upRes));
      res.flushHeaders(); // a watch with nothing to say yet must still show it is connected
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    res.once('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    up.on('error', (e: NodeJS.ErrnoException) => {
      this.opts.log.warn('kube.upstream', { code: e.code ?? 'ERR' });
      if (!res.headersSent) this.#answer(res, 502, statusBody(502, 'BadGateway', 'The API server did not answer.'), false);
      else res.destroy();
    });
    up.end(body ?? undefined);
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * WebSocket upgrade (pods/exec)
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const conn = this.#begin(socket);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.#end(socket, conn);
    };
    socket.once('close', done);
    const raw = (status: string, body: string) => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      else socket.destroy();
      done();
    };
    const denyRaw = (why: KubeRefusal) => {
      this.#count(why.rule, conn.trace);
      if (why.rule === 'auth') raw('401 Unauthorized', statusBody(401, 'Unauthorized', 'Unauthorized'));
      else raw('403 Forbidden', deniedStatus(why.rule));
    };
    try {
      const pre = this.#preflight(req);
      if ('rule' in pre) return denyRaw(pre);
      const key = req.headers['sec-websocket-key'];
      const protocols = req.headers['sec-websocket-protocol'];
      if (!mayUpgrade(pre.route) || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || pre.method !== 'GET') return denyRaw(refuseKube('upgrade', 'Only a workspace pod’s exec may be upgraded.'));
      if (typeof key !== 'string' || !/^[A-Za-z0-9+/=]{16,40}$/.test(key) || req.headers['sec-websocket-version'] !== '13') return denyRaw(refuseKube('upgrade', 'Not a WebSocket handshake.'));
      if (protocols !== undefined && (typeof protocols !== 'string' || !SUBPROTOCOL.test(protocols))) return denyRaw(refuseKube('upgrade', 'The subprotocols are not valid.'));
      let auth: string;
      try {
        auth = `Bearer ${this.token()}`;
      } catch {
        return raw('503 Service Unavailable', statusBody(503, 'ServiceUnavailable', 'The service account token could not be read.'));
      }
      const headers: http.OutgoingHttpHeaders = {
        authorization: auth,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        ...(protocols ? { 'sec-websocket-protocol': protocols } : {}),
        'user-agent': 'claudepilot-agent',
      };
      const lib = this.#target.protocol === 'https:' ? https : http;
      const upReq = lib.request({ ...this.#requestOptions('GET', `${pre.path}?${pre.query}`, headers), agent: false });
      this.opts.log.debug('kube.request', { trace: conn.trace, kind: 'exec', upgrade: true });
      socket.once('close', () => upReq.destroy());
      upReq.on('error', (e: NodeJS.ErrnoException) => {
        this.opts.log.warn('kube.upstream', { code: e.code ?? 'ERR' });
        raw('502 Bad Gateway', statusBody(502, 'BadGateway', 'The API server did not answer.'));
      });
      upReq.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`];
        for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) upSocket.write(head);
        socket.pipe(upSocket);
        upSocket.pipe(socket);
        const end = () => {
          upSocket.destroy();
          socket.destroy();
          done();
        };
        upSocket.once('close', end);
        socket.once('close', end);
        upSocket.on('error', () => undefined);
        socket.on('error', () => undefined);
      });
      upReq.on('response', (upRes) => {
        // Not upgraded (the pod is gone, the verb is refused): the API server's answer goes back as it is.
        const parts: Buffer[] = [];
        upRes.on('data', (c: Buffer) => parts.length < 64 && parts.push(c));
        upRes.on('end', () => {
          raw(`${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ''}`.trim(), Buffer.concat(parts).toString('utf8'));
        });
      });
      upReq.end();
    } catch (e) {
      this.opts.log.error('kube.proxy.failed', { trace: conn.trace, code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
      raw('500 Internal Server Error', statusBody(500, 'InternalError', 'The agent could not handle the request.'));
    }
  }
}
