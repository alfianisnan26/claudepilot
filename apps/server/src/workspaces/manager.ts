import { AppError, isAppError } from '@isnanme/core';
import {
  workspaceId,
  workspaceNameProblem,
  type CreateWorkspaceRequest,
  type Workspace,
  type WorkspaceTarget,
  type WorkspaceUsage,
} from '@portal/contracts';
import type { JsonFile } from '../jsonFile.js';
import type { Runtime, ShellSession } from './runtime.js';

const CHECK_TTL_MS = 10_000;
const CHECK_TIMEOUT_MS = 4_000;

/** The readable part of a Docker (`json.message`) or Kubernetes (`body.message`) error. */
export function runtimeMessage(e: unknown): string {
  const err = e as { json?: { message?: string }; body?: unknown; message?: string };
  if (err.json?.message) return err.json.message;
  if (typeof err.body === 'string') {
    try {
      return (JSON.parse(err.body) as { message?: string }).message ?? err.body;
    } catch {
      return err.body;
    }
  }
  if (err.body && typeof err.body === 'object' && 'message' in err.body) return String(err.body.message);
  return err.message ?? String(e);
}

const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), ms))]);

/**
 * Every target's workspaces in one place. What exists is read from the runtimes each time; only
 * creates in flight (and creates that failed, until removed) live here. Those are also saved to
 * disk, so a restart picks an interrupted create back up instead of dropping it.
 */
export class Workspaces {
  readonly #runtimes = new Map<string, Runtime>();
  readonly #pending = new Map<string, Workspace>();
  #checked: { at: number; targets: Promise<WorkspaceTarget[]> } | undefined;
  /**
   * `beforeStop`: runs (for at most 5 s) before the portal stops a workspace, such as an outbox pull.
   * `changed`: the list changed through the portal (a create's progress, start, stop, remove).
   */
  hooks: { beforeStop?: (workspaceId: string) => Promise<void>; changed?: () => void } = {};

  constructor(
    runtimes: Runtime[],
    private readonly saved: JsonFile<Workspace[]>,
  ) {
    for (const r of runtimes) this.#runtimes.set(r.target.id, r);
  }

  /** Picks up the creates that were in flight (or had failed) when the portal last stopped. */
  async resume() {
    const saved = this.saved.read();
    if (!saved.length) return;
    for (const w of saved) this.#pending.set(w.id, w.status === 'creating' ? { ...w, detail: 'Resuming after restart' } : w);
    const targets = await this.targets(true);
    await Promise.all(
      saved
        .filter((w) => w.status === 'creating')
        .map(async (w) => {
          const workspace = this.#pending.get(w.id)!;
          const target = targets.find((t) => t.id === w.target);
          if (!target?.available) {
            const why = target ? `${target.label} isn’t reachable: ${target.problem}` : `No target “${w.target}”.`;
            return this.#setPending({ ...workspace, status: 'error', detail: `Could not resume after restart. ${why}` });
          }
          const runtime = this.#runtime(target.id);
          try {
            const found = (await runtime.list()).find((x) => x.name === w.name);
            if (found) {
              // The runtime got far enough to hold it; finish the job if it never started.
              if (found.status === 'stopped') await runtime.start(w.name);
              this.#deletePending(w.id);
              console.log(`[workspaces] ${w.id} was created before the restart`);
              return;
            }
          } catch (e) {
            return this.#setPending({ ...workspace, status: 'error', detail: runtimeMessage(e) });
          }
          console.log(`[workspaces] resuming create of ${w.id}`);
          this.#launch(runtime, workspace);
        }),
    );
  }

