import { AppError } from '@isnanme/core';
import type {
  McpCatalogVersion,
  McpDeliveryState,
  McpMatcher,
  McpPluginVerify,
  McpProposalRequest,
  McpProposalResult,
  McpRevokeResult,
  McpServerStatus,
  McpSetContent,
  McpVerifyResult,
  McpWorkspaceStatus,
  PoolSummary,
} from '@portal/contracts';
import type { OutboxEvent } from '../delivery/outbox.js';
import { WorkspaceSteps } from '../delivery/steps.js';
import type { References } from '../pools/references.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { DeliveryAccess } from '../workspaces/runtime.js';
import { McpCatalog } from './catalog.js';
import { McpJobs } from './jobs.js';
import { McpSetKind, namesIn } from './kind.js';

/** FR11: more stdio servers than this start in every session, so the status warns. */
const STDIO_WARN = 8;
/** Launcher events kept for the status (§13.2); older ones only matter to Monitoring. */
const LAUNCH_EVENTS_FOR_MS = 24 * 60 * 60_000;

interface DeliveryRow {
  pool_id: string;
  server_key: string;
  plugin: string;
  version_id: string | null;
  target: string | null;
  state: McpDeliveryState;
  reason: string | null;
  updated_at: string;
}

/**
 * The MCP set pool type in one place (MCP set PRD): the catalog, the `mcpset` kind registered with the
 * pool service, the reference source registered with References, and what runs inside workspaces.
 * Made once in index.ts, before the reconciler starts.
 */
export class McpSets {
  readonly catalog: McpCatalog;
  readonly kind: McpSetKind;
  readonly jobs: McpJobs;
  readonly steps: WorkspaceSteps;

  constructor(
    private readonly store: Store,
    private readonly pools: PoolService,
    private readonly references: References,
    access: (target: string) => DeliveryAccess | undefined,
    opts: { resolveDns?: boolean; steps?: WorkspaceSteps } = {},
  ) {
    this.catalog = new McpCatalog(store, { urlCheck: () => ({ portalUrl: process.env.PORTAL_PUBLIC_URL?.trim() || null }), resolveDns: opts.resolveDns });
    this.kind = new McpSetKind(store, this.catalog, pools, references);
    this.steps = opts.steps ?? new WorkspaceSteps(store, access);
    this.jobs = new McpJobs(store, this.steps);
    this.catalog.usage = () => this.kind.usage();
    this.catalog.versionUse = (id) => this.kind.workspacesWith(id).length;
    this.catalog.onChange = () => pools.onChange();
    this.jobs.onChange = () => pools.onChange();
    this.kind.afterDelivery = (compiled, ctx) => this.jobs.afterDelivery(compiled, ctx);
    this.kind.redeliver = (id, why) => void pools.reconciler?.request(id, why);
    pools.register(this.kind);
    references.addSource(this.kind);
  }

  /* ---------- Proposals (I3: the global "add MCP" flow) ---------- */

  /**
   * An agent or a token proposes a catalog entry (or a new version of one): a draft waiting for a person,
   * with `actor` (`portal-mcp:<token id>`, `session:<id>`, `ticket:<id>`) recorded, secrets by slot name
   * only. It goes through the catalog the UI uses and stops at its review gate: nothing here approves, and
   * no set accepts a draft, so nothing is delivered until a person approves the version in the portal.
   */
  proposeEntry(actor: string, req: Partial<McpProposalRequest>): Promise<McpProposalResult> {
    return this.catalog.propose(actor, req);
  }

  /** The proposer takes back its own proposal while it still waits for review. */
  withdrawProposal(actor: string, versionId: string): void {
    this.catalog.withdrawProposal(actor, versionId);
  }

  /* ---------- Revocation (FR13b) ---------- */

