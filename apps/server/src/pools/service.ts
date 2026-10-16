import { AppError, newId } from '@isnanme/core';
import {
  MULTI_POOL_TYPES,
  POOL_NAME_MAX,
  POOL_REDACTED,
  type AssignPoolResult,
  type MultiPoolType as WireMultiPoolType,
  type PoolDetail,
  type PoolPreview,
  type PoolPreviewRequest,
  type PoolRequest,
  type PoolRevisionInfo,
  type PoolStatus,
  type PoolSummary,
  type SetWorkspacePoolsResult,
  type WorkspacePoolAssignment,
} from '@portal/contracts';
import { compile, CompileError } from '../delivery/compile.js';
import type { FragmentProvider, Reconciler } from '../delivery/reconciler.js';
import type { DeliveredDir, DeliveredFile } from '../delivery/types.js';
import { isWorkspaceId } from '../names.js';
import type { Store } from '../store/store.js';
import type { AssignedPool, MultiPoolType, PoolKind } from './kinds.js';
import { KindProvider } from './provider.js';

/** Fails to compile when the server's union (kinds.ts) and the wire's (contracts) drift apart. */
const SAME_TYPES: [MultiPoolType, WireMultiPoolType] extends [WireMultiPoolType, MultiPoolType] ? true : never = true;
void SAME_TYPES;

interface PoolRow {
  id: string;
  type: string;
  name: string;
  description: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  pool_id: string;
  revision: number;
  content: string;
  note: string;
  created_at: string;
  status: PoolStatus;
  rollout_paused_at: string | null;
  rollout_paused_reason: string | null;
}

interface AssignmentRow {
  workspace_id: string;
  pool_id: string;
  pool_type: string;
  pinned_revision: number | null;
  assigned_at: string;
  options: string;
  delivered_revision: number | null;
}

/** What `#effective` needs from an assignment. */
type Following = Pick<AssignmentRow, 'pool_id' | 'pinned_revision' | 'delivered_revision'>;

const DESCRIPTION_MAX = 300;
const NOTE_MAX = 500;
const REASON_MAX = 300;
/** A bulk assignment covers a page of workspaces, not the whole fleet by accident. */
const BULK_MAX = 500;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const gone = () => new AppError('NOT_FOUND', 'That pool no longer exists.');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const description = (input: unknown) => String(input ?? '').trim().slice(0, DESCRIPTION_MAX);
const note = (input: unknown) => (typeof input === 'string' ? input.trim().slice(0, NOTE_MAX) : '');

/** `<target>/<name>` of plain names, as the workspace routes build it (names.ts): never an id that could end up in a Docker URL (QA-032). */
function workspaceIdOf(input: unknown, field = 'workspaceId'): string {
  if (!isWorkspaceId(input)) throw invalid(field, 'Pick a workspace.');
  return input;
}

/**
 * Multi-assignment pools (foundation PRD §3, §5): secrets & env, skillsets and MCP sets, on the
 * foundation's `pools`, `pool_revisions` and `assignments` tables. Each type plugs in a `PoolKind`
 * for what its content is and delivers; the service owns the rest, the same way for every type:
 *
 * - every content change is a new immutable revision, whose status (Skillset PRD §18 A3) comes from
 *   the kind; `pools.current_revision` moves only to deliverable revisions;
 * - a paused rollout (FR23) keeps the current revision from reaching workspaces it hasn't reached;
 * - assignments may pin a revision and carry per-workspace options (A4); removing one writes a
 *   removal record, which keeps the manifest's pool accounted for until it's gone (§6.5);
 * - every change asks the reconciler to deliver to the workspaces it affects, and tells live pages.
 */
export class PoolService {
  /** Set once the reconciler exists; every change asks it to deliver to the workspaces affected. */
  reconciler: Pick<Reconciler, 'request'> | null = null;
  /** Pools or assignments changed, for live pages (the `pools` topic). */
  onChange: () => void = () => {};
  readonly #kinds = new Map<MultiPoolType, PoolKind>();
  readonly #providers = new Map<MultiPoolType, KindProvider>();

  constructor(
    private readonly store: Store,
    /** `providers`: the reconciler's provider list, which each registered kind's provider joins. */
    private readonly opts: { providers?: FragmentProvider[] } = {},
  ) {}

  /* ---------- Kinds ---------- */

