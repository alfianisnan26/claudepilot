import { AppError, isAppError } from '@isnanme/core';
import {
  isExactClaudeVersion,
  normalizeWorkspaceLabel,
  workspaceDisplayName,
  workspaceId,
  workspaceLabelProblem,
  workspaceNameProblem,
  workspaceResourcesProblem,
  type RenameWorkspaceResult,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceResourcesRequest,
  type WorkspaceResources,
  type WorkspaceResourcesFit,
  type WorkspaceResourceValues,
  type Workspace,
  type WorkspaceTarget,
  type WorkspaceUsage,
} from '@portal/contracts';
import { workspaceRef, type Actor } from '@portal/contracts';
import { actorString, actorUserId, ownerActor, requireCan } from '../authz/seam.js';
import { redact } from '../chat/redact.js';
import type { JsonFile } from '../jsonFile.js';
import { PLAIN_NAME } from '../names.js';
import { findWorkspace, WorkspaceIdentities, type WorkspaceIdentity } from './identity.js';
import { describeValues } from './resources.js';
import { isTargetUnreachable, type ResourceAccess, type ResourceApplied, type Runtime, type ShellSession } from './runtime.js';

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

/** A tunnelled runtime follows its links (and may hold a loopback listener): it lets go when it is replaced or removed. */
const dispose = (r: Runtime) => (r as { dispose?: () => void }).dispose?.();

/** How long a portal that just started waits for its enrolled targets' first connection before judging a pending create (FR38). */
const SETTLE_MS = 20_000;

const CHECK_TTL_MS = 10_000;
const CHECK_TIMEOUT_MS = 4_000;
/** How long one target's list may take before the manager answers from its last good list (T-515): a slow API never holds up the page. */
const LIST_TIMEOUT_MS = 8_000;
/** One element of a stored last good list that can be shown: an object with its id, name and target as text. */
const isStoredWorkspace = (w: unknown): w is Workspace => {
  const x = w as Partial<Record<'id' | 'name' | 'target' | 'createdAt', unknown>> | null;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.target === 'string' && typeof x.createdAt === 'string';
};
/** How often an unchanged last good list is written again (only its time moved): the file stays quiet while the lists do. */
const LAST_KNOWN_REWRITE_MS = 60_000;

/** How long a target's check counts, and how long one may take, and how long a list may take (tests shorten them). */
export interface CheckTiming {
  ttlMs?: number;
  timeoutMs?: number;
  listTimeoutMs?: number;
}

/** A target's last good list (T-515): what its runtime last answered, and when. Kept in memory and on disk, per target id. */
export interface LastKnownList {
  at: string;
  workspaces: Workspace[];
}
export type LastKnownLists = Record<string, LastKnownList>;

const REASON_MAX = 160;

/**
 * Why a target's list could not be had, as the UI may show it: one line, credential shapes redacted, no URL (a kube URL may carry a
 * token or an internal address), at most 160 characters.
 */
export function unavailableReason(e: unknown): string {
  const text = redact(runtimeMessage(e))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim();
  const short = text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
  return short || 'No answer';
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

/** `p`, or "Timed out" after `ms`; the timer goes when `p` settles first (a list answers on every page load). */
const timeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Timed out')), ms)))]).finally(() => clearTimeout(timer));
};

/**
 * Every target's workspaces in one place. What exists is read from the runtimes each time; only
 * creates in flight (and creates that failed, until removed) live here. Those are also saved to
 * disk, so a restart picks an interrupted create back up instead of dropping it. Each target's last
 * good list is kept too (memory and disk), shown `unavailable` while its runtime does not answer (T-515).
 */
