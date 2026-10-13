// A Docker or Swarm target as one runtime over its nodes (docs/prd/targets-connect.md §12.3, §12.4): one DockerRuntime per node, each
// talking to its node's agent through a `docker` stream per connection. `list()` is the union with `node` on each workspace; names are
// unique across nodes (an offline node's snapshot included); create goes to the asked node or the connected, undrained one with the
// fewest workspaces (ties: most cores); everything else goes to the node that has the workspace. Workspaces never move between nodes.
// A node that is offline keeps its workspaces in the list as `unreachable`; calls to them fail with TargetUnreachableError.
import { AppError } from '@isnanme/core';
import type { Workspace, WorkspaceUsage } from '@portal/contracts';
import type { ConnectNodeRecord, ConnectTargetRecord, NodeLink, RuntimeDeps } from '../../connect/seams.js';
import { DockerRuntime } from '../docker.js';
import { legacyRuntimeName } from '../identity.js';
import { TargetUnreachableError, type CreateSpec, type DeliveryAccess, type ExecSession, type Runtime, type RuntimeNames, type ShellSession } from '../runtime.js';
import { lastSeenText, Reachability } from './link.js';
import { tunnelDocker } from './tunnelAgent.js';

interface Node {
  record: ConnectNodeRecord;
  link: NodeLink;
  reach: Reachability;
  docker: DockerRuntime;
}

const notFound = () => Object.assign(new Error('That workspace doesn’t exist.'), { statusCode: 404 });

export class ConnectDockerRuntime implements Runtime {
  readonly portalUrl: string;
  readonly delivery?: DeliveryAccess;
  readonly #nodes: Node[];
  /** Workspace name -> node id, rebuilt on every list and on a miss. */
  readonly #where = new Map<string, string>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #startListeners = new Set<(name: string) => void>();

