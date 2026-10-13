// A Kubernetes target over the tunnel (docs/prd/targets-connect.md §12.6). The Kubernetes client wants an HTTP endpoint, so the portal
// listens on 127.0.0.1:0 (never 0.0.0.0), one listener per connection of the connector; each accepted connection becomes a `kube`
// stream to the agent's proxy, which checks the per-connection bearer (`kubeToken()`), drops it and sets the service account's own.
// The listener closes with the connection; the next connection brings a new port and token, so the KubernetesRuntime is made again.
// The runtime never creates the namespace (the manifest did). Delivery (FR44) is the KubernetesRuntime's, through the same tunnel: exec
// only, as root through the image's `sudo -n` (kubernetesDelivery.ts); `settings.delivery: false` switches it off for the target (FR43).
import net from 'node:net';
import { AppError } from '@isnanme/core';
import { KubeConfig } from '@kubernetes/client-node';
import type { Workspace, WorkspaceUsage } from '@portal/contracts';
import type { ConnectNodeRecord, ConnectTargetRecord, NodeLink, RuntimeDeps } from '../../connect/seams.js';
import { KubernetesRuntime } from '../kubernetes.js';
import { pollStarts, START_POLL_MS } from '../kubernetesDelivery.js';
import { TargetUnreachableError, type CreateSpec, type DeliveryAccess, type ExecSession, type Runtime, type RuntimeNames, type ShellSession } from '../runtime.js';
import { lastSeenText, Reachability } from './link.js';

const DEFAULT_NAMESPACE = 'claudepilot-workspaces';

/** A loopback listener whose connections are `kube` streams on `link`. */
export class KubeLoopback {
  readonly #server: net.Server;
  readonly #sockets = new Set<net.Socket>();

  private constructor(private readonly link: Pick<NodeLink, 'open'>) {
    this.#server = net.createServer((socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.pause();
      this.link.open('kube').then(
        (stream) => {
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
          stream.on('close', () => socket.destroy());
          socket.on('close', () => stream.destroy());
          socket.pipe(stream);
          stream.pipe(socket);
          socket.resume();
        },
        () => socket.destroy(),
      );
    });
  }

  static async listen(link: Pick<NodeLink, 'open'>): Promise<KubeLoopback> {
    const lb = new KubeLoopback(link);
    await new Promise<void>((resolve, reject) => {
      lb.#server.once('error', reject);
      lb.#server.listen(0, '127.0.0.1', () => resolve());
    });
    return lb;
  }

  get port(): number {
    return (this.#server.address() as net.AddressInfo).port;
  }

  close() {
    this.#server.close();
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
  }
}

/** The KubeConfig of a loopback endpoint: plain HTTP to 127.0.0.1 with the per-connection bearer. */
export function loopbackKubeConfig(port: number, token: string): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'tunnel', server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: 'portal', token }],
    contexts: [{ name: 'tunnel', cluster: 'tunnel', user: 'portal' }],
    currentContext: 'tunnel',
  });
  return kc;
}

export class ConnectKubeRuntime implements Runtime {
  readonly portalUrl: string;
  readonly delivery?: DeliveryAccess;
  readonly #link: NodeLink;
  readonly #reach: Reachability;
  #inner: { runtime: KubernetesRuntime; loopback: KubeLoopback; token: string } | null = null;
  #making: Promise<KubernetesRuntime> | null = null;
  readonly #unsubscribe: () => void;
  /** The manager's identity registry (T-42): each connection's KubernetesRuntime reads the stored runtime names from it. */
  #names: RuntimeNames | undefined;

  useNames(names: RuntimeNames) {
    this.#names = names;
    this.#inner?.runtime.useNames(names);
  }

  constructor(
    private readonly record: ConnectTargetRecord,
    node: { record: ConnectNodeRecord; link: NodeLink },
    private readonly deps: RuntimeDeps,
    /** Tests only: how often starts are polled, and the folders delivery may write (an enrolled target always has the engine's). */
    private readonly testing: { startPollMs?: number; deliveryRoots?: readonly string[] } = {},
  ) {
    this.portalUrl = record.portalUrl;
    this.#link = node.link;
    this.#reach = new Reachability(node.link, record.id, deps.snapshots.last(record.id)?.at ?? null);
    this.#unsubscribe = node.link.onChange(() => this.#close());
    // FR43: delivery can be switched off per target; pools, secrets and the chat host then read "unsupported" here.
    if (record.settings.delivery !== false) this.delivery = this.#delivery();
  }