export class Workspaces {
  readonly #runtimes = new Map<string, Runtime>();
  /** The targets the portal was started with (its environment and settings, PORTAL_K8S_TARGETS too): a runtime added later never takes one's id. */
  readonly #static = new Set<string>();
  readonly #pending = new Map<string, Workspace>();
  /** Creates in flight at the restart whose enrolled target had not come back yet: resumed by `recheck` when it does. */
  readonly #awaitingTarget = new Set<string>();
  /** Per target: the last check's result and when it finished, and the check in flight (one at a time). */
  readonly #known = new Map<string, { at: number; target: WorkspaceTarget }>();
  readonly #checking = new Map<string, Promise<WorkspaceTarget>>();
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #listTimeoutMs: number;
  /** Per target: its last good list (T-515), read from disk at the start so a restart during an outage keeps it too. */
  readonly #lastGood = new Map<string, LastKnownList>();
  /** When each target's last good list was last written, and the list then (to write only when it changed, or a minute on). */
  readonly #lastWritten = new Map<string, { at: number; json: string }>();
  /** Targets whose last list came from `#lastGood` (their API did not answer), with the reason shown. */
  readonly #unavailable = new Map<string, string>();
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
    /** Writes an audit row (the platform audit): a rename (T-42 slice 2). Never throws. */
    audit?: (e: { kind: string; actor: string; userId: string | null; actorLabel?: string | null; subject?: string | null; detail?: Record<string, unknown> }) => void;
    /** How many CI runs are running in a workspace (`<target>/<name>`): a resources change that restarts its pod waits for them (T-98). */
    runningCi?: (workspaceId: string) => number;
  } = {};
  /** Why pending resources were not applied at a workspace's last start (T-98), by stable id; in memory only. */
  readonly #resourceProblems = new Map<string, string>();
  /** Watchers of the runtimes added while running (static ones are wired by index.ts), by target id. */
  readonly #watching = new Map<string, () => void>();
  readonly #runtimeListeners = new Set<(targetId: string, runtime: Runtime | null) => void>();

  /** Every workspace's stable id, its alias and its stored runtime name (T-42); the runtimes read their object names from it. */
  readonly identities: WorkspaceIdentities;

  constructor(
    runtimes: Runtime[],
    private readonly saved: JsonFile<Workspace[]>,
    timing: CheckTiming = {},
    identities: WorkspaceIdentities = WorkspaceIdentities.memory(),
    /** Where the last good lists live between restarts (T-515); none: memory only. */
    private readonly lastKnown: JsonFile<LastKnownLists> | null = null,
  ) {
    this.identities = identities;
    for (const r of runtimes) {
      r.useNames?.(identities);
      this.#runtimes.set(r.target.id, r);
      this.#static.add(r.target.id);
    }
    this.#ttlMs = timing.ttlMs ?? CHECK_TTL_MS;
    this.#timeoutMs = timing.timeoutMs ?? CHECK_TIMEOUT_MS;
    this.#listTimeoutMs = timing.listTimeoutMs ?? LIST_TIMEOUT_MS;
    const stored = lastKnown?.read() ?? {};
    for (const [id, entry] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
      if (entry && typeof entry.at === 'string' && Array.isArray(entry.workspaces)) {
        // A bad element (null, a string, a record without its names) is skipped, never the whole list (T-515).
        const workspaces = entry.workspaces.filter(isStoredWorkspace);
        if (workspaces.length !== entry.workspaces.length) console.error(`[workspaces] last known list of ${id}: skipped ${entry.workspaces.length - workspaces.length} bad element(s)`);
        this.#lastGood.set(id, { at: entry.at, workspaces });
        this.#lastWritten.set(id, { at: Date.parse(entry.at) || 0, json: JSON.stringify(workspaces) });
      }
    }
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
    this.#unavailable.delete(targetId);
    this.#lastWritten.delete(targetId);
    if (this.#lastGood.delete(targetId)) this.#saveLastKnown();
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
    // An enrolled target with the id of a configured one (made before PORTAL_K8S_TARGETS named it) would hide that target's workspaces: refused.
    if (this.#static.has(id)) throw new AppError('CONFLICT', `Target “${id}” is configured on the portal; an enrolled target can’t take its id.`);
    this.#unwatch(id);
    const old = this.#runtimes.get(id);
    if (old && old !== runtime) dispose(old);
    runtime.useNames?.(this.identities);
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
    // One deadline per target for the check AND the list together (T-515): a first check that takes 4 s must not leave 8 s more for the list.
    const deadline = Date.now() + this.#listTimeoutMs;
    const lists = await Promise.all([...this.#runtimes.values()].map((r) => this.#listTarget(r, deadline)));
    // Every workspace a runtime reports has an identity: one it has no record of yet gets its id now, with the runtime name the runtime
    // says it has (T-42); the response carries both the id and the alias.
    const found = lists.flat().map((w) => this.#identified(w));
    const ids = new Set(found.map((w) => w.id));
    // A create in flight shows as "creating" until the runtime has it (then the runtime's view wins).
    for (const [id, w] of this.#pending) if (w.status === 'creating' && ids.has(id)) this.#deletePending(id);
    const pending = [...this.#pending.values()].filter((w) => !ids.has(w.id));
    return [...pending, ...found].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One target's workspaces for the list. An enrolled target whose tunnel is down shows its own last known list, each `unreachable` (FR37).
   * Any other target whose check or list fails or takes longer than the list timeout shows its last good list, each `unavailable` with the
   * reason and the time of that answer (T-515), instead of vanishing; its next good answer replaces it.
   */
  async #listTarget(runtime: Runtime, deadline: number): Promise<Workspace[]> {
    const left = () => Math.max(1, deadline - Date.now());
    try {
      const t = await timeout(this.#target(runtime, false), left());
      return await this.#listOf(runtime, t, left);
    } catch (e) {
      // The check did not finish within the deadline.
      if (runtime.listLastKnown) return runtime.listLastKnown();
      console.error(`[workspaces] listing ${runtime.target.id} failed: ${unavailableReason(e)}`);
      return this.#fromLastGood(runtime.target.id, e);
    }
  }

  async #listOf(runtime: Runtime, t: WorkspaceTarget, left: () => number): Promise<Workspace[]> {
    const id = t.id;
    if (!t.available) {
      if (runtime.listLastKnown) return runtime.listLastKnown();
      return this.#fromLastGood(id, t.problem ?? 'No answer');
    }
    try {
      const list = await timeout(runtime.list(), left());
      if (this.#runtimes.get(id) === runtime) this.#remember(id, list);
      return list;
    } catch (e) {
      if (isTargetUnreachable(e) && runtime.listLastKnown) return runtime.listLastKnown();
      console.error(`[workspaces] listing ${id} failed: ${unavailableReason(e)}`);
      return this.#fromLastGood(id, e);
    }
  }

  /** The target's last good list, each workspace `unavailable` (T-515); empty when it never answered. */
  #fromLastGood(id: string, why: unknown): Workspace[] {
    const reason = unavailableReason(typeof why === 'string' ? new Error(why) : why);
    const last = this.#lastGood.get(id);
    if (!last) return [];
    if (this.#unavailable.get(id) !== reason) console.log(`[workspaces] ${id} unavailable, showing its list of ${last.at}: ${reason}`);
    this.#unavailable.set(id, reason);
    return last.workspaces.map((w) => ({ ...w, status: 'unavailable' as const, detail: reason, lastSeenAt: last.at }));
  }

  /** A good answer: kept as the target's last good list, written to disk when it changed (or a minute on, for its time). */
  #remember(id: string, list: Workspace[]) {
    const now = Date.now();
    if (this.#unavailable.delete(id)) console.log(`[workspaces] ${id} answers again`);
    this.#lastGood.set(id, { at: new Date(now).toISOString(), workspaces: list });
    if (!this.lastKnown) return;
    const json = JSON.stringify(list);
    const written = this.#lastWritten.get(id);
    if (written && written.json === json && now - written.at < LAST_KNOWN_REWRITE_MS) return;
    this.#lastWritten.set(id, { at: now, json });
    this.#saveLastKnown();
  }

  #saveLastKnown() {
    try {
      this.lastKnown?.write(Object.fromEntries(this.#lastGood));
    } catch (e) {
      console.error(`[workspaces] could not save the last known lists: ${(e as Error).message}`);
    }
  }

  /** Whether a target's last list came from its last good answer (its API did not answer): calls that need the target skip it (T-515). */
  isUnavailable(targetId: string): boolean {
    return this.#unavailable.has(targetId);
  }

  /** A listed workspace with its identity: adopted when the portal has no record of it, the stored runtime name over the reported one. */
  #identified(w: Workspace): Workspace {
    const known = this.identities.adopt(w.target, w.name, w.runtimeName);
    return { ...w, stableId: known.id, label: known.label ?? w.name, ...(known.runtimeName ? { runtimeName: known.runtimeName } : {}) };
  }

  /**
   * THE resolver of a workspace reference (T-42): its stable id (`ws_…`) or its alias (`<target>/<name>`), to the identity the portal
   * keeps. Null for anything else, an unknown one, or a removed one. Synchronous: it answers from the registry, so a workspace the portal
   * has never listed resolves by its alias only after the first list (which `get` does).
   */
  resolve(ref: string): WorkspaceIdentity | null {
    return this.identities.resolve(ref);
  }

  /**
   * One workspace by either form of its id, as the list shows it. The alias is followed BEFORE anything is decided: authorization is asked
   * about the workspace (its `<target>/<name>`, which the seam knows), never about the string given. What does not exist and what the actor
   * may not view are the same 404.
   */
  async get(ref: string, actor: Actor = ownerActor()): Promise<Workspace> {
    const { known, all } = await this.#authorized(ref, actor, 'view');
    const found = findWorkspace(all ?? (await this.list()), known.legacyId);
    if (!found) throw notFound();
    return found;
  }

  /** The identity behind `ref` (any form), after the seam allowed `verb` on the workspace; unknown and not allowed-to-see are the same 404. */
  async #authorized(ref: string, actor: Actor, verb: 'view' | 'operate'): Promise<{ known: WorkspaceIdentity; all: Workspace[] | null }> {
    if (typeof ref !== 'string') throw notFound();
    let known = this.resolve(ref);
    let all: Workspace[] | null = null;
    if (!known) {
      // A workspace the portal has not listed yet has no record: list once (which adopts it), then ask again.
      all = await this.list();
      known = this.resolve(ref);
    }
    if (!known) throw notFound();
    try {
      requireCan(actor, verb, workspaceRef(known.legacyId));
    } catch (e) {
      if (isAppError(e) && e.code === 'NOT_FOUND') throw notFound();
      throw e;
    }
    return { known, all };
  }

  /**
   * Checks a rename without making it (T-42 slice 2): who may (`operate` on the workspace, through the seam), the label's rules, and that no
   * other workspace on the target answers to it (its name, label, or a label it had). Throws the refusal; answers the label before and after.
   */
  async planRename(ref: string, label: unknown, actor: Actor = ownerActor()): Promise<{ known: WorkspaceIdentity; from: string; to: string; unchanged: boolean }> {
    const { known } = await this.#authorized(ref, actor, 'operate');
    const to = typeof label === 'string' ? normalizeWorkspaceLabel(label) : '';
    const problem = workspaceLabelProblem(to);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, { details: { label: problem } });
    const from = known.label ?? known.name;
    const other = this.identities.holder(known.target, to);
    if (other && other.id !== known.id) {
      const where = this.#runtimes.get(known.target)?.target.label ?? known.target;
      const msg = `“${to}” is already a workspace on ${where}. Pick another name.`;
      throw new AppError('CONFLICT', msg, { details: { label: msg } });
    }
    return { known, from, to, unchanged: to === from };
  }

  /**
   * Renames a workspace (T-42 slice 2): its LABEL only. Never its stable id, its `<target>/<name>` key, its runtime name or any stored
   * reference: nothing running is touched. Every form it was called by keeps resolving, and the new label too. Audited. `via`: how a Portal
   * MCP token is named in the audit row (its actor string and label).
   */
  async rename(ref: string, label: unknown, actor: Actor = ownerActor(), via: { actor?: string; actorLabel?: string } = {}): Promise<RenameWorkspaceResult> {
    const { known, from, to, unchanged } = await this.planRename(ref, label, actor);
    if (!unchanged) {
      this.identities.relabel(known.id, to);
      this.hooks.audit?.({
        kind: 'workspace.rename',
        actor: via.actor ?? actorString(actor),
        userId: actorUserId(actor),
        actorLabel: via.actorLabel ?? null,
        subject: known.id,
        detail: { workspace: known.legacyId, from, to },
      });
      console.log(`[workspaces] ${known.legacyId} (${known.id}) renamed`);
      this.hooks.changed?.();
    }
    return { id: known.legacyId, stableId: known.id, name: known.name, label: workspaceDisplayName({ name: known.name, label: known.label ?? undefined }), previous: from };
  }

  /* ---------- Resources: CPU and memory after a create (T-98, docs/prd/targets-connect.md §25) ---------- */

  /** The runtime's resource access for a workspace's target; a target without one (Docker, This machine, a single) says so. */
  #resourceAccess(known: WorkspaceIdentity): ResourceAccess {
    const access = this.#runtimes.get(known.target)?.resources;
    if (!access) throw new AppError('CONFLICT', 'Only a Kubernetes workspace’s CPU and memory can be changed here.');
    return access;
  }

  #resourcesView(known: WorkspaceIdentity, live: Partial<WorkspaceResourceValues>, replicas: number, extra: Partial<WorkspaceResources> = {}): WorkspaceResources {
    return {
      id: known.legacyId,
      stableId: known.id,
      wanted: known.resources ?? null,
      live,
      pending: !!known.resourcesPendingAt,
      pendingSince: known.resourcesPendingAt ?? null,
      appliedAt: known.resourcesAppliedAt ?? null,
      running: replicas > 0,
      problem: known.resourcesPendingAt ? (this.#resourceProblems.get(known.id) ?? null) : null,
      ...extra,
    };
  }

  /** The wanted values on the record, what the Deployment has, and whether a change waits for the next start. `view` on the workspace. */
  async resourcesOf(ref: string, actor: Actor = ownerActor()): Promise<WorkspaceResources> {
    const { known } = await this.#authorized(ref, actor, 'view');
    const access = this.#resourceAccess(known);
    const { live, replicas } = await this.#run(known.target, () => access.read(known.name));
    return this.#resourcesView(known, live, replicas);
  }

  /**
   * Checks a resources change without making it: who may (`operate` on the workspace through the seam, and never an agent: a change that
   * restarts the pod ends its own session), the values (left-out ones keep what is stored, else what the Deployment has; then the bounds and
   * no request above its limit), and the fit check with its numbers. Throws the refusal.
   */
  async planResources(
    ref: string,
    req: Partial<UpdateWorkspaceResourcesRequest>,
    actor: Actor = ownerActor(),
  ): Promise<{ known: WorkspaceIdentity; access: ResourceAccess; values: WorkspaceResourceValues; live: Partial<WorkspaceResourceValues>; replicas: number; apply: 'now' | 'next_restart'; unchanged: boolean; fit: WorkspaceResourcesFit }> {
    const { known } = await this.#authorized(ref, actor, 'operate');
    if (actor.kind === 'agent') throw new AppError('FORBIDDEN', 'An agent can’t change a workspace’s CPU and memory: the restart would end every session in it. Ask a person.');
    const access = this.#resourceAccess(known);
    const body = (req ?? {}) as Partial<UpdateWorkspaceResourcesRequest>;
    if (body.apply !== 'now' && body.apply !== 'next_restart')
      throw new AppError('VALIDATION_FAILED', 'Say when: now, or at the next restart.', { details: { apply: 'now or next_restart.' } });
    const { live, replicas } = await this.#run(known.target, () => access.read(known.name));
    const base: Partial<WorkspaceResourceValues> = { ...live, ...(known.resources ?? {}) };
    const pick = (k: keyof WorkspaceResourceValues) => (body[k] === undefined || body[k] === null ? base[k] : body[k]);
    const merged = { cpus: pick('cpus'), memoryMb: pick('memoryMb'), cpuRequest: pick('cpuRequest'), memoryRequestMb: pick('memoryRequestMb') };
    const problems = workspaceResourcesProblem(merged);
    if (problems) throw new AppError('VALIDATION_FAILED', Object.values(problems)[0]!, { details: problems });
    const values = merged as WorkspaceResourceValues;
    const unchanged = (Object.keys(values) as (keyof WorkspaceResourceValues)[]).every((k) => live[k] === values[k]);
    const fit = await this.#run(known.target, () => access.fit(known.name, values));
    return { known, access, values, live, replicas, apply: body.apply, unchanged, fit };
  }

  /**
   * Stores a workspace's CPU and memory on its record and applies them when the person picked (T-98). `now`: refused while a CI run is
   * running in it, or when the fit check does not say it fits (the numbers in the refusal); then the running pod is resized in place and the
   * Deployment written (T-3081: no session ends), or, when the cluster refuses the resize, the Deployment is patched and its pod restarts,
   * every session in it ending (events written just before are pulled first, like a stop); `how` and `resizeRefused` say which. `next_restart`: kept until its next
   * start, which applies them before it scales up. Values equal to what the Deployment has change nothing. Audited.
   */
  async setResources(
    ref: string,
    req: Partial<UpdateWorkspaceResourcesRequest>,
    actor: Actor = ownerActor(),
    via: { actor?: string; actorLabel?: string } = {},
  ): Promise<WorkspaceResources> {
    const plan = await this.planResources(ref, req, actor);
    const { known, access, values, live, replicas, apply, unchanged, fit } = plan;
    const now = new Date().toISOString();
    if (unchanged) {
      this.identities.setResources(known.id, values, { pendingAt: null, appliedAt: known.resourcesAppliedAt ?? null });
      this.#resourceProblems.delete(known.id);
      return this.#resourcesView(known, live, replicas, { fit, outcome: 'unchanged' });
    }
    let outcome: 'applied' | 'pending' = 'pending';
    let applied: ResourceApplied | null = null;
    if (apply === 'now') {
      const ci = replicas > 0 ? (this.hooks.runningCi?.(known.legacyId) ?? 0) : 0;
      if (ci > 0) throw new AppError('CONFLICT', `${ci === 1 ? 'A CI run is' : `${ci} CI runs are`} running in this workspace. Let ${ci === 1 ? 'it' : 'them'} finish (or cancel ${ci === 1 ? 'it' : 'them'}), then apply.`, { details: { ci: String(ci) } });
      if (fit.state !== 'fits') throw new AppError('CONFLICT', fit.message, { details: { fit: fit.message } });
      if (replicas > 0) {
        const pull = this.hooks.beforeStop?.(known.legacyId).catch(() => undefined);
        if (pull) await Promise.race([pull, new Promise((r) => setTimeout(r, 5_000).unref())]);
      }
      applied = (await this.#run(known.target, () => access.apply(known.name, values))) || null;
      outcome = 'applied';
    }
    const restarted = applied?.how === 'restarted';
    this.identities.setResources(known.id, values, outcome === 'applied' ? { pendingAt: null, appliedAt: now } : { pendingAt: now, appliedAt: known.resourcesAppliedAt ?? null });
    this.#resourceProblems.delete(known.id);
    this.hooks.audit?.({
      kind: 'workspace.resources',
      actor: via.actor ?? actorString(actor),
      userId: actorUserId(actor),
      actorLabel: via.actorLabel ?? null,
      subject: known.id,
      detail: {
        workspace: known.legacyId,
        apply,
        outcome,
        restarted,
        ...(applied ? { how: applied.how, resizeRefused: applied.refused } : {}),
        from: describeValues(live),
        to: describeValues(values),
      },
    });
    const said =
      outcome !== 'applied' ? 'kept for the next start'
      : applied?.how === 'resized' ? 'applied in place, no restart'
      : restarted ? `applied, the pod restarts${applied?.refused ? ` (in-place resize not used: ${applied.refused})` : ''}`
      : 'applied';
    console.log(`[workspaces] ${known.legacyId} resources ${said}`);
    this.hooks.changed?.();
    return this.#resourcesView(known, outcome === 'applied' ? values : live, replicas, { fit, outcome, ...(applied ? { how: applied.how, resizeRefused: applied.refused } : {}) });
  }

  /**
   * At a start: resources waiting for it are written into the stopped Deployment before it scales up, when the fit check says they fit.
   * When they do not (or anything fails), the workspace starts as it was and they stay pending, the reason shown. Never blocks a start.
   */
  async #applyPendingResources(target: string, name: string): Promise<void> {
    const known = this.identities.of(target, name);
    const access = this.#runtimes.get(target)?.resources;
    if (!known?.resourcesPendingAt || !known.resources || !access) return;
    const values = known.resources;
    try {
      const { live, replicas } = await access.read(name);
      if (replicas !== 0) return;
      const fit = await access.fit(name, values);
      if (fit.state !== 'fits') {
        this.#resourceProblems.set(known.id, fit.message);
        console.log(`[workspaces] ${known.legacyId} started without its pending resources: ${fit.message}`);
        return;
      }
      if (!(await access.apply(name, values, { onlyWhenStopped: true }))) return;
      this.identities.setResources(known.id, values, { pendingAt: null, appliedAt: new Date().toISOString() });
      this.#resourceProblems.delete(known.id);
      this.hooks.audit?.({
        kind: 'workspace.resources',
        actor: 'system:workspaces',
        userId: null,
        subject: known.id,
        detail: { workspace: known.legacyId, apply: 'next_restart', outcome: 'applied', restarted: false, from: describeValues(live), to: describeValues(values) },
      });
      console.log(`[workspaces] ${known.legacyId} starts with its pending resources`);
    } catch (e) {
      this.#resourceProblems.set(known.id, runtimeMessage(e));
      console.error(`[workspaces] ${known.legacyId}: pending resources not applied: ${runtimeMessage(e)}`);
    }
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
    // Nor may it take a name another workspace there answers to: its label, or a label it had (T-42 slice 2).
    const holder = this.identities.holder(target.id, name);
    if (holder && holder.legacyId !== id) throw new AppError('CONFLICT', `A workspace named “${name}” already exists on ${target.label}.`);
    // Its identity (T-42): a new stable id, and the runtime name its container or Deployment and volume get (`ws-<12 hex>`, or the form
    // the target's runtime must use), stored and never derived from the name again. A record still holding the name is of a workspace that
    // is gone (the list above has none): it is retired.
    const identity = this.identities.allocate(target.id, name, (stableId) => runtime.runtimeNameForNew?.(name, stableId));
    const workspace: Workspace = {
      id,
      stableId: identity.id,
      name,
      label: name,
      ...(identity.runtimeName ? { runtimeName: identity.runtimeName } : {}),
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
    // A create saved before T-42 (resumed after the restart that brought it) has no runtime name: the one on record, if any, else the runtime's.
    const runtimeName = workspace.runtimeName ?? this.identities.runtimeNameOf(workspace.target, name);
    void runtime
      .create({ name, cpus, memoryMb, claudeVersion: workspace.claude?.pinned ?? undefined, ...(node ? { node } : {}), ...(runtimeName ? { runtimeName } : {}) }, (detail) => {
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
    this.#refuseIfUnavailable(target);
    try {
      await this.#applyPendingResources(target, name);
      return await this.#run(target, (r) => r.start(name));
    } finally {
      this.hooks.changed?.();
    }
  }

  async stop(target: string, name: string) {
    this.#refuseIfUnavailable(target);
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
    this.#refuseIfUnavailable(target);
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
      this.identities.retire(target, name);
      console.log(`[workspaces] dropped the waiting create of ${id}`);
      return;
    }
    if (this.#pending.get(id)?.status === 'creating')
      throw new AppError('CONFLICT', 'Wait for it to finish creating, then remove it.');
    this.#refuseIfUnavailable(target);
    this.#deletePending(id);
    try {
      await this.#run(target, (r) => r.remove(name));
    } finally {
      this.hooks.changed?.();
    }
    // Its identity stays on record, removed: the id is never given again, and the name is free for another workspace (T-42).
    this.identities.retire(target, name);
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
      // Bounded like the list (T-515): a slow API answers "yes" in time instead of holding the caller.
      return (await timeout(runtime.list(), this.#listTimeoutMs)).some((w) => w.id === id);
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

  /**
   * A target whose workspaces are shown from last-known data (its API did not answer, T-515) takes no runtime action: the call would only
   * wait for the client's own timeout. Refused at once, with the reason; it runs after the seam's check, so what an actor may not see stays a 404.
   */
  #refuseIfUnavailable(target: string) {
    const reason = this.#unavailable.get(target);
    if (reason === undefined) return;
    const label = this.#runtimes.get(target)?.target.label ?? target;
    throw new AppError('SERVICE_UNAVAILABLE', `${label} isn’t answering (${reason}), so this can’t run now. Try again when it is back.`);
  }

  /** Runs a runtime call; Docker/Kubernetes failures come back as a readable 503. */
  async #run<T>(target: string, fn: (r: Runtime) => Promise<T>): Promise<T> {
    const runtime = this.#runtime(target);
    this.#refuseIfUnavailable(target);
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
