import type { WorkspaceSkills, WorkspaceSkillset } from '@portal/contracts';
import { versionAtLeast } from '../delivery/compile.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { Runtime } from '../workspaces/runtime.js';
import { BlobStore } from './blobs.js';
import { SkillsetKind, type Expected } from './kind.js';
import { SkillsLibrary } from './library.js';
import type { StoredSkillset } from './plugin.js';
import { SkillVerifier, type PluginResult } from './verify.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
/** What verification's short details mean, for the Skills row. */
const DETAIL: Record<string, string> = {
  stopped: 'The workspace is stopped; it’s checked when it starts.',
  'no session': 'No Claude Code session has registered the portal marketplace yet; checked again after one has.',
  'timed out': 'Verification timed out.',
};

/**
 * Skillsets (Skillset PRD): the library and reviews, the `skillset` pool kind, verification and the blob
 * store, wired together. Register before the reconciler starts (index.ts), so manifests naming a
 * skillset pool are accounted for (foundation §6.5).
 */
export class SkillsModule {
  readonly blobs: BlobStore;
  readonly library: SkillsLibrary;
  readonly kind: SkillsetKind;
  readonly verifier: SkillVerifier;
  #gc: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private readonly service: PoolService,
    opts: { runtimes: (target: string) => Runtime | undefined; minClaudeVersion?: string },
  ) {
    this.blobs = new BlobStore(store);
    this.library = new SkillsLibrary(store, this.blobs);
    this.kind = new SkillsetKind(store, this.library, () => service, { minClaudeVersion: opts.minClaudeVersion });
    this.verifier = new SkillVerifier(store, opts.runtimes, () => service);
    this.kind.onDelivered = (id, ctx) => this.verifier.delivered(id, ctx);
    // `service.onChange` is the live `pools` topic, set by index.ts after this runs.
    this.verifier.onChange = () => this.service.onChange();
    this.blobs.addSource(() => this.library.referencedBlobs());
    this.library.hooks = {
      changed: () => this.service.onChange(),
      approved: (hash) => this.#release(hash),
      revoked: (hash) => this.#recompile(hash),
      setsUsing: () => this.setsUsing(),
    };
    service.register(this.kind);
  }

  /** Blob garbage collection: a minute after start, then daily. */
  start(): void {
    const run = () => {
      try {
        const r = this.blobs.collect();
        if (r.deleted) console.log(`[skills] blob store: deleted ${r.deleted} unreferenced blob(s)`);
      } catch (e) {
        console.error(`[skills] blob collection failed: ${(e as Error).message}`);
      }
    };
    const first = setTimeout(() => {
      run();
      this.#gc = setInterval(run, DAY_MS);
      this.#gc.unref();
    }, 60_000);
    first.unref();
    this.#gc = first;
  }

  stop(): void {
    clearTimeout(this.#gc);
    clearInterval(this.#gc);
  }

  /** Version → the skillsets that list it, with the revisions that do; `listed` when the newest or current one does. */
  setsUsing(): Map<string, { poolId: string; poolName: string; revisions: number[]; listed: boolean }[]> {
    const rows = (this.store.db?.prepare(
      `SELECT p.id, p.name, p.current_revision, r.revision, r.content, (SELECT max(revision) FROM pool_revisions WHERE pool_id = p.id) AS newest
       FROM pools p JOIN pool_revisions r ON r.pool_id = p.id WHERE p.type = 'skillset' ORDER BY p.name, r.revision`,
    ).all() ?? []) as { id: string; name: string; current_revision: number; revision: number; content: string; newest: number }[];
    const out = new Map<string, { poolId: string; poolName: string; revisions: number[]; listed: boolean }[]>();
    for (const r of rows) {
      for (const s of json<Partial<StoredSkillset>>(r.content, {}).skills ?? []) {
        const list = out.get(s.versionId) ?? [];
        let entry = list.find((x) => x.poolId === r.id);
        if (!entry) list.push((entry = { poolId: r.id, poolName: r.name, revisions: [], listed: false }));
        entry.revisions.push(r.revision);
        if (r.revision === r.newest || r.revision === r.current_revision) entry.listed = true;
        out.set(s.versionId, list);
      }
    }
    return out;
  }

  /** FR14: approving a skill releases every revision waiting only on approvals, oldest first. */
  #release(treeHash: string): void {
    const rows = (this.store.db?.prepare(
      `SELECT r.pool_id, r.revision, r.content FROM pool_revisions r JOIN pools p ON p.id = r.pool_id
       WHERE p.type = 'skillset' AND r.status = 'waiting_review' ORDER BY r.pool_id, r.revision`,
    ).all() ?? []) as { pool_id: string; revision: number; content: string }[];
    for (const r of rows) {
      const content = json<StoredSkillset>(r.content, { prefix: '', skills: [] });
      if (!content.skills.some((s) => s.treeHash === treeHash) || this.kind.review(content) !== 'deliverable') continue;
      try {
        this.service.approve(r.pool_id, r.revision);
      } catch (e) {
        console.error(`[skills] releasing ${r.pool_id} r${r.revision} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * §11.3: a revocation recompiles every workspace that has a set listing the version in any revision,
   * pinned or not, at once (reconcile requests skip the rollout pace).
   */
  #recompile(treeHash: string): void {
    const db = this.store.db;
    if (!db) return;
    const pools = new Set(
      (db.prepare("SELECT r.pool_id, r.content FROM pool_revisions r JOIN pools p ON p.id = r.pool_id WHERE p.type = 'skillset'").all() as { pool_id: string; content: string }[])
        .filter((r) => (json<Partial<StoredSkillset>>(r.content, {}).skills ?? []).some((s) => s.treeHash === treeHash))
        .map((r) => r.pool_id),
    );
    const workspaces = new Set<string>();
    for (const id of pools) for (const r of db.prepare('SELECT workspace_id FROM assignments WHERE pool_id = ?').all(id) as { workspace_id: string }[]) workspaces.add(r.workspace_id);
    for (const ws of workspaces) void this.service.reconciler?.request(ws, 'skill revoked', { changed: true });
  }

  /** The Configuration panel's Skills row (FR24): sets, revisions, commands, verification and warnings. */
  workspace(workspaceId: string): WorkspaceSkills {
    const db = this.store.db;
    const min = this.kind.minClaudeVersion;
    const claudeVersion =
      (db?.prepare('SELECT claude_version FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as { claude_version: string | null } | undefined)?.claude_version ?? null;
    const tooOld = !!claudeVersion && !versionAtLeast(claudeVersion, min);
    const inv = db?.prepare('SELECT * FROM skill_inventory WHERE workspace_id = ?').get(workspaceId) as
      | { status: WorkspaceSkillset['status'] | null; observed_at: string | null; detail: string | null; plugins: string; expected: string; changed_at: string | null }
      | undefined;
    const results = json<PluginResult[]>(inv?.plugins, []);
    const expected = json<Expected[]>(inv?.expected, []);
    const assigned = this.service.assignedPools<StoredSkillset>(workspaceId, 'skillset');
    const now = new Date();
    const sets = this.service
      .assignmentsFor(workspaceId)
      .filter((a) => a.type === 'skillset' && a.state === 'assigned')
      .map((a): WorkspaceSkillset => {
        const blocked = this.kind.denyRules([a.poolId], now).filter((d) => !d.rule.endsWith(' *)')).map((d) => ({ command: d.command, until: d.until }));
        const ap = assigned.find((x) => x.pool.id === a.poolId);
        if (!ap) return { poolId: a.poolId, poolName: a.poolName, revision: 0, prefix: '', status: 'pending', message: 'No revision is deliverable yet.', skills: [], leftOut: [], blocked };
        const set = this.kind.compiled(ap.pool, ap.content);
        const skills = set.skills.map((s) => ({ name: s.name, command: `/${ap.content.prefix}:${s.name}`, mode: s.mode, scripted: s.scripted, hash: s.treeHash.slice(0, 12) }));
        const base = { poolId: a.poolId, poolName: a.poolName, revision: ap.pool.revision, prefix: ap.content.prefix, skills, leftOut: set.leftOut, blocked };
        if (tooOld) return { ...base, status: 'not_verified', message: `Claude Code ${claudeVersion?.replace(/\s*\(Claude Code\)/, '')} is too old for skillsets (needs ${min}).` };
        if (!set.bundle) return { ...base, status: 'not_verified', message: 'Nothing to deliver: no approved skill is on.' };
        const exp = expected.find((e) => e.poolId === a.poolId);
        if (!exp || exp.revision !== ap.pool.revision || exp.folder !== set.hash12) return { ...base, status: 'pending', message: 'Delivering.' };
        const res = results.find((r) => r.poolId === a.poolId && r.revision === exp.revision);
        if (inv?.status === 'not_verified' && inv.detail === 'stopped') return { ...base, status: 'not_verified', message: DETAIL.stopped! };
        if (!res) return { ...base, status: 'pending', message: 'Checking.' };
        return { ...base, status: res.status, message: res.message };
      });
    return {
      workspaceId,
      minClaudeVersion: min,
      claudeVersion,
      tooOld,
      sets,
      verification: inv?.status && inv.observed_at ? { status: inv.status, at: inv.observed_at, detail: inv.detail ? (DETAIL[inv.detail] ?? inv.detail) : null } : null,
      changedAt: inv?.changed_at ?? null,
    };
  }
}
