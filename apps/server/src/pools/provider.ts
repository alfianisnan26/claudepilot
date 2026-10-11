import { CompileError } from '../delivery/compile.js';
import { dropInPath } from '../delivery/ownership.js';
import type { FragmentProvider } from '../delivery/reconciler.js';
import type { Fragment } from '../delivery/types.js';
import type { Store } from '../store/store.js';
import type { MultiPoolType, PoolKind } from './kinds.js';
import type { PoolService } from './service.js';

/** What one fragments() call compiled for a workspace, kept for the delivered() that follows it. */
interface Compiled {
  /** Pool → the revision compiled. */
  revisions: Map<string, number>;
  /** Pools the fragments named: what the manifest lists if this bundle gets written. */
  named: Set<string>;
  fragments: Fragment[];
}

/**
 * One registered kind's fragment provider (foundation PRD §6.1): its pools from the foundation tables,
 * each at the workspace's effective revision, and the bookkeeping after each delivery.
 *
 * A removal record goes only once the workspace's manifest no longer names its pool: until then it's
 * what keeps a drift read from freezing the workspace as "Assignments missing" (§6.5). The manifest
 * isn't in the bundle hash, so a removal that changes no file leaves the old manifest in place; the
 * record then waits for the next write.
 */
export class KindProvider implements FragmentProvider {
  readonly type: MultiPoolType;
  readonly #compiled = new Map<string, Compiled>();
  /** Pools named in the manifest last written to each workspace, as far as this process saw it written. */
  readonly #applied = new Map<string, Set<string>>();

  constructor(
    private readonly kind: PoolKind,
    private readonly service: PoolService,
    private readonly store: Store,
  ) {
    this.type = kind.type;
  }

  knownPools(workspaceId: string): string[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db
      .prepare('SELECT pool_id FROM assignments WHERE workspace_id = ? AND pool_type = ? UNION SELECT pool_id FROM removals WHERE workspace_id = ? AND pool_type = ?')
      .all(workspaceId, this.type, workspaceId, this.type) as { pool_id: string }[];
    return rows.map((r) => r.pool_id);
  }

  fragments(workspaceId: string, ctx: { running: boolean; now: Date }): Fragment[] {
    const assigned = this.service.assignedPools(workspaceId, this.type);
    const fragments = this.kind.fragments(assigned, { workspaceId, running: ctx.running, now: ctx.now });
    // Ownership is checked per owner, so a fragment under another owner's name would write its paths.
    for (const f of fragments) if (f.owner !== this.type) throw new CompileError(this.type, `returned a fragment owned by ${f.owner}`);
    this.#compiled.set(workspaceId, {
      revisions: new Map(assigned.map((a) => [a.pool.id, a.pool.revision])),
      named: new Set(fragments.flatMap((f) => (f.pool ? [f.pool.id] : []))),
      fragments,
    });
    return fragments;
  }

  delivered(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string>; pluginFolders?: Map<string, string[]> }) {
    const db = this.store.db;
    const compiled = this.#compiled.get(workspaceId);
    this.#compiled.delete(workspaceId);
    if (!db || !this.store.writable) return;
    if (compiled) {
      // The reconciler stamps applied_at with this run's time only when it wrote the bundle, and with
      // it a manifest naming exactly the pools compiled now.
      const row = db.prepare('SELECT applied_at FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as { applied_at: string | null } | undefined;
      if (row?.applied_at === ctx.now.toISOString()) this.#applied.set(workspaceId, compiled.named);
      const applied = this.#applied.get(workspaceId);
      if (applied) {
        const removals = db.prepare('SELECT id, pool_id FROM removals WHERE workspace_id = ? AND pool_type = ?').all(workspaceId, this.type) as { id: number; pool_id: string }[];
        const done = removals.filter((r) => !applied.has(r.pool_id) && !compiled.named.has(r.pool_id));
        const remove = db.prepare('DELETE FROM removals WHERE id = ?');
        for (const r of done) remove.run(r.id);
        if (done.length) this.service.onChange();
      }
      // The workspace now has the revisions compiled, unless the compiler left this kind's fragments out
      // (a Claude Code too old for them). A paused rollout lets the workspaces it reached keep theirs.
      const dropIn = dropInPath(this.type);
      const whole = compiled.fragments.every(
        (f) =>
          (f.files ?? []).every((file) => ctx.delivered.has(file.path)) &&
          (!f.settings || Object.keys(f.settings).length === 0 || (!!dropIn && ctx.delivered.has(dropIn))),
      );
      if (whole) {
        const update = db.prepare('UPDATE assignments SET delivered_revision = ? WHERE workspace_id = ? AND pool_id = ? AND delivered_revision IS NOT ?');
        for (const [poolId, revision] of compiled.revisions) update.run(revision, workspaceId, poolId, revision);
      }
    }
    this.kind.delivered?.(workspaceId, ctx);
  }

  /** The workspace was removed: nothing to remember about it. */
  forget(workspaceId: string) {
    this.#compiled.delete(workspaceId);
    this.#applied.delete(workspaceId);
  }
}
