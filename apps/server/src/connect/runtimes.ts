// The enrolled targets' runtimes on the workspace manager (docs/prd/targets-connect.md §12.1, §12.8): one `Runtime` per active target, made by the
// factory T3 gives (`useRuntimeFactory`), added, replaced and removed on the manager as the registry changes (`bind`), plus the three questions
// the manager asks Connect: may a workspace be created here (`canCreate`), have the agents come back yet after a restart (`settled`), and which
// target just came back (`onReturned`). A runtime outlives its tunnel on purpose: while the node is offline the manager serves the stored
// snapshot as Unreachable, so a runtime is only taken away with its target (and none is made while the kill switch is off).

import { AppError } from '@isnanme/core';
import { CONNECT_ROLE, type Workspace } from '@portal/contracts';
import type { ConnectConfig } from './config.js';
import type { Hub } from './hub.js';
import type { Registry } from './registry.js';
import type { ConnectModuleApi, ConnectNodeRecord, RuntimeDeps, RuntimeFactory } from './seams.js';
import type { Runtime } from '../workspaces/runtime.js';
import type { ConnectSettingsStore } from './settings.js';
import type { ConnectStore, NodeRow, TargetRow } from './store.js';

type BindTarget = Parameters<ConnectModuleApi['bind']>[0];

export interface RuntimesDeps {
  registry: Registry;
  hub: Hub;
  store: ConnectStore;
  config: ConnectConfig;
  settings: ConnectSettingsStore;
  portalId(): string | null;
  log(line: string): void;
}

export class Runtimes {
  #factory: RuntimeFactory | null = null;
  #ws: BindTarget | null = null;
  readonly #built = new Map<string, { runtime: Runtime; signature: string }>();
  readonly #deps: RuntimeDeps;

  constructor(private readonly d: RuntimesDeps) {
    this.#deps = {
      portalId: () => d.portalId(),
      image: (t) => t.settings.workspaceImage || d.config.workspaceImage,
      snapshots: {
        save: (targetId, list: Workspace[]) => d.registry.saveSnapshot(targetId, list),
        last: (targetId) => d.registry.lastSnapshot(targetId),
      },
      switch: {
        get: (targetId) => d.registry.target(targetId)?.settings.running !== false,
        set: (targetId, on) => d.registry.setRunning(targetId, on),
      },
      log: (line) => d.log(line),
    };
    d.registry.onChange((c) => this.sync(c.targetId));
  }

  useFactory(f: RuntimeFactory): void {
    this.#factory = f;
    this.syncAll();
  }

  bind(workspaces: BindTarget): void {
    this.#ws = workspaces;
    this.syncAll();
  }

  /** The nodes a runtime is given: the live ones, or (so that a target whose every node was revoked still shows its workspaces as Unreachable) the revoked ones, drained. */
  #nodesOf(t: TargetRow): { record: ConnectNodeRecord; link: ReturnType<Hub['link']> }[] {
    const all = this.d.store.nodes(t.id);
    const live = all.filter((n) => !n.revokedAt);
    const use: NodeRow[] = live.length ? live : all;
    return use.map((n) => ({ record: { ...this.d.registry.nodeRecord(n), drained: n.drained || !!n.revokedAt }, link: this.d.hub.link(n) }));
  }

  /** What changes the runtime's shape (a running switch does not: it is read through `deps.switch`). */
  #signature(t: TargetRow, nodes: { record: ConnectNodeRecord }[]): string {
    const { running: _running, ...settings } = t.settings;
    void _running;
    return JSON.stringify([t.kind, t.label, t.portalUrl, settings, nodes.map((n) => [n.record.id, n.record.name, n.record.drained])]);
  }

  /** Brings one target's runtime in line with the registry. Safe to call any time. */
  sync(targetId: string): void {
    const ws = this.#ws;
    const factory = this.#factory;
    if (!ws || !factory || !this.d.config.enabled) return;
    const t = this.d.registry.target(targetId);
    const had = this.#built.get(targetId);
    if (!t) {
      if (had) {
        this.#built.delete(targetId);
        ws.removeRuntime(targetId);
      }
      return;
    }
    if (t.state !== 'active') return;
    const nodes = this.#nodesOf(t);
    const signature = this.#signature(t, nodes);
    if (had && had.signature === signature) return;
    let runtime: Runtime;
    try {
      runtime = factory(this.d.registry.record(t), nodes, this.#deps);
    } catch (e) {
      this.d.log(`[connect] could not make the runtime of ${targetId}: ${(e as Error).message}`);
      return;
    }
    this.#built.set(targetId, { runtime, signature });
    if (had) ws.replaceRuntime(runtime);
    else ws.addRuntime(runtime);
  }

  syncAll(): void {
    for (const t of this.d.registry.targets()) this.sync(t.id);
    for (const id of [...this.#built.keys()]) if (!this.d.registry.target(id)) this.sync(id);
  }

  has(targetId: string): boolean {
    return this.#built.has(targetId);
  }

  // ---- what the manager asks -----------------------------------------------------------------------------------------------------------

  /** Throws LIMIT_REACHED when `maxWorkspaces` is reached and CONFLICT when a drain says no (PRD FR10, §12.8). A target that is not an enrolled cluster is not ours to judge. */
  canCreate(targetId: string, node?: string): void {
    const t = this.d.registry.target(targetId);
    if (!t || CONNECT_ROLE[t.kind] !== 'cluster') return;
    const nodes = this.d.registry.liveNodes(targetId);
    if (node) {
      const n = nodes.find((x) => x.id === node || x.name === node);
      if (!n) throw new AppError('CONFLICT', 'There is no such node on this target.');
      if (n.drained) throw new AppError('CONFLICT', `${n.name} is drained: it takes no new workspaces.`);
    } else if (nodes.length > 0 && nodes.every((n) => n.drained)) throw new AppError('CONFLICT', 'Every node of this target is drained: none takes new workspaces.');
    const max = t.settings.maxWorkspaces;
    if (typeof max === 'number' && this.d.registry.workspaceCount(t) >= max) throw new AppError('LIMIT_REACHED', `This target holds at most ${max} workspace${max === 1 ? '' : 's'}.`, { details: { limit: max } });
  }

  /** Resolves when every node that was connected before the restart has connected again, or after `ms` (FR38). */
  settled(ms: number): Promise<void> {
    if (!this.d.config.enabled) return Promise.resolve();
    const waiting = new Set(this.d.store.nodesSeenBefore().filter((n) => !this.d.hub.hasConnectedSinceStart(n.id)).map((n) => n.id));
    if (!waiting.size) return Promise.resolve();
    return new Promise((resolve) => {
      let off: () => void = () => undefined;
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      off = this.d.hub.onConnected((_target, nodeId) => {
        waiting.delete(nodeId);
        if (!waiting.size) done();
      });
    });
  }

  onReturned(fn: (targetId: string) => void): () => void {
    return this.d.hub.onConnected((targetId) => fn(targetId));
  }
}
