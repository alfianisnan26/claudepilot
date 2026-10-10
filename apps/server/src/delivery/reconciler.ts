import type { Store } from '../store/store.js';
import type { Runtime } from '../workspaces/runtime.js';
import { compile, CompileError } from './compile.js';
import { OUTBOX_PULL } from './outbox.js';
import { NODE, ROOT, MANIFEST_PATH, type Fragment, type PoolType } from './types.js';
import { deleteFiles, readApplied, writeBundle } from './writer.js';

/** How long a file stays after nothing references it, so a session mid-retry never loses it (§6.4). */
const DELETE_GRACE_MS = 30_000;
const RUNNING_EVERY_MS = 60_000;
const STOPPED_EVERY_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

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
  /** After a successful write: advance removals and the like. */
  delivered?(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string> }): void;
}

/** Shared folders every delivery needs; created by the engine because old images lack them (§9). */
const FOUNDATION: Fragment = {
  owner: 'foundation',
  dirs: [
    { path: '/etc/claudepilot', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claudepilot/bin', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claude-code/managed-settings.d', mode: 0o755, uid: ROOT, gid: ROOT },
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
  readonly #listeners = new Set<(workspaceId: string) => void>();
  #stopWatchers: (() => void)[] = [];
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
      this.#save(workspaceId, { status: 'unsupported', reason: 'Delivery to this target comes with Kubernetes support (F3).', checked_at: now.toISOString() });
      return;
    }

    try {
      const state = await access.state(name);
      if (!state.exists) {
        this.#save(workspaceId, { status: 'pending', reason: 'Waiting for the workspace to exist.', checked_at: now.toISOString() });
        return;
      }
      const row = this.row(workspaceId) ?? ({ generation: 0, applied_hash: null, pending_deletes: '[]', secret_paths: '{}' } as DeliveryRow);
      const secretPaths = JSON.parse(row.secret_paths || '{}') as Record<string, string>;
      const applied = await readApplied(access, name, state.running);

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

      const bundle = compile({ portalId: this.store.portalId!, generation: row.generation + 1, fragments: [FOUNDATION, ...fragments], claudeVersion: version, now });
      const wanted = new Set([...bundle.files.map((f) => f.path), MANIFEST_PATH]);

      // Files delivered before and no longer wanted: delete after a grace period (or at the next start).
      const pending = new Map<string, number>((JSON.parse(row.pending_deletes) as { path: string; since: number }[]).map((p) => [p.path, p.since]));
      for (const path of Object.keys(applied.manifest?.files ?? {})) if (!wanted.has(path) && !pending.has(path)) pending.set(path, now.getTime());
      for (const path of [...pending.keys()]) if (wanted.has(path)) pending.delete(path);
      const due = state.running
        ? [...pending].filter(([, since]) => now.getTime() - since >= DELETE_GRACE_MS || why === 'started').map(([p]) => p)
        : [];

      // On a running workspace, anything on disk that isn't what we want gets rewritten; files that
      // differ from what the manifest says we wrote were changed by hand (drift).
      const mismatched = applied.hashes ? bundle.files.filter((f) => applied.hashes![f.path] !== bundle.manifest.files[f.path]) : [];
      const handEdited = applied.hashes
        ? Object.keys(applied.manifest?.files ?? {}).filter((p) => p !== MANIFEST_PATH && wanted.has(p) && applied.hashes![p] !== applied.manifest!.files[p])
        : [];
      const needWrite = adopting || bundle.hash !== row.applied_hash || !applied.manifest || mismatched.length > 0;

      if (needWrite) {
        this.#save(workspaceId, { generation: row.generation + 1, desired_hash: bundle.hash, status: 'pending', reason: null }); // recorded before writing (§6.5)
        const stoppedDeletes = state.running ? [] : [...pending.keys()];
        await writeBundle(access, name, bundle, { running: state.running, deletes: state.running ? due : stoppedDeletes });
        for (const p of state.running ? due : []) pending.delete(p);
        this.#exposuresRemoved(workspaceId, state.running ? due : stoppedDeletes, secretPaths, now);
        if (handEdited.length) this.#event(workspaceId, 'drift_repaired', { files: handEdited });
        this.#event(workspaceId, 'delivered', { why, generation: row.generation + 1, running: state.running, files: bundle.files.length, deleted: due, skipped: bundle.skipped });
        this.#recordExposures(workspaceId, bundle.files, now);
      } else if (due.length) {
        await deleteFiles(access, name, due);
        for (const p of due) pending.delete(p);
        this.#exposuresRemoved(workspaceId, due, secretPaths, now);
        this.#event(workspaceId, 'deleted', { files: due });
      }
      for (const f of bundle.files) if (f.secretRef) secretPaths[f.path] = f.secretRef;

      this.#save(workspaceId, {
        applied_hash: needWrite ? bundle.hash : row.applied_hash,
        applied_at: needWrite ? now.toISOString() : row.applied_at,
        status: 'synced',
        reason: bundle.skipped.length ? bundle.skipped.map((s) => s.reason).join(' ') : null,
        claude_version: version,
        checked_at: now.toISOString(),
        pending_deletes: JSON.stringify([...pending].map(([path, since]) => ({ path, since }))),
        secret_paths: JSON.stringify(Object.fromEntries(Object.entries(secretPaths).filter(([p]) => wanted.has(p) || pending.has(p)))),
      });
      for (const p of this.providers) p.delivered?.(workspaceId, { ...ctx, delivered: wanted });
      this.#adopting.delete(workspaceId);
      this.#failures.delete(workspaceId);
      // Deletions still waiting for their grace period: come back for them.
      if (state.running && pending.size) setTimeout(() => void this.request(workspaceId, 'grace'), DELETE_GRACE_MS + 1000).unref();
    } catch (e) {
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