  constructor(
    private readonly record: ConnectTargetRecord,
    nodes: { record: ConnectNodeRecord; link: NodeLink }[],
    private readonly deps: RuntimeDeps,
  ) {
    this.portalUrl = record.portalUrl;
    const seed = deps.snapshots.last(record.id)?.at ?? null;
    this.#nodes = nodes.map(({ record: node, link }) => {
      const reach = new Reachability(link, record.id, seed);
      const docker = new DockerRuntime({ id: record.id, label: record.label, socket: 'tunnel' }, deps.image(record), '', () => deps.portalId(), tunnelDocker(link), {
        tunnel: { reach: async () => reach.assertUp() },
      });
      return { record: node, link, reach, docker };
    });
    for (const n of this.#saved()) if (n.node) this.#where.set(n.name, n.node);
    if (record.settings.delivery !== false) this.delivery = this.#delivery();
    // A node that comes back: what started or changed while it was away is checked again (delivery re-reads its running workspaces).
    for (const n of this.#nodes)
      this.#unsubscribe.push(
        n.link.onChange((up) => {
          if (!up || !this.#startListeners.size) return;
          void this.#listNode(n).then(
            (list) => list.filter((w) => w.status === 'running').forEach((w) => this.#startListeners.forEach((fn) => fn(w.name))),
            () => undefined,
          );
        }),
      );
  }

  dispose() {
    this.#unsubscribe.splice(0).forEach((fn) => fn());
  }

  /**
   * A new workspace's container here is `claudepilot-<name>`, not `ws-<12 hex>` (T-42): the agents already installed on Docker and Swarm hosts
   * admit only that form, labelled with the same name (targets-connect PRD appendix A). It is chosen once, at the create, and stored like any
   * runtime name, so a later rename of the workspace's label never touches it. An agent policy that admits `ws-*` would lift this.
   */
  runtimeNameForNew(name: string): string {
    return legacyRuntimeName('docker', name);
  }

  /** The manager's identity registry (T-42): every node's DockerRuntime reads the stored runtime names (containers, volumes) from it. */
  useNames(names: RuntimeNames) {
    for (const n of this.#nodes) n.docker.useNames(names);
  }

  get target() {
    const docker = this.#nodes.map((n) => n.link.info()?.status?.docker).find(Boolean);
    const connected = this.#nodes.filter((n) => n.link.connected()).length;
    const where = `${docker ? `docker ${docker.engine}` : this.record.kind} · ${this.#nodes.length === 1 ? (this.#nodes[0]!.link.info()?.hello.hostname ?? this.#nodes[0]!.record.name) : `${connected}/${this.#nodes.length} nodes`}`;
    return {
      id: this.record.id,
      label: this.record.label,
      kind: 'docker' as const,
      where,
      source: 'enrolled' as const,
      role: 'cluster' as const,
      nodes: this.#nodes.map((n) => ({ id: n.record.id, name: n.record.name, connected: n.link.connected(), drained: n.record.drained })),
    };
  }

  #connected() {
    return this.#nodes.filter((n) => n.link.connected());
  }

  #downSince(): string | null {
    const times = this.#nodes.map((n) => n.reach.downSince).filter((t): t is string => !!t);
    return times.sort().at(-1) ?? this.deps.snapshots.last(this.record.id)?.at ?? null;
  }

  async check() {
    const up = this.#connected();
    if (!up.length) throw new TargetUnreachableError(this.record.id, this.#downSince());
    // Usable when any node answers; one that doesn't is shown on its own row.
    await Promise.any(up.map((n) => n.docker.check())).catch((e: AggregateError) => {
      throw e.errors[0] ?? e;
    });
  }

  #saved(): Workspace[] {
    return this.deps.snapshots.last(this.record.id)?.workspaces ?? [];
  }

  async #listNode(n: Node): Promise<Workspace[]> {
    const list = await n.reach.call(() => n.docker.list());
    return list.map((w) => ({ ...w, node: n.record.id }));
  }

  async list(): Promise<Workspace[]> {
    const up = this.#connected();
    if (!up.length) throw new TargetUnreachableError(this.record.id, this.#downSince());
    const saved = this.#saved();
    const parts = await Promise.all(
      this.#nodes.map(async (n) => {
        if (n.link.connected()) {
          try {
            return { fresh: true, list: await this.#listNode(n) };
          } catch (e) {
            if (!(e instanceof TargetUnreachableError)) throw e;
          }
        }
        return { fresh: false, list: saved.filter((w) => w.node === n.record.id) };
      }),
    );
    // The snapshot keeps each node's last good list: a node that is offline now keeps what it had.
    this.deps.snapshots.save(this.record.id, parts.flatMap((p) => p.list));
    this.#where.clear();
    for (const p of parts) for (const w of p.list) this.#where.set(w.name, w.node!);
    const at = this.#downSince();
    return parts.flatMap((p) => (p.fresh ? p.list : p.list.map((w) => this.#unreachable(w, at))));
  }

  #unreachable(w: Workspace, at: string | null): Workspace {
    return { ...w, status: 'unreachable', detail: lastSeenText(at), ...(at ? { lastSeenAt: at } : {}) };
  }

  /** The workspace's node is connected (a name not known yet: any node is). */
  reachable(name: string): boolean {
    const id = this.#where.get(name);
    const node = id ? this.#nodes.find((n) => n.record.id === id) : undefined;
    return node ? node.link.connected() : this.#connected().length > 0;
  }

  listLastKnown(): Workspace[] {
    const at = this.#downSince();
    return this.#saved().map((w) => this.#unreachable(w, at));
  }

  /** The node a workspace is on; a miss lists again once. */
  async #nodeOf(name: string): Promise<Node> {
    let id = this.#where.get(name);
    if (!id) {
      if (this.#connected().length) await this.list().catch(() => undefined);
      id = this.#where.get(name);
    }
    const node = this.#nodes.find((n) => n.record.id === id);
    if (!node) throw notFound();
    return node;
  }

  async #on<T>(name: string, fn: (d: DockerRuntime) => Promise<T>): Promise<T> {
    const n = await this.#nodeOf(name);
    return n.reach.call(() => fn(n.docker));
  }

  async create(spec: CreateSpec, progress: (detail: string) => void) {
    const all = await this.list().catch((e: unknown) => {
      if (e instanceof TargetUnreachableError) return this.listLastKnown();
      throw e;
    });
    if (all.some((w) => w.name === spec.name)) throw new AppError('CONFLICT', `A workspace named “${spec.name}” already exists on ${this.record.label}.`);
    const max = this.record.settings.maxWorkspaces;
    if (typeof max === 'number' && all.length >= max) throw new AppError('LIMIT_REACHED', `${this.record.label} holds at most ${max} workspaces.`);
    const node = this.#place(spec.node, all);
    this.#where.set(spec.name, node.record.id);
    progress(this.#nodes.length > 1 ? `Placing on ${node.record.name}` : 'Queued');
    await node.reach.call(() => node.docker.create(spec, progress));
  }

  #place(asked: string | undefined, all: Workspace[]): Node {
    if (asked) {
      const n = this.#nodes.find((x) => x.record.id === asked || x.record.name === asked);
      if (!n) throw new AppError('VALIDATION_FAILED', 'Pick a node of this target.', { details: { node: 'Not a node of this target.' } });
      if (n.record.drained) throw new AppError('CONFLICT', `${n.record.name} is drained: no new workspaces go there.`);
      n.reach.assertUp();
      return n;
    }
    const eligible = this.#connected().filter((n) => !n.record.drained);
    if (!eligible.length) {
      if (!this.#connected().length) throw new TargetUnreachableError(this.record.id, this.#downSince());
      throw new AppError('CONFLICT', 'Every connected node is drained.');
    }
    const count = (n: Node) => all.filter((w) => w.node === n.record.id).length;
    const cores = (n: Node) => n.link.info()?.status?.docker?.ncpu ?? n.link.info()?.status?.usage?.cores ?? 0;
    return [...eligible].sort((a, b) => count(a) - count(b) || cores(b) - cores(a))[0]!;
  }

  start = (name: string) => this.#on(name, (d) => d.start(name));
  stop = (name: string) => this.#on(name, (d) => d.stop(name));
  remove = async (name: string) => {
    await this.#on(name, (d) => d.remove(name));
    this.#where.delete(name);
  };
  exec = (name: string, command: string[]): Promise<ExecSession> => this.#on(name, (d) => d.exec(name, command));
  shell = (name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> => this.#on(name, (d) => d.shell(name, size, command));
  imageOf = (name: string) => this.#on(name, (d) => d.imageOf(name)).catch((e: unknown) => ((e as { statusCode?: number }).statusCode === 404 ? null : Promise.reject(e)));

  async usage(names: string[]): Promise<Omit<WorkspaceUsage, 'id'>[]> {
    return Promise.all(
      names.map((name) =>
        this.#on(name, (d) => d.usage([name])).then(
          (u) => u[0]!,
          () => ({ cpuPercent: null, memoryBytes: null }),
        ),
      ),
    );
  }

  watch(onChange: () => void): () => void {
    const stops = this.#nodes.flatMap((n) => [n.docker.watch(onChange), n.link.onChange(() => onChange())]);
    return () => stops.forEach((s) => s());
  }

  #delivery(): DeliveryAccess {
    return {
      state: async (name) => {
        let node: Node;
        try {
          node = await this.#nodeOf(name);
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 404) {
            if (!this.#connected().length) throw new TargetUnreachableError(this.record.id, this.#downSince());
            return { exists: false, running: false };
          }
          throw e;
        }
        return node.reach.call(() => node.docker.delivery.state(name));
      },
      run: (name, script, opts) => this.#on(name, (d) => d.delivery.run(name, script, opts)),
      put: (name, entries) => this.#on(name, (d) => d.delivery.put(name, entries)),
      read: (name, path) => this.#on(name, (d) => d.delivery.read(name, path)),
      watchStarts: (onStart) => {
        this.#startListeners.add(onStart);
        const stops = this.#nodes.map((n) => n.docker.delivery.watchStarts(onStart));
        return () => {
          this.#startListeners.delete(onStart);
          stops.forEach((s) => s());
        };
      },
    };
  }
}
