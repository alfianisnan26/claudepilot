// Test support for the tunnelled runtimes (docs/prd/targets-connect.md §19.3 T-RT, T-MGR, T-OUT): a `NodeLink` over a real mux pair on
// an in-memory socket, whose agent end serves `docker` (a byte pipe to a Docker socket: the DinD one or a recording fake), `kube` (a
// pipe to a TCP port: a fake API server) and `host` (T2's host service). `connect()` and `drop()` make and break the tunnel, so a test
// can do to a runtime what a dropped WebSocket does. Nothing in the portal imports this file.
import net from 'node:net';
import type { ConnectHostOpen, ConnectStatusMessage, ConnectStreamError } from '@portal/contracts';
import { ConnectError, type NodeInfo, type NodeLink, type RuntimeDeps, type TunnelStream, type ConnectTargetRecord } from '../../connect/seams.js';
import { memoryPair } from '../../connect/tunnel/memory.js';
import { MuxSession, type MuxStream } from '../../connect/tunnel/mux.js';
import { acceptService, openService, type OpenDecision } from '../../connect/tunnel/open.js';
import type { HostService } from '../../connect/agent/services/host/index.js';
import type { Workspace } from '@portal/contracts';

export interface FakeAgentServices {
  /** Where `docker` streams go: a unix socket path (`/var/run/docker.sock`, or a fake daemon's). */
  dockerSocket?: string;
  /** Where `kube` streams go: a loopback TCP port (a fake API server). */
  kubePort?: number;
  host?: HostService;
}

/** Pipes a stream to a fresh connection, both ways, ending and destroying together. */
function pipeTo(stream: MuxStream, conn: net.Socket) {
  stream.pipe(conn);
  conn.pipe(stream);
  conn.on('error', () => stream.destroy());
  stream.on('error', () => conn.destroy());
  stream.on('close', () => conn.destroy());
  conn.on('close', () => stream.destroy());
}

export class FakeLink implements NodeLink {
  #portal: MuxSession | null = null;
  #agent: MuxSession | null = null;
  #token: string | null = null;
  #info: NodeInfo | null = null;
  readonly #listeners = new Set<(connected: boolean) => void>();
  /** Every stream the portal opened, by service (the tests' view of what crossed the tunnel). */
  readonly opened: { service: string; args?: ConnectHostOpen }[] = [];

  constructor(
    readonly nodeId: string,
    readonly targetId: string,
    private readonly services: FakeAgentServices,
    private readonly status: Partial<ConnectStatusMessage> = {},
  ) {}

  connected() {
    return !!this.#portal && !this.#portal.closed;
  }

