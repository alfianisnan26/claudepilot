// The Docker policy proxy's HTTP plumbing (docs/prd/targets-connect.md §11.4). Each `docker` stream is the server side of an HTTP
// connection: Node's own parser reads the requests (one parser, so no smuggling between two), `policy.ts` decides, and the agent
// sends a FRESH request to the daemon's socket. Nothing is forwarded as bytes except what the policy says is a stream: an archive on
// its way in, and the raw stream of a hijacked exec after the daemon agreed to the upgrade.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ConnectDockerRule } from '@portal/contracts';
import { CONNECT_LIMITS } from '@portal/contracts';
import type { TunnelStream } from '../../../seams.js';
import type { Logger } from '../../log.js';
import { framingProblem, readFromSocket, relayHeaders } from '../httpcommon.js';
import { ExecIds } from './execIds.js';
import { decide, type Decision, type PolicyContext, type Resolved, type Upstream } from './policy.js';
import { classify, normalizeTarget, refuse, type ImageAllow, type Refusal, type Route, type Target } from './rules.js';

const HEADER_LIMIT = 16 * 1024;
const SAFE_CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*[\w=.-]+)*$/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);

export interface DockerProxyOptions {
  /** The Docker daemon's unix socket. */
  socket: string;
  images: ImageAllow;
  allowBinds: string[];
  portalId(): string | null;
  log: Logger;
  /** How long a container lookup is remembered (PRD: 2 s). */
  resolveTtlMs?: number;
  /** A connection with no request in flight is closed after this long (PRD: 60 s). */
  idleMs?: number;
  now?: () => number;
  /** Something the status message shows changed: a request was refused, or the daemon stopped answering. */
  onChange?: (why: 'denied' | 'upstream') => void;
}

interface Conn {
  trace: string;
  inflight: number;
  timer?: NodeJS.Timeout;
}

const dockerError = (message: string) => JSON.stringify({ message });
const deniedMessage = (rule: string) => dockerError(`denied by claudepilot policy (${rule})`);

export class DockerProxy {
  readonly #server: http.Server;
  readonly #conns = new Map<Duplex, Conn>();
  readonly #denied = new Map<string, number>();
  readonly #cache = new Map<string, { at: number; value: Resolved }>();
  readonly #agent = new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 30_000 });
  readonly execs: ExecIds;
  readonly #ctx: PolicyContext;
  #closed = false;

  constructor(private readonly opts: DockerProxyOptions) {
    this.execs = new ExecIds(opts.now ? { now: opts.now } : {});
    this.#ctx = { portalId: opts.portalId, images: opts.images, allowBinds: opts.allowBinds, resolve: (ref) => this.#resolve(ref), execs: this.execs };
    this.#server = http.createServer({ maxHeaderSize: HEADER_LIMIT, requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 0 }, (req, res) => void this.#onRequest(req, res));
    this.#server.on('upgrade', (req, socket, head) => void this.#onUpgrade(req, socket as Duplex, head));
    this.#server.on('clientError', (err, socket) => this.#onClientError(err as NodeJS.ErrnoException, socket as Duplex));
  }

  /** Serves one stream as an HTTP connection. */
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

  /** What was refused since the last call, by rule. */
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