  /**
   * Adds a pool type. Its fragment provider joins the reconciler's providers, so register every kind
   * before the reconciler starts: a manifest naming a pool of a type nobody registered freezes that
   * workspace (foundation PRD §6.5), which is right for a type that's gone, not for one that's late.
   */
  register<C>(kind: PoolKind<C>): void {
    if (this.#kinds.has(kind.type)) throw new Error(`The ${kind.type} pool type is already registered.`);
    const k = kind as unknown as PoolKind;
    const provider = new KindProvider(k, this, this.store);
    this.#kinds.set(kind.type, k);
    this.#providers.set(kind.type, provider);
    this.opts.providers?.push(provider);
  }

  /** The kind for `type`; NOT_FOUND for a type nobody registered (the routes' 404). */
  kind(type: string): PoolKind {
    const kind = this.#kinds.get(type as MultiPoolType);
    if (!kind) throw new AppError('NOT_FOUND', 'No such pool type.');
    return kind;
  }

  /** Registered types, in a fixed order. */
  types(): MultiPoolType[] {
    return MULTI_POOL_TYPES.filter((t) => this.#kinds.has(t));
  }

  /** A pool's type, or null for an unknown pool or one whose type isn't registered. */
  typeOf(id: string): MultiPoolType | null {
    const row = this.store.db?.prepare('SELECT type FROM pools WHERE id = ?').get(id) as { type: string } | undefined;
    return row && this.#kinds.has(row.type as MultiPoolType) ? (row.type as MultiPoolType) : null;
  }

  /* ---------- Storage helpers ---------- */

  get #db() {
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return db;
  }

  #tx<T>(fn: () => T): T {
    const db = this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  #pool(id: string): PoolRow {
    const row = this.store.db?.prepare('SELECT * FROM pools WHERE id = ?').get(id) as PoolRow | undefined;
    if (!row || !this.#kinds.has(row.type as MultiPoolType)) throw gone();
    return row;
  }

  #revision(poolId: string, revision: number): RevisionRow | undefined {
    return this.store.db?.prepare('SELECT * FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(poolId, revision) as RevisionRow | undefined;
  }

  #latest(poolId: string): RevisionRow | undefined {
    return this.store.db?.prepare('SELECT * FROM pool_revisions WHERE pool_id = ? ORDER BY revision DESC LIMIT 1').get(poolId) as RevisionRow | undefined;
  }

