import { isWorkspaceId } from '../names.js';
import type { Store } from '../store/store.js';
import { foreignPortal, isTargetUnreachable, type Runtime } from '../workspaces/runtime.js';
import { changedAreas } from './changes.js';
import { compile, CompileError } from './compile.js';
import { dueFolders, folderPlugin, manifestPlugins, pluginDir } from './marketplace.js';
import { OUTBOX_PULL } from './outbox.js';
import { deliverable } from './ownership.js';
import { parsePending, serializePending } from './pending.js';
import { settleTombstones, tombstoneKey } from './tombstones.js';
import { NODE, ROOT, MANIFEST_PATH, type Fragment, type PoolType } from './types.js';
import { checkReadable, deleteFiles, readApplied, writeBundle } from './writer.js';
import { appendedLines, sameLine } from './hooks.js';

/** How long a file stays after nothing references it, so a session mid-retry never loses it (§6.4). */
const DELETE_GRACE_MS = 30_000;
const RUNNING_EVERY_MS = 60_000;
const STOPPED_EVERY_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Version folders are checked by tree hash at each start and this often (skillset §10.5). */
const TREES_EVERY_MS = 10 * 60_000;

export type DeliveryStatus = 'synced' | 'pending' | 'drifted' | 'failed' | 'locked' | 'frozen' | 'unsupported' | 'none';

export interface DeliveryRow {
  workspace_id: string;
  generation: number;
  desired_hash: string | null;
  applied_hash: string | null;
  applied_at: string | null;
  status: DeliveryStatus;
  reason: string | null;
  claude_version: string | null;
  checked_at: string | null;
  pending_deletes: string;
  secret_paths: string;
}

/** A pool type's contribution to each workspace (foundation PRD §6.1). */
export interface FragmentProvider {
  type: PoolType;
  /** Pools of this type the database says this workspace has (assigned, or being removed). */
  knownPools(workspaceId: string): string[];
  fragments(workspaceId: string, ctx: { running: boolean; now: Date }): Fragment[];
  /**
   * After a successful write: advance removals and the like. `delivered` holds the files now wanted;
   * `pluginFolders` maps each portal plugin with a version folder still in the workspace (current or
   * kept for older sessions) to those folders' `<hash12>` names, so an owner can tell when a revoked or
   * unassigned plugin is really gone.
   */
  delivered?(
    workspaceId: string,
    ctx: {
      running: boolean;
      now: Date;
      delivered: Set<string>;
      pluginFolders: Map<string, string[]>;
      /** Seconds each running `claude` process had been up when this pass began, before anything was written (null: couldn't be read). */
      claudeAges?: number[] | null;
      /** When this pass's write finished (ms), or when it began if nothing was written. A session that started before it can lack what was written. */
      landedAt?: number;
    },
  ): void;
}

/** Shared folders every delivery needs; created by the engine because old images lack them (§9). */
export const FOUNDATION: Fragment = {
  owner: 'foundation',
  dirs: [
    { path: '/etc/claudepilot', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claudepilot/bin', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code/managed-settings.d', mode: 0o755, uid: ROOT, gid: ROOT },
    // Claude Code watches a managed folder only if it existed when a session started (✅ 2.1.296), so the
    // instruction, subagent and output-style folders are always there, even empty (persona PRD A4).
    { path: '/etc/claude-code/.claude', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code/.claude/agents', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code/.claude/output-styles', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code/.claude/rules', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/home/node/.claudepilot', mode: 0o755, uid: NODE, gid: NODE },
    { path: '/home/node/.claudepilot/outbox', mode: 0o700, uid: NODE, gid: NODE },
  ],
  files: [{ path: '/etc/claudepilot/bin/outbox-pull', content: OUTBOX_PULL, mode: 0o755, uid: ROOT, gid: ROOT }],
};

const splitId = (id: string) => {
  const i = id.indexOf('/');
  return { target: id.slice(0, i), name: id.slice(i + 1) };
};