  /**
   * The inner runtime's delivery, made again with each connection; an outage is `TargetUnreachableError` (pending, never failed). Starts are
   * polled here, not by the inner runtime, so the watch outlives a reconnect and a pod that started while the tunnel was down still counts.
   */
  #delivery(): DeliveryAccess {
    return {
      needsRunning: true,
      state: (name) => this.#call((r) => r.delivery.state(name)),
      run: (name, script, opts) => this.#call((r) => r.delivery.run(name, script, opts)),
      put: (name, entries) => this.#call((r) => r.delivery.put(name, entries)),
      read: (name, path) => this.#call((r) => r.delivery.read(name, path)),
      watchStarts: (onStart) => pollStarts(() => this.#call((r) => r.startKeys()), onStart, this.testing.startPollMs ?? START_POLL_MS),
    };
  }

  get #namespace() {
    return this.record.settings.namespace ?? DEFAULT_NAMESPACE;
  }

  get target() {
    return {
      id: this.record.id,
      label: this.record.label,
      kind: 'kubernetes' as const,
      where: `${this.#link.info()?.hello.hostname ?? 'cluster'} / ${this.#namespace}`,
      source: 'enrolled' as const,
      role: 'cluster' as const,
    };
  }

  dispose() {
    this.#unsubscribe();
    this.#close();
  }

  #close() {
    this.#inner?.loopback.close();
    this.#inner = null;
    this.#making = null;
  }

  /** The runtime of the current connection (made on first use after each connect). */
  async #runtime(): Promise<KubernetesRuntime> {
    this.#reach.assertUp();
    const token = this.#link.kubeToken();
    if (!token) throw new TargetUnreachableError(this.record.id, this.#reach.downSince);
    if (this.#inner?.token === token) return this.#inner.runtime;
    if (this.#inner) this.#close();
    this.#making ??= KubeLoopback.listen(this.#link).then((loopback) => {
      const runtime = new KubernetesRuntime(
        {
          namespace: this.#namespace,
          image: this.deps.image(this.record),
          storage: this.record.settings.storage ?? '10Gi',
          ...(this.record.settings.storageClass ? { storageClass: this.record.settings.storageClass } : {}),
          ...(this.testing.deliveryRoots ? { delivery: { roots: this.testing.deliveryRoots } } : {}),
        },
        { kubeConfig: loopbackKubeConfig(loopback.port, token), manageNamespace: false, target: { id: this.record.id, label: this.record.label, where: this.target.where } },
      );
      if (this.#names) runtime.useNames(this.#names);
      this.#inner = { runtime, loopback, token };
      this.#making = null;
      return runtime;
    });
    return this.#making;
  }

  #call<T>(fn: (r: KubernetesRuntime) => Promise<T>): Promise<T> {
    return this.#reach.call(async () => fn(await this.#runtime()));
  }

  check = () => this.#call((r) => r.check());

  async list(): Promise<Workspace[]> {
    const list = await this.#call((r) => r.list());
    this.deps.snapshots.save(this.record.id, list);
    return list;
  }

  reachable(): boolean {
    return this.#link.connected();
  }

  listLastKnown(): Workspace[] {
    const at = this.#reach.downSince ?? this.deps.snapshots.last(this.record.id)?.at ?? null;
    return (this.deps.snapshots.last(this.record.id)?.workspaces ?? []).map((w) => ({ ...w, status: 'unreachable' as const, detail: lastSeenText(at), ...(at ? { lastSeenAt: at } : {}) }));
  }

  async create(spec: CreateSpec, progress: (detail: string) => void) {
    const max = this.record.settings.maxWorkspaces;
    if (typeof max === 'number' && (await this.list()).length >= max) throw new AppError('LIMIT_REACHED', `${this.record.label} holds at most ${max} workspaces.`);
    return this.#call((r) => r.create(spec, progress));
  }

  start = (name: string) => this.#call((r) => r.start(name));
  stop = (name: string) => this.#call((r) => r.stop(name));
  remove = (name: string) => this.#call((r) => r.remove(name));
  usage = (names: string[]): Promise<Omit<WorkspaceUsage, 'id'>[]> =>
    this.#call((r) => r.usage(names)).catch(() => names.map(() => ({ cpuPercent: null, memoryBytes: null })));
  exec = (name: string, command: string[]): Promise<ExecSession> => this.#call((r) => r.exec(name, command));
  shell = (name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> => this.#call((r) => r.shell(name, size, command));

  watch(onChange: () => void): () => void {
    return this.#link.onChange(() => onChange());
  }
}
