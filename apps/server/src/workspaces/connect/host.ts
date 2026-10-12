// The Host runtime (docs/prd/targets-connect.md §12.7): an enrolled single (a Host or a Container) as one workspace `<id>/<id>`, with This
// machine's state machine (a switch the portal keeps: off refuses shells and commands; nothing to create or remove) and the agent's
// `host` service as its executor. While the node is offline every call fails with `TargetUnreachableError` and the list shows the
// workspace `unreachable` with when it was last seen.
import { AppError } from '@isnanme/core';
import { workspaceId, type Workspace, type WorkspaceUsage } from '@portal/contracts';
import type { ConnectNodeRecord, ConnectTargetRecord, NodeLink, RuntimeDeps } from '../../connect/seams.js';
import type { CreateSpec, DeliveryAccess, ExecSession, Runtime, ShellSession } from '../runtime.js';
import { tarOf } from '../tar.js';
import { HostCall, lastSeenText, Reachability } from './link.js';

const OFF = 'This workspace is switched off. Start it first.';
/** A login shell: the user's own, else bash, else sh (the agent maps nothing in it). */
const LOGIN = ['sh', '-c', 'exec "${SHELL:-$(command -v bash || echo sh)}" -l'];

export class HostRuntime implements Runtime {
  readonly target;
  readonly portalUrl: string;
  readonly delivery?: DeliveryAccess;
  readonly #name: string;
  readonly #link: NodeLink;
  readonly #reach: Reachability;
  readonly #startListeners = new Set<(name: string) => void>();
  readonly #changeListeners = new Set<() => void>();
  readonly #since = new Date().toISOString();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly record: ConnectTargetRecord,
    node: { record: ConnectNodeRecord; link: NodeLink },
    private readonly deps: RuntimeDeps,
  ) {
    this.#name = record.id;
    this.#link = node.link;
    this.#reach = new Reachability(node.link, record.id, deps.snapshots.last(record.id)?.at ?? null);
    this.portalUrl = record.portalUrl;
    this.target = { id: record.id, label: record.label, kind: 'local' as const, where: this.#where(), source: 'enrolled' as const, role: 'single' as const };
    // FR43: delivery can be switched off per target; pools, secrets and the chat host then read "unsupported" here.
    if (record.settings.delivery !== false) this.delivery = this.#delivery();
    // `watchStarts` fires on every (re)connect while switched on: what was delivered while it was away is checked again.
    this.#unsubscribe = node.link.onChange((up) => {
      if (up && this.#on) this.#startListeners.forEach((fn) => fn(this.#name));
      this.#changeListeners.forEach((fn) => fn());
    });
  }

  /** Stops following the link (the runtime was replaced or removed). */
  dispose() {
    this.#unsubscribe();
  }

  #where() {
    const hello = this.#link.info()?.hello;
    if (!hello) return this.record.kind === 'container' ? 'container' : 'host';
    return this.record.kind === 'container' ? `${hello.hostname} (container)` : `${hello.hostname} (host)`;
  }

  get #on() {
    return this.deps.switch.get(this.record.id);
  }

  #same(name: string) {
    if (name !== this.#name) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
  }

  #guard() {
    if (!this.#on) throw new AppError('CONFLICT', OFF);
  }

  async check() {
    this.#reach.assertUp();
    const host = this.#link.info()?.status?.services.find((s) => s.name === 'host') ?? this.#link.info()?.hello.services?.find((s) => s.name === 'host');
    if (host && !host.ok) throw new Error(host.error ?? 'The host service is not working.');
  }

  #workspace(): Workspace {
    const on = this.#on;
    return {
      id: workspaceId(this.record.id, this.#name),
      name: this.#name,
      target: this.record.id,
      image: this.record.kind === 'container' ? this.deps.image(this.record) : `${this.#link.info()?.hello.hostname ?? this.record.id} (host)`,
      status: on ? 'running' : 'stopped',
      detail: on ? 'Switched on' : 'Switched off',
      createdAt: this.deps.snapshots.last(this.record.id)?.workspaces[0]?.createdAt ?? this.#since,
    };
  }

  async list(): Promise<Workspace[]> {
    this.#reach.assertUp();
    const list = [this.#workspace()];
    this.deps.snapshots.save(this.record.id, list);
    return list;
  }

  reachable(): boolean {
    return this.#link.connected();
  }

  listLastKnown(): Workspace[] {
    const last = this.deps.snapshots.last(this.record.id);
    const seen = this.#reach.downSince ?? last?.at ?? null;
    const base = last?.workspaces[0] ?? this.#workspace();
    return [{ ...base, status: 'unreachable', detail: lastSeenText(seen), ...(seen ? { lastSeenAt: seen } : {}) }];
  }

  async create(_spec: CreateSpec): Promise<void> {
    throw new AppError('VALIDATION_FAILED', `This target is the workspace “${this.#name}”. Start it instead of creating one.`, {
      details: { name: `Only “${this.#name}” exists here.` },
    });
  }

  async start(name: string) {
    this.#same(name);
    if (this.#on) return;
    this.deps.switch.set(this.record.id, true);
    if (this.#link.connected()) this.#startListeners.forEach((fn) => fn(name));
    this.#changeListeners.forEach((fn) => fn());
  }

  async stop(name: string) {
    this.#same(name);
    this.deps.switch.set(this.record.id, false);
    this.#changeListeners.forEach((fn) => fn());
  }

  async remove(): Promise<void> {
    throw new AppError('CONFLICT', 'This workspace is its target: remove the target instead.');
  }

  /** The agent's last status: host-wide figures for a Host, the container's cgroup for a Container. */
  async usage(names: string[]): Promise<Omit<WorkspaceUsage, 'id'>[]> {
    const u = this.#link.connected() ? this.#link.info()?.status?.usage : undefined;
    return names.map(() => (u ? { cpuPercent: u.cpuPercent, memoryBytes: u.memoryBytes, cores: u.cores, memoryTotalBytes: u.memoryTotalBytes } : { cpuPercent: null, memoryBytes: null }));
  }

  watch(onChange: () => void): () => void {
    this.#changeListeners.add(onChange);
    return () => void this.#changeListeners.delete(onChange);
  }

  async shell(name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> {
    this.#same(name);
    this.#guard();
    const call = await this.#reach.call(() => HostCall.open(this.#link, { op: 'exec', argv: command ?? LOGIN, user: 'node', tty: { cols: size.cols, rows: size.rows }, merge: true }));
    return {
      write: (data) => call.send(data),
      resize: (cols, rows) => call.resize(cols, rows),
      close: () => call.kill(),
      onData: (fn) => call.onData((chunk) => fn(chunk)),
      onExit: (fn) => void call.result().then((r) => fn(r.code), () => fn(null)),
    };
  }

  async exec(name: string, command: string[]): Promise<ExecSession> {
    this.#same(name);
    this.#guard();
    if (!command.length) throw new AppError('VALIDATION_FAILED', 'No command.');
    const call = await this.#reach.call(() => HostCall.open(this.#link, { op: 'exec', argv: command, user: 'node', merge: true }));
    return {
      write: (data) => call.send(data),
      // Like a dropped connection elsewhere: stdin ends; the agent ends the process when the stream is reset.
      close: () => call.kill(),
      onData: (fn) => call.onData((chunk) => fn(chunk)),
      onExit: (fn) => void call.result().then((r) => fn(r.code), () => fn(null)),
    };
  }

  #delivery(): DeliveryAccess {
    return {
      state: async (name) => {
        this.#reach.assertUp();
        return name === this.#name ? { exists: true, running: this.#on } : { exists: false, running: false };
      },

      run: async (name, script, opts = {}) => {
        this.#same(name);
        this.#guard();
        const timeoutMs = opts.timeoutMs ?? 30_000;
        return this.#reach.call(async () => {
          const call = await HostCall.open(this.#link, { op: 'exec', argv: ['sh', '-c', script], user: opts.user === 'node' ? 'node' : 'root' });
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          call.onData((chunk, stderr) => (stderr ? err : out).push(chunk));
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              call.kill();
              reject(new Error(`command timed out after ${timeoutMs} ms`));
            }, timeoutMs);
          });
          try {
            if (opts.stdin !== undefined) await call.write(opts.stdin);
            call.eof();
            const result = await Promise.race([call.result(), timedOut]);
            if (result.code === null && result.error) throw new Error(result.error.message);
            return { code: result.code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
          } finally {
            clearTimeout(timer);
          }
        });
      },

      put: async (name, entries) => {
        this.#same(name);
        this.#guard();
        const archive = await tarOf(entries);
        await this.#reach.call(async () => {
          const call = await HostCall.open(this.#link, { op: 'put' });
          await call.write(archive);
          call.eof();
          const result = await call.result();
          if (result.error) throw new Error(result.error.message);
          if (result.skipped?.length) throw new Error(`${result.skipped.length} entr${result.skipped.length === 1 ? 'y was' : 'ies were'} not written (${result.skipped[0]!.reason}).`);
        });
      },

      read: async (name, path) => {
        this.#same(name);
        return this.#reach.call(async () => {
          const call = await HostCall.open(this.#link, { op: 'read', path });
          const chunks: Buffer[] = [];
          call.onData((chunk) => chunks.push(chunk));
          const result = await call.result();
          if (result.error?.code === 'ENOENT') return null;
          if (result.error) throw new Error(result.error.message);
          return Buffer.concat(chunks).toString('utf8');
        });
      },

      watchStarts: (onStart) => {
        this.#startListeners.add(onStart);
        return () => void this.#startListeners.delete(onStart);
      },
    };
  }
}