  /**
   * Revokes a version: it leaves every delivery at once, pinned workspaces and paused rollouts
   * included (each affected workspace is asked directly, not through the rollout), its folders are
   * deleted, its tools denied for 14 days, and its processes stopped after the deny rule lands.
   */
  revoke(entryId: string, versionId: string, reason: unknown): McpRevokeResult {
    const cv = this.catalog.markRevoked(entryId, versionId, reason);
    const workspaces = this.kind.workspacesWith(versionId);
    const at = new Date().toISOString();
    const db = this.store.db!;
    this.catalog.event('version_revoked', { entryId, versionId }, { version: cv.row.version, target: cv.target ?? cv.spec.url ?? null, workspaces: workspaces.length });
    // Monitoring's security event, per workspace it reaches.
    const insert = db.prepare('INSERT INTO delivery_events (at, workspace_id, kind, details) VALUES (?, ?, ?, ?)');
    for (const ws of workspaces) {
      insert.run(at, ws, 'mcp_revoked', JSON.stringify({ entry: cv.entry.key, version: cv.row.version, target: cv.target ?? cv.spec.url ?? null }));
      void this.pools.reconciler?.request(ws, 'mcp version revoked', { changed: true });
    }
    this.pools.onChange();
    return { version: this.catalog.version(cv.entry, cv.row), workspaces };
  }

  /* ---------- "Try in set" (FR4) ---------- */

  /** A new revision of the set with every server of `entry` at `version`, held back: pin trial workspaces to it, then make it current. */
  tryInSet(poolId: string, entryId: unknown, version: unknown): PoolSummary {
    if (typeof entryId !== 'string' || typeof version !== 'string') throw new AppError('VALIDATION_FAILED', 'Pick a catalog entry and version.');
    if (this.pools.typeOf(poolId) !== 'mcpset') throw new AppError('NOT_FOUND', 'That set no longer exists.');
    const cv = this.catalog.find(entryId, version);
    if (!cv || cv.row.review_state !== 'approved') throw new AppError('CONFLICT', 'Only an approved version can be tried.');
    const detail = this.pools.get(poolId);
    const content = detail.content as McpSetContent;
    if (!content.servers.some((s) => s.entry === entryId)) throw new AppError('CONFLICT', `${detail.name} doesn’t use ${cv.entry.display_name}.`);
    const next: McpSetContent = { ...content, servers: content.servers.map((s) => (s.entry === entryId ? { ...s, version } : s)) };
    return this.pools.update(poolId, { content: next, hold: true, note: `Try ${cv.entry.display_name} ${version}` });
  }

  /* ---------- A workspace ---------- */

  /** Workspaces with a set, whose launcher events the portal pulls (§13.2). */
  assignedWorkspaces(): string[] {
    const rows = this.store.db?.prepare("SELECT DISTINCT workspace_id FROM assignments WHERE pool_type = 'mcpset'").all() as { workspace_id: string }[] | undefined;
    return (rows ?? []).map((r) => r.workspace_id);
  }

