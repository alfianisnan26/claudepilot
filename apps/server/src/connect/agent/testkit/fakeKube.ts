// An in-process fake Kubernetes API server (docs/prd/targets-connect.md §19.3 T-KUBE and acceptance scenario A6; T3 and T6 use it too).
// Plain HTTP on 127.0.0.1, no cluster, no kubeconfig: the proxy's server URL, token file and CA are injectable, so nothing here can reach a
// real cluster. It keeps pods, deployments, claims and secrets in memory and records every request with its headers, so a test can assert
// what the "API server" saw: the service account's token and never the client's, no impersonation, only labelled lists.
//
// It speaks the part of the API `KubernetesRuntime`, the agent and the browser pool use: `/version`, pod, deployment, claim, ConfigMap and
// NetworkPolicy lists (selectors, watch), nodes and every namespace's pods (T-98's fit check; or 403 with `clusterReads` off),
// create, replace, scale and delete (a deployment brings a pod up and down), secrets by name, pod metrics, SelfSubjectAccessReview, and
// `pods/exec` over a WebSocket with the channel subprotocol (stdin 0, stdout 1, stderr 2, status 3, resize 4).
import { randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

export interface KubeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type Obj = Record<string, unknown> & { metadata: { name: string; namespace?: string; labels?: Record<string, string>; resourceVersion?: string; uid?: string; creationTimestamp?: string } };

export interface ExecIo {
  pod: string;
  command: string[];
  tty: boolean;
  /** Bytes the client sent on stdin so far, as they arrive. */
  onStdin(fn: (data: Buffer) => void): void;
  stdout(data: string | Buffer): void;
  stderr(data: string | Buffer): void;
  /** Ends the session with the status channel (0 is Success). */
  exit(code: number): void;
  /** Ends the session with this status as it is (a Failure without an exit code: the container is gone, say). */
  status(value: Record<string, unknown>): void;
  onResize(fn: (size: { width: number; height: number }) => void): void;
}

export class FakeKube {
  readonly url: string;
  readonly requests: KubeRequest[] = [];
  /** Upgrade requests (exec), with the subprotocols the client offered. */
  readonly upgrades: { url: string; headers: IncomingHttpHeaders }[] = [];
  /** The token the API server accepts. */
  token = 'sa-token-1';
  readonly namespace: string;
  readonly deployments = new Map<string, Obj>();
  readonly claims = new Map<string, Obj>();
  readonly secrets = new Map<string, Obj>();
  readonly pods = new Map<string, Obj>();
  readonly configMaps = new Map<string, Obj>();
  readonly networkPolicies = new Map<string, Obj>();
  /**
   * Nodes (T-98's fit check): `GET /api/v1/nodes` and `/api/v1/nodes/<name>`. While there is one, a deployment's new pod is scheduled on
   * `scheduleOn` (default: the first node) and carries the template's containers, so its requests count.
   */
  readonly nodes = new Map<string, Obj>();
  scheduleOn: string | undefined;
  /** Pods of other namespaces, for `GET /api/v1/pods` (every namespace) with this namespace's pods. */
  readonly otherPods: Obj[] = [];
  /** false: the cluster-wide reads (nodes, every namespace's pods) answer 403, as for a namespaced Role. */
  clusterReads = true;
  /** Per-container usage the metrics API reports for a pod; default one `workspace` container. */
  podMetrics: (pod: Obj) => { name: string; usage: { cpu: string; memory: string } }[] = () => [{ name: 'workspace', usage: { cpu: '250m', memory: '512Mi' } }];
  /** Scripts an exec: default echoes stdin to stdout and ends on `exit`. */
  onExec: (io: ExecIo) => void = (io) => io.onStdin((d) => (io.stdout(d), d.toString().includes('exit') && io.exit(0)));
  /** Answers SelfSubjectAccessReview. */
  rbac: (attrs: { verb?: string; resource?: string; group?: string; subresource?: string; namespace?: string }) => boolean = () => true;
  #rv = 100;
  #server: http.Server;
  #wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('v4.channel.k8s.io') ? 'v4.channel.k8s.io' : false) });
  readonly #watchers = new Set<{ kind: string; selector: string; write(line: string): void; close(): void }>();
  readonly #sockets = new Set<Duplex>();

  private constructor(server: http.Server, namespace: string) {
    this.#server = server;
    this.namespace = namespace;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  static async start(opts: { namespace?: string; token?: string } = {}): Promise<FakeKube> {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fake = new FakeKube(server, opts.namespace ?? 'claudepilot-workspaces');
    if (opts.token) fake.token = opts.token;
    server.on('request', (req, res) => void fake.#handle(req, res));
    server.on('upgrade', (req, socket, head) => fake.#upgrade(req, socket as Duplex, head));
    server.on('connection', (s) => {
      fake.#sockets.add(s);
      s.on('close', () => fake.#sockets.delete(s));
    });
    return fake;
  }

  async stop(): Promise<void> {
    for (const w of this.#watchers) w.close();
    this.#watchers.clear();
    for (const s of this.#sockets) s.destroy();
    this.#wss.close();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  seen(method: string, pathPattern: RegExp | string): KubeRequest[] {
    return this.requests.filter((r) => r.method === method && (typeof pathPattern === 'string' ? r.url.split('?')[0] === pathPattern : pathPattern.test(r.url)));
  }

  /** What a pod of a deployment looks like once it is running. */
  podFor(d: Obj): Obj {
    const labels = ((d.spec as { template?: { metadata?: { labels?: Record<string, string> } } })?.template?.metadata?.labels ?? {}) as Record<string, string>;
    const name = `${d.metadata.name}-7d9f6c-${randomBytes(2).toString('hex')}`;
    const node = this.nodes.size ? (this.scheduleOn ?? [...this.nodes.keys()][0]!) : undefined;
    const containers = (d.spec as { template?: { spec?: { containers?: unknown[] } } })?.template?.spec?.containers;
    return {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: this.namespace, labels, uid: randomBytes(8).toString('hex'), creationTimestamp: new Date().toISOString(), resourceVersion: String(++this.#rv) },
      spec: node ? { nodeName: node, containers: JSON.parse(JSON.stringify(containers ?? [])) } : {}, status: { phase: 'Running', containerStatuses: [{ name: 'workspace', ready: true, state: { running: {} } }] },
    };
  }

  /* ------------------------------------------------------------------------------------------------------------------------ */

  #reconcile(d: Obj) {
    const want = Number((d.spec as { replicas?: number }).replicas ?? 1);
    const mine = [...this.pods.values()].filter((p) => p.metadata.name.startsWith(`${d.metadata.name}-`));
    if (want > 0 && mine.length === 0) {
      const pod = this.podFor(d);
      this.pods.set(pod.metadata.name, pod);
      this.#notify('pod', 'ADDED', pod);
    }
    if (want === 0) for (const p of mine) {
      this.pods.delete(p.metadata.name);
      this.#notify('pod', 'DELETED', p);
    }
  }

  #notify(kind: string, type: string, obj: Obj) {
    for (const w of this.#watchers) if (w.kind === kind && matchesSelector(obj.metadata.labels ?? {}, w.selector)) w.write(`${JSON.stringify({ type, object: obj })}\n`);
  }

  #auth(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = Buffer.concat(parts);
    this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const send = (code: number, value: unknown) => {
      const text = JSON.stringify(value);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    const status = (code: number, reason: string, message: string) => send(code, { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason, code });
    if (!this.#auth(req)) return status(401, 'Unauthorized', 'Unauthorized');
    const ns = this.namespace;
    let m: RegExpExecArray | null;

    if (path === '/version') return send(200, { major: '1', minor: '30', gitVersion: 'v1.30.1+fake' });
    if (path === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews' && method === 'POST') {
      const spec = (JSON.parse(body.toString('utf8') || '{}') as { spec?: { resourceAttributes?: Record<string, string> } }).spec?.resourceAttributes ?? {};
      return send(201, { kind: 'SelfSubjectAccessReview', status: { allowed: this.rbac(spec) } });
    }
    if (path === `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods` && method === 'GET') {
      const items = [...this.pods.values()].filter((p) => matchesSelector(p.metadata.labels ?? {}, url.searchParams.get('labelSelector') ?? '')).map((p) => ({ metadata: p.metadata, containers: this.podMetrics(p) }));
      return send(200, { kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', items });
    }

    if (path === '/api/v1/nodes' || path.startsWith('/api/v1/nodes/') || path === '/api/v1/pods') {
      if (method !== 'GET') return status(405, 'MethodNotAllowed', 'only reads here');
      if (!this.clusterReads) return status(403, 'Forbidden', `${path} is forbidden: User "system:serviceaccount:portal" cannot list resource at the cluster scope`);
      if (path === '/api/v1/pods') {
        const field = url.searchParams.get('fieldSelector') ?? '';
        const onNode = field.startsWith('spec.nodeName=') ? field.slice('spec.nodeName='.length) : null;
        const items = [...this.pods.values(), ...this.otherPods].filter((p) => !onNode || (p.spec as { nodeName?: string } | undefined)?.nodeName === onNode);
        return send(200, { kind: 'PodList', apiVersion: 'v1', metadata: { resourceVersion: String(this.#rv) }, items });
      }
      if (path === '/api/v1/nodes') return send(200, { kind: 'NodeList', apiVersion: 'v1', metadata: { resourceVersion: String(this.#rv) }, items: [...this.nodes.values()] });
      const node = this.nodes.get(decodeURIComponent(path.slice('/api/v1/nodes/'.length)));
      return node ? send(200, node) : status(404, 'NotFound', 'node not found');
    }

    if (path === '/api/v1/namespaces' && method === 'POST') {
      if (!this.clusterReads) return status(403, 'Forbidden', 'namespaces is forbidden: cannot create resource "namespaces" at the cluster scope');
      return status(409, 'AlreadyExists', `namespaces "${ns}" already exists`);
    }

    const collections: [RegExp, Map<string, Obj>, string, string, string][] = [
      [new RegExp(`^/api/v1/namespaces/${ns}/pods$`), this.pods, 'pod', 'PodList', 'v1'],
      [new RegExp(`^/apis/apps/v1/namespaces/${ns}/deployments$`), this.deployments, 'deployment', 'DeploymentList', 'apps/v1'],
      [new RegExp(`^/api/v1/namespaces/${ns}/persistentvolumeclaims$`), this.claims, 'claim', 'PersistentVolumeClaimList', 'v1'],
      [new RegExp(`^/api/v1/namespaces/${ns}/secrets$`), this.secrets, 'secret', 'SecretList', 'v1'],
      [new RegExp(`^/api/v1/namespaces/${ns}/configmaps$`), this.configMaps, 'configmap', 'ConfigMapList', 'v1'],
      [new RegExp(`^/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies$`), this.networkPolicies, 'networkpolicy', 'NetworkPolicyList', 'networking.k8s.io/v1'],
    ];
    for (const [re, store, kind, listKind, apiVersion] of collections) {
      if (!re.test(path)) continue;
      if (method === 'GET') {
        const selector = url.searchParams.get('labelSelector') ?? '';
        const items = [...store.values()].filter((o) => matchesSelector(o.metadata.labels ?? {}, selector));
        if (url.searchParams.get('watch') === 'true' || url.searchParams.get('watch') === '1') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
          res.flushHeaders();
          for (const o of items) res.write(`${JSON.stringify({ type: 'ADDED', object: o })}\n`);
          const w = { kind, selector, write: (l: string) => void res.write(l), close: () => res.end() };
          this.#watchers.add(w);
          res.on('close', () => this.#watchers.delete(w));
          return;
        }
        const limit = Number(url.searchParams.get('limit') ?? '0');
        return send(200, { kind: listKind, apiVersion, metadata: { resourceVersion: String(this.#rv) }, items: limit > 0 ? items.slice(0, limit) : items });
      }
      if (method === 'POST') {
        const obj = JSON.parse(body.toString('utf8')) as Obj;
        if (store.has(obj.metadata.name)) return status(409, 'AlreadyExists', `${kind} ${obj.metadata.name} already exists`);
        obj.metadata.namespace = ns;
        obj.metadata.resourceVersion = String(++this.#rv);
        obj.metadata.uid = randomBytes(8).toString('hex');
        obj.metadata.creationTimestamp = new Date().toISOString();
        store.set(obj.metadata.name, obj);
        if (kind === 'deployment') this.#reconcile(obj);
        return send(201, obj);
      }
    }

    const named: [RegExp, Map<string, Obj>, string][] = [
      [new RegExp(`^/apis/apps/v1/namespaces/${ns}/deployments/([^/]+)$`), this.deployments, 'deployment'],
      [new RegExp(`^/api/v1/namespaces/${ns}/persistentvolumeclaims/([^/]+)$`), this.claims, 'claim'],
      [new RegExp(`^/api/v1/namespaces/${ns}/secrets/([^/]+)$`), this.secrets, 'secret'],
      [new RegExp(`^/api/v1/namespaces/${ns}/pods/([^/]+)$`), this.pods, 'pod'],
      [new RegExp(`^/api/v1/namespaces/${ns}/configmaps/([^/]+)$`), this.configMaps, 'configmap'],
      [new RegExp(`^/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/([^/]+)$`), this.networkPolicies, 'networkpolicy'],
    ];
    for (const [re, store, kind] of named) {
      if (!(m = re.exec(path))) continue;
      const name = m[1]!;
      const obj = store.get(name);
      if (method === 'GET') return obj ? send(200, obj) : status(404, 'NotFound', `${kind} "${name}" not found`);
      if (method === 'DELETE') {
        if (!obj) return status(404, 'NotFound', `${kind} "${name}" not found`);
        store.delete(name);
        if (kind === 'deployment') for (const p of [...this.pods.values()].filter((p) => p.metadata.name.startsWith(`${name}-`))) (this.pods.delete(p.metadata.name), this.#notify('pod', 'DELETED', p));
        return send(200, { kind: 'Status', apiVersion: 'v1', status: 'Success', code: 200 });
      }
      if (method === 'PUT' || method === 'PATCH') {
        if (!obj) return status(404, 'NotFound', `${kind} "${name}" not found`);
        const next = JSON.parse(body.toString('utf8')) as Obj;
        const merged = method === 'PATCH' ? { ...obj, ...next, metadata: { ...obj.metadata, ...(next.metadata ?? {}) } } : next;
        if (kind === 'secret' && method === 'PUT' && next.metadata.resourceVersion && next.metadata.resourceVersion !== obj.metadata.resourceVersion) return status(409, 'Conflict', 'the object has been modified');
        merged.metadata.name = name;
        merged.metadata.namespace = ns;
        merged.metadata.uid = obj.metadata.uid;
        merged.metadata.resourceVersion = String(++this.#rv);
        store.set(name, merged);
        // A deployment's pod template changed: its pods are replaced (every workspace Deployment is Recreate: the old pod goes first).
        if (kind === 'deployment' && JSON.stringify((obj.spec as { template?: unknown })?.template) !== JSON.stringify((merged.spec as { template?: unknown })?.template)) {
          for (const p of [...this.pods.values()].filter((p) => p.metadata.name.startsWith(`${name}-`))) (this.pods.delete(p.metadata.name), this.#notify('pod', 'DELETED', p));
          this.#reconcile(merged);
        }
        return send(200, merged);
      }
    }

    if ((m = new RegExp(`^/apis/apps/v1/namespaces/${ns}/deployments/([^/]+)/scale$`).exec(path))) {
      const d = this.deployments.get(m[1]!);
      if (!d) return status(404, 'NotFound', `deployment "${m[1]}" not found`);
      if (method === 'GET') return send(200, { kind: 'Scale', apiVersion: 'autoscaling/v1', metadata: d.metadata, spec: { replicas: (d.spec as { replicas?: number }).replicas ?? 1 } });
      if (method === 'PUT' || method === 'PATCH') {
        const wanted = (JSON.parse(body.toString('utf8')) as { spec: { replicas: number } }).spec.replicas;
        (d.spec as { replicas: number }).replicas = wanted;
        d.metadata.resourceVersion = String(++this.#rv);
        this.#reconcile(d);
        return send(200, { kind: 'Scale', apiVersion: 'autoscaling/v1', metadata: d.metadata, spec: { replicas: wanted } });
      }
    }

    return status(404, 'NotFound', `the server could not find the requested resource (${method} ${path})`);
  }

  /* ------------------------------------------------------------------------------------------------------------------------ */

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.alloc(0) });
    this.upgrades.push({ url: req.url ?? '', headers: req.headers });
    const url = new URL(req.url ?? '/', 'http://fake');
    const refuse = (code: string) => void socket.end(`HTTP/1.1 ${code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    if (!this.#auth(req)) return refuse('401 Unauthorized');
    const m = new RegExp(`^/api/v1/namespaces/${this.namespace}/pods/([^/]+)/exec$`).exec(url.pathname);
    if (!m || !this.pods.has(m[1]!)) return refuse('404 Not Found');
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#exec(ws, m[1]!, url));
  }

  #exec(ws: WebSocket, pod: string, url: URL) {
    const stdinFns: ((d: Buffer) => void)[] = [];
    const resizeFns: ((s: { width: number; height: number }) => void)[] = [];
    const frame = (channel: number, data: string | Buffer) => ws.send(Buffer.concat([Buffer.from([channel]), Buffer.from(data)]));
    ws.on('message', (data: Buffer, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!isBinary || buf.length === 0) return;
      if (buf[0] === 0) stdinFns.forEach((f) => f(buf.subarray(1)));
      else if (buf[0] === 4) {
        try {
          const s = JSON.parse(buf.subarray(1).toString('utf8')) as Record<string, number>;
          resizeFns.forEach((f) => f({ width: (s.Width ?? s.width)!, height: (s.Height ?? s.height)! }));
        } catch {
          // not a size
        }
      }
    });
    // The first frames of a v4 session are empty ones on channels 0..; the client library does not need them.
    this.onExec({
      pod,
      command: url.searchParams.getAll('command'),
      tty: url.searchParams.get('tty') === 'true',
      onStdin: (fn) => void stdinFns.push(fn),
      onResize: (fn) => void resizeFns.push(fn),
      stdout: (d) => frame(1, d),
      stderr: (d) => frame(2, d),
      status: (value) => {
        frame(3, JSON.stringify(value));
        ws.close(1000);
      },
      exit: (code) => {
        frame(3, JSON.stringify(code === 0 ? { metadata: {}, status: 'Success' } : { metadata: {}, status: 'Failure', message: `command terminated with non-zero exit code: Error executing in Docker Container: ${code}`, reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: String(code) }] } }));
        ws.close(1000);
      },
    });
  }
}

/** Label selector matching: `a=b`, `a!=b`, `a`, comma-separated and ANDed. */
export function matchesSelector(labels: Record<string, string>, selector: string): boolean {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => {
      if (s.includes('!=')) {
        const [k, v] = s.split('!=');
        return labels[k!] !== v;
      }
      const eq = s.indexOf('=');
      return eq < 0 ? s in labels : labels[s.slice(0, eq).replace(/=$/, '')] === s.slice(eq + 1).replace(/^=/, '');
    });
}
