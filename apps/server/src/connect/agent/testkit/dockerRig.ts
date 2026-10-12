// Test rig for the Docker policy: a FakeDocker, the agent's docker service in front of it, and ways to talk to the service the way the
// portal does (an `http.Agent` whose connections are streams served by the proxy: what T3's TunnelAgent does over the tunnel) or with
// raw bytes (what an attacker does).
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import Docker from 'dockerode';
import { createService, type DockerService, type DockerServiceOptions } from '../services/docker/index.js';
import { collectingLogger } from '../log.js';
import { FakeDocker } from './fakeDocker.js';
import { streamPair } from './streams.js';

export const PORTAL_ID = '6f1c0d52-3b1e-4a64-9c43-0d6c3c9b7a11';
export const IMAGE = 'claudepilot-workspace:latest';

class StreamAgent extends http.Agent {
  constructor(private readonly serve: (agentSide: Duplex) => void) {
    super({ keepAlive: true, maxSockets: 8 });
  }
  override createConnection(_options: http.ClientRequestArgs, _cb?: (err: Error | null, stream: Duplex) => void) {
    const [portal, agent] = streamPair();
    this.serve(agent);
    // Like a net.Socket (allowHalfOpen false): when the agent ends the stream (its idle time), this side ends too, so the HTTP agent drops it from its pool.
    portal.once('end', () => portal.end());
    return portal;
  }
}

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: () => unknown;
}

export interface DockerRig {
  fake: FakeDocker;
  service: DockerService;
  log: ReturnType<typeof collectingLogger>;
  /** A dockerode client whose connections are streams served by the proxy. */
  docker: Docker;
  agent: http.Agent;
  request(method: string, path: string, opts?: { body?: unknown; rawBody?: Buffer | string; headers?: Record<string, string> }): Promise<Answer>;
  /** Sends bytes as one connection and returns whatever comes back until it ends or goes quiet. */
  raw(bytes: string | Buffer, opts?: { quietMs?: number; keepOpen?: boolean }): Promise<string>;
  denied(): { rule: string; count: number }[];
  stop(): Promise<void>;
}

export async function startDockerRig(opts: { images?: string[]; portalId?: string | null; allowBinds?: string[]; service?: Partial<DockerServiceOptions> } = {}): Promise<DockerRig> {
  const fake = await FakeDocker.start({ images: [IMAGE, ...(opts.images ?? [])] });
  const log = collectingLogger();
  const portalId = opts.portalId === undefined ? PORTAL_ID : opts.portalId;
  const service = createService({
    socket: fake.socketPath,
    images: [IMAGE, ...(opts.images ?? [])],
    allowBinds: opts.allowBinds ?? [],
    portalId: () => portalId,
    log: log.logger,
    ...opts.service,
  });
  await service.refresh!();
  const agent = new StreamAgent((side) => service.handle(side as never, 'abcd1234'));
  const docker = new Docker({ protocol: 'http', host: 'tunnel.invalid', port: 2375, agent } as never);
  const denied: { rule: string; count: number }[] = [];

  const request: DockerRig['request'] = (method, path, o = {}) =>
    new Promise((resolve, reject) => {
      const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
      const headers: Record<string, string | number> = { ...(o.headers ?? {}) };
      if (payload !== undefined) {
        headers['Content-Length'] = Buffer.byteLength(payload);
        headers['Content-Type'] ??= 'application/json';
      }
      const req = http.request({ host: 'tunnel.invalid', port: 2375, method, path, agent, headers }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const body = Buffer.concat(parts);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8'), json: () => JSON.parse(body.toString('utf8')) as unknown });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });

  const raw: DockerRig['raw'] = async (bytes, o = {}) => {
    const [portal, side] = streamPair();
    service.handle(side as never, 'raw00000');
    const parts: Buffer[] = [];
    portal.on('data', (c: Buffer) => parts.push(c));
    portal.on('error', () => undefined);
    portal.write(bytes);
    const quiet = o.quietMs ?? 250;
    let seen = -1;
    for (let i = 0; i < 80; i++) {
      await sleep(quiet);
      const size = parts.reduce((n, p) => n + p.length, 0);
      if (size === seen || portal.destroyed || portal.readableEnded) break;
      seen = size;
    }
    if (!o.keepOpen) portal.destroy();
    return Buffer.concat(parts).toString('latin1');
  };

  return {
    fake,
    service,
    log,
    docker,
    agent,
    request,
    raw,
    denied: () => {
      const taken = service.report!().denied ?? [];
      for (const d of taken) denied.push(d);
      return denied;
    },
    async stop() {
      agent.destroy();
      service.close();
      await fake.stop();
    },
  };
}
