import { AppError, isAppError } from '@isnanme/core';
import {
  isExactClaudeVersion,
  workspaceId,
  workspaceNameProblem,
  type CreateWorkspaceRequest,
  type Workspace,
  type WorkspaceTarget,
  type WorkspaceUsage,
} from '@portal/contracts';
import type { Actor } from '@portal/contracts';
import { ownerActor, requireCan } from '../authz/seam.js';
import type { JsonFile } from '../jsonFile.js';
import { PLAIN_NAME } from '../names.js';
import { isTargetUnreachable, type Runtime, type ShellSession } from './runtime.js';

/** A tunnelled runtime follows its links (and may hold a loopback listener): it lets go when it is replaced or removed. */
const dispose = (r: Runtime) => (r as { dispose?: () => void }).dispose?.();

/** How long a portal that just started waits for its enrolled targets' first connection before judging a pending create (FR38). */
const SETTLE_MS = 20_000;

const CHECK_TTL_MS = 10_000;
const CHECK_TIMEOUT_MS = 4_000;

/** How long a target's check counts, and how long one may take (tests shorten both). */
export interface CheckTiming {
  ttlMs?: number;
  timeoutMs?: number;
}

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
  /** Creates in flight at the restart whose enrolled target had not come back yet: resumed by `recheck` when it does. */
  readonly #awaitingTarget = new Set<string>();
  /** Per target: the last check's result and when it finished, and the check in flight (one at a time). */
  readonly #known = new Map<string, { at: number; target: WorkspaceTarget }>();
  readonly #checking = new Map<string, Promise<WorkspaceTarget>>();
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  /**
   * `beforeStop`: runs (for at most 5 s) before the portal stops a workspace, such as an outbox pull.
   * `changed`: the list changed through the portal (a create's progress, start, stop, remove).
   */
  hooks: {
    beforeStop?: (workspaceId: string) => Promise<void>;
    changed?: () => void;
    /** The Claude Code version a new workspace on `target` is pinned to when the request names none (the portal's default pin); undefined: the target's own image. */
    defaultClaudeVersion?: (target: string) => string | undefined;
    /** Connect's quota and drain check for an enrolled target (targets-connect PRD §12.8): throws LIMIT_REACHED / CONFLICT. */
    beforeCreate?: (target: string, node?: string) => void;
    /** Resolves once the enrolled targets have had their first connection, or after `ms` (`connect.settled`); read by `resume()`. */
    settled?: (ms: number) => Promise<void>;
  } = {};
  /** Watchers of the runtimes added while running (static ones are wired by index.ts), by target id. */
  readonly #watching = new Map<string, () => void>();
  readonly #runtimeListeners = new Set<(targetId: string, runtime: Runtime | null) => void>();

  constructor(
    runtimes: Runtime[],
    private readonly saved: JsonFile<Workspace[]>,
    timing: CheckTiming = {},
  ) {
    for (const r of runtimes) this.#runtimes.set(r.target.id, r);
    this.#ttlMs = timing.ttlMs ?? CHECK_TTL_MS;
    this.#timeoutMs = timing.timeoutMs ?? CHECK_TIMEOUT_MS;
  }

  /* ---------- Runtimes that come and go (enrolled targets, targets-connect PRD §12.5, FR36) ---------- */

  /** Adds a runtime while running (an enrolled target became usable); one already there under the same id is replaced. */
  addRuntime(runtime: Runtime) {
    this.#install(runtime);
  }

  /** Replaces a target's runtime (its nodes or settings changed); every cache of the old one is dropped. */
  replaceRuntime(runtime: Runtime) {
    this.#install(runtime);
  }

  /** Removes a target's runtime (the target was removed). Its pending creates stay until removed, as on any target. */
  removeRuntime(targetId: string) {
    const old = this.#runtimes.get(targetId);
    if (!old || !this.#runtimes.delete(targetId)) return;
    dispose(old);
    this.#unwatch(targetId);
    this.#known.delete(targetId);
    this.#checking.delete(targetId);
    this.#runtimeListeners.forEach((fn) => fn(targetId, null));
    this.hooks.changed?.();
  }

  /** Called when a runtime is added or replaced (with it) or removed (null): delivery follows its start events. */
  onRuntimeChange(fn: (targetId: string, runtime: Runtime | null) => void): () => void {
    this.#runtimeListeners.add(fn);
    return () => void this.#runtimeListeners.delete(fn);
  }

  #install(runtime: Runtime) {
    const id = runtime.target.id;
    this.#unwatch(id);
    const old = this.#runtimes.get(id);
    if (old && old !== runtime) dispose(old);
    this.#runtimes.set(id, runtime);
    // A check of the old runtime may still be running: its answer is dropped when it lands (#check compares the runtime).
    this.#known.delete(id);
    this.#checking.delete(id);
    if (runtime.watch) this.#watching.set(id, runtime.watch(() => this.hooks.changed?.()));
    this.#runtimeListeners.forEach((fn) => fn(id, runtime));
    this.hooks.changed?.();
  }

  #unwatch(id: string) {
    this.#watching.get(id)?.();
    this.#watching.delete(id);
  }

  /** Picks up the creates that were in flight (or had failed) when the portal last stopped. */
  async resume() {
    const saved = this.saved.read();
    if (!saved.length) return;
    for (const w of saved) this.#pending.set(w.id, w.status === 'creating' ? { ...w, detail: 'Resuming after restart' } : w);
    // Enrolled targets come back over their tunnels a few seconds after a restart: judge a pending create on one only after that (FR38).
    if (saved.some((w) => w.status === 'creating')) await this.hooks.settled?.(SETTLE_MS).catch(() => undefined);
    const targets = await this.targets(true);
    await Promise.all(saved.filter((w) => w.status === 'creating').map((w) => this.#resumeOne(this.#pending.get(w.id)!, targets.find((t) => t.id === w.target))));
  }

  /**
   * One create that was in flight at the restart. An enrolled target that has not come back yet keeps it waiting (its agent may still be in
   * its reconnect backoff, up to a minute after a crash: T6 saw one fail here 20 s after the restart); it resumes when the target returns
   * (`recheck`), and can be removed meanwhile like any pending one. A scanned target, or one that is gone, fails it as before.
   */
  async #resumeOne(workspace: Workspace, target: WorkspaceTarget | undefined): Promise<void> {
    if (!target?.available) {
      if (target?.source === 'enrolled') {
        this.#awaitingTarget.add(workspace.id);
        return this.#setPending({ ...workspace, status: 'creating', detail: `Waiting for ${target.label} to reconnect` });
      }
      const why = target ? `${target.label} isn’t reachable: ${target.problem}` : `No target “${workspace.target}”.`;
      return this.#setPending({ ...workspace, status: 'error', detail: `Could not resume after restart. ${why}` });
    }
    const runtime = this.#runtime(target.id);
    try {
      const found = (await runtime.list()).find((x) => x.name === workspace.name);
      if (found) {
        // The runtime got far enough to hold it; finish the job if it never started.
        if (found.status === 'stopped') await runtime.start(workspace.name);
        this.#deletePending(workspace.id);
        console.log(`[workspaces] ${workspace.id} was created before the restart`);
        return;
      }
    } catch (e) {
      return this.#setPending({ ...workspace, status: 'error', detail: runtimeMessage(e) });
    }
    console.log(`[workspaces] resuming create of ${workspace.id}`);
    this.#setPending({ ...workspace, detail: 'Resuming after restart' });
    this.#launch(runtime, this.#pending.get(workspace.id)!);
  }

  /**
   * Every target and whether it can be reached. A target's check is kept for a few seconds; after that it answers from what was
   * last known while it is checked again in the background (stale-while-revalidate), so one that is down, whose check only ends
   * by timing out, never holds up the list of the others. Only a target never checked yet, or a `fresh` ask, waits for the check.
   */
  targets(fresh = false): Promise<WorkspaceTarget[]> {
    return Promise.all([...this.#runtimes.values()].map((r) => this.#target(r, fresh)));
  }

  #target(runtime: Runtime, fresh: boolean): Promise<WorkspaceTarget> {
    const id = runtime.target.id;
    const known = this.#known.get(id);
    if (!fresh && known && Date.now() - known.at < this.#ttlMs) return Promise.resolve(known.target);
    const check = this.#check(runtime);
    return !fresh && known ? Promise.resolve(known.target) : check;
  }

  /** One check of a target at a time; its result is what the next asks see. */
  #check(runtime: Runtime): Promise<WorkspaceTarget> {
    const id = runtime.target.id;
    let running = this.#checking.get(id);
    if (!running) {
      running = timeout(runtime.check(), this.#timeoutMs)
        .then(
          (): WorkspaceTarget => ({ ...runtime.target, available: true }),
          (e: unknown): WorkspaceTarget => ({ ...runtime.target, available: false, problem: runtimeMessage(e) }),
        )
        .then((target) => {
          // A runtime replaced or removed while it was checked, or a check that `recheck` began after this one: its answer is not the target's any more.
          if (this.#runtimes.get(id) === runtime && this.#checking.get(id) === running) this.#known.set(id, { at: Date.now(), target });
          return target;
        })
        .finally(() => {
          if (this.#checking.get(id) === running) this.#checking.delete(id);
        });
      this.#checking.set(id, running);
    }
    return running;
  }

  /**
   * One target's reachability just changed (an enrolled target's tunnel dropped or came back; `wireConnect` calls this): checks it again now
   * instead of at the end of the cache's lifetime, and tells the pages when the answer differs. A check that was already running began before
   * the change, so its answer is dropped. The other targets' caches stay. Never rejects.
   */
  async recheck(targetId: string): Promise<void> {
    const runtime = this.#runtimes.get(targetId);
    if (!runtime) return;
    const was = this.#known.get(targetId)?.target.available;
    this.#checking.delete(targetId);
    const now = await this.#check(runtime);
    if (this.#runtimes.get(targetId) !== runtime) return;
    if (now.available !== was) this.hooks.changed?.();
    // Creates that waited for this target since the restart go on now.
    if (now.available) {
      const waiting = [...this.#pending.values()].filter((w) => w.target === targetId && this.#awaitingTarget.has(w.id));
      for (const w of waiting) this.#awaitingTarget.delete(w.id); // once: two nodes returning at once must not launch it twice
      await Promise.all(waiting.map((w) => this.#resumeOne(w, now)));
    }
  }

  async list(): Promise<Workspace[]> {
    const targets = (await this.targets()).filter((t) => this.#runtimes.has(t.id));
    // An enrolled target that can't be reached shows its last known list, each workspace `unreachable` (FR37); a scanned one is skipped.
    const lastKnown = (t: WorkspaceTarget) => this.#runtimes.get(t.id)?.listLastKnown?.() ?? [];
    const lists = await Promise.all(
      targets.map((t) =>
        !t.available
          ? lastKnown(t)
          : this.#runtime(t.id)
              .list()
              .catch((e: unknown) => {
                if (isTargetUnreachable(e)) return lastKnown(t);
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

  /** `actor`: who asks (the route's `actorOf(c)`); creating on a target needs `operate` on it (multi-user PRD; the single-owner seam allows the owner). */
  async create(req: Partial<CreateWorkspaceRequest>, actor: Actor = ownerActor()): Promise<Workspace> {
    const name = typeof req.name === 'string' ? req.name.trim() : '';
    const problem = workspaceNameProblem(name);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, { details: { name: problem } });
    const cpus = req.cpus === undefined || req.cpus === null ? undefined : Number(req.cpus);
    if (cpus !== undefined && !(cpus > 0 && cpus <= 64))
      throw new AppError('VALIDATION_FAILED', 'CPUs must be between 0 and 64.', { details: { cpus: 'Between 0 and 64.' } });
    const memoryMb = req.memoryMb === undefined || req.memoryMb === null ? undefined : Number(req.memoryMb);
    if (memoryMb !== undefined && !(Number.isInteger(memoryMb) && memoryMb >= 256))
      throw new AppError('VALIDATION_FAILED', 'Memory must be at least 256 MB.', { details: { memoryMb: 'At least 256 MB.' } });

    let target = (await this.targets()).find((t) => t.id === req.target);
    // A target last seen down may be back: someone creating on it checks again rather than trusting a stale "no".
    if (target && !target.available) target = (await this.targets(true)).find((t) => t.id === req.target);
    if (!target) throw new AppError('VALIDATION_FAILED', 'Pick where it runs.', { details: { target: 'Pick a target.' } });
    if (!target.available) throw new AppError('SERVICE_UNAVAILABLE', `${target.label} isn’t reachable: ${target.problem}`);
    requireCan(actor, 'operate', { type: 'target', id: target.id });
    const node = req.node === undefined || req.node === null || req.node === '' ? undefined : req.node;
    if (node !== undefined && (typeof node !== 'string' || !PLAIN_NAME.test(node)))
      throw new AppError('VALIDATION_FAILED', 'Pick a node of this target.', { details: { node: 'Not a node of this target.' } });
    // An enrolled target's quota and drained nodes (Connect); a node on a target without nodes is refused by its runtime.
    this.hooks.beforeCreate?.(target.id, node);

    const id = workspaceId(target.id, name);
    if (this.#pending.get(id)?.status === 'creating')
      throw new AppError('CONFLICT', `“${name}” is already being created.`);

    const runtime = this.#runtime(target.id);
    // The Claude Code version to pin (claude-version-pinning PRD): an exact x.y.z, only where the target holds an image per version.
    if (req.claudeVersion !== undefined && req.claudeVersion !== null && !isExactClaudeVersion(req.claudeVersion))
      throw new AppError('VALIDATION_FAILED', 'Use an exact version such as 2.1.296.', { details: { claudeVersion: 'An exact x.y.z.' } });
    if (req.claudeVersion && !runtime.images) throw new AppError('VALIDATION_FAILED', `${target.label} can’t pin a Claude Code version.`, { details: { claudeVersion: 'Not on this target.' } });
    const claudeVersion = req.claudeVersion || (runtime.images ? this.hooks.defaultClaudeVersion?.(target.id) : undefined);
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
      // Saved with the pending create, so a create resumed after a restart goes to the same node.
      ...(node ? { node } : {}),
      // Saved with the pending create, so one that resumes after a restart is pinned to the same version.
      ...(claudeVersion ? { claude: { pinned: claudeVersion, running: null, flags: [] } } : {}),
    };
    this.#setPending(workspace);
    this.#launch(runtime, workspace);
    return workspace;
  }

  /** Runs a create in the background; `workspace` (the pending entry) tracks its progress. */
  #launch(runtime: Runtime, workspace: Workspace) {
    const { id, name, cpus, memoryMb, node } = workspace;
    void runtime
      .create({ name, cpus, memoryMb, claudeVersion: workspace.claude?.pinned ?? undefined, ...(node ? { node } : {}) }, (detail) => {
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
    this.#awaitingTarget.delete(id);
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

  /**
   * Replaces a workspace's container with one made from `image`, keeping its home volume (claude-version-pinning PRD §7). The events
   * written just before are pulled first, like a stop. Only the Runtime knows how; a target without it says so.
   */
  async recreate(target: string, name: string, image: string, progress: (detail: string) => void, opts?: { label?: string }) {
    const runtime = this.#runtime(target);
    if (!runtime.recreate) throw new AppError('CONFLICT', 'This target can’t recreate a workspace from another image.');
    const pull = this.hooks.beforeStop?.(workspaceId(target, name)).catch(() => undefined);
    if (pull) await Promise.race([pull, new Promise((r) => setTimeout(r, 5_000).unref())]);
    try {
      return await this.#run(target, (r) => r.recreate!(name, image, progress, opts));
    } finally {
      this.hooks.changed?.();
    }
  }

  async remove(target: string, name: string) {
    const id = workspaceId(target, name);
    // A create that waits for its target to come back has not started here: removing it forgets it (whatever the target already made shows up in its list when it returns).
    if (this.#awaitingTarget.has(id)) {
      this.#deletePending(id);
      console.log(`[workspaces] dropped the waiting create of ${id}`);
      return;
    }
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

  /**
   * Whether a workspace of that name is on that target now: only that target's runtime is asked, not all of them. A target that cannot
   * answer says yes, so the call that follows fails with its own reason (a stopped Docker daemon) instead of "no such workspace".
   */
  async exists(target: string, name: string): Promise<boolean> {
    const runtime = this.#runtimes.get(target);
    if (!runtime || !PLAIN_NAME.test(name)) return false;
    const id = workspaceId(target, name);
    if (this.#pending.has(id)) return true;
    try {
      return (await runtime.list()).some((w) => w.id === id);
    } catch {
      return true;
    }
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

  shell(target: string, name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> {
    return this.#run(target, (r) => r.shell(name, size, command));
  }

  /** Whether a workspace's target can be reached now (an enrolled target's tunnel); for the chat readers' outage rule (§12.5). */
  targetState(workspaceId: string): 'up' | 'down' {
    const i = workspaceId.indexOf('/');
    const runtime = this.#runtimes.get(workspaceId.slice(0, i));
    return runtime?.reachable && !runtime.reachable(workspaceId.slice(i + 1)) ? 'down' : 'up';
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
      // An enrolled target's tunnel is down: "Target unreachable (since 14:02)" (targets-connect PRD §12.5).
      if (isTargetUnreachable(e)) throw new AppError('SERVICE_UNAVAILABLE', e.message, { cause: e });
      const status = (e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: unknown }).code;
      if (status === 404) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
      throw new AppError('SERVICE_UNAVAILABLE', runtimeMessage(e), { cause: e });
    }
  }
}
