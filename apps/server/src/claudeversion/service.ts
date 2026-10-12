// Claude Code version pinning: the service (docs/prd/claude-version-pinning.md §7, §8). It shows what each workspace really runs next to what
// it is pinned to, keeps the one feature-minimum registry's warnings, builds an image per exact version, runs the canary (a throwaway container,
// the stand-in API and the REAL CLI) and only then lets a person Apply: recreate the workspace's container from the new tag KEEPING its home
// volume, with a one-action Rollback. The runtime stays the record of what a workspace runs; this keeps only the small history that cannot be read
// from it (the store's three tables) and in-memory caches. Platform-level things (the registry, the canary, the images, the default pin) belong to
// the platform area `version`; applying or rolling back ONE workspace needs `manage` on it (the routes check; a job re-checks when it runs).

import { AppError } from '@isnanme/core';
// Side effect: defines the CONFIRMATION_REQUIRED error code an Apply and a Rollback answer with until the person confirms.
import '../settings/registry.js';
import {
  CLAUDE_CANARY_DEFAULT_DAYS,
  CLAUDE_CANARY_SUITE,
  CLAUDE_FEATURES,
  CLAUDE_SETTING_KEYS,
  claudeBelowMinimum,
  claudeImageRef,
  claudeVersionOfImageRef,
  compareClaudeVersions,
  DEFAULT_CLAUDE_CODE_VERSION,
  isExactClaudeVersion,
  normalizeClaudeVersion,
  type ChatSession,
  type ClaudeApplyRequest,
  type ClaudeAutoUpdate,
  type ClaudeBelowMinimum,
  type ClaudeCanaryReport,
  type ClaudeCanaryRequest,
  type ClaudeCanaryRun,
  type ClaudeCandidate,
  type ClaudeImage,
  type ClaudeImagePruneRequest,
  type ClaudeImagePruneResult,
  type ClaudeOperation,
  type ClaudeRollbackRequest,
  type ClaudeSchedule,
  type ClaudeUpgradePlan,
  type ClaudeVersionHistoryEntry,
  type ClaudeVersionInfo,
  type ClaudeVersionOverview,
  type ClaudeVersionWarning,
  type Workspace,
  type WorkspaceClaudeBrief,
} from '@portal/contracts';
import { actorString, actorUserId, can, ownerActor, systemActor, visible } from '../authz/seam.js';
import type { Actor } from '@portal/contracts';
import type { AuditInput } from '../platform/audit.js';
import type { Settings } from '../settings/store.js';
import type { Store } from '../store/store.js';
import type { ImageInfo, Runtime } from '../workspaces/runtime.js';
import { versionArea } from './authz.js';
import { candidateOf, readRegistry, type RegistryReading } from './candidate.js';
import { runCanary, type CanaryHooks, type CanaryOutcome, type CanaryTarget } from './canary/runner.js';
import { canaryChecks } from './canary/checks.js';
import { buildReport, canaryWarnings, flagsOf, parseDoctor, testedSet, unacceptedFailures, workspaceWarnings } from './info.js';
import { ClaudeVersionStore, verdictOf, type HistoryRow } from './store.js';

/** A canary this fresh counts for an Apply; older, or from an older suite, must be run again. */
const CANARY_FRESH_MS = 7 * 86_400_000;
/** How long what `claude --version` and `claude doctor` said inside a workspace is trusted before it is read again. */
const READ_TTL_MS = 10 * 60_000;
const DOCTOR_TTL_MS = 30 * 60_000;
/** How long the registry's answer is trusted. */
const CANDIDATE_TTL_MS = 6 * 3_600_000;
/** The scheduler looks this often whether a canary is due. */
const SCHEDULE_TICK_MS = 15 * 60_000;
const SCHEDULE_FIRST_DELAY_MS = 90_000;
const RUNNING_STATES: readonly string[] = ['starting', 'idle', 'working', 'waiting'];

/** What the service needs of the workspace manager. */
export interface WorkspaceAccess {
  list(): Promise<Workspace[]>;
  runtimeFor(target: string): Runtime | undefined;
  runtimeList(): Runtime[];
  recreate(target: string, name: string, image: string, progress: (detail: string) => void, opts?: { label?: string }): Promise<{ from: string | null; to: string }>;
}

export interface ClaudeVersionsDeps {
  store: Store;
  workspaces: WorkspaceAccess;
  /** The delivery engine's record of each workspace: the `claude --version` it last read, and when. */
  reconciler: { row(workspaceId: string): { claude_version: string | null; checked_at: string | null } | null; request(workspaceId: string, why?: string): Promise<void> };
  chat: { list(filter: { workspaceId?: string }): ChatSession[] };
  settings: Pick<Settings, 'get' | 'onChange'>;
  /** Tells pages (the `claudeversion` live topic). */
  notify?: () => void;
  /** The platform audit (`platform.audit.record`): platform-level acts and every upgrade or rollback also leave a row there. Names, ids and numbers only. */
  audit?: (e: AuditInput) => void;
  now?: () => Date;
  fetch?: typeof fetch;
  /** The target the canary, the image list and the scheduled job use: the first with images when absent. Never `docker-host` by accident. */
  canaryTarget?: string;
  /** `PORTAL_WORKSPACE_IMAGE` names the image whole: the default pin is then not applied to new workspaces and cannot be changed here. */
  imageFixed?: boolean;
  /** Replaced in tests. */
  runner?: (t: NonNullable<Runtime['throwaway']>, target: CanaryTarget, hooks: CanaryHooks) => Promise<CanaryOutcome>;
  /** How long after start the first scheduled canary waits. */
  scheduleDelayMs?: number;
  /** How long to wait before reading the version after a recreate (tests shorten it). */
  settleMs?: number;
}

const wsLabel = (w: { target: string; name: string }) => `${w.target}/${w.name}`;