  /** A GET to the daemon on the agent's own account (status, container lookups): not a client request, not subject to the policy. */
  daemon(path: string, timeoutMs = 5000): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.opts.socket, path, method: 'GET', headers: { host: 'docker' }, agent: this.#agent, timeout: timeoutMs }, (res) => {
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
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end();
    });
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Connections
   * ------------------------------------------------------------------------------------------------------------------------ */

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

  /** Counts a refusal and logs the rule (never the request). */
  #count(rule: ConnectDockerRule, trace: string) {
    this.#denied.set(rule, (this.#denied.get(rule) ?? 0) + 1);
    this.opts.log.warn('policy.denied', { rule, trace });
    this.opts.onChange?.('denied');
  }

  #onClientError(err: NodeJS.ErrnoException, socket: Duplex) {
    // A reset stream (the portal's HTTP agent ends idle streams that way) is a socket error, not a refused request: only the HTTP parser's
    // own errors (HPE_*) are denials, or status.denied counts what nobody sent (T6, the same hole as the Kubernetes proxy's on k3s).
    if (!String(err.code ?? '').startsWith('HPE_')) return void socket.destroy();
    const trace = this.#conns.get(socket)?.trace ?? '--------';
    this.#count('body', trace);
    const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    if (socket.writable) {
      const body = deniedMessage('body');
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else socket.destroy();
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Requests
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const socket = req.socket as unknown as Duplex;
    const conn = this.#begin(socket);
    res.once('close', () => this.#end(socket, conn));
    try {
      await this.#handle(req, res, conn);
    } catch (e) {
      this.opts.log.error('docker.proxy.failed', { trace: conn.trace, code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
      this.#answer(res, 500, dockerError('The agent could not handle the request.'), true);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse, conn: Conn): Promise<void> {
    const refused = this.#preflight(req);
    if ('rule' in refused) return this.#deny(res, conn, refused);
    const { method, target, route } = refused;

    let body: unknown;
    if (route.json) {
      const read = await readJson(req, CONNECT_LIMITS.maxJsonBody);
      if ('rule' in read) return this.#deny(res, conn, read);
      body = read.value;
    }
    const decision = await decide({ method, target, route, body, upgrade: false }, this.#ctx);
    if (!decision.allow) return this.#reply(res, conn, decision);
    this.opts.log.debug('docker.request', { trace: conn.trace, kind: route.kind });
    this.#forward(req, res, decision.upstream);
  }

  /** What every request must pass before the route table: one framing, an allowed method, a clean origin-form target that matches a route. */
  #preflight(req: IncomingMessage): Refusal | { method: string; target: Target; route: Route } {
    const framing = framingProblem(req);
    if (framing) return refuse('body', framing);
    const method = req.method ?? '';
    if (!METHODS.has(method)) return refuse('method', `${method.slice(0, 16)} is not allowed.`);
    const target = normalizeTarget(req.url ?? '');
    if ('rule' in target) return target;
    const route = classify(method, target.path);
    if ('rule' in route) return route;
    return { method, target, route };
  }

  #deny(res: ServerResponse, conn: Conn, why: Refusal) {
    this.#count(why.rule, conn.trace);
    this.opts.log.debug('policy.reason', { rule: why.rule, trace: conn.trace });
    this.#answer(res, 403, deniedMessage(why.rule), true);
  }

  #reply(res: ServerResponse, conn: Conn, d: Extract<Decision, { allow: false }>) {
    if (d.rule) return this.#deny(res, conn, { rule: d.rule, message: d.message });
    this.#answer(res, d.status, dockerError(d.message), false);
  }

  #answer(res: ServerResponse, status: number, body: string, close: boolean) {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(close ? { Connection: 'close' } : {}) });
    res.end(body);
    // A refused upload is not read to its end: once the answer is out (Node closes our side), give the client a moment to take it, then drop the stream.
    if (close) {
      const socket = res.req.socket;
      res.once('finish', () => setTimeout(() => socket.destroy(), 2000).unref());
    }
  }

  /** Sends the policy's request to the daemon and relays the answer. */
  #forward(req: IncomingMessage, res: ServerResponse, up: Upstream): void {
    const headers: http.OutgoingHttpHeaders = { host: 'docker' };
    if (typeof req.headers.accept === 'string') headers.accept = req.headers.accept.slice(0, 200);
    if (up.body.kind === 'json') {
      headers['content-type'] = 'application/json';
      headers['content-length'] = up.body.data.length;
    } else if (up.body.kind === 'stream') {
      const type = req.headers['content-type'];
      headers['content-type'] = typeof type === 'string' && SAFE_CONTENT_TYPE.test(type) ? type : 'application/x-tar';
      if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    }
    const upReq = http.request({ socketPath: this.opts.socket, method: up.method, path: up.query ? `${up.path}?${up.query}` : up.path, headers, agent: this.#agent });

    const abort = () => upReq.destroy();
    res.once('close', () => {
      if (!res.writableFinished) abort();
    });
    upReq.on('error', (e: NodeJS.ErrnoException) => {
      this.opts.log.warn('docker.upstream', { code: e.code ?? 'ERR' });
      this.opts.onChange?.('upstream');
      if (!res.headersSent) this.#answer(res, 502, dockerError('The Docker daemon did not answer.'), false);
      else res.destroy();
    });
    upReq.on('response', (upRes) => {
      const out = relayHeaders(upRes);
      const mutating = up.method !== 'GET' && up.method !== 'HEAD' && (upRes.statusCode ?? 500) < 300;
      if (mutating) this.#cache.clear();
      if (up.learn) {
        // A small JSON answer the proxy reads: the id of the exec it just allowed. The bytes the client gets are the daemon's.
        const parts: Buffer[] = [];
        let size = 0;
        upRes.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 1_048_576) {
            upReq.destroy();
            return void res.destroy();
          }
          parts.push(c);
        });
        upRes.on('end', () => {
          const text = Buffer.concat(parts);
          if ((upRes.statusCode ?? 500) < 300) {
            try {
              const id = (JSON.parse(text.toString('utf8')) as { Id?: unknown }).Id;
              if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) this.execs.add(id, up.learn!.container);
            } catch {
              // the daemon's answer is relayed as it is
            }
          }
          res.writeHead(upRes.statusCode ?? 502, out);
          res.end(text);
        });
        return;
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, out);
      // A stream that has nothing to say yet (events, a followed log) must still show its headers, so the client knows it is connected.
      res.flushHeaders();
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });

    if (up.body.kind === 'json') upReq.end(up.body.data);
    else if (up.body.kind === 'stream') {
      req.on('error', abort);
      req.pipe(upReq);
    } else {
      req.resume();
      upReq.end();
    }
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Upgrade: the one hijacked exchange
   * ------------------------------------------------------------------------------------------------------------------------ */

  /**
   * Node emits `upgrade` for any request that says `Connection: Upgrade`, and then leaves the body to us: `head` is the bytes already read
   * after the headers. Only `exec/{id}/start` may upgrade; its small JSON body (Content-Length only) is read here, checked, and the
   * daemon gets a new request. After its 101 the two sockets are piped both ways, which is the raw stream of the exec.
   */
  async #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const conn = this.#begin(socket);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.#end(socket, conn);
    };
    socket.once('close', done);
    const rawAnswer = (status: string, body: string) => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      else socket.destroy();
      done();
    };
    const denyRaw = (why: Refusal) => {
      this.#count(why.rule, conn.trace);
      rawAnswer('403 Forbidden', deniedMessage(why.rule));
    };

    try {
      const pre = this.#preflight(req);
      if ('rule' in pre) return denyRaw(pre.rule === 'path' || pre.rule === 'method' ? refuse('upgrade', 'Only an exec may take over the connection.') : pre);
      const { method, target, route } = pre;
      if (route.kind !== 'execStart' || String(req.headers.upgrade ?? '').toLowerCase() !== 'tcp') return denyRaw(refuse('upgrade', 'Only an exec may take over the connection.'));
      const length = Number(req.headers['content-length'] ?? '');
      if (!Number.isInteger(length) || length < 0 || length > 65_536 || req.headers['transfer-encoding']) return denyRaw(refuse('body', 'A hijacked exec needs a small body with a Content-Length.'));

      const got = await readFromSocket(socket, head, length).catch(() => null);
      if (!got) return denyRaw(refuse('body', 'The body did not arrive.'));
      let parsed: unknown;
      if (length > 0) {
        try {
          parsed = JSON.parse(got.body.toString('utf8'));
        } catch {
          return denyRaw(refuse('body', 'The body is not JSON.'));
        }
      }
      const decision = await decide({ method, target, route, body: parsed, upgrade: true }, this.#ctx);
      if (!decision.allow) {
        if (decision.rule) return denyRaw({ rule: decision.rule, message: decision.message });
        return rawAnswer(`${decision.status} ${decision.status === 404 ? 'Not Found' : 'Bad Gateway'}`, dockerError(decision.message));
      }
      this.opts.log.debug('docker.request', { trace: conn.trace, kind: 'execStart', upgrade: true });
      await this.#hijack(socket, decision.upstream, got.rest, done);
    } catch (e) {
      this.opts.log.error('docker.proxy.failed', { trace: conn.trace, code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
      rawAnswer('500 Internal Server Error', dockerError('The agent could not handle the request.'));
    }
  }

  #hijack(socket: Duplex, up: Upstream, early: Buffer, done: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const data = up.body.kind === 'json' ? up.body.data : Buffer.alloc(0);
      const upReq = http.request({
        socketPath: this.opts.socket,
        method: up.method,
        path: up.path,
        agent: false,
        headers: { host: 'docker', connection: 'Upgrade', upgrade: 'tcp', 'content-type': 'application/json', 'content-length': data.length },
      });
      const fail = (status: string, message: string) => {
        if (socket.writable) {
          const body = dockerError(message);
          socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        } else socket.destroy();
        done();
        resolve();
      };
      upReq.on('error', () => fail('502 Bad Gateway', 'The Docker daemon did not answer.'));
      socket.once('close', () => upReq.destroy());
      upReq.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'UPGRADED'}`];
        for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && k.toLowerCase() !== 'content-length') lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (early.length) upSocket.write(early);
        socket.pipe(upSocket);
        upSocket.pipe(socket);
        const end = () => {
          upSocket.destroy();
          socket.destroy();
          done();
          resolve();
        };
        upSocket.once('close', end);
        socket.once('close', end);
        upSocket.on('error', () => undefined);
        socket.on('error', () => undefined);
      });
      upReq.on('response', (upRes) => {
        // The daemon did not take the upgrade (no such exec, already running): its answer goes to the client as it is.
        const parts: Buffer[] = [];
        upRes.on('data', (c: Buffer) => parts.length < 64 && parts.push(c));
        upRes.on('end', () => {
          const body = Buffer.concat(parts);
          const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ''}`.trim(), 'Connection: close', `Content-Length: ${body.length}`];
          const type = upRes.headers['content-type'];
          if (typeof type === 'string') lines.push(`Content-Type: ${type}`);
          if (socket.writable) socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
          done();
          resolve();
        });
      });
      upReq.end(data);
    });
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Container lookups (cached for 2 s)
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #resolve(ref: string): Promise<Resolved> {
    const now = (this.opts.now ?? Date.now)();
    const cached = this.#cache.get(ref);
    if (cached && now - cached.at < (this.opts.resolveTtlMs ?? 2000)) return cached.value;
    let value: Resolved;
    try {
      const res = await this.daemon(`/containers/${ref}/json`, 10_000);
      if (res.status === 404) value = { state: 'missing' };
      else if (res.status === 200) {
        const info = JSON.parse(res.body.toString('utf8')) as { Id?: unknown; Config?: { Labels?: Record<string, unknown> | null } };
        const labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(info.Config?.Labels ?? {})) if (typeof v === 'string') labels[k] = v;
        value = typeof info.Id === 'string' ? { state: 'found', id: info.Id, labels } : { state: 'error', message: 'unexpected answer' };
      } else value = { state: 'error', message: `status ${res.status}` };
    } catch {
      return { state: 'error', message: 'unreachable' };
    }
    if (value.state !== 'error') {
      this.#cache.set(ref, { at: now, value });
      if (this.#cache.size > 512) this.#cache.delete(this.#cache.keys().next().value as string);
    }
    return value;
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------------------------------------------------------------------- */

/** Reads a JSON body up to `limit` bytes. `value` is undefined when there was no body. */
function readJson(req: IncomingMessage, limit: number): Promise<{ value: unknown } | Refusal> {
  return new Promise((resolve) => {
    const length = Number(req.headers['content-length'] ?? '0');
    if (length > limit) return resolve(refuse('body', 'The body is too large.'));
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(refuse('body', 'The body is too large.'));
        return void req.destroy();
      }
      parts.push(c);
    });
    req.on('error', () => resolve(refuse('body', 'The body could not be read.')));
    req.on('end', () => {
      if (size === 0) return resolve({ value: undefined });
      try {
        resolve({ value: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown });
      } catch {
        resolve(refuse('body', 'The body is not JSON.'));
      }
    });
  });
}