  targets(fresh = false): Promise<WorkspaceTarget[]> {
    if (!fresh && this.#checked && Date.now() - this.#checked.at < CHECK_TTL_MS) return this.#checked.targets;
    const targets = Promise.all(
      [...this.#runtimes.values()].map((r) =>
        timeout(r.check(), CHECK_TIMEOUT_MS).then(
          () => ({ ...r.target, available: true }),
          (e: unknown) => ({ ...r.target, available: false, problem: runtimeMessage(e) }),
        ),
      ),
    );
    this.#checked = { at: Date.now(), targets };
    return targets;
  }

  async list(): Promise<Workspace[]> {
    const available = (await this.targets()).filter((t) => t.available);
    const lists = await Promise.all(
      available.map((t) =>
        this.#runtime(t.id)
          .list()
          .catch((e: unknown) => {
            console.error(`[workspaces] listing ${t.id} failed: ${runtimeMessage(e)}`);
            return [];
          }),
      ),
    );
    const found = lists.flat();
    const ids = new Set(found.map((w) => w.id));
    // A create in flight shows as "creating" until the runtime has it (then the runtime's view wins).
    for (const [id, w] of this.#pending) if (w.status === 'creating' && ids.has(id)) this.#deletePending(id);
    const pending = [...this.#pending.values()].filter((w) => !ids.has(w.id));
    return [...pending, ...found].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(req: Partial<CreateWorkspaceRequest>): Promise<Workspace> {
    const name = typeof req.name === 'string' ? req.name.trim() : '';
    const problem = workspaceNameProblem(name);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, { details: { name: problem } });
    const cpus = req.cpus === undefined || req.cpus === null ? undefined : Number(req.cpus);
    if (cpus !== undefined && !(cpus > 0 && cpus <= 64))
      throw new AppError('VALIDATION_FAILED', 'CPUs must be between 0 and 64.', { details: { cpus: 'Between 0 and 64.' } });
    const memoryMb = req.memoryMb === undefined || req.memoryMb === null ? undefined : Number(req.memoryMb);
    if (memoryMb !== undefined && !(Number.isInteger(memoryMb) && memoryMb >= 256))
      throw new AppError('VALIDATION_FAILED', 'Memory must be at least 256 MB.', { details: { memoryMb: 'At least 256 MB.' } });

    const target = (await this.targets()).find((t) => t.id === req.target);
    if (!target) throw new AppError('VALIDATION_FAILED', 'Pick where it runs.', { details: { target: 'Pick a target.' } });
    if (!target.available) throw new AppError('SERVICE_UNAVAILABLE', `${target.label} isn’t reachable: ${target.problem}`);

    const id = workspaceId(target.id, name);
    if (this.#pending.get(id)?.status === 'creating')
      throw new AppError('CONFLICT', `“${name}” is already being created.`);

    const runtime = this.#runtime(target.id);
    // Refuse a taken name now, not in the background: a failed create kept under the same id
    // would stand in for the real workspace (and "remove" on it would delete the real one).
    if ((await runtime.list()).some((w) => w.name === name))
      throw new AppError('CONFLICT', `A workspace named “${name}” already exists on ${target.label}.`);
    const workspace: Workspace = {
      id,
      name,
      target: target.id,
      image: '',
      status: 'creating',
      detail: 'Queued',
      createdAt: new Date().toISOString(),
      cpus,
      memoryMb,
    };
    this.#setPending(workspace);
    this.#launch(runtime, workspace);
    return workspace;
  }

  /** Runs a create in the background; `workspace` (the pending entry) tracks its progress. */
  #launch(runtime: Runtime, workspace: Workspace) {
    const { id, name, cpus, memoryMb } = workspace;
    void runtime
      .create({ name, cpus, memoryMb }, (detail) => {
        workspace.detail = detail;
        this.hooks.changed?.();
      })
      .then(
        () => {
          console.log(`[workspaces] created ${id}`);
          this.#deletePending(id);
        },
        (e: unknown) => {
          const message = isAppError(e) ? e.message : runtimeMessage(e);
          console.error(`[workspaces] creating ${id} failed: ${message}`);
          // Keep a failed create visible (as an error) until someone removes it.
          this.#setPending({ ...workspace, status: 'error', detail: message });
        },
      );
  }

  // Progress text changes too often to save; status changes (added, failed, done) are saved.
  #setPending(w: Workspace) {
    this.#pending.set(w.id, w);
    this.#save();
    this.hooks.changed?.();
  }

  #deletePending(id: string) {
    if (this.#pending.delete(id)) this.#save();
    this.hooks.changed?.();
  }

  #save() {
    try {
      this.saved.write([...this.#pending.values()]);
    } catch (e) {
      console.error(`[workspaces] could not save pending creates: ${(e as Error).message}`);
    }
  }

  async start(target: string, name: string) {
    try {
      return await this.#run(target, (r) => r.start(name));
    } finally {
      this.hooks.changed?.();
    }
  }

  async stop(target: string, name: string) {
    // Events written just before a stop are pulled first (foundation PRD §8); never blocks a stop long.
    const pull = this.hooks.beforeStop?.(workspaceId(target, name)).catch(() => undefined);
    if (pull) await Promise.race([pull, new Promise((r) => setTimeout(r, 5_000).unref())]);
    try {
      return await this.#run(target, (r) => r.stop(name));
    } finally {
      this.hooks.changed?.();
    }
  }

  async remove(target: string, name: string) {
    const id = workspaceId(target, name);
    if (this.#pending.get(id)?.status === 'creating')
      throw new AppError('CONFLICT', 'Wait for it to finish creating, then remove it.');
    this.#deletePending(id);
    try {
      await this.#run(target, (r) => r.remove(name));
    } finally {
      this.hooks.changed?.();
    }
    console.log(`[workspaces] removed ${id}`);
  }

  /** A command in a running workspace, as its user, with stdin open and no terminal. */
  exec(target: string, name: string, command: string[]) {
    return this.#run(target, (r) => r.exec(name, command));
  }

  async usage(): Promise<WorkspaceUsage[]> {
    const running = (await this.list()).filter((w) => w.status === 'running');
    const byTarget = new Map<string, Workspace[]>();
    for (const w of running) byTarget.set(w.target, [...(byTarget.get(w.target) ?? []), w]);
    const results = await Promise.all(
      [...byTarget].map(async ([target, list]) => {
        const usage = await this.#runtime(target)
          .usage(list.map((w) => w.name))
          .catch(() => list.map(() => ({ cpuPercent: null, memoryBytes: null })));
        return list.map((w, i) => ({ id: w.id, ...usage[i]! }));
      }),
    );
    return results.flat();
  }

  shell(target: string, name: string, size: { cols: number; rows: number }): Promise<ShellSession> {
    return this.#run(target, (r) => r.shell(name, size));
  }

  /** The runtime for a target, if configured (for the delivery engine). */
  runtimeFor(target: string): Runtime | undefined {
    return this.#runtimes.get(target);
  }

  runtimeList(): Runtime[] {
    return [...this.#runtimes.values()];
  }

  #runtime(target: string): Runtime {
    const runtime = this.#runtimes.get(target);
    if (!runtime) throw new AppError('NOT_FOUND', `No target “${target}”.`);
    return runtime;
  }

  /** Runs a runtime call; Docker/Kubernetes failures come back as a readable 503. */
  async #run<T>(target: string, fn: (r: Runtime) => Promise<T>): Promise<T> {
    const runtime = this.#runtime(target);
    try {
      return await fn(runtime);
    } catch (e) {
      if (isAppError(e)) throw e;
      const status = (e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: unknown }).code;
      if (status === 404) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
      throw new AppError('SERVICE_UNAVAILABLE', runtimeMessage(e), { cause: e });
    }
  }
}