export class ClaudeVersions {
  readonly store: ClaudeVersionStore;
  readonly #sinks = new Set<(w: ClaudeVersionWarning) => void>();
  readonly #ops = new Map<string, ClaudeOperation>();
  readonly #direct = new Map<string, { version: string | null; at: number }>();
  readonly #doctor = new Map<string, { auto: ClaudeAutoUpdate; at: number }>();
  #opSeq = 0;
  #tested = new Set<string>();
  #candidate: ClaudeCandidate | null = null;
  #canary: { id: number; cancel: boolean } | null = null;
  #timer: NodeJS.Timeout | undefined;
  #stopSettings: (() => void) | undefined;
  #raising: Promise<void> = Promise.resolve();
  #building = new Set<string>();

  constructor(private readonly deps: ClaudeVersionsDeps) {
    this.store = new ClaudeVersionStore(deps.store);
    this.#refreshTested();
    this.#candidate = this.store.meta<ClaudeCandidate>('candidate');
  }

  readonly #now = () => (this.deps.now ?? (() => new Date()))();

  #notify() {
    try {
      this.deps.notify?.();
    } catch {
      // a page that cannot be told is not a reason to fail
    }
  }

  /**
   * One audit entry: this area's own trail (its three tables) and the platform audit. `kind` is `claude.<action>`; the detail carries names, ids
   * and numbers only (the platform audit keeps plain values and drops the rest).
   */
  #audit(action: string, actor: Actor, fields: { workspaceId?: string | null; version?: string | null; detail?: string | null }, severity: AuditInput['severity'] = 'info'): void {
    this.store.audit(action, { actor: actorString(actor) }, fields);
    try {
      this.deps.audit?.({
        kind: `claude.${action.replace(/[^a-z0-9_.]/gi, '_').toLowerCase()}`,
        severity,
        actor: actorString(actor),
        userId: actorUserId(actor),
        subject: fields.workspaceId ?? null,
        detail: { ...(fields.version ? { version: fields.version } : {}), ...(fields.detail ? { note: fields.detail } : {}) },
      });
    } catch (e) {
      console.error(`[claude-version] the platform audit refused an entry: ${(e as Error).message}`);
    }
  }

  #refreshTested() {
    this.#tested = testedSet(this.store.testedVersions());
  }

  /** Called with each warning the canary's runs raise, once each (notifications plug in here). */
  onWarning(fn: (w: ClaudeVersionWarning) => void): () => void {
    this.#sinks.add(fn);
    return () => void this.#sinks.delete(fn);
  }

  /* ---------- Where things are ---------- */

  /** THE one place a workspace is fetched by id (multi-user: an access check lands here, not in every caller). */
  async #workspace(id: string): Promise<Workspace> {
    const found = (await this.deps.workspaces.list()).find((w) => w.id === id);
    if (!found) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
    return found;
  }

  /** The runtime of the target a canary and the image list use: the configured one, else the first that holds an image per version. */
  #defaultRuntime(): Runtime | undefined {
    const all = this.deps.workspaces.runtimeList();
    return this.deps.canaryTarget ? all.find((r) => r.target.id === this.deps.canaryTarget && r.images) : all.find((r) => r.images);
  }

  #runtimeOf(target: string | undefined): Runtime {
    const r = target ? this.deps.workspaces.runtimeFor(target) : this.#defaultRuntime();
    if (!r?.images) throw new AppError('CONFLICT', target ? `${target} keeps no image per Claude Code version.` : 'No target here keeps an image per Claude Code version.');
    return r;
  }

  /** The version new workspaces get: the person's choice, else the built-in default. */
  defaultVersion(): string {
    const chosen = this.store.meta<string>('default');
    return isExactClaudeVersion(chosen) ? chosen : DEFAULT_CLAUDE_CODE_VERSION;
  }

  /** What the manager passes for a new workspace that names no version (undefined when `PORTAL_WORKSPACE_IMAGE` fixed the image). */
  defaultForNew = (): string | undefined => (this.deps.imageFixed ? undefined : this.defaultVersion());

  async setDefault(version: string, actor: Actor): Promise<{ defaultVersion: string }> {
    if (this.deps.imageFixed) throw new AppError('CONFLICT', 'PORTAL_WORKSPACE_IMAGE fixes the image of new workspaces; the default pin cannot change here.');
    if (!isExactClaudeVersion(version)) throw invalid('version', 'Use an exact version such as 2.1.296.');
    const runtime = this.#defaultRuntime();
    if (runtime?.images && !(await runtime.images.inspect(runtime.images.refFor(version)))) throw new AppError('CONFLICT', `Build the image for ${version} first.`);
    this.store.setMeta('default', version);
    this.#audit('default_set', actor, { version }, 'medium');
    this.#notify();
    return { defaultVersion: version };
  }

  /* ---------- What a workspace runs ---------- */

  #rowVersion(workspaceId: string): { version: string | null; at: number | null } {
    const row = this.deps.reconciler.row(workspaceId);
    const version = normalizeClaudeVersion(row?.claude_version);
    return { version, at: version && row?.checked_at ? Date.parse(row.checked_at) : null };
  }

  /** The newest reading of `claude --version` we have: our own direct one, or the delivery engine's, whichever is fresher. */
  #knownVersion(workspaceId: string): { version: string | null; at: number | null } {
    const row = this.#rowVersion(workspaceId);
    const direct = this.#direct.get(workspaceId);
    if (direct && (row.at === null || direct.at >= row.at)) return { version: direct.version, at: direct.at };
    return row;
  }

  /** Reads `claude --version` inside a running workspace now (only when asked or the last reading is old). */
  async #readVersion(w: Workspace, fresh: boolean): Promise<{ version: string | null; at: number | null }> {
    const known = this.#knownVersion(w.id);
    if (!fresh && known.version && known.at !== null && this.#now().getTime() - known.at < READ_TTL_MS) return known;
    const access = this.deps.workspaces.runtimeFor(w.target)?.delivery;
    if (!access || w.status !== 'running') return known;
    try {
      const r = await access.run(w.name, 'claude --version 2>/dev/null | head -n 1', { user: 'node', timeoutMs: 20_000 });
      const version = r.code === 0 ? normalizeClaudeVersion(r.stdout) : null;
      const reading = { version, at: this.#now().getTime() };
      this.#direct.set(w.id, reading);
      return reading;
    } catch {
      return known;
    }
  }

  async #readAutoUpdate(w: Workspace, fresh: boolean): Promise<ClaudeAutoUpdate> {
    const cached = this.#doctor.get(w.id);
    if (!fresh && cached && this.#now().getTime() - cached.at < DOCTOR_TTL_MS) return cached.auto;
    const access = this.deps.workspaces.runtimeFor(w.target)?.delivery;
    if (!access || w.status !== 'running') return cached?.auto ?? 'unknown';
    try {
      const r = await access.run(w.name, 'timeout 30 claude doctor 2>&1 | grep -E "^Auto-update"', { user: 'node', timeoutMs: 40_000 });
      const auto = parseDoctor(r.stdout);
      this.#doctor.set(w.id, { auto, at: this.#now().getTime() });
      return auto;
    } catch {
      return cached?.auto ?? 'unknown';
    }
  }

  /** The workspace list's small summary: from caches only, never a probe. */
  brief = (w: Workspace): WorkspaceClaudeBrief => {
    const pinned = w.claude?.pinned ?? null;
    const running = this.#knownVersion(w.id).version;
    const auto = this.#doctor.get(w.id)?.auto ?? 'unknown';
    return { pinned, running, flags: flagsOf({ pinned, running, autoUpdate: auto, tested: this.#tested }) };
  };

  async #info(w: Workspace, fresh: boolean): Promise<ClaudeVersionInfo> {
    const runtime = this.deps.workspaces.runtimeFor(w.target);
    const image = await runtime?.imageOf?.(w.name).catch(() => null);
    const pinned = image?.version ?? w.claude?.pinned ?? null;
    const reading = await this.#readVersion(w, fresh);
    const autoUpdate = await this.#readAutoUpdate(w, fresh);
    const flags = flagsOf({ pinned, running: reading.version, autoUpdate, tested: this.#tested });
    const last = this.store.latestApplied().get(w.id);
    const imageTag = image?.ref ?? null;
    return {
      workspaceId: w.id,
      pinned,
      running: reading.version,
      imageTag,
      checkedAt: reading.at === null ? null : new Date(reading.at).toISOString(),
      differs: flags.includes('differs'),
      autoUpdate,
      belowMinimum: claudeBelowMinimum(reading.version),
      tested: reading.version ? this.#tested.has(reading.version) : null,
      flags,
      previous: last && imageTag && last.toImage === imageTag ? { version: last.fromVersion, image: last.fromImage, at: last.at } : null,
      canRecreate: !!runtime?.recreate && !!runtime.images,
      operation: this.#ops.get(w.id)?.status === 'running' ? this.#ops.get(w.id)! : null,
    };
  }

  async info(workspaceId: string): Promise<ClaudeVersionInfo> {
    return this.#info(await this.#workspace(workspaceId), true);
  }

  /** Every workspace's info, from caches (what the list's chips and the overview use); a stopped or unread one says unknown. */
  async infos(actor: Actor): Promise<Record<string, ClaudeVersionInfo>> {
    const all = visible(actor, 'workspace', await this.deps.workspaces.list(), (w) => w.id);
    const out: Record<string, ClaudeVersionInfo> = {};
    for (const w of all) out[w.id] = await this.#info(w, false);
    return out;
  }

  history(workspaceId: string): ClaudeVersionHistoryEntry[] {
    return this.store.history(workspaceId).map(({ fromImageId: _id, ...entry }) => entry);
  }

  /* ---------- Images ---------- */

  async images(target?: string): Promise<ClaudeImage[]> {
    const runtime = this.#runtimeOf(target);
    const found: ImageInfo[] = await runtime.images!.list();
    const workspaces = (await this.deps.workspaces.list()).filter((w) => w.target === runtime.target.id);
    const usedBy = new Map<string, string[]>();
    for (const w of workspaces) {
      const ref = (await runtime.imageOf?.(w.name).catch(() => null))?.ref;
      if (ref) usedBy.set(ref, [...(usedBy.get(ref) ?? []), w.id]);
    }
    const rollback = new Map<string, string[]>();
    for (const [id, e] of this.store.latestApplied()) if (id.startsWith(`${runtime.target.id}/`)) rollback.set(e.fromImage, [...(rollback.get(e.fromImage) ?? []), id]);
    const defaultRef = runtime.images!.refFor(this.defaultVersion());
    return found
      .map((i): ClaudeImage => {
        const run = i.version ? this.store.runs({ version: i.version, status: 'done', limit: 1 })[0] : undefined;
        return {
          target: runtime.target.id,
          ref: i.ref,
          version: i.version,
          builtAt: i.builtAt,
          sizeBytes: i.sizeBytes,
          usedBy: usedBy.get(i.ref) ?? [],
          rollbackFor: rollback.get(i.ref) ?? [],
          isDefault: i.ref === defaultRef,
          canary: run && run.verdict ? { runId: run.id, at: run.finishedAt ?? run.startedAt, verdict: run.verdict } : null,
        };
      })
      .sort((a, b) => compareClaudeVersions(b.version, a.version) ?? 0);
  }

  /** Builds the image of an exact version on a target (long; runs in the background, one build at a time per daemon). */
  async buildImage(version: string, actor: Actor, target?: string): Promise<{ ref: string; building: boolean }> {
    if (!isExactClaudeVersion(version)) throw invalid('version', 'Use an exact version such as 2.1.296.');
    const runtime = this.#runtimeOf(target);
    const ref = runtime.images!.refFor(version);
    if (await runtime.images!.inspect(ref)) return { ref, building: false };
    if (this.#building.has(ref)) return { ref, building: true };
    this.#building.add(ref);
    this.#audit('image_build', actor, { version, detail: ref });
    void runtime
      .images!.ensure(version, () => this.#notify())
      .then(
        () => this.#audit('image_built', actor, { version, detail: ref }),
        (e: unknown) => this.#audit('image_build_failed', actor, { version, detail: clip(e) }, 'medium'),
      )
      .finally(() => {
        this.#building.delete(ref);
        this.#notify();
      });
    this.#notify();
    return { ref, building: true };
  }

  /** Whether a build of this version is running now. */
  building(): string[] {
    return [...this.#building];
  }

  /**
   * Removes unused images, listing first. Never an image a workspace's container was made from, never the default, and by default never one a
   * Rollback goes back to (a rollback target is rebuilt when it is missing, but the build takes minutes and needs the network).
   */
  async prune(req: ClaudeImagePruneRequest, actor: Actor): Promise<ClaudeImagePruneResult> {
    const runtime = this.#runtimeOf(req.target);
    const images = await this.images(runtime.target.id);
    const wanted = req.refs ? new Set(req.refs) : null;
    const removed: string[] = [];
    const kept: { ref: string; why: string }[] = [];
    for (const i of images) {
      if (wanted && !wanted.has(i.ref)) continue;
      const why = i.usedBy.length ? `used by ${i.usedBy.join(', ')}` : i.isDefault ? 'default' : !wanted && i.rollbackFor.length ? `rollback for ${i.rollbackFor.join(', ')}` : null;
      if (why) kept.push({ ref: i.ref, why });
      else if (!claudeVersionOfImageRef(i.ref)) kept.push({ ref: i.ref, why: 'not a version tag' });
      else if (req.dryRun) removed.push(i.ref);
      else {
        try {
          await runtime.images!.remove(i.ref);
          removed.push(i.ref);
        } catch (e) {
          kept.push({ ref: i.ref, why: clip(e) });
        }
      }
    }
    if (wanted) for (const ref of wanted) if (!images.some((i) => i.ref === ref)) kept.push({ ref, why: 'not an image of this portal' });
    if (!req.dryRun) this.#audit('image_prune', actor, { detail: `removed ${removed.length}: ${removed.join(', ')}`.slice(0, 500) }, 'medium');
    this.#notify();
    return { dryRun: !!req.dryRun, removed, kept };
  }

  /* ---------- Upgrade: plan, apply, rollback ---------- */

  #runningSessions(workspaceId: string, actor: Actor): { shown: { id: string; title: string }[]; hidden: number } {
    const running = this.deps.chat.list({ workspaceId }).filter((s) => RUNNING_STATES.includes(s.state));
    const shown = visible(actor, 'session', running, (s) => s.id).map((s) => ({ id: s.id, title: s.title }));
    return { shown, hidden: running.length - shown.length };
  }

  /** How many of the portal's terminals (tmux sessions named `cp-…`) are open in a running workspace; 0 when none, or when it cannot be read. */
  async #terminalCount(w: Workspace): Promise<number> {
    const access = this.deps.workspaces.runtimeFor(w.target)?.delivery;
    if (!access || w.status !== 'running') return 0;
    try {
      const r = await access.run(w.name, `tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c '^cp-' || true`, { user: 'node', timeoutMs: 10_000 });
      return Math.max(0, Number(r.stdout.trim()) || 0);
    } catch {
      return 0;
    }
  }

  /**
   * The newest finished canary on a version's own IMAGE (any trigger), as an Apply reads it. A scratch run of the scheduled candidate check tests the
   * same Claude Code but not the image an upgrade would put in a workspace, so it informs (the plan says what it found) and never clears an Apply.
   */
  #canaryFor(version: string, runId?: number | null): ClaudeCanaryRun | null {
    if (runId) {
      const run = this.store.run(runId);
      return run && run.version === version && run.mode === 'image' ? run : null;
    }
    return this.store.runs({ version, status: 'done', limit: 20 }).find((r) => r.mode === 'image') ?? null;
  }

  async plan(workspaceId: string, version: string, actor: Actor): Promise<ClaudeUpgradePlan> {
    if (!isExactClaudeVersion(version)) throw invalid('version', 'Use an exact version such as 2.1.296.');
    const w = await this.#workspace(workspaceId);
    const runtime = this.deps.workspaces.runtimeFor(w.target);
    const blockers: string[] = [];
    if (!runtime?.recreate || !runtime.images) blockers.push('This target cannot recreate a workspace from another image.');
    const ref = runtime?.images?.refFor(version) ?? claudeImageRef(version);
    const imageReady = runtime?.images ? !!(await runtime.images.inspect(ref).catch(() => null)) : false;
    if (runtime?.images && !imageReady) blockers.push('Build the image first.');
    const current = await runtime?.imageOf?.(w.name).catch(() => null);
    const from = current?.version ?? w.claude?.pinned ?? this.#knownVersion(w.id).version;
    if (current?.ref === ref) blockers.push(`It is already on ${version}.`);
    const run = this.#canaryFor(version);
    const failed = run ? run.results.filter((r) => r.status === 'fail').map((r) => r.id) : [];
    const stale = !!run && (run.suite !== CLAUDE_CANARY_SUITE || this.#now().getTime() - Date.parse(run.finishedAt ?? run.startedAt) > CANARY_FRESH_MS);
    if (!run) {
      blockers.push('Run the canary first.');
      const scratch = this.store.runs({ version, status: 'done', limit: 20 }).find((r) => r.mode === 'scratch' && r.fail > 0);
      if (scratch) blockers.push(`The scheduled canary found ${version} fails ${scratch.results.filter((r) => r.status === 'fail').map((r) => r.id).join(', ')}.`);
    } else if (run.status !== 'done') blockers.push('The canary has not finished.');
    else if (stale) blockers.push('The canary result is old: run it again.');
    else if (failed.length) blockers.push(`The canary failed: ${failed.join(', ')}. Accept the failed items to go on.`);
    if (this.#ops.get(w.id)?.status === 'running') blockers.push('An upgrade is already running here.');
    const sessions = this.#runningSessions(w.id, actor);
    return {
      workspaceId: w.id,
      from,
      to: version,
      imageRef: ref,
      imageReady,
      canary: run ? { runId: run.id, at: run.finishedAt ?? run.startedAt, verdict: run.verdict, failed, stale } : null,
      sessions: sessions.shown,
      hiddenSessions: sessions.hidden,
      terminals: await this.#terminalCount(w),
      willLose: ['Running processes and open terminals', 'Software installed outside the home folder (apt, global npm)', 'Chats in progress stop; they can be resumed'],
      appliable: blockers.length === 0,
      blockers,
    };
  }

  #op(w: Workspace, kind: 'upgrade' | 'rollback', from: string | null, to: string | null): ClaudeOperation {
    const op: ClaudeOperation = { id: `op-${++this.#opSeq}`, workspaceId: w.id, kind, status: 'running', detail: 'Starting', from, to, startedAt: this.#now().toISOString(), finishedAt: null };
    this.#ops.set(w.id, op);
    for (const [k, v] of this.#ops) if (this.#ops.size > 30 && v.status !== 'running') this.#ops.delete(k);
    this.#notify();
    return op;
  }

  /** The current image of a workspace as history records it: reference, id and version. */
  async #current(w: Workspace) {
    const runtime = this.deps.workspaces.runtimeFor(w.target);
    const image = await runtime?.imageOf?.(w.name).catch(() => null);
    return { ref: image?.ref ?? w.image ?? 'unknown', id: image?.id ?? null, version: image?.version ?? w.claude?.pinned ?? this.#knownVersion(w.id).version };
  }

  /** Recreates a workspace on `ref` and records it, in the background; `op` is what the page watches. */
  #recreate(w: Workspace, op: ClaudeOperation, ref: string, wantVersion: string | null, extra: { label?: string; kind: ClaudeVersionHistoryEntry['kind']; canaryRunId: number | null; canary: ClaudeVersionHistoryEntry['canary']; accepted: string[]; from: { ref: string; id: string | null; version: string | null }; actor: Actor }) {
    const set = (detail: string) => {
      op.detail = detail;
      this.#notify();
    };
    const finish = (status: 'done' | 'failed', detail: string) => {
      op.status = status;
      op.detail = detail;
      op.finishedAt = this.#now().toISOString();
      this.#notify();
    };
    const who = actorString(extra.actor);
    const owner = actorUserId(extra.actor) ?? undefined;
    void (async () => {
      try {
        // A tag that was pruned is rebuilt first (rollback to a removed image): the version is in its tag.
        const runtime = this.deps.workspaces.runtimeFor(w.target)!;
        if (runtime.images && !(await runtime.images.inspect(ref))) {
          const version = claudeVersionOfImageRef(ref);
          if (version) await runtime.images.ensure(version, set);
        }
        await this.deps.workspaces.recreate(w.target, w.name, ref, set, extra.label ? { label: extra.label } : undefined);
        this.#direct.delete(w.id);
        this.#doctor.delete(w.id);
        set('Reading the version');
        void this.deps.reconciler.request(w.id, 'claude code changed').catch(() => undefined);
        let seen: string | null = null;
        for (let i = 0; i < 12 && !seen; i++) {
          await new Promise((r) => setTimeout(r, this.deps.settleMs ?? (i === 0 ? 800 : 1500)).unref());
          seen = (await this.#readVersion((await this.#workspace(w.id).catch(() => w)) as Workspace, true)).version;
        }
        const note = wantVersion && seen && seen !== wantVersion ? `Recreated, but it reports ${seen}, not ${wantVersion}.` : null;
        this.store.addHistory({ workspaceId: w.id, kind: extra.kind, fromVersion: extra.from.version, toVersion: wantVersion ?? seen, fromImage: extra.from.ref, fromImageId: extra.from.id, toImage: extra.label ?? ref, canaryRunId: extra.canaryRunId, canary: extra.canary, accepted: extra.accepted, outcome: 'applied', detail: note, actor: who, createdBy: owner }, this.#now());
        this.#audit(extra.kind, extra.actor, { workspaceId: w.id, version: wantVersion, detail: `${extra.from.ref} -> ${ref}`.slice(0, 300) }, 'medium');
        finish('done', note ?? `Now on ${seen ?? wantVersion ?? 'the new image'}`);
      } catch (e) {
        const message = e instanceof AppError ? e.message : clip(e);
        const restored = /back on|put back/.test(message);
        this.store.addHistory({ workspaceId: w.id, kind: extra.kind, fromVersion: extra.from.version, toVersion: wantVersion, fromImage: extra.from.ref, fromImageId: extra.from.id, toImage: extra.label ?? ref, canaryRunId: extra.canaryRunId, canary: extra.canary, accepted: extra.accepted, outcome: restored ? 'restored' : 'failed', detail: message.slice(0, 500), actor: who, createdBy: owner }, this.#now());
        this.#audit(`${extra.kind}_failed`, extra.actor, { workspaceId: w.id, version: wantVersion, detail: message.slice(0, 300) }, 'high');
        finish('failed', message);
      }
    })();
  }

  async apply(workspaceId: string, req: ClaudeApplyRequest, actor: Actor): Promise<ClaudeOperation> {
    if (!isExactClaudeVersion(req.version)) throw invalid('version', 'Use an exact version such as 2.1.296.');
    const w = await this.#workspace(workspaceId);
    const runtime = this.deps.workspaces.runtimeFor(w.target);
    if (!runtime?.recreate || !runtime.images) throw new AppError('CONFLICT', 'This target cannot recreate a workspace from another image.');
    if (this.#ops.get(w.id)?.status === 'running') throw new AppError('CONFLICT', 'An upgrade is already running here.');
    const ref = runtime.images.refFor(req.version);
    if (!(await runtime.images.inspect(ref))) throw new AppError('CONFLICT', `Build the image for ${req.version} first.`);
    const from = await this.#current(w);
    if (from.ref === ref) throw new AppError('CONFLICT', `It is already on ${req.version}.`);
    // Only a canary that passed (or whose failures were accepted by name) clears an Apply.
    const run = this.#canaryFor(req.version, req.canaryRunId);
    if (!run || run.status !== 'done') throw new AppError('CONFLICT', 'Run the canary on that version first.', { details: { canaryRunId: 'No finished canary for this version.' } });
    if (run.suite !== CLAUDE_CANARY_SUITE || this.#now().getTime() - Date.parse(run.finishedAt ?? run.startedAt) > CANARY_FRESH_MS) throw new AppError('CONFLICT', 'The canary result is old: run it again.');
    const open = unacceptedFailures(run, req.acceptFailed);
    if (open.length) throw new AppError('CONFLICT', `The canary failed: ${open.join(', ')}. Accept the failed items by name to go on.`, { details: { acceptFailed: open.join(', ') } });
    if (req.confirm !== true) {
      const s = this.#runningSessions(w.id, actor);
      throw new AppError('CONFIRMATION_REQUIRED', `Upgrading recreates ${wsLabel(w)}: ${s.shown.length + s.hidden} session(s) and ${await this.#terminalCount(w)} terminal(s) stop. Confirm to go on.`, { details: { confirm: 'Confirm first.' } });
    }
    const op = this.#op(w, 'upgrade', from.version, req.version);
    this.#audit('upgrade_start', actor, { workspaceId: w.id, version: req.version, detail: `canary run ${run.id}` }, 'medium');
    const kind = from.version && from.version === req.version ? 'repin' : 'upgrade';
    this.#recreate(w, op, ref, req.version, { kind, canaryRunId: run.id, canary: run.verdict ?? 'none', accepted: (req.acceptFailed ?? []).filter((id) => run.results.some((r) => r.id === id && r.status === 'fail')), from, actor });
    return { ...op };
  }

  async rollback(workspaceId: string, req: ClaudeRollbackRequest, actor: Actor): Promise<ClaudeOperation> {
    const w = await this.#workspace(workspaceId);
    const runtime = this.deps.workspaces.runtimeFor(w.target);
    if (!runtime?.recreate || !runtime.images) throw new AppError('CONFLICT', 'This target cannot recreate a workspace from another image.');
    if (this.#ops.get(w.id)?.status === 'running') throw new AppError('CONFLICT', 'An upgrade is already running here.');
    const from = await this.#current(w);
    const last = this.store.latestApplied().get(w.id);
    if (!last || last.toImage !== from.ref) throw new AppError('CONFLICT', 'There is nothing to roll back to.');
    if (req.confirm !== true) {
      const s = this.#runningSessions(w.id, actor);
      throw new AppError('CONFIRMATION_REQUIRED', `Rolling back recreates ${wsLabel(w)}: ${s.shown.length + s.hidden} session(s) and ${await this.#terminalCount(w)} terminal(s) stop. Confirm to go on.`, { details: { confirm: 'Confirm first.' } });
    }
    // The old image by its tag; when that tag moved or is gone, by the id recorded then (a pruned version tag is rebuilt from its version).
    let target = last.fromImage;
    if (runtime.images && !(await runtime.images.inspect(target)) && last.fromImageId && (await runtime.images.inspect(last.fromImageId))) target = last.fromImageId;
    const op = this.#op(w, 'rollback', from.version, last.fromVersion);
    this.#audit('rollback_start', actor, { workspaceId: w.id, version: last.fromVersion }, 'medium');
    this.#recreate(w, op, target, last.fromVersion, { label: last.fromImage, kind: 'rollback', canaryRunId: null, canary: 'none', accepted: [], from, actor });
    return { ...op };
  }

  /* ---------- Candidate ---------- */

  /** The newest version the registry offers, cached; `refresh` reads it again. Unavailable says so, with why. */
  async candidate(refresh = false, reading?: RegistryReading): Promise<ClaudeCandidate> {
    const fresh = this.#candidate?.checkedAt && this.#now().getTime() - Date.parse(this.#candidate.checkedAt) < CANDIDATE_TTL_MS && this.#candidate.status !== 'unavailable';
    if (!refresh && fresh && this.#candidate) return this.#candidate;
    const installed = await this.installedVersion().catch(() => null);
    this.#candidate = candidateOf(reading ?? (await readRegistry(this.deps.fetch)), installed, this.#now());
    this.store.setMeta('candidate', this.#candidate);
    this.#notify();
    return this.#candidate;
  }

  /** What the default image carries (its label), or null while it is not built. */
  async installedVersion(): Promise<string | null> {
    const runtime = this.#defaultRuntime();
    if (!runtime?.images) return null;
    return (await runtime.images.inspect(runtime.images.refFor(this.defaultVersion())).catch(() => null))?.version ?? null;
  }

  /* ---------- Canary ---------- */

  checks() {
    return canaryChecks().map((c) => c.def);
  }

  runs(limit = 30): ClaudeCanaryRun[] {
    return this.store.runs({ limit });
  }

  run(id: number): ClaudeCanaryRun {
    const run = this.store.run(id);
    if (!run) throw new AppError('NOT_FOUND', 'No such canary run.');
    return run;
  }

  /** The newest finished run of a subject, for the report. */
  #latestRun(subject: ClaudeCanaryRun['subject'], version?: string | null): ClaudeCanaryRun | null {
    return this.store.runs({ subject, status: 'done', ...(version ? { version } : {}), limit: 1 })[0] ?? null;
  }

  async report(): Promise<ClaudeCanaryReport> {
    const info = this.#candidate ?? (await this.candidate(false));
    const installed = this.#latestRun('installed');
    // The candidate's run counts only while it is for the version the registry offers now.
    const candidate = info.version ? this.#latestRun('candidate', info.version) : null;
    return buildReport(installed, candidate, info, this.checks());
  }

  /**
   * Starts a canary run in the background and returns its row (status running). ONE canary container at a time; a second asks to wait. The
   * `installed` subject tests the default pin's image, `candidate` the registry's newest in a scratch install, `target` a version a person picked
   * (its image is built first when a person asked; the scheduled job never builds).
   */
  async startCanary(req: ClaudeCanaryRequest, opts: { trigger: ClaudeCanaryRun['trigger']; actor: Actor }): Promise<ClaudeCanaryRun> {
    if (!['installed', 'candidate', 'target'].includes(req.subject)) throw invalid('subject', 'Pick installed, candidate or target.');
    if (req.subject === 'target' && !isExactClaudeVersion(req.version)) throw invalid('version', 'Use an exact version such as 2.1.296.');
    if (this.#canary) throw new AppError('CONFLICT', 'A canary is already running. One at a time.');
    const runtime = this.#runtimeOf(req.target);
    const who = actorString(opts.actor);
    const createdBy = actorUserId(opts.actor) ?? undefined;
    const build = opts.trigger !== 'scheduled';
    const base = { trigger: opts.trigger, subject: req.subject, suite: CLAUDE_CANARY_SUITE, actor: who, createdBy } as const;
    const installed = this.defaultVersion();
    const installedRef = runtime.images!.refFor(installed);
    const unavailable = (version: string | null, image: string | null, mode: 'image' | 'scratch', note: string) => {
      const id = this.store.startRun({ ...base, version, image, mode, status: 'unavailable', note }, this.#now());
      this.store.saveRun(id, { finished: true }, this.#now());
      this.#notify();
      return this.store.run(id)!;
    };

    let version: string;
    let mode: 'image' | 'scratch';
    let image: string;
    if (req.subject === 'target') {
      version = req.version!;
      mode = 'image';
      image = runtime.images!.refFor(version);
    } else if (req.subject === 'installed') {
      version = installed;
      mode = 'image';
      image = installedRef;
    } else {
      const cand = await this.candidate(true);
      if (cand.status === 'unavailable' || !cand.version) return unavailable(null, null, 'scratch', `Not run: ${cand.reason ?? 'the registry’s newest version is unknown'} Nothing was guessed.`);
      version = cand.version;
      mode = 'scratch';
      image = installedRef;
      if (cand.status === 'same') {
        // The installed version is the registry's newest: the installed run is the candidate's too; do not run it twice.
        const same = this.#latestRun('installed', version);
        if (same) return same;
        return this.startCanary({ ...req, subject: 'installed' }, opts);
      }
    }
    if (mode === 'image' && req.subject !== 'target') {
      // `installed`: the default pin's image.
      if (!(await runtime.images!.inspect(image).catch(() => null)) && !build) return unavailable(version, image, mode, `Not run: the default image ${image} is not built yet.`);
    }
    if (mode === 'scratch' && !(await runtime.images!.inspect(image).catch(() => null)) && !build) return unavailable(version, image, mode, `Not run: the installed image ${image} is not built yet.`);
    if (!runtime.throwaway) return unavailable(version, image, mode, 'Not run: this target cannot start a throwaway container.');

    const id = this.store.startRun({ ...base, version, image, mode, status: 'running', note: 'Queued' }, this.#now());
    this.#canary = { id, cancel: false };
    this.#audit(opts.trigger === 'scheduled' ? 'canary_scheduled' : 'canary_start', opts.actor, { version, detail: `${req.subject} ${mode} run ${id}` });
    this.#notify();
    void this.#execute(id, runtime, { version, mode, image }, req.subject).finally(() => {
      this.#canary = null;
      this.#notify();
    });
    return this.store.run(id)!;
  }

  async #execute(id: number, runtime: Runtime, target: CanaryTarget, subject: ClaudeCanaryRun['subject']): Promise<void> {
    const set = (note: string) => {
      this.store.saveRun(id, { note });
      this.#notify();
    };
    try {
      // The image of the version under test (or the installed one, for a scratch install) must exist: build it when it is missing.
      if (!(await runtime.images!.inspect(target.image).catch(() => null))) {
        set(`Building ${target.image}`);
        const version = claudeVersionOfImageRef(target.image);
        if (!version) throw new Error(`${target.image} is not an image this portal can build.`);
        await runtime.images!.ensure(version, set);
      }
      const runner = this.deps.runner ?? runCanary;
      const outcome = await runner(runtime.throwaway!, target, {
        note: set,
        results: (results, reported) => {
          this.store.saveRun(id, { results, reported });
          this.#notify();
        },
        cancelled: () => !!this.#canary?.cancel,
      });
      this.store.saveRun(id, { status: outcome.status, note: outcome.note, reported: outcome.reported, results: outcome.results, finished: true }, this.#now());
    } catch (e) {
      this.store.saveRun(id, { status: 'error', note: clip(e), finished: true }, this.#now());
    }
    this.#refreshTested();
    this.#audit('canary_finish', systemActor('claude-canary'), { detail: `run ${id}` });
    this.#raising = this.#raising.then(() => this.#raiseWarnings(subject)).catch(() => undefined);
    this.#notify();
  }

  /** Resolves once the warning pass of the last canary has run (tests wait on this instead of the clock). */
  idle(): Promise<void> {
    return this.#raising;
  }

  /** Warnings the runs call for: each told once (a sink is where a notification plugs in). */
  async #raiseWarnings(_subject: ClaudeCanaryRun['subject']): Promise<void> {
    const told = new Set(this.store.meta<string[]>('warned') ?? []);
    const fresh = canaryWarnings(await this.report(), this.#now().toISOString(), this.checks()).filter((w) => !told.has(w.id));
    if (!fresh.length) return;
    this.store.setMeta('warned', [...told, ...fresh.map((w) => w.id)].slice(-100));
    for (const w of fresh) for (const sink of this.#sinks) {
      try {
        sink(w);
      } catch (e) {
        console.error(`[claude-version] a warning sink failed: ${(e as Error).message}`);
      }
    }
  }

  /** Stops the canary at the next check boundary (the container is removed by the runner). */
  cancelCanary(): boolean {
    if (!this.#canary) return false;
    this.#canary.cancel = true;
    return true;
  }

  get canaryRunning(): boolean {
    return !!this.#canary;
  }

  /* ---------- Warnings and the overview ---------- */

  async warnings(actor: Actor): Promise<ClaudeVersionWarning[]> {
    const at = this.#now().toISOString();
    const out = canaryWarnings(await this.report(), at, this.checks());
    for (const [id, info] of Object.entries(await this.infos(actor))) {
      out.push(...workspaceWarnings({ workspaceId: id, pinned: info.pinned, running: info.running, flags: info.flags, featuresBelow: info.belowMinimum as ClaudeBelowMinimum[] }, at));
    }
    const order = { urgent: 0, attention: 1, info: 2 } as const;
    return out.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  schedule(): ClaudeSchedule {
    const everyDays = this.#days();
    const last = this.store.runs({ subject: 'installed', limit: 1 })[0];
    const lastAt = last?.finishedAt ?? last?.startedAt ?? null;
    const nextAt = everyDays > 0 ? new Date((lastAt ? Date.parse(lastAt) : this.#now().getTime()) + everyDays * 86_400_000).toISOString() : null;
    return { everyDays, lastAt, nextAt, running: !!this.#canary };
  }

  #days(): number {
    try {
      const n = this.deps.settings.get<number>(CLAUDE_SETTING_KEYS.canaryDays);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CLAUDE_CANARY_DEFAULT_DAYS;
    } catch {
      return CLAUDE_CANARY_DEFAULT_DAYS;
    }
  }

  async overview(actor: Actor): Promise<ClaudeVersionOverview> {
    const runtime = this.#defaultRuntime();
    return {
      defaultVersion: this.defaultVersion(),
      builtInDefault: DEFAULT_CLAUDE_CODE_VERSION,
      installed: await this.installedVersion().catch(() => null),
      schedule: this.schedule(),
      report: await this.report(),
      images: runtime ? await this.images(runtime.target.id).catch(() => []) : [],
      warnings: await this.warnings(actor),
      recreateTargets: this.deps.workspaces.runtimeList().filter((r) => r.recreate && r.images).map((r) => r.target.id),
    };
  }

  features() {
    return CLAUDE_FEATURES;
  }

  /* ---------- The scheduled canary ---------- */

  /** Starts the scheduler: a tick every quarter hour asks whether a canary is due. Skips honestly when offline or when there is no Docker. */
  start(): void {
    if (this.#timer) return;
    // The cadence is a setting (the shared settings store audits it too); a change is also a platform-level act, so it goes to the platform audit.
    this.#stopSettings = this.deps.settings.onChange((key, value, old) => {
      if (key !== CLAUDE_SETTING_KEYS.canaryDays) return;
      this.#audit('schedule_set', ownerActor(), { detail: `every ${String(value)} days (was ${String(old)})` });
      this.#notify();
    });
    const interrupted = this.store.interruptRunning('The portal stopped while it ran.', this.#now());
    if (interrupted) console.log(`[claude-version] ${interrupted} canary run(s) were cut short by a restart`);
    void this.#removeLeftovers();
    const first = setTimeout(() => void this.#tick(), this.deps.scheduleDelayMs ?? SCHEDULE_FIRST_DELAY_MS);
    first.unref();
    this.#timer = setInterval(() => void this.#tick(), SCHEDULE_TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#stopSettings?.();
    this.#stopSettings = undefined;
  }

  async #removeLeftovers(): Promise<void> {
    try {
      const t = this.#defaultRuntime()?.throwaway;
      for (const c of (await t?.leftovers()) ?? []) await t!.remove(c.name);
    } catch {
      // nothing to clean, or no Docker
    }
  }

  /** Whether the schedule says a canary is due now (pure of the scheduler's timing, for tests). */
  due(): boolean {
    const days = this.#days();
    if (days <= 0 || this.#canary) return false;
    const last = this.store.runs({ subject: 'installed', limit: 1 })[0];
    if (!last) return true;
    return this.#now().getTime() - Date.parse(last.finishedAt ?? last.startedAt) >= days * 86_400_000;
  }

  /** One scheduled pass: the installed version, then the candidate. Runs as the system actor and asks the policy when it RUNS. */
  async runScheduled(): Promise<ClaudeCanaryRun[]> {
    const actor = systemActor('claude-canary');
    if (!can(actor, 'manage', versionArea).allow) return [];
    const out: ClaudeCanaryRun[] = [];
    for (const subject of ['installed', 'candidate'] as const) {
      let run: ClaudeCanaryRun;
      try {
        run = await this.startCanary({ subject }, { trigger: 'scheduled', actor });
      } catch (e) {
        console.error(`[claude-version] scheduled ${subject} canary not started: ${(e as Error).message}`);
        return out;
      }
      out.push(run);
      // One canary container at a time: wait for this one before the next.
      while (this.#canary) await new Promise((r) => setTimeout(r, 1000));
    }
    return out;
  }

  /**
   * Reads `claude --version` and `claude doctor` in running workspaces whose reading is old, a few per pass, so the list's flags (a different version,
   * the updater on) fill in without anyone opening a page. One exec each, never a model call.
   */
  async refreshReadings(max = 5): Promise<number> {
    let read = 0;
    let changed = false;
    for (const w of await this.deps.workspaces.list()) {
      if (w.status !== 'running') continue;
      const cached = this.#doctor.get(w.id);
      if (cached && this.#now().getTime() - cached.at < DOCTOR_TTL_MS) continue;
      if (read >= max) break;
      read++;
      const was = [this.#knownVersion(w.id).version, cached?.auto];
      const version = (await this.#readVersion(w, false)).version;
      const auto = await this.#readAutoUpdate(w, true);
      if (version !== was[0] || auto !== was[1]) changed = true;
    }
    if (changed) this.#notify();
    return read;
  }

  async #tick(): Promise<void> {
    try {
      await this.refreshReadings();
    } catch (e) {
      console.error(`[claude-version] refreshing versions failed: ${(e as Error).message}`);
    }
    try {
      if (this.due()) await this.runScheduled();
    } catch (e) {
      console.error(`[claude-version] scheduled canary failed: ${(e as Error).message}`);
    }
  }
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const clip = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

export { verdictOf };
export type { HistoryRow };