  #name(type: string, input: unknown, exceptId?: string): string {
    const name = typeof input === 'string' ? input.trim() : '';
    if (!name) throw invalid('name', 'Give it a name.');
    if (name.length > POOL_NAME_MAX) throw invalid('name', `Use at most ${POOL_NAME_MAX} characters.`);
    const clash = this.#db.prepare('SELECT id FROM pools WHERE type = ? AND name = ? COLLATE NOCASE').get(type, name) as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new AppError('CONFLICT', `A pool named “${name}” already exists.`, { details: { name: 'Already used.' } });
    return name;
  }

  /**
   * The revision a workspace gets from one assignment: its pin; otherwise the current revision, unless
   * that revision's rollout is paused and hasn't reached this workspace, which then keeps the newest
   * deliverable revision before it (Skillset PRD A3, FR23). Null when there's nothing to give it.
   */
  #effective(a: Following, current: number): number | null {
    if (a.pinned_revision !== null) return this.#revision(a.pool_id, a.pinned_revision)?.status === 'deliverable' ? a.pinned_revision : null;
    const rev = current ? this.#revision(a.pool_id, current) : undefined;
    if (!rev) return null;
    if (!rev.rollout_paused_at || a.delivered_revision === current) return current;
    const before = this.store.db!
      .prepare("SELECT max(revision) AS r FROM pool_revisions WHERE pool_id = ? AND revision < ? AND status = 'deliverable'")
      .get(a.pool_id, current) as { r: number | null };
    return before.r ?? null;
  }

  /** Asks for delivery to the pool's workspaces: those following its current revision, or all of them. */
  #deliver(poolId: string, why: string, all = false) {
    const rows = this.store.db!
      .prepare(`SELECT workspace_id FROM assignments WHERE pool_id = ?${all ? '' : ' AND pinned_revision IS NULL'}`)
      .all(poolId) as { workspace_id: string }[];
    for (const r of rows) void this.reconciler?.request(r.workspace_id, why, { changed: true });
  }

  /**
   * Asks for delivery to every workspace that has the pool now, pinned ones included, at once and unpaced: for a
   * change that must reach them whatever revision they hold (an urgent rotation, a revoked secret value).
   */
  redeliver(poolId: string, why: string): number {
    this.#pool(poolId);
    const rows = this.store.db!.prepare('SELECT workspace_id FROM assignments WHERE pool_id = ?').all(poolId) as { workspace_id: string }[];
    for (const r of rows) void this.reconciler?.request(r.workspace_id, why, { changed: true });
    return rows.length;
  }

  /** Stores a new revision. Deliverable and not held back, it becomes the current one. */
  #addRevision(
    kind: PoolKind,
    poolId: string,
    revision: number,
    content: unknown,
    req: Pick<Partial<PoolRequest>, 'note' | 'draft' | 'hold'>,
    current: unknown,
    now: string,
  ): { madeCurrent: boolean } {
    const json = JSON.stringify(content);
    if (json === undefined) throw new Error(`${kind.type}: parse returned no content`);
    const status: PoolStatus = req.draft === true ? 'draft' : (kind.review?.(content, current) ?? 'deliverable');
    if (status !== 'draft' && status !== 'waiting_review' && status !== 'deliverable') throw new Error(`${kind.type}: review returned ${String(status)}`);
    this.#db
      .prepare('INSERT INTO pool_revisions (pool_id, revision, content, note, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(poolId, revision, json, note(req.note), now, status);
    const madeCurrent = status === 'deliverable' && req.hold !== true;
    if (madeCurrent) this.#db.prepare('UPDATE pools SET current_revision = ?, updated_at = ? WHERE id = ?').run(revision, now, poolId);
    return { madeCurrent };
  }

  /** Per-workspace options through the kind; without `parseOptions` a type has none. */
  #options(kind: PoolKind, input: unknown, content: unknown): Record<string, unknown> {
    if (kind.parseOptions) return kind.parseOptions(input, content);
    if (input === undefined || (isObject(input) && Object.keys(input).length === 0)) return {};
    throw invalid('options', 'This pool type has no per-workspace options.');
  }

  #pin(poolId: string, input: unknown): number | null {
    if (input === null) return null;
    if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) throw invalid('pinnedRevision', 'Pick a revision.');
    const rev = this.#revision(poolId, input);
    if (!rev) throw invalid('pinnedRevision', `There’s no revision ${input}.`);
    if (rev.status !== 'deliverable') throw invalid('pinnedRevision', `Revision ${input} isn’t deliverable yet.`);
    // A revision holding something that was revoked can't be pinned to (Secrets & env FR18).
    const why = this.kind(this.#pool(poolId).type).unusable?.(JSON.parse(rev.content));
    if (why) throw invalid('pinnedRevision', `Revision ${input} can’t be pinned: ${why}`);
    return input;
  }

  /* ---------- Pools ---------- */

  #summary(p: PoolRow): PoolSummary {
    const kind = this.kind(p.type);
    const latest = this.#latest(p.id);
    const current = p.current_revision ? this.#revision(p.id, p.current_revision) : undefined;
    const used = this.store.db!.prepare('SELECT count(*) AS n FROM assignments WHERE pool_id = ?').get(p.id) as { n: number };
    return {
      id: p.id,
      type: p.type as MultiPoolType,
      name: p.name,
      description: p.description,
      revision: p.current_revision,
      latestRevision: latest?.revision ?? 0,
      status: latest?.status ?? 'draft',
      rolloutPaused: current?.rollout_paused_at ? { at: current.rollout_paused_at, reason: current.rollout_paused_reason ?? '' } : null,
      workspaces: Number(used.n),
      content: latest ? kind.view(JSON.parse(latest.content)) : null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }

  /** The type's pools, oldest first, each with its current revision, status, rollout pause and use. */
  list(type: string): PoolSummary[] {
    this.kind(type);
    const rows = this.store.db?.prepare('SELECT * FROM pools WHERE type = ? ORDER BY created_at, name').all(type) as PoolRow[] | undefined;
    return (rows ?? []).map((r) => this.#summary(r));
  }

  /** One pool with its revision history (newest first) and where it's assigned. */
  get(id: string): PoolDetail {
    const p = this.#pool(id);
    const db = this.store.db!;
    const revisions = (db.prepare('SELECT * FROM pool_revisions WHERE pool_id = ? ORDER BY revision DESC').all(id) as unknown as RevisionRow[]).map(
      (r): PoolRevisionInfo => ({
        revision: r.revision,
        status: r.status,
        note: r.note,
        createdAt: r.created_at,
        current: r.revision === p.current_revision,
        rolloutPaused: r.rollout_paused_at ? { at: r.rollout_paused_at, reason: r.rollout_paused_reason ?? '' } : null,
      }),
    );
    const assignedTo = (db.prepare('SELECT * FROM assignments WHERE pool_id = ? ORDER BY assigned_at').all(id) as unknown as AssignmentRow[]).map((a) => ({
      workspaceId: a.workspace_id,
      pinnedRevision: a.pinned_revision,
      revision: this.#effective(a, p.current_revision) ?? 0,
      deliveredRevision: a.delivered_revision,
    }));
    return { ...this.#summary(p), revisions, assignedTo };
  }

  create(type: string, req: Partial<PoolRequest>): PoolSummary {
    const kind = this.kind(type);
    const id = newId();
    const now = new Date().toISOString();
    this.#tx(() => {
      const name = this.#name(type, req.name);
      // The row comes first, so side data that `parse` stores can refer to the pool.
      this.#db
        .prepare('INSERT INTO pools (id, type, name, description, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(id, type, name, description(req.description), now, now);
      const content = kind.parse(req.content, null, { poolId: id, revision: 1 });
      this.#addRevision(kind, id, 1, content, req, null, now);
    });
    this.onChange();
    return this.#summary(this.#pool(id));
  }

  /**
   * Name and description change in place; content makes a new revision (unless it comes out the same),
   * continuing from the newest one. Workspaces following the pool get it once it's current.
   */
  update(id: string, req: Partial<PoolRequest>): PoolSummary {
    const p = this.#pool(id);
    const kind = this.kind(p.type);
    // The editor says which revision it opened: a pool that has moved on since is not overwritten.
    if (req.baseRevision !== undefined) {
      if (typeof req.baseRevision !== 'number' || !Number.isInteger(req.baseRevision) || req.baseRevision < 0) throw invalid('baseRevision', 'Send the revision you opened.');
      const newest = this.#latest(id)?.revision ?? 0;
      if (req.baseRevision !== newest) throw new AppError('CONFLICT', `${p.name} changed since you opened it (r${newest}). Reload to see it.`);
    }
    const now = new Date().toISOString();
    let madeCurrent = false;
    let renamed = false;
    this.#tx(() => {
      const name = req.name === undefined ? p.name : this.#name(p.type, req.name, id);
      renamed = name !== p.name;
      if (req.content !== undefined) {
        const latest = this.#latest(id);
        const revision = (latest?.revision ?? 0) + 1;
        const content = kind.parse(req.content, latest ? JSON.parse(latest.content) : null, { poolId: id, revision });
        const same = !!latest && JSON.stringify(content) === latest.content && (latest.status === 'draft') === (req.draft === true);
        if (!same) {
          const current = p.current_revision ? this.#revision(id, p.current_revision) : undefined;
          madeCurrent = this.#addRevision(kind, id, revision, content, req, current ? JSON.parse(current.content) : null, now).madeCurrent;
        }
      }
      this.#db
        .prepare('UPDATE pools SET name = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(name, req.description === undefined ? p.description : description(req.description), now, id);
    });
    // Kinds see the name (PoolRef), so a rename reaches pinned workspaces too.
    if (madeCurrent || renamed) this.#deliver(id, madeCurrent ? 'pool changed' : 'pool renamed', renamed);
    this.onChange();
    return this.#summary(this.#pool(id));
  }

  /**
   * Releases a revision waiting for review (or a draft): it becomes deliverable, and current when it's
   * newer than the current one (Skillset FR14: "becomes current once every skill is approved"). The
   * kind may refuse. Approving a revision that's already deliverable changes nothing.
   */
  approve(id: string, revision: number): PoolSummary {
    const p = this.#pool(id);
    const rev = this.#revision(id, revision);
    if (!rev) throw new AppError('NOT_FOUND', `There’s no revision ${revision}.`);
    if (rev.status === 'deliverable') return this.#summary(p);
    this.kind(p.type).approve?.(JSON.parse(rev.content));
    const moves = revision > p.current_revision;
    const now = new Date().toISOString();
    this.#tx(() => {
      this.#db.prepare("UPDATE pool_revisions SET status = 'deliverable' WHERE pool_id = ? AND revision = ?").run(id, revision);
      if (moves) this.#db.prepare('UPDATE pools SET current_revision = ?, updated_at = ? WHERE id = ?').run(revision, now, id);
    });
    if (moves) this.#deliver(id, 'revision approved');
    this.onChange();
    return this.#summary(this.#pool(id));
  }

  /**
   * Makes a deliverable revision the current one: a roll back, or a revision held back for a trial (MCP set FR4).
   *
   * A roll back of a kind that keeps values outside its revisions (Secrets & env FR18) doesn't point at the
   * old revision: it publishes a new one with the old content, whose secrets keep their CURRENT versions
   * (`restoreSecretVersions` brings back the old ones instead). Otherwise a token rotated away after a
   * leak would be delivered again by a roll back. Such a roll back is refused when it would drop or clash
   * with names others use, as an edit would be.
   */
  makeCurrent(id: string, revision: number, opts: { restoreSecretVersions?: boolean } = {}): PoolSummary {
    const p = this.#pool(id);
    const rev = this.#revision(id, revision);
    if (!rev) throw new AppError('NOT_FOUND', `There’s no revision ${revision}.`);
    if (rev.status !== 'deliverable') throw new AppError('CONFLICT', `Revision ${revision} isn’t deliverable yet.`);
    if (p.current_revision === revision) return this.#summary(p);
    const rollingBack = revision < p.current_revision;
    const kind = this.kind(p.type);
    const now = new Date().toISOString();
    const currentRow = p.current_revision ? this.#revision(id, p.current_revision) : undefined;
    this.#tx(() => {
      const target: unknown = JSON.parse(rev.content);
      const current: unknown = currentRow ? JSON.parse(currentRow.content) : null;
      const next = rollingBack && kind.rollback ? kind.rollback(target, current, { poolId: id, restoreSecrets: opts.restoreSecretVersions === true }) : target;
      kind.beforeCurrent?.(next, current, id);
      if (JSON.stringify(next) === rev.content) {
        // Nothing in it moves with time (or it was asked for exactly as it was): pointing at the revision is the same thing.
        this.#db.prepare('UPDATE pools SET current_revision = ?, updated_at = ? WHERE id = ?').run(revision, now, id);
        return;
      }
      const n = (this.#latest(id)?.revision ?? 0) + 1;
      const how = opts.restoreSecretVersions === true ? 'with its secret versions' : 'secrets keep their current versions';
      const { madeCurrent } = this.#addRevision(kind, id, n, next, { note: `Rolled back to r${revision} (${how})` }, current, now);
      // A kind that wants a review first holds the roll back for it, like any other change.
      if (!madeCurrent) throw new AppError('CONFLICT', 'That roll back needs a review first: it was saved as a new revision waiting for one.');
    });
    this.#deliver(id, rollingBack ? 'rolled back' : 'revision made current');
    this.onChange();
    return this.#summary(this.#pool(id));
  }

  /**
   * Pauses the current revision's rollout (Skillset FR23): workspaces it reached keep it, the rest keep
   * the revision before it, and newly assigned ones get that one too. Pinned workspaces are unaffected.
   */
  pauseRollout(id: string, reason?: unknown): PoolSummary {
    const p = this.#pool(id);
    if (!p.current_revision) throw new AppError('CONFLICT', 'Nothing is rolling out yet.');
    const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, REASON_MAX) : 'Paused by an admin.';
    const changed = this.#db
      .prepare('UPDATE pool_revisions SET rollout_paused_at = ?, rollout_paused_reason = ? WHERE pool_id = ? AND revision = ? AND rollout_paused_at IS NULL')
      .run(new Date().toISOString(), why, id, p.current_revision).changes;
    if (changed) {
      this.#deliver(id, 'rollout paused');
      this.onChange();
    }
    return this.#summary(this.#pool(id));
  }

  resumeRollout(id: string): PoolSummary {
    this.#pool(id);
    const changed = this.#db
      .prepare('UPDATE pool_revisions SET rollout_paused_at = NULL, rollout_paused_reason = NULL WHERE pool_id = ? AND rollout_paused_at IS NOT NULL')
      .run(id).changes;
    if (changed) {
      this.#deliver(id, 'rollout resumed');
      this.onChange();
    }
    return this.#summary(this.#pool(id));
  }

  /** A new pool with the newest revision's content as its first revision; write-only values carry over through `parse`. */
  duplicate(id: string, name: unknown): PoolSummary {
    const src = this.#pool(id);
    const kind = this.kind(src.type);
    const latest = this.#latest(id);
    if (!latest) throw gone();
    const copyId = newId();
    const now = new Date().toISOString();
    this.#tx(() => {
      const copyName = this.#name(src.type, name);
      this.#db
        .prepare('INSERT INTO pools (id, type, name, description, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(copyId, src.type, copyName, src.description, now, now);
      const source: unknown = JSON.parse(latest.content);
      const content = kind.parse(kind.view(source), source, { poolId: copyId, revision: 1 });
      this.#addRevision(kind, copyId, 1, content, { note: `Copy of ${src.name} r${latest.revision}` }, null, now);
    });
    this.onChange();
    return this.#summary(this.#pool(copyId));
  }

  /**
   * Refused while any workspace has the pool. Removal records may outlive it: they name the pool by ID
   * only, and keep the reconciler accounting for it until its files are gone.
   */
  delete(id: string): void {
    const p = this.#pool(id);
    const used = this.#db.prepare('SELECT count(*) AS n FROM assignments WHERE pool_id = ?').get(id) as { n: number };
    if (used.n > 0) throw new AppError('CONFLICT', `In use by ${plural(Number(used.n), 'workspace')}. Remove it from them first.`);
    this.kind(p.type).beforeUnassign?.('', id);
    this.#db.prepare('DELETE FROM pools WHERE id = ?').run(id);
    this.onChange();
  }

  /**
   * Deletes a pool that workspaces still have (Secrets & env FR19): refused while another pool references it (the
   * kind says so), otherwise it is taken out of each workspace, which writes the removal records that clear its
   * files there, and then deleted. Returns the workspaces it was in and what the removals warn about.
   */
  deleteWithUnassign(id: string): { workspaces: string[]; warnings: string[] } {
    const p = this.#pool(id);
    const kind = this.kind(p.type);
    kind.beforeUnassign?.('', id);
    const rows = this.#db.prepare('SELECT workspace_id FROM assignments WHERE pool_id = ? ORDER BY workspace_id').all(id) as { workspace_id: string }[];
    const workspaces: string[] = [];
    const warnings: string[] = [];
    for (const { workspace_id: ws } of rows) {
      const keep = this.#rows(ws, p.type).filter((r) => r.pool_id !== id).map((r) => ({ poolId: r.pool_id }));
      warnings.push(...this.setAssignments(ws, p.type, keep).warnings);
      workspaces.push(ws);
    }
    this.delete(id);
    return { workspaces, warnings: [...new Set(warnings)] };
  }

  /* ---------- Assignment ---------- */

  #rows(workspaceId: string, type: string): (AssignmentRow & { name: string; current_revision: number })[] {
    const rows = this.store.db
      ?.prepare(
        `SELECT a.*, p.name, p.current_revision FROM assignments a JOIN pools p ON p.id = a.pool_id
         WHERE a.workspace_id = ? AND a.pool_type = ? ORDER BY a.assigned_at, p.name`,
      )
      .all(workspaceId, type) as (AssignmentRow & { name: string; current_revision: number })[] | undefined;
    return rows ?? [];
  }

  #assignmentsOf(workspaceId: string, type: MultiPoolType): WorkspacePoolAssignment[] {
    const assigned = this.#rows(workspaceId, type).map(
      (r): WorkspacePoolAssignment => ({
        type,
        poolId: r.pool_id,
        poolName: r.name,
        revision: this.#effective(r, r.current_revision) ?? 0,
        currentRevision: r.current_revision,
        pinnedRevision: r.pinned_revision,
        options: JSON.parse(r.options) as Record<string, unknown>,
        state: 'assigned',
        assignedAt: r.assigned_at,
      }),
    );
    const removing = (
      (this.store.db
        ?.prepare(
          `SELECT r.pool_id, max(r.requested_at) AS requested_at, p.name FROM removals r LEFT JOIN pools p ON p.id = r.pool_id
           WHERE r.workspace_id = ? AND r.pool_type = ? GROUP BY r.pool_id ORDER BY requested_at`,
        )
        .all(workspaceId, type) ?? []) as { pool_id: string; requested_at: string; name: string | null }[]
    )
      .filter((r) => !assigned.some((a) => a.poolId === r.pool_id))
      .map(
        (r): WorkspacePoolAssignment => ({
          type,
          poolId: r.pool_id,
          poolName: r.name ?? 'Removed pool',
          revision: 0,
          currentRevision: 0,
          pinnedRevision: null,
          options: {},
          state: 'removing',
          assignedAt: r.requested_at,
        }),
      );
    return [...assigned, ...removing];
  }

  /** Every pool of the registered types the workspace has, or is losing (`removing`). */
  assignmentsFor(workspaceId: string): WorkspacePoolAssignment[] {
    return this.types().flatMap((t) => this.#assignmentsOf(workspaceId, t));
  }

  /**
   * Replaces the workspace's pools of one type with `items`. Removed pools get a removal record (the
   * kind may refuse or warn first), added ones an assignment, and a pending removal of a pool added
   * back is superseded. For a pool it keeps, an omitted pin or options keep what's there.
   */
  setAssignments(workspaceId: string, type: string, items: unknown): SetWorkspacePoolsResult {
    const kind = this.kind(type);
    workspaceIdOf(workspaceId);
    if (!Array.isArray(items)) throw invalid('items', 'Send the list of pools.');
    const existing = new Map(this.#rows(workspaceId, type).map((r) => [r.pool_id, r]));
    const wanted = new Map<string, { pinned: number | null; options: string }>();
    for (const item of items as unknown[]) {
      if (!isObject(item) || typeof item.poolId !== 'string') throw invalid('items', 'Each item needs a pool.');
      const poolId = item.poolId;
      if (wanted.has(poolId)) throw invalid('items', 'A pool is listed twice.');
      const pool = this.store.db?.prepare('SELECT * FROM pools WHERE id = ?').get(poolId) as PoolRow | undefined;
      if (!pool || pool.type !== type) throw invalid('items', 'One of the pools no longer exists.');
      const had = existing.get(poolId);
      const pinned = item.pinnedRevision === undefined ? (had?.pinned_revision ?? null) : this.#pin(poolId, item.pinnedRevision);
      let options = had?.options ?? '{}';
      if (item.options !== undefined || !had) {
        const target = this.#revision(poolId, pinned ?? pool.current_revision) ?? this.#latest(poolId);
        options = JSON.stringify(this.#options(kind, item.options ?? {}, target ? JSON.parse(target.content) : null));
      }
      wanted.set(poolId, { pinned, options });
    }

    if (kind.single && wanted.size > 1) throw invalid('items', `A workspace has one ${type} pool: pick one.`);
    const removed = [...existing.keys()].filter((id) => !wanted.has(id));
    const added = [...wanted].filter(([id]) => !existing.has(id));
    const changed = [...wanted].filter(([id, w]) => {
      const had = existing.get(id);
      return !!had && (had.pinned_revision !== w.pinned || had.options !== w.options);
    });
    if (added.length) kind.beforeAssign?.(workspaceId, added.map(([id]) => id), [...wanted.keys()].filter((id) => existing.has(id)));
    const warnings = removed.flatMap((poolId) => kind.beforeUnassign?.(workspaceId, poolId) ?? []);
    if (!removed.length && !added.length && !changed.length) return { assignments: this.#assignmentsOf(workspaceId, kind.type), warnings };

    const now = new Date().toISOString();
    this.#tx(() => {
      const db = this.#db;
      for (const poolId of removed) {
        db.prepare('DELETE FROM assignments WHERE workspace_id = ? AND pool_id = ?').run(workspaceId, poolId);
        db.prepare('INSERT INTO removals (workspace_id, pool_type, pool_id, requested_at) VALUES (?, ?, ?, ?)').run(workspaceId, type, poolId, now);
      }
      for (const [poolId, w] of added) {
        db.prepare('INSERT INTO assignments (workspace_id, pool_id, pool_type, pinned_revision, assigned_at, options) VALUES (?, ?, ?, ?, ?, ?)').run(
          workspaceId,
          poolId,
          type,
          w.pinned,
          now,
          w.options,
        );
        db.prepare('DELETE FROM removals WHERE workspace_id = ? AND pool_type = ? AND pool_id = ?').run(workspaceId, type, poolId);
      }
      for (const [poolId, w] of changed)
        db.prepare('UPDATE assignments SET pinned_revision = ?, options = ? WHERE workspace_id = ? AND pool_id = ?').run(w.pinned, w.options, workspaceId, poolId);
    });
    void this.reconciler?.request(workspaceId, 'pools changed', { changed: true });
    this.onChange();
    return { assignments: this.#assignmentsOf(workspaceId, kind.type), warnings };
  }

  /** Bulk assignment (foundation PRD §10): adds the pool, following its current revision, to each workspace that lacks it. */
  assignToMany(poolId: string, workspaceIds: unknown): AssignPoolResult {
    const p = this.#pool(poolId);
    const kind = this.kind(p.type);
    if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) throw invalid('workspaceIds', 'Pick at least one workspace.');
    if (workspaceIds.length > BULK_MAX) throw invalid('workspaceIds', `Pick at most ${BULK_MAX} workspaces at a time.`);
    const ids = [...new Set(workspaceIds.map((id) => workspaceIdOf(id, 'workspaceIds')))];
    const target = this.#revision(poolId, p.current_revision) ?? this.#latest(poolId);
    const options = JSON.stringify(this.#options(kind, {}, target ? JSON.parse(target.content) : null));
    const result: AssignPoolResult = { assigned: [], already: [] };
    const replaced: string[] = [];
    const now = new Date().toISOString();
    this.#tx(() => {
      const db = this.#db;
      for (const ws of ids) {
        if (db.prepare('SELECT 1 FROM assignments WHERE workspace_id = ? AND pool_id = ?').get(ws, poolId)) {
          result.already.push(ws);
          continue;
        }
        const had = (db.prepare('SELECT pool_id FROM assignments WHERE workspace_id = ? AND pool_type = ?').all(ws, p.type) as { pool_id: string }[]).map((r) => r.pool_id);
        // A one-per-workspace type swaps its pool: the old one leaves with a removal record, like any unassign.
        const keeping = kind.single ? [] : had;
        if (kind.beforeAssign) kind.beforeAssign(ws, [poolId], keeping);
        if (kind.single && had.length) {
          for (const old of had) {
            kind.beforeUnassign?.(ws, old);
            db.prepare('DELETE FROM assignments WHERE workspace_id = ? AND pool_id = ?').run(ws, old);
            db.prepare('INSERT INTO removals (workspace_id, pool_type, pool_id, requested_at) VALUES (?, ?, ?, ?)').run(ws, p.type, old, now);
          }
          replaced.push(ws);
        }
        db.prepare('INSERT INTO assignments (workspace_id, pool_id, pool_type, pinned_revision, assigned_at, options) VALUES (?, ?, ?, NULL, ?, ?)').run(ws, poolId, p.type, now, options);
        db.prepare('DELETE FROM removals WHERE workspace_id = ? AND pool_type = ? AND pool_id = ?').run(ws, p.type, poolId);
        result.assigned.push(ws);
      }
    });
    for (const ws of result.assigned) void this.reconciler?.request(ws, 'pool assigned', { changed: true });
    if (result.assigned.length) this.onChange();
    return replaced.length ? { ...result, replaced } : result;
  }

  /**
   * The workspace's pools of one type, each at the revision it gets, with content and options: what
   * `fragments` receives, and how one kind looks at another's pools (an MCP set asking which secret
   * names the workspace has). Pools with nothing deliverable for it yet are left out.
   */
  assignedPools<C = unknown>(workspaceId: string, type: MultiPoolType): AssignedPool<C>[] {
    const out: AssignedPool<C>[] = [];
    for (const r of this.#rows(workspaceId, type)) {
      const revision = this.#effective(r, r.current_revision);
      const rev = revision === null ? undefined : this.#revision(r.pool_id, revision);
      if (revision === null || !rev) continue;
      out.push({ pool: { id: r.pool_id, name: r.name, revision }, content: JSON.parse(rev.content) as C, options: JSON.parse(r.options) as Record<string, unknown> });
    }
    return out;
  }

  /**
   * The deliverable revisions of a pool before `revision`, newest first, at most `limit`, each with its content. For a
   * kind that must still recognise what an older revision delivered while sessions move off it (the browser's lockdown
   * allowlist, T-881). Drafts and rejected revisions are never in it.
   */
  deliverableBefore<C = unknown>(poolId: string, revision: number, limit: number): { pool: { id: string; name: string; revision: number }; content: C }[] {
    const p = this.store.db?.prepare('SELECT id, name FROM pools WHERE id = ?').get(poolId) as { id: string; name: string } | undefined;
    if (!p) return [];
    const rows = this.store.db!
      .prepare("SELECT revision, content FROM pool_revisions WHERE pool_id = ? AND revision < ? AND status = 'deliverable' ORDER BY revision DESC LIMIT ?")
      .all(poolId, revision, limit) as { revision: number; content: string }[];
    return rows.map((r) => ({ pool: { id: p.id, name: p.name, revision: r.revision }, content: JSON.parse(r.content) as C }));
  }

  /**
   * A pool at the revision workspaces get by default (its current one), with its content, or null when the
   * pool is unknown or has nothing deliverable yet. How one kind reads another's pools by ID: a persona
   * holding instruction contexts, for one. Pins and rollout pauses are per workspace and don't apply.
   */
  currentContent<C = unknown>(poolId: string, type?: MultiPoolType): { pool: { id: string; name: string; revision: number }; content: C } | null {
    const p = this.store.db?.prepare('SELECT * FROM pools WHERE id = ?').get(poolId) as PoolRow | undefined;
    if (!p || !this.#kinds.has(p.type as MultiPoolType) || (type && p.type !== type) || !p.current_revision) return null;
    const rev = this.#revision(poolId, p.current_revision);
    return rev ? { pool: { id: p.id, name: p.name, revision: p.current_revision }, content: JSON.parse(rev.content) as C } : null;
  }

  /**
   * Checks a create request's Add-ons before the workspace exists, so a bad one fails the whole create
   * rather than half of it. Returns them by type, without duplicates.
   */
  checkAddOns(input: unknown): Partial<Record<MultiPoolType, string[]>> {
    if (input === undefined || input === null) return {};
    if (!isObject(input)) throw invalid('pools', 'Pick add-ons from the lists.');
    const out: Partial<Record<MultiPoolType, string[]>> = {};
    for (const [type, ids] of Object.entries(input)) {
      if (!this.#kinds.has(type as MultiPoolType)) throw invalid('pools', 'One of the add-on types isn’t available.');
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw invalid('pools', 'Pick add-ons from the lists.');
      for (const id of ids as string[]) if (this.typeOf(id) !== type) throw invalid('pools', 'One of the add-ons no longer exists.');
      if (ids.length) out[type as MultiPoolType] = [...new Set(ids as string[])];
      if (this.#kinds.get(type as MultiPoolType)?.single && (out[type as MultiPoolType]?.length ?? 0) > 1) throw invalid('pools', `A workspace has one ${type} pool: pick one.`);
    }
    return out;
  }

  /** The workspace was removed: its multi-type assignments and removal records go too (its files went with it). */
  forgetWorkspace(workspaceId: string) {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    const types = MULTI_POOL_TYPES.map(() => '?').join(', ');
    db.prepare(`DELETE FROM assignments WHERE workspace_id = ? AND pool_type IN (${types})`).run(workspaceId, ...MULTI_POOL_TYPES);
    db.prepare(`DELETE FROM removals WHERE workspace_id = ? AND pool_type IN (${types})`).run(workspaceId, ...MULTI_POOL_TYPES);
    for (const [type, kind] of this.#kinds) {
      this.#providers.get(type)?.forget(workspaceId);
      try {
        kind.forgetWorkspace?.(workspaceId);
      } catch (e) {
        console.error(`[pools] ${type}: forgetting ${workspaceId} failed: ${(e as Error).message}`);
      }
    }
    this.onChange();
  }

  /* ---------- Preview ---------- */

  /**
   * Exactly what one pool would write (foundation PRD §10 "Preview files"): on its own or as a given
   * workspace gets it, from a stored revision (the workspace's, else the newest) or from unsaved editor
   * content (`poolId` null for a pool not saved yet). Runs in a transaction that is always rolled back,
   * so whatever `parse` stores for unsaved content goes away. Files that carry a secret are redacted.
   */
  preview(type: string, poolId: string | null, req: Partial<PoolPreviewRequest>): PoolPreview {
    const kind = this.kind(type);
    const pool = poolId === null ? null : this.#pool(poolId);
    if (pool && pool.type !== type) throw gone();
    const workspaceId = req.workspaceId === undefined || req.workspaceId === null || req.workspaceId === '' ? null : workspaceIdOf(req.workspaceId);
    if (req.content === undefined && !pool) throw invalid('content', 'There’s nothing to preview yet.');
    const db = pool && req.content === undefined ? this.store.db : this.#db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    const now = new Date();
    db.exec('BEGIN');
    try {
      const id = pool?.id ?? newId();
      // A pool not saved yet gets a row for the length of the preview, so `parse` sees a real pool.
      if (!pool)
        db.prepare("INSERT INTO pools (id, type, name, description, current_revision, created_at, updated_at) VALUES (?, ?, ?, '', 0, ?, ?)").run(
          id,
          type,
          `preview ${id}`,
          now.toISOString(),
          now.toISOString(),
        );
      const assignment =
        pool && workspaceId ? (db.prepare('SELECT * FROM assignments WHERE workspace_id = ? AND pool_id = ?').get(workspaceId, pool.id) as AssignmentRow | undefined) : undefined;
      let revision: number;
      let content: unknown;
      if (req.content !== undefined) {
        const latest = pool ? this.#latest(pool.id) : undefined;
        revision = (latest?.revision ?? 0) + 1;
        content = kind.parse(req.content, latest ? JSON.parse(latest.content) : null, { poolId: id, revision });
      } else {
        revision = (assignment && this.#effective(assignment, pool!.current_revision)) || this.#latest(pool!.id)!.revision;
        content = JSON.parse(this.#revision(pool!.id, revision)!.content);
      }
      const options = assignment ? (JSON.parse(assignment.options) as Record<string, unknown>) : this.#options(kind, {}, content);
      const fragments = kind.fragments([{ pool: { id, name: pool?.name ?? 'New pool', revision }, content, options }], {
        workspaceId: workspaceId ?? '',
        running: false,
        now,
        preview: true,
      });
      const claudeVersion = workspaceId
        ? ((db.prepare('SELECT claude_version FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as { claude_version: string | null } | undefined)?.claude_version ?? null)
        : null;
      let bundle: ReturnType<typeof compile>;
      try {
        for (const f of fragments) if (f.owner !== type) throw new CompileError(kind.type, `returned a fragment owned by ${f.owner}`);
        bundle = compile({ portalId: this.store.portalId ?? 'preview', generation: 0, fragments, claudeVersion, now });
      } catch (e) {
        if (e instanceof CompileError) throw new AppError('VALIDATION_FAILED', `Configuration error: ${e.message}`);
        throw e;
      }
      // Plugin version folders (the portal marketplace, F6), when the compiler produces them.
      const plugins = 'plugins' in bundle && Array.isArray(bundle.plugins) ? (bundle.plugins as { dirs: DeliveredDir[]; files: DeliveredFile[] }[]) : [];
      return {
        revision,
        workspaceId,
        dirs: [...bundle.dirs, ...plugins.flatMap((p) => p.dirs)].map((d) => ({ path: d.path, mode: d.mode, uid: d.uid, gid: d.gid })),
        files: [...bundle.files, ...plugins.flatMap((p) => p.files)].map((f) => ({
          path: f.path,
          mode: f.mode,
          uid: f.uid,
          gid: f.gid,
          content: f.secretRef ? POOL_REDACTED : f.content,
          redacted: !!f.secretRef,
        })),
        skipped: bundle.skipped.map((s) => ({ owner: s.owner, reason: s.reason })),
      };
    } finally {
      db.exec('ROLLBACK');
    }
  }
}