/**
 * Keeps every workspace's delivered files matching the database (foundation PRD §6.3, §6.5): one run
 * per workspace at a time, triggered by changes, starts and timers; never writing while the portal
 * is Locked or Frozen, and freezing a workspace whose manifest it can't account for.
 */
export class Reconciler {
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  readonly #failures = new Map<string, number>();
  readonly #lastCheck = new Map<string, number>();
  readonly #lastTrees = new Map<string, number>();
  readonly #listeners = new Set<(workspaceId: string) => void>();
  #stopWatchers: (() => void)[] = [];
  /** Start watchers of runtimes added while running (an enrolled target connecting), by target id. */
  readonly #dynamic = new Map<string, () => void>();
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private readonly runtimes: (target: string) => Runtime | undefined,
    private readonly allRuntimes: () => Runtime[],
    private readonly providers: FragmentProvider[],
  ) {}

  /** Checks every known workspace now (after an unlock, for example). */
  requestAll(why: string) {
    for (const id of this.knownWorkspaces()) void this.request(id, why);
  }

  /** Starts timers and start-event watchers, and checks every known workspace once. */
  start() {
    for (const r of this.allRuntimes()) {
      if (r.delivery) this.#stopWatchers.push(r.delivery.watchStarts((name) => this.request(`${r.target.id}/${name}`, 'started')));
    }
    this.#timer = setInterval(() => this.#tick(), 15_000);
    this.#timer.unref();
    for (const id of this.knownWorkspaces()) this.request(id, 'portal start');
  }

  stop() {
    clearInterval(this.#timer);
    for (const s of this.#stopWatchers) s();
    this.#stopWatchers = [];
    for (const s of this.#dynamic.values()) s();
    this.#dynamic.clear();
  }

  /**
   * A runtime added, replaced or removed while the portal runs (targets-connect PRD §12.5): its start events are followed (null: it went),
   * and its workspaces are checked again: a target that came back gets what waited for it while it was unreachable.
   */
  runtimeChanged(targetId: string, runtime: Runtime | null) {
    this.#dynamic.get(targetId)?.();
    this.#dynamic.delete(targetId);
    if (!runtime) return;
    if (runtime.delivery) this.#dynamic.set(targetId, runtime.delivery.watchStarts((name) => this.request(`${targetId}/${name}`, 'started')));
    this.requestTarget(targetId, 'target returned');
  }

  /** Checks every known workspace of one target now (its tunnel came back). */
  requestTarget(targetId: string, why: string) {
    for (const id of this.knownWorkspaces()) if (id.startsWith(`${targetId}/`)) void this.request(id, why);
  }

  /** Called with a workspace ID whenever its delivery row changes. */
  onChange(fn: (workspaceId: string) => void) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  knownWorkspaces(): string[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db
      .prepare('SELECT workspace_id FROM assignments UNION SELECT workspace_id FROM removals UNION SELECT workspace_id FROM workspace_delivery')
      .all() as { workspace_id: string }[];
    return rows.map((r) => r.workspace_id);
  }

  row(workspaceId: string): DeliveryRow | null {
    return (this.store.db?.prepare('SELECT * FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as unknown as DeliveryRow | undefined) ?? null;
  }

  /**
   * Schedules a reconcile; a request during one queues exactly one more. `changed` marks the
   * workspace pending at once, so the UI never shows "synced" for a change that hasn't landed.
   */
  request(workspaceId: string, why = 'requested', opts: { changed?: boolean } = {}): Promise<void> {
    // Not a workspace id (QA-032: a hostile one was kept as a "known workspace" and asked of Docker every 15 s): nothing to reconcile,
    // no row to make.
    if (!isWorkspaceId(workspaceId)) return Promise.resolve();
    if (opts.changed) this.#save(workspaceId, { status: 'pending', reason: null });
    const running = this.#inFlight.get(workspaceId);
    if (running) {
      this.#again.add(workspaceId);
      return running;
    }
    const p = this.#reconcile(workspaceId, why)
      .catch((e: unknown) => console.error(`[delivery] ${workspaceId}: ${(e as Error).message}`))
      .finally(() => {
        this.#inFlight.delete(workspaceId);
        if (this.#again.delete(workspaceId)) void this.request(workspaceId, 'queued');
      });
    this.#inFlight.set(workspaceId, p);
    return p;
  }

  #tick() {
    const now = Date.now();
    for (const id of this.knownWorkspaces()) {
      const last = this.#lastCheck.get(id) ?? 0;
      const failures = this.#failures.get(id) ?? 0;
      const backoff = failures ? Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (failures - 1)) : 0;
      const row = this.row(id);
      const due = row?.status === 'synced' || row?.status === 'none' ? RUNNING_EVERY_MS : 0;
      if (now - last >= Math.max(due, backoff)) void this.request(id, failures ? 'retry' : 'timer');
    }
  }

  #save(workspaceId: string, patch: Partial<DeliveryRow>) {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('INSERT INTO workspace_delivery (workspace_id) VALUES (?) ON CONFLICT (workspace_id) DO NOTHING').run(workspaceId);
    const keys = Object.keys(patch) as (keyof DeliveryRow)[];
    if (keys.length) {
      db.prepare(`UPDATE workspace_delivery SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE workspace_id = ?`).run(
        ...keys.map((k) => (patch[k] ?? null) as string | number | null),
        workspaceId,
      );
    }
    for (const fn of this.#listeners) fn(workspaceId);
  }

  /**
   * T-102: the areas the deliveries written into a workspace after `sinceMs` changed, newest delivery first, each once (owner names, or
   * `other` for a delivery recorded before areas were). Empty when none landed since, or the events can't be read.
   */
  changesSince(workspaceId: string, sinceMs: number): string[] {
    if (!this.store.db || !Number.isFinite(sinceMs)) return [];
    try {
      const rows = this.store.db
        .prepare(`SELECT details FROM delivery_events WHERE workspace_id = ? AND kind = 'delivered' AND at > ? ORDER BY at DESC, id DESC LIMIT 50`)
        .all(workspaceId, new Date(sinceMs).toISOString()) as { details: string }[];
      const out = new Set<string>();
      for (const r of rows) {
        let areas: unknown;
        try {
          areas = (JSON.parse(r.details) as { areas?: unknown }).areas;
        } catch {
          areas = undefined;
        }
        if (Array.isArray(areas)) for (const a of areas) if (typeof a === 'string') out.add(a);
        if (!Array.isArray(areas)) out.add('other');
      }
      return [...out];
    } catch {
      return [];
    }
  }

  #event(workspaceId: string, kind: string, details: Record<string, unknown> = {}) {
    if (!this.store.writable) return;
    this.store.db!.prepare('INSERT INTO delivery_events (at, workspace_id, kind, details) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), workspaceId, kind, JSON.stringify(details));
  }

  async #reconcile(workspaceId: string, why: string) {
    const now = new Date();
    this.#lastCheck.set(workspaceId, now.getTime());

    // Failing safe (§6.5): a portal that doesn't trust its own state writes nothing.
    const trust = this.store.trust;
    if (trust.state !== 'ok') {
      this.#save(workspaceId, { status: trust.state, reason: trust.reasons.map((r) => r.message).join(' '), checked_at: now.toISOString() });
      return;
    }

    const { target, name } = splitId(workspaceId);
    const access = this.runtimes(target)?.delivery;
    if (!access) {
      this.#save(workspaceId, { status: 'unsupported', reason: 'Delivery is switched off for this target.', checked_at: now.toISOString() });
      return;
    }

    try {
      const state = await access.state(name);
      if (!state.exists) {
        this.#save(workspaceId, { status: 'pending', reason: 'Waiting for the workspace to exist.', checked_at: now.toISOString() });
        return;
      }
      // Created by another portal (it carries that portal's id): never read and never written, the first manifest
      // included, whatever global fragments this portal has (a lockdown for one). Without the label (made before
      // it existed) a workspace stays adoptable.
      if (foreignPortal(state.portal, this.store.portalId)) {
        if (this.row(workspaceId)) this.#save(workspaceId, { status: 'frozen', reason: 'Created by another portal.', checked_at: now.toISOString() });
        return;
      }
      // Kubernetes (`needsRunning`): a stopped workspace has no pod to write into, and its next pod starts from the image outside the home
      // volume, so everything is delivered at that start (watchStarts), not now.
      if (!state.running && access.needsRunning) {
        const waiting = this.providers.some((p) => p.fragments(workspaceId, { running: false, now }).length > 0);
        this.#save(workspaceId, { status: waiting ? 'pending' : 'none', reason: waiting ? 'Delivered when the workspace starts.' : null, checked_at: now.toISOString() });
        return;
      }
      const row = this.row(workspaceId) ?? ({ generation: 0, applied_hash: null, pending_deletes: '[]', secret_paths: '{}' } as DeliveryRow);
      const secretPaths = JSON.parse(row.secret_paths || '{}') as Record<string, string>;
      const treesDue = state.running && (why === 'started' || now.getTime() - (this.#lastTrees.get(workspaceId) ?? 0) >= TREES_EVERY_MS);
      const applied = await readApplied(access, name, state.running, { trees: treesDue });
      if (applied.trees) this.#lastTrees.set(workspaceId, now.getTime());

      // Can we account for what's in the workspace? (Skipped once when an admin adopts it.)
      const adopting = this.#adopting.has(workspaceId);
      if (applied.manifest && !adopting) {
        const m = applied.manifest;
        const frozen =
          m.portalId !== this.store.portalId
            ? 'Set up by another portal. Adopt the workspace to let this portal manage it.'
            : m.generation > row.generation
              ? 'The database is older than this workspace (restored from an old backup?).'
              : this.#unaccounted(workspaceId, m.pools.map((p) => p.id));
        if (frozen) {
          this.#save(workspaceId, { status: 'frozen', reason: frozen, checked_at: now.toISOString(), claude_version: applied.claudeVersion ?? row.claude_version });
          return;
        }
      }

      const ctx = { running: state.running, now };
      const fragments = this.providers.flatMap((p) => p.fragments(workspaceId, ctx));
      const version = applied.claudeVersion ?? row.claude_version;
      if (fragments.length === 0 && !applied.manifest) {
        this.#save(workspaceId, { status: 'none', reason: null, checked_at: now.toISOString(), claude_version: version });
        this.#failures.delete(workspaceId);
        return;
      }

      // What's on its way out: files, version folders no longer current, and tombstones. A tombstone
      // goes once no `claude` process older than it still runs, and at once in a stopped workspace (A6).
      const pending = parsePending(row.pending_deletes);
      const carried = settleTombstones(pending.tombstones, { running: state.running, claudeAges: applied.claudeAges, now: now.getTime() });

      const bundle = compile({
        portalId: this.store.portalId!,
        generation: row.generation + 1,
        fragments: [FOUNDATION, ...fragments],
        claudeVersion: version,
        now,
        previous: { env: applied.manifest?.env },
        tombstones: carried,
        running: state.running,
      });
      // Hook lines (secrets A3) are appended once, on a running workspace, and the manifest remembers which;
      // a stopped workspace gets them at its next start.
      const appended = appendedLines(applied.manifest);
      const newLines = state.running ? (bundle.lines ?? []).filter((l) => !appended.some((a) => sameLine(a, l))) : [];
      const keptLines = (bundle.lines ?? []).filter((l) => state.running || appended.some((a) => sameLine(a, l)));
      if (keptLines.length) bundle.manifest.lines = keptLines;
      const wanted = new Set([...bundle.files.map((f) => f.path), MANIFEST_PATH]);
      const current = new Set(bundle.plugins.map((p) => `${p.dir}/`));
      const delivering = new Set(bundle.plugins.map((p) => p.name));
      const appliedPlugins = manifestPlugins(applied.manifest);

      // Files delivered before and no longer wanted: delete after a grace period (or at the next start).
      for (const path of Object.keys(applied.manifest?.files ?? {})) if (!wanted.has(path) && !pending.paths.has(path) && deliverable(path)) pending.paths.set(path, now.getTime());
      // Version folders the catalog no longer points at: kept for sessions that loaded them (retention).
      for (const p of appliedPlugins) {
        const dir = `${pluginDir(p.name, p.treeHash)}/`;
        if (!current.has(dir) && !pending.paths.has(dir)) pending.paths.set(dir, now.getTime());
      }
      for (const path of [...pending.paths.keys()]) if (wanted.has(path) || current.has(path)) pending.paths.delete(path);
      const retired = [...pending.paths].filter(([p]) => p.endsWith('/')).map(([path, since]) => ({ path, since }));
      const due = [
        ...(state.running ? [...pending.paths].filter(([p, since]) => !p.endsWith('/') && (now.getTime() - since >= DELETE_GRACE_MS || why === 'started')).map(([p]) => p) : []),
        ...dueFolders(retired, {
          running: state.running,
          started: why === 'started',
          now: now.getTime(),
          current: delivering,
          revoked: new Set(bundle.revoked),
          graceMs: DELETE_GRACE_MS,
        }),
      ];

      // On a running workspace, anything on disk that isn't what we want gets rewritten; files that
      // differ from what the manifest says we wrote were changed by hand (drift).
      const mismatched = applied.hashes ? bundle.files.filter((f) => applied.hashes![f.path] !== bundle.manifest.files[f.path]) : [];
      const handEdited = applied.hashes
        ? Object.keys(applied.manifest?.files ?? {}).filter((p) => p !== MANIFEST_PATH && wanted.has(p) && applied.hashes![p] !== applied.manifest!.files[p])
        : [];
      // Version folders to write: new ones, and delivered ones whose tree hash no longer matches (drift).
      const inPlace = new Map(appliedPlugins.map((p) => [pluginDir(p.name, p.treeHash), p.treeHash]));
      const changed = bundle.plugins.filter((p) => inPlace.get(p.dir) === p.treeHash && applied.trees && p.dir in applied.trees && applied.trees[p.dir] !== p.treeHash);
      const fresh = bundle.plugins.filter((p) => inPlace.get(p.dir) !== p.treeHash || changed.includes(p));
      const needWrite = adopting || bundle.hash !== row.applied_hash || !applied.manifest || mismatched.length > 0 || fresh.length > 0 || newLines.length > 0;

      let landed = now.getTime();
      if (needWrite) {
        this.#save(workspaceId, { generation: row.generation + 1, desired_hash: bundle.hash, status: 'pending', reason: null }); // recorded before writing (§6.5)
        const stoppedDeletes = state.running ? [] : [...pending.paths.keys()].filter((p) => !p.endsWith('/'));
        await writeBundle(access, name, bundle, { running: state.running, deletes: state.running ? due : stoppedDeletes, plugins: fresh, lines: newLines });
        landed = Date.now();
        for (const p of state.running ? due : []) pending.paths.delete(p);
        this.#exposuresRemoved(workspaceId, state.running ? due : stoppedDeletes, secretPaths, now);
        if (handEdited.length || changed.length) this.#event(workspaceId, 'drift_repaired', { files: handEdited, ...(changed.length ? { plugins: changed.map((p) => p.dir) } : {}) });
        this.#event(workspaceId, 'delivered', {
          why,
          // T-102: the areas a session started before this write has not read (owner names only), for the chat's "Tools changed" sheet.
          areas: changedAreas(applied.manifest, bundle.manifest),
          generation: row.generation + 1,
          running: state.running,
          files: bundle.files.length,
          deleted: due,
          skipped: bundle.skipped,
          ...(fresh.length ? { plugins: fresh.map((p) => p.dir) } : {}),
          ...(bundle.tombstones.length ? { tombstones: bundle.tombstones.map((t) => t.name) } : {}),
        });
        this.#recordExposures(workspaceId, bundle.files, now);
      } else if (due.length) {
        await deleteFiles(access, name, due);
        for (const p of due) pending.paths.delete(p);
        this.#exposuresRemoved(workspaceId, due, secretPaths, now);
        this.#event(workspaceId, 'deleted', { files: due });
      }
      // A secret file whose content became another value (a rotation, an urgent one for pinned workspaces, a
      // revoked value replaced) no longer exposes the old one here: close its record, so "safe to revoke" and
      // the purge of a revoked value can tell (Secrets & env FR17, FR18). Other copies are not this file's concern.
      const overwritten = bundle.files.flatMap((f) => (f.secretRef && secretPaths[f.path] && secretPaths[f.path] !== f.secretRef ? [secretPaths[f.path]!] : []));
      if (overwritten.length && this.store.writable) {
        const close = this.store.db!.prepare('UPDATE exposures SET removed_at = ? WHERE secret_ref = ? AND workspace_id = ? AND removed_at IS NULL');
        for (const ref of new Set(overwritten)) close.run(now.toISOString(), ref, workspaceId);
      }
      for (const f of bundle.files) if (f.secretRef) secretPaths[f.path] = f.secretRef;
      // Tombstones this compile added reached the workspace just now: processes started before may hold the old value.
      const kept = new Set(carried.map(tombstoneKey));
      pending.tombstones = bundle.tombstones.map((t) => (kept.has(tombstoneKey(t)) ? t : { ...t, since: landed }));

      // Secrets FR12: after a write to a running workspace, the workspace user must be able to read what the
      // fragments that ask for it got. A failure is saved with the rest, but without the applied hash, so the
      // next attempt writes and checks again.
      let unreadable: string | null = null;
      if (needWrite && state.running && bundle.readable?.length) {
        try {
          await checkReadable(access, name, bundle.readable);
        } catch (e) {
          if (isTargetUnreachable(e)) throw e; // the tunnel dropped mid-check: pending, not failed
          unreadable = (e as Error).message;
        }
      }

      this.#save(workspaceId, {
        applied_hash: unreadable !== null ? null : needWrite ? bundle.hash : row.applied_hash,
        applied_at: needWrite ? now.toISOString() : row.applied_at,
        status: unreadable !== null ? 'failed' : 'synced',
        reason: unreadable ?? (bundle.skipped.length ? bundle.skipped.map((s) => s.reason).join(' ') : null),
        claude_version: version,
        checked_at: now.toISOString(),
        pending_deletes: serializePending(pending),
        secret_paths: JSON.stringify(Object.fromEntries(Object.entries(secretPaths).filter(([p]) => wanted.has(p) || pending.paths.has(p)))),
      });
      if (unreadable !== null) throw new Error(unreadable);
      const pluginFolders = new Map<string, string[]>();
      for (const dir of [...current, ...pending.paths.keys()]) {
        const plugin = folderPlugin(dir);
        if (plugin) pluginFolders.set(plugin, [...(pluginFolders.get(plugin) ?? []), dir.slice(-13, -1)]);
      }
      // `claudeAges`: seconds each running `claude` process has been up (null when it couldn't be read), so an owner can
      // tell which sessions started before a change (the MCP lockdown's "restart these sessions").
      for (const p of this.providers) p.delivered?.(workspaceId, { ...ctx, delivered: wanted, pluginFolders, claudeAges: applied.claudeAges, landedAt: landed });
      this.#adopting.delete(workspaceId);
      this.#failures.delete(workspaceId);
      // Deletions still waiting for their grace period: come back for them. Folders kept for retention
      // wait for the regular timer instead.
      const graceWaiting = [...pending.paths.keys()].some((p) => !p.endsWith('/') || !delivering.has(folderPlugin(p) ?? ''));
      if (state.running && graceWaiting) setTimeout(() => void this.request(workspaceId, 'grace'), DELETE_GRACE_MS + 1000).unref();
    } catch (e) {
      // An outage is not a failure (targets-connect PRD §12.5): nothing counts towards a backoff, nothing turns failed or frozen, and the
      // target's return asks again.
      if (isTargetUnreachable(e)) {
        this.#save(workspaceId, { status: 'pending', reason: 'Target unreachable', checked_at: now.toISOString() });
        return;
      }
      const failures = (this.#failures.get(workspaceId) ?? 0) + 1;
      this.#failures.set(workspaceId, failures);
      const message = e instanceof CompileError ? `Configuration error: ${e.message}` : (e as Error).message;
      this.#save(workspaceId, { status: 'failed', reason: message, checked_at: now.toISOString() });
      this.#event(workspaceId, 'failed', { why, message, attempt: failures });
    }
  }

  /** A manifest pool the database knows nothing about (no assignment, no removal record) freezes it. */
  #unaccounted(workspaceId: string, poolIds: string[]): string | null {
    const known = new Set(this.providers.flatMap((p) => p.knownPools(workspaceId)));
    const missing = poolIds.filter((id) => !known.has(id));
    return missing.length ? `Assignments missing for ${missing.length} pool(s) delivered here. Adopt the workspace to reset it.` : null;
  }

  /** Secret files deleted (or blanked while stopped) no longer expose their secret here. */
  #exposuresRemoved(workspaceId: string, paths: string[], secretPaths: Record<string, string>, now: Date) {
    const update = this.store.db!.prepare('UPDATE exposures SET removed_at = ? WHERE secret_ref = ? AND workspace_id = ? AND removed_at IS NULL');
    for (const p of paths) if (secretPaths[p]) update.run(now.toISOString(), secretPaths[p], workspaceId);
  }

  #recordExposures(workspaceId: string, files: { secretRef?: string }[], now: Date) {
    const db = this.store.db!;
    const upsert = db.prepare(
      `INSERT INTO exposures (secret_ref, workspace_id, first_delivered_at, last_delivered_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (secret_ref, workspace_id) DO UPDATE SET last_delivered_at = excluded.last_delivered_at, removed_at = NULL`,
    );
    for (const f of files) if (f.secretRef) upsert.run(f.secretRef, workspaceId, now.toISOString(), now.toISOString());
  }

  /** "Adopt workspace": accept what's there as this portal's, then deliver from scratch. */
  async adopt(workspaceId: string) {
    const { target, name } = splitId(workspaceId);
    const access = this.runtimes(target)?.delivery;
    if (!access) throw new Error('This target has no delivery yet.');
    const state = await access.state(name);
    const applied = state.exists ? await readApplied(access, name, state.running) : { manifest: null };
    const generation = Math.max(this.row(workspaceId)?.generation ?? 0, applied.manifest?.generation ?? 0);
    this.#save(workspaceId, { generation, applied_hash: null, status: 'pending', reason: null });
    // Pools listed in the old manifest with no assignment: record removals so their files are cleared safely.
    if (applied.manifest && this.store.writable) {
      const known = new Set(this.providers.flatMap((p) => p.knownPools(workspaceId)));
      const insert = this.store.db!.prepare('INSERT INTO removals (workspace_id, pool_type, pool_id, requested_at) VALUES (?, ?, ?, ?)');
      for (const p of applied.manifest.pools) if (!known.has(p.id)) insert.run(workspaceId, p.type, p.id, new Date().toISOString());
    }
    // Adopting another portal's workspace means overwriting its manifest: allow it once.
    this.#adopting.add(workspaceId);
    this.#event(workspaceId, 'adopted', { generation });
    await this.request(workspaceId, 'adopt');
  }
  readonly #adopting = new Set<string>();
}