  /** Makes the tunnel (again). */
  connect(): this {
    if (this.connected()) return this;
    const [a, b] = memoryPair();
    const agent = new MuxSession({ role: 'client', socket: a, onStream: (s) => void this.#serve(s) });
    const portal = new MuxSession({ role: 'server', socket: b, closeError: () => new ConnectError('agent_offline', 'The node went offline.') });
    this.#agent = agent;
    this.#portal = portal;
    this.#token = `kube-${Math.random().toString(36).slice(2)}`;
    this.#info = {
      hello: { t: 'hello', v: 1 } as unknown as NodeInfo['hello'],
      status: { t: 'status', at: new Date().toISOString(), services: [], ...this.status } as ConnectStatusMessage,
      connectedAt: new Date().toISOString(),
      rttMs: 1,
      ip: '127.0.0.1',
    };
    portal.onClose(() => {
      if (this.#portal !== portal) return;
      this.#portal = null;
      this.#token = null;
      this.#info = null;
      this.#listeners.forEach((fn) => fn(false));
    });
    this.#listeners.forEach((fn) => fn(true));
    return this;
  }

  /** Breaks the tunnel the way a dropped WebSocket does: every open stream fails. */
  drop(): this {
    this.#agent?.destroy('dropped');
    this.#portal?.destroy('dropped');
    return this;
  }

  setStatus(status: Partial<ConnectStatusMessage>) {
    if (this.#info) this.#info = { ...this.#info, status: { ...this.#info.status!, ...status } };
  }

  async open(service: 'docker' | 'kube' | 'host', args?: ConnectHostOpen, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TunnelStream> {
    const session = this.#portal;
    if (!session || session.closed) throw new ConnectError('agent_offline', 'The node is offline.');
    this.opened.push({ service, ...(args ? { args } : {}) });
    return (await openService(session, { service, ...(args ? { args } : {}) }, opts)) as unknown as TunnelStream;
  }

  info() {
    return this.#info;
  }

  onChange(fn: (connected: boolean) => void) {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  kubeToken() {
    return this.#token;
  }

  #serve(stream: MuxStream) {
    return serveAgentStream(stream, this.services);
  }
}

/** The agent's end of one stream: accepts it for the services there are and pipes or hands it over (a stand-in for T2's agent). */
export async function serveAgentStream(stream: MuxStream, services: FakeAgentServices) {
  let hostRefusal: { code: ConnectStreamError; message: string } | null = null;
  const request = await acceptService(stream, async (r): Promise<OpenDecision> => {
    if (r.service === 'docker' && services.dockerSocket) return { ok: true };
    if (r.service === 'kube' && services.kubePort) return { ok: true };
    if (r.service === 'host' && services.host) {
      hostRefusal = await services.host.accept(r.args);
      return hostRefusal ? { ok: false, code: hostRefusal.code, message: hostRefusal.message } : { ok: true };
    }
    return { ok: false, code: 'service_unavailable', message: `No ${r.service} here.` };
  });
  if (!request) return;
  if (request.service === 'docker') pipeTo(stream, net.connect(services.dockerSocket!));
  else if (request.service === 'kube') pipeTo(stream, net.connect(services.kubePort!, '127.0.0.1'));
  else services.host!.handle(stream as unknown as TunnelStream, request.trace ?? 'test0001', request.args);
}

export const targetRecord = (over: Partial<ConnectTargetRecord> = {}): ConnectTargetRecord => ({
  id: 'cx3-t',
  label: 'cx3 target',
  kind: 'docker',
  portalUrl: 'http://portal.example:3213',
  settings: {},
  active: true,
  isDefault: false,
  ...over,
});

/** A RuntimeDeps that keeps everything in memory. */
export function memoryDeps(over: Partial<{ portalId: string | null; image: string }> = {}): RuntimeDeps & { logs: string[]; saved: Map<string, { at: string; workspaces: Workspace[] }>; switches: Map<string, boolean> } {
  const saved = new Map<string, { at: string; workspaces: Workspace[] }>();
  const switches = new Map<string, boolean>();
  const logs: string[] = [];
  return {
    logs,
    saved,
    switches,
    portalId: () => (over.portalId === undefined ? 'cx3-portal' : over.portalId),
    image: (t) => t.settings.workspaceImage ?? over.image ?? 'claudepilot-workspace:latest',
    snapshots: {
      save: (id, list) => void saved.set(id, { at: new Date().toISOString(), workspaces: list }),
      last: (id) => saved.get(id) ?? null,
    },
    switch: { get: (id) => switches.get(id) ?? false, set: (id, on) => void switches.set(id, on) },
    log: (line) => void logs.push(line),
  };
}

/**
 * A tiny Docker daemon on a unix socket, enough for DockerRuntime's list, create, start, stop, remove, inspect and ping (no exec):
 * the cluster tests' nodes, so placement, names across nodes and outages are tested without DinD. `requests` records what it was asked.
 */
export async function fakeDaemon(path: string, opts: { ncpu?: number } = {}) {
  const { createServer } = await import('node:http');
  const containers = new Map<string, { Id: string; Names: string[]; Labels: Record<string, string>; State: string; Status: string; Image: string; Created: number }>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.replace(/^\/v\d+\.\d+/, '');
    requests.push(`${req.method} ${p}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (p === '/_ping') return void res.end('OK');
      if (p === '/info') return json(200, { NCPU: opts.ncpu ?? 2 });
      if (p === '/events') return void res.writeHead(200).flushHeaders();
      if (req.method === 'GET' && p === '/containers/json') {
        const f = JSON.parse(url.searchParams.get('filters') ?? '{}') as { name?: string[]; label?: string[] };
        let list = [...containers.values()];
        if (f.name) list = list.filter((c) => f.name!.some((n) => new RegExp(n).test(c.Names[0]!)));
        if (f.label) list = list.filter((c) => f.label!.every((l) => { const [k, v] = l.split('='); return v === undefined ? k! in c.Labels : c.Labels[k!] === v; }));
        return json(200, list);
      }
      let m = p.match(/^\/images\/(.+)\/json$/);
      if (m) return json(200, { Id: 'sha256:img', Config: { Labels: {} }, Created: new Date().toISOString(), Size: 1 });
      if (req.method === 'POST' && p === '/containers/create') {
        const spec = JSON.parse(body) as { Image: string; Labels: Record<string, string> };
        const name = url.searchParams.get('name')!;
        containers.set(name, { Id: name, Names: [`/${name}`], Labels: spec.Labels, State: 'created', Status: 'Created', Image: spec.Image, Created: Math.floor(Date.now() / 1000) });
        return json(201, { Id: name });
      }
      m = p.match(/^\/containers\/([^/]+)(?:\/(start|stop|json))?$/);
      const c = m ? containers.get(m[1]!) : undefined;
      if (m && !c) return json(404, { message: 'No such container' });
      if (m && c) {
        if (m[2] === 'start') (c.State = 'running'), (c.Status = 'Up');
        else if (m[2] === 'stop') (c.State = 'exited'), (c.Status = 'Exited');
        else if (m[2] === 'json') return json(200, { Id: c.Id, State: { Running: c.State === 'running' }, Config: { Labels: c.Labels, Image: c.Image }, Mounts: [] });
        else if (req.method === 'DELETE') containers.delete(m[1]!);
        res.writeHead(204);
        return void res.end();
      }
      if (req.method === 'DELETE' && p.startsWith('/volumes/')) return void res.writeHead(204).end();
      json(404, { message: `fake daemon: ${req.method} ${p}` });
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { containers, requests, close: () => new Promise<void>((r) => server.close(() => r())), server };
}

/**
 * A tiny Kubernetes API server on loopback for the tunnelled Kubernetes runtime: deployments (a Running pod per replica), claims,
 * scale, delete, and `pods/exec` over a WebSocket (it echoes the command line on stdout and reports Success). Creating a namespace is
 * answered 403, as a namespaced Role would; `requests` records every call with the bearer it carried.
 */
export async function fakeKubeApi() {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const deployments = new Map<string, { metadata: { name: string; namespace: string; labels: Record<string, string>; creationTimestamp: string }; spec: { replicas: number; template: unknown } }>();
  const claims = new Set<string>();
  const requests: { method: string; path: string; auth: string | undefined }[] = [];
  const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const pods = (ns: string) =>
    [...deployments.values()]
      .filter((d) => d.metadata.namespace === ns && d.spec.replicas > 0)
      .map((d) => ({ metadata: { name: `${d.metadata.name}-pod`, labels: d.metadata.labels }, status: { phase: 'Running', containerStatuses: [{ name: 'workspace', ready: true, state: { running: {} } }] } }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    requests.push({ method: req.method!, path: p, auth: req.headers.authorization });
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && p === '/api/v1/namespaces') return json(res, 403, { kind: 'Status', status: 'Failure', message: 'namespaces is forbidden', code: 403 });
      let m = p.match(/^\/api\/v1\/namespaces\/([^/]+)\/pods$/);
      if (m) return json(res, 200, { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: pods(m[1]!) });
      m = p.match(/^\/apis\/apps\/v1\/namespaces\/([^/]+)\/deployments(?:\/([^/]+))?(\/scale)?$/);
      if (m) {
        const [, ns, name, scale] = m;
        if (!name && req.method === 'GET') return json(res, 200, { kind: 'DeploymentList', apiVersion: 'apps/v1', metadata: {}, items: [...deployments.values()].filter((d) => d.metadata.namespace === ns) });
        if (!name && req.method === 'POST') {
          const d = JSON.parse(body);
          d.metadata.namespace = ns;
          d.metadata.creationTimestamp = new Date().toISOString();
          deployments.set(d.metadata.name, d);
          return json(res, 201, d);
        }
        const d = deployments.get(name!);
        if (!d) return json(res, 404, { kind: 'Status', status: 'Failure', code: 404, message: 'not found' });
        if (scale) {
          d.spec.replicas = JSON.parse(body).spec.replicas;
          return json(res, 200, { kind: 'Scale', spec: { replicas: d.spec.replicas } });
        }
        if (req.method === 'DELETE') deployments.delete(name!);
        return json(res, 200, d);
      }
      m = p.match(/^\/api\/v1\/namespaces\/([^/]+)\/persistentvolumeclaims(?:\/([^/]+))?$/);
      if (m) {
        if (req.method === 'POST') claims.add(JSON.parse(body).metadata.name);
        if (req.method === 'DELETE') claims.delete(m[2]!);
        return json(res, req.method === 'POST' ? 201 : 200, { kind: 'PersistentVolumeClaim' });
      }
      json(res, 404, { kind: 'Status', status: 'Failure', code: 404, message: `fake: ${req.method} ${p}` });
    });
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push({ method: 'UPGRADE', path: url.pathname, auth: req.headers.authorization });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const command = url.searchParams.getAll('command').join(' ');
      ws.send(Buffer.concat([Buffer.from([1]), Buffer.from(`exec: ${command}\n`)]));
      ws.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: 'Success' }))]));
      setTimeout(() => ws.close(), 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { port, deployments, claims, requests, close: () => new Promise<void>((r) => { wss.close(); server.closeAllConnections(); server.close(() => r()); }) };
}