  /** Launcher and helper events from the outbox (§13.2): starts and failures, never values. */
  onOutbox(workspaceId: string, events: OutboxEvent[]) {
    let failures = false;
    const started = new Set<string>();
    for (const e of events) {
      const server = typeof e.server === 'string' && /^cpm-[a-z0-9-]+\/[a-z0-9-]+$/.test(e.server) ? e.server : null;
      const phase = e.phase === 'start' || e.phase === 'fail' ? e.phase : null;
      if (!server || !phase) continue;
      const word = (v: unknown) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null);
      this.catalog.event('launch', { workspaceId }, { server, phase, source: word(e.source), reason: word(e.reason_class), at: typeof e.at === 'string' ? e.at.slice(0, 40) : null });
      failures ||= phase === 'fail';
      if (phase === 'start') started.add(server.slice(0, server.indexOf('/')));
    }
    // A set's server started, so a session ran there: Claude Code has likely registered the marketplace
    // by now, and a verify that found it unregistered (FR16, §13.2) runs again instead of waiting.
    if (started.size && this.store.writable) {
      const db = this.store.db!;
      const stale = (db.prepare("SELECT plugin FROM mcp_verify WHERE workspace_id = ? AND result = 'not_registered'").all(workspaceId) as { plugin: string }[])
        .map((r) => r.plugin)
        .filter((p) => started.has(p));
      if (stale.length) {
        const drop = db.prepare('DELETE FROM mcp_verify WHERE workspace_id = ? AND plugin = ?');
        for (const p of stale) drop.run(workspaceId, p);
        void this.pools.reconciler?.request(workspaceId, 'verify mcp sets');
      }
    }
    if (failures) this.pools.onChange();
  }

  /** FR19: what an MCP allowlist must admit for this workspace (Settings & policies includes it). */
  matchers(workspaceId: string): McpMatcher[] {
    return this.kind
      .compileFor(workspaceId)
      .servers.flatMap((s) => (s.matcher ? [s.matcher] : []))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  retry(workspaceId: string, what: 'installs' | 'verify') {
    this.jobs.retry(workspaceId, what);
    void this.pools.reconciler?.request(workspaceId, what === 'installs' ? 'retry mcp installs' : 'verify mcp sets');
  }

  /** The MCP part of the workspace's Configuration row (FR17): each server's state, installs, the verify, missing names. */
  status(workspaceId: string): McpWorkspaceStatus {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    const rows = db.prepare('SELECT * FROM mcp_delivery WHERE workspace_id = ? ORDER BY plugin, server_key').all(workspaceId) as unknown as DeliveryRow[];
    const poolNames = new Map((db.prepare("SELECT id, name FROM pools WHERE type = 'mcpset'").all() as { id: string; name: string }[]).map((p) => [p.id, p.name]));
    const installs = new Map(
      (db.prepare('SELECT package_ref, state, error, updated_at FROM mcp_installs WHERE workspace_id = ?').all(workspaceId) as {
        package_ref: string;
        state: 'installing' | 'installed' | 'failed';
        error: string | null;
        updated_at: string;
      }[]).map((r) => [r.package_ref, r]),
    );
    const verify: McpPluginVerify[] = (
      db.prepare('SELECT plugin, result, servers, detail, at FROM mcp_verify WHERE workspace_id = ? ORDER BY plugin').all(workspaceId) as {
        plugin: string;
        result: McpVerifyResult;
        servers: string;
        detail: string | null;
        at: string;
      }[]
    ).map((r) => ({ plugin: r.plugin, result: r.result, servers: JSON.parse(r.servers) as string[], detail: r.detail, at: r.at }));
    const lastFailure = this.#lastLaunchFailures(workspaceId);
    const servers: McpServerStatus[] = rows.map((r) => {
      const cv = r.version_id ? this.catalog.findById(r.version_id) : null;
      const install = r.target?.startsWith('npm:') ? installs.get(r.target) : undefined;
      const v = verify.find((x) => x.plugin === r.plugin);
      const listed = v && (v.result === 'ok' || v.result === 'mismatch') ? v.servers.includes(r.server_key) : null;
      const failure = lastFailure.get(`${r.plugin}/${r.server_key}`);
      const delivered = r.state === 'delivered' || r.state === 'pending_start';
      return {
        poolId: r.pool_id,
        poolName: poolNames.get(r.pool_id) ?? 'Removed set',
        plugin: r.plugin,
        key: r.server_key,
        entryName: cv?.entry.display_name ?? r.server_key,
        version: cv?.row.version ?? '',
        target: r.target,
        state: r.state,
        reason: r.reason ?? (delivered && failure ? `Last start failed: ${failure.replace(/_/g, ' ')}.` : null),
        install: install ? { state: install.state, error: install.error, at: install.updated_at } : null,
        listed: delivered ? listed : null,
        updatedAt: r.updated_at,
      };
    });
    // Names the sets reference that this workspace's Secrets & env sets don't provide as files (US3).
    const have = this.references.secretNamesFor(workspaceId);
    const used = this.kind.namesUsedBy(workspaceId);
    const missingNames = [...used.keys()].filter((n) => !have.get(n)?.file).sort();
    return { workspaceId, servers, verify, missingNames, warnings: this.#warnings(workspaceId, servers) };
  }

  #lastLaunchFailures(workspaceId: string): Map<string, string> {
    const since = new Date(Date.now() - LAUNCH_EVENTS_FOR_MS).toISOString();
    const rows = this.store.db!
      .prepare("SELECT details FROM mcp_events WHERE type = 'launch' AND workspace_id = ? AND at >= ? ORDER BY id")
      .all(workspaceId, since) as { details: string }[];
    const out = new Map<string, string>();
    for (const r of rows) {
      const d = JSON.parse(r.details) as { server?: string; phase?: string; reason?: string | null };
      if (!d.server) continue;
      if (d.phase === 'fail') out.set(d.server, d.reason ?? 'unknown');
      else out.delete(d.server);
    }
    return out;
  }

  /** FR11's warnings: one entry in two sets, and many stdio servers per session. */
  #warnings(workspaceId: string, servers: McpServerStatus[]): string[] {
    const out: string[] = [];
    const sets = this.pools.assignedPools<McpSetContent>(workspaceId, 'mcpset');
    const byEntry = new Map<string, string[]>();
    for (const a of sets) for (const s of a.content.servers.filter((x) => x.enabled)) byEntry.set(s.entry, [...(byEntry.get(s.entry) ?? []), a.pool.name]);
    for (const [entry, names] of byEntry) {
      if (new Set(names).size < 2) continue;
      const display = this.catalog.find(entry, sets.flatMap((a) => a.content.servers).find((s) => s.entry === entry)!.version)?.entry.display_name ?? 'A server';
      out.push(`${display} is in ${[...new Set(names)].join(' and ')}: each session starts it twice.`);
    }
    const stdio = servers.filter((s) => (s.state === 'delivered' || s.state === 'pending_start') && s.target && !/^https?:/.test(s.target)).length;
    if (stdio > STDIO_WARN) out.push(`${stdio} stdio servers start in every session: about ${stdio} processes per open session.`);
    for (const a of sets) if (namesIn(a.content).length === 0 && a.content.servers.length === 0) out.push(`${a.pool.name} has no servers yet.`);
    return out;
  }

  /** A catalog version as the API shows it. */
  versionView(versionId: string): McpCatalogVersion | null {
    const cv = this.catalog.findById(versionId);
    return cv ? this.catalog.version(cv.entry, cv.row) : null;
  }
}

/**
 * I3, for Portal MCP and other callers: propose an MCP catalog entry on behalf of an agent or a token.
 * Always a draft waiting for a person's review in the portal; see `McpSets.proposeEntry`.
 *
 *   const r = await proposeEntry(mcp, `portal-mcp:${token.id}`, { key: 'linear', displayName: 'Linear', kind: 'remote',
 *     spec: { url: 'https://mcp.linear.app/mcp', auth: 'headers' },
 *     slots: [{ name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' }],
 *     reason: 'The ticket needs Linear issues.' });
 *   // r.status === 'waiting_review', r.reviewPath === '/admin/pools/mcp/catalog/<entry id>'
 */
export function proposeEntry(mcp: Pick<McpSets, 'proposeEntry'>, actor: string, req: Partial<McpProposalRequest>): Promise<McpProposalResult> {
  return mcp.proposeEntry(actor, req);
}

/** Registers the MCP set type (index.ts): call before the reconciler starts. */
export function registerMcpSets(deps: { store: Store; pools: PoolService; references: References; access: (target: string) => DeliveryAccess | undefined }): McpSets {
  return new McpSets(deps.store, deps.pools, deps.references, deps.access);
}
