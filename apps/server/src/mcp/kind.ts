import { AppError } from '@isnanme/core';
import type { McpEntryUse, McpSetContent, McpSetServer } from '@portal/contracts';
import { SECRET_FILE_REF, secretFileRef } from '@portal/contracts';
import type { Fragment } from '../delivery/types.js';
import type { AssignedPool, KindContext, ParseContext, PoolKind } from '../pools/kinds.js';
import type { ReferenceSource, References } from '../pools/references.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { CatalogVersion, McpCatalog } from './catalog.js';
import { compileMcp, REVOKE_DENY_MS, type CompileOutput, type RevokedHistory } from './compile.js';
import { configValue, serverKeyProblem, slugFrom, slugProblem } from './spec.js';

const MAX_SERVERS = 30;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface DeliveryRow {
  workspace_id: string;
  pool_id: string;
  server_key: string;
  plugin: string;
  version_id: string | null;
  target: string | null;
  state: string;
  reason: string | null;
  revoked_at: string | null;
  killed_at: string | null;
}

/** What one reconcile compiled for a workspace, kept for the `delivered` call that follows it. */
export interface Compiled extends CompileOutput {
  workspaceId: string;
}

/** The names a set's servers reference (`{{secret-file:NAME}}`). */
export function namesIn(content: McpSetContent): string[] {
  const out = new Set<string>();
  for (const s of content.servers ?? []) for (const ref of Object.values(s.secrets ?? {})) {
    const name = SECRET_FILE_REF.exec(ref)?.[1];
    if (name) out.add(name);
  }
  return [...out];
}

/**
 * The `mcpset` pool kind (MCP set PRD FR9–FR11, FR13b, FR14): a set's servers point at approved
 * catalog versions and name Secrets & env entries for their secret slots. Revisions follow the
 * foundation (pins, held trial revisions, rollout pauses); a revoked version leaves every delivery
 * through `fragments`, whatever revision a workspace is on. It is also the reference source Secrets &
 * env asks before renaming or removing a name a set uses (Secrets & env FR19, FR23).
 */
export class McpSetKind implements PoolKind<McpSetContent>, ReferenceSource {
  readonly type = 'mcpset' as const;
  /** After each successful reconcile of a running workspace (the A4 steps: verify, installs, kills). */
  afterDelivery: (compiled: Compiled, ctx: { now: Date; running: boolean }) => void = () => {};
  /** A workspace still holds a revoked version folder the last compile didn't name: deliver again now. */
  redeliver: (workspaceId: string, why: string) => void = () => {};
  /** The workspace is gone: what else keeps something for it lets go (the OAuth sign-in state, §13.3). */
  onForget: (workspaceId: string) => void = () => {};
  readonly #compiled = new Map<string, Compiled>();
  /** Each workspace's portal plugin version folders, as the engine last reported them. */
  readonly #folders = new Map<string, Map<string, string[]>>();

  constructor(
    private readonly store: Store,
    private readonly catalog: McpCatalog,
    private readonly pools: PoolService,
    private readonly references: References,
  ) {}

  /* ---------- Content ---------- */

  #slugOwner(slug: string, exceptPoolId: string): string | null {
    const rows = this.store.db!
      .prepare(
        `SELECT p.id, r.content FROM pools p JOIN pool_revisions r ON r.pool_id = p.id
         WHERE p.type = 'mcpset' AND p.id <> ? AND r.revision = (SELECT max(revision) FROM pool_revisions WHERE pool_id = p.id)`,
      )
      .all(exceptPoolId) as { id: string; content: string }[];
    return rows.find((r) => (JSON.parse(r.content) as McpSetContent).slug === slug)?.id ?? null;
  }

  /** A slug no other set uses, from `base`: `team` → `team-2`. */
  #freshSlug(base: string, poolId: string): string {
    for (let n = 2; n < 1000; n++) {
      const suffix = `-${n}`;
      const slug = `${base.slice(0, 12 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!this.#slugOwner(slug, poolId)) return slug;
    }
    throw new AppError('CONFLICT', 'Pick another ID for the set.');
  }

  /** Whether any workspace ever got the pool (then its slug is fixed, FR5). */
  #everDelivered(poolId: string): boolean {
    return !!this.store.db!
      .prepare(
        `SELECT 1 FROM assignments WHERE pool_id = ? AND delivered_revision IS NOT NULL
         UNION SELECT 1 FROM mcp_delivery WHERE pool_id = ? AND state IN ('delivered', 'pending_start', 'revoked') LIMIT 1`,
      )
      .get(poolId, poolId);
  }

  parse(input: unknown, prev: McpSetContent | null, ctx?: ParseContext): McpSetContent {
    if (!isObject(input)) throw invalid('content', 'Describe the set.');
    const poolId = ctx?.poolId ?? '';
    const name = (this.store.db!.prepare('SELECT name FROM pools WHERE id = ?').get(poolId) as { name: string } | undefined)?.name ?? 'set';
    let slug = typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : (prev?.slug ?? slugFrom(name));
    const problem = slugProblem(slug);
    if (problem) throw invalid('slug', problem);
    if (this.#slugOwner(slug, poolId)) {
      // Duplicating carries the source's slug over (`prev` is the source's content): the copy gets its own.
      if (prev && prev.slug === slug) slug = this.#freshSlug(slug, poolId);
      else throw new AppError('CONFLICT', `The ID “${slug}” is used by another set.`, { details: { slug: 'Used by another set.' } });
    }
    // Fixed once delivered (FR5): it names the plugin, so every tool name depends on it.
    if (prev && prev.slug !== slug && this.#everDelivered(poolId))
      throw invalid('slug', 'The ID is fixed once a workspace has the set: its tool names depend on it. Duplicate the set to start a new one.');

    const list = input.servers === undefined ? [] : input.servers;
    if (!Array.isArray(list)) throw invalid('servers', 'Servers are a list.');
    if (list.length > MAX_SERVERS) throw invalid('servers', `Use at most ${MAX_SERVERS} servers in one set.`);
    const keys = new Set<string>();
    const servers = (list as unknown[]).map((raw, i) => this.#server(raw, i, prev, keys));
    return { slug, servers };
  }

  #server(raw: unknown, i: number, prev: McpSetContent | null, keys: Set<string>): McpSetServer {
    const f = `servers.${i}`;
    if (!isObject(raw)) throw invalid(f, 'Each server is an object.');
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    const keyProblem = serverKeyProblem(key);
    if (keyProblem) throw invalid(`${f}.key`, keyProblem);
    if (keys.has(key)) throw invalid(`${f}.key`, `${key} is used twice in this set.`);
    keys.add(key);
    const entryId = typeof raw.entry === 'string' ? raw.entry : '';
    const version = typeof raw.version === 'string' ? raw.version : '';
    const cv = entryId && version ? this.catalog.find(entryId, version) : null;
    if (!cv) throw invalid(`${f}.version`, 'Pick a server and version from the catalog.');
    const was = prev?.servers.find((s) => s.key === key && s.entry === entryId && s.version === version);
    const label = `${cv.entry.display_name} ${cv.row.version}`;
    switch (cv.row.review_state) {
      case 'draft':
        throw invalid(`${f}.version`, `${label} isn’t approved yet. Review it in the catalog first.`);
      case 'revoked':
        // Kept only where it already was: it's never delivered (fragments take it out).
        if (!was) throw invalid(`${f}.version`, `${label} was revoked.`);
        break;
      case 'deprecated':
        // Deprecated versions keep working where they are but can't be added (FR13).
        if (!was) throw invalid(`${f}.version`, `${label} is deprecated: pick a newer version.`);
        break;
      case 'approved':
        break;
    }
    if (cv.entry.kind === 'pypi') throw invalid(`${f}.version`, 'PyPI servers need uv in the workspace image, which comes in a later release.');
    const enabled = raw.enabled !== false;
    const configIn = isObject(raw.config) ? raw.config : {};
    const secretsIn = isObject(raw.secrets) ? raw.secrets : {};
    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const slot of cv.slots) {
      const sf = `${f}.${slot.secret ? 'secrets' : 'config'}.${slot.name}`;
      if (slot.secret) {
        const ref = this.#ref(secretsIn[slot.name], sf);
        if (ref) secrets[slot.name] = ref;
        else if (slot.required && enabled) throw invalid(sf, `Pick a secret for ${slot.name}.`);
      } else {
        const v = configIn[slot.name];
        if (v !== undefined && v !== null && v !== '') config[slot.name] = configValue(v, sf);
        else if (slot.required && enabled && !slot.default) throw invalid(sf, `Fill in ${slot.name}.`);
      }
    }
    return { key, entry: entryId, version: cv.row.version, enabled, config, secrets };
  }

  /** A secret slot's reference: `{{secret-file:NAME}}`, or just the name (stored in the reference form). */
  #ref(input: unknown, field: string): string | null {
    if (input === undefined || input === null || input === '') return null;
    if (typeof input !== 'string') throw invalid(field, 'Name a Secrets & env entry.');
    const s = input.trim();
    if (/\$\{[^}]*\}/.test(s))
      throw invalid(field, 'Use {{secret-file:NAME}}: a ${NAME} variable sits in Claude Code’s environment, and credential-like names read as empty there.');
    const name = SECRET_FILE_REF.exec(s)?.[1] ?? (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null);
    if (!name) throw invalid(field, 'Name a Secrets & env entry: letters, digits, dots, dashes and underscores.');
    return secretFileRef(name);
  }

  view(content: McpSetContent): McpSetContent {
    return content;
  }

  /* ---------- Delivery ---------- */

  #claudeVersion(workspaceId: string): string | null {
    return (this.store.db?.prepare('SELECT claude_version FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as { claude_version: string | null } | undefined)?.claude_version ?? null;
  }

  /** Servers earlier compiles took out for a revocation, within their deny window (FR13b). */
  #history(workspaceId: string, now: Date): RevokedHistory[] {
    const since = new Date(now.getTime() - REVOKE_DENY_MS).toISOString();
    const rows = this.store.db!
      .prepare("SELECT plugin, server_key, revoked_at FROM mcp_delivery WHERE workspace_id = ? AND state = 'revoked' AND revoked_at >= ?")
      .all(workspaceId, since) as { plugin: string; server_key: string; revoked_at: string }[];
    return rows.map((r) => ({ plugin: r.plugin, key: r.server_key, revokedAt: r.revoked_at }));
  }

  /** Version folders this workspace still has that hold a revoked version (FR13b, §10.4). */
  #revokedFolders(workspaceId: string): string[] {
    const folders = this.#folders.get(workspaceId);
    if (!folders?.size) return [];
    const db = this.store.db!;
    const out: string[] = [];
    for (const [plugin, hashes] of folders)
      for (const hash12 of hashes) {
        const row = db.prepare('SELECT version_ids FROM mcp_plugin_folders WHERE plugin = ? AND hash12 = ?').get(plugin, hash12) as { version_ids: string } | undefined;
        const ids = row ? (JSON.parse(row.version_ids) as string[]) : [];
        if (ids.some((id) => this.catalog.findById(id)?.row.review_state === 'revoked')) out.push(`${plugin}/${hash12}`);
      }
    return out;
  }

  /** The workspace's MCP fragment as it would compile now, without recording anything (matchers, status). */
  compileFor(workspaceId: string, now = new Date(), running = true): CompileOutput {
    const assigned = this.pools.assignedPools<McpSetContent>(workspaceId, 'mcpset');
    return this.#compile(assigned, { workspaceId, running, now, preview: true });
  }

  #compile(assigned: AssignedPool<McpSetContent>[], ctx: KindContext): CompileOutput {
    const ws = ctx.workspaceId;
    return compileMcp({
      sets: assigned.map((a) => ({ pool: a.pool, content: a.content })),
      find: (entryId, version): CatalogVersion | null => this.catalog.find(entryId, version),
      // A preview without a workspace shows what a workspace with every name gets.
      names: ws ? this.references.secretNamesFor(ws) : null,
      claudeVersion: ws ? this.#claudeVersion(ws) : null,
      running: ctx.running,
      now: ctx.now,
      history: ws ? this.#history(ws, ctx.now) : [],
      revokeFolders: ws ? this.#revokedFolders(ws) : [],
    });
  }

  fragments(assigned: AssignedPool<McpSetContent>[], ctx: KindContext): Fragment[] {
    const out = this.#compile(assigned, ctx);
    if (ctx.workspaceId && !ctx.preview && this.store.writable) {
      this.#record(ctx.workspaceId, out, ctx.now);
      this.#compiled.set(ctx.workspaceId, { ...out, workspaceId: ctx.workspaceId });
    }
    return out.fragments;
  }

  /** What each server's delivery state is now (§9 `mcp_delivery`), and which versions each folder holds. */
  #record(workspaceId: string, out: CompileOutput, now: Date) {
    const db = this.store.db!;
    const at = now.toISOString();
    const existing = new Map(
      (db.prepare('SELECT * FROM mcp_delivery WHERE workspace_id = ?').all(workspaceId) as unknown as DeliveryRow[]).map((r) => [`${r.pool_id}\0${r.server_key}`, r]),
    );
    const upsert = db.prepare(
      `INSERT INTO mcp_delivery (workspace_id, pool_id, server_key, plugin, version_id, target, state, reason, revoked_at, killed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, pool_id, server_key) DO UPDATE SET plugin = excluded.plugin, version_id = excluded.version_id,
         target = excluded.target, state = excluded.state, reason = excluded.reason, revoked_at = excluded.revoked_at,
         killed_at = excluded.killed_at, updated_at = excluded.updated_at`,
    );
    const seen = new Set<string>();
    for (const s of out.servers) {
      const k = `${s.poolId}\0${s.key}`;
      seen.add(k);
      const had = existing.get(k);
      const revokedAt = s.state === 'revoked' ? (s.revokedAt ?? at) : null;
      // A kill done for this revocation stays recorded; a new revocation needs a new one.
      const killedAt = s.state === 'revoked' && had?.killed_at && had.revoked_at === revokedAt ? had.killed_at : null;
      const same =
        had &&
        had.plugin === s.plugin &&
        had.version_id === s.versionId &&
        had.target === s.target &&
        had.state === s.state &&
        had.reason === s.reason &&
        had.revoked_at === revokedAt &&
        had.killed_at === killedAt;
      if (!same) upsert.run(workspaceId, s.poolId, s.key, s.plugin, s.versionId, s.target, s.state, s.reason, revokedAt, killedAt, at);
    }
    // Servers no longer compiled go, except revoked ones, whose deny rule outlives them (14 days).
    const since = new Date(now.getTime() - REVOKE_DENY_MS).toISOString();
    const drop = db.prepare('DELETE FROM mcp_delivery WHERE workspace_id = ? AND pool_id = ? AND server_key = ?');
    for (const [k, r] of existing) if (!seen.has(k) && !(r.state === 'revoked' && (r.revoked_at ?? '') >= since)) drop.run(workspaceId, r.pool_id, r.server_key);
    const folder = db.prepare('INSERT INTO mcp_plugin_folders (plugin, hash12, version_ids, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
    for (const p of out.plugins) folder.run(p.plugin, p.hash12, JSON.stringify(p.versionIds), at);
  }

  delivered(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string>; pluginFolders?: Map<string, string[]> }) {
    if (ctx.pluginFolders) this.#folders.set(workspaceId, new Map([...ctx.pluginFolders].filter(([name]) => name.startsWith('cpm-'))));
    const compiled = this.#compiled.get(workspaceId);
    this.#compiled.delete(workspaceId);
    if (!compiled) return;
    // A portal restart forgets which folders a workspace has until this call: name revoked ones now.
    const listed = new Set(compiled.fragments.flatMap((f) => f.revokePluginFolders ?? []));
    if (this.#revokedFolders(workspaceId).some((f) => !listed.has(f))) this.redeliver(workspaceId, 'revoked folders');
    try {
      this.afterDelivery(compiled, { now: ctx.now, running: ctx.running });
    } catch (e) {
      console.error(`[mcp] ${workspaceId}: ${(e as Error).message}`);
    }
  }

  beforeUnassign(workspaceId: string): string[] {
    return workspaceId ? ['Running stdio MCP servers keep their values until their session ends or reloads.'] : [];
  }

  forgetWorkspace(workspaceId: string) {
    this.onForget(workspaceId);
    this.#compiled.delete(workspaceId);
    this.#folders.delete(workspaceId);
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    for (const table of ['mcp_delivery', 'mcp_installs', 'mcp_verify']) db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
  }

  /* ---------- Where things are used ---------- */

  /** Each mcpset pool's newest and deliverable revisions' content. */
  #revisions(): { poolId: string; poolName: string; contents: McpSetContent[] }[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db
      .prepare(
        `SELECT p.id, p.name, r.content FROM pools p JOIN pool_revisions r ON r.pool_id = p.id
         WHERE p.type = 'mcpset' AND (r.status = 'deliverable' OR r.revision = (SELECT max(revision) FROM pool_revisions WHERE pool_id = p.id))
         ORDER BY p.created_at, p.name, r.revision`,
      )
      .all() as { id: string; name: string; content: string }[];
    const out = new Map<string, { poolId: string; poolName: string; contents: McpSetContent[] }>();
    for (const r of rows) {
      const item = out.get(r.id) ?? { poolId: r.id, poolName: r.name, contents: [] };
      item.contents.push(JSON.parse(r.content) as McpSetContent);
      out.set(r.id, item);
    }
    return [...out.values()];
  }

  /** Catalog entry → the sets that use it (newest or deliverable revisions) and the workspaces that get them. */
  usage(): Map<string, { sets: McpEntryUse[]; workspaces: Set<string> }> {
    const out = new Map<string, { sets: McpEntryUse[]; workspaces: Set<string> }>();
    const db = this.store.db;
    if (!db) return out;
    for (const { poolId, poolName, contents } of this.#revisions()) {
      const byEntry = new Map<string, Set<string>>();
      for (const c of contents) for (const s of c.servers) byEntry.set(s.entry, (byEntry.get(s.entry) ?? new Set()).add(s.version));
      const workspaces = (db.prepare('SELECT workspace_id FROM assignments WHERE pool_id = ?').all(poolId) as { workspace_id: string }[]).map((r) => r.workspace_id);
      for (const [entry, versions] of byEntry) {
        const item = out.get(entry) ?? { sets: [], workspaces: new Set<string>() };
        item.sets.push({ poolId, poolName, versions: [...versions] });
        for (const w of workspaces) item.workspaces.add(w);
        out.set(entry, item);
      }
    }
    return out;
  }

  /** Workspaces that get a catalog version now (their effective revisions, pins included), or still had it at their last delivery. */
  workspacesWith(versionId: string): string[] {
    const cv = this.catalog.findById(versionId);
    const db = this.store.db;
    if (!cv || !db) return [];
    const out = new Set((db.prepare('SELECT DISTINCT workspace_id FROM mcp_delivery WHERE version_id = ?').all(versionId) as { workspace_id: string }[]).map((r) => r.workspace_id));
    const workspaces = db.prepare("SELECT DISTINCT workspace_id FROM assignments WHERE pool_type = 'mcpset'").all() as { workspace_id: string }[];
    for (const { workspace_id: ws } of workspaces) {
      if (out.has(ws)) continue;
      const sets = this.pools.assignedPools<McpSetContent>(ws, 'mcpset');
      if (sets.some((a) => a.content.servers.some((s) => s.entry === cv.entry.id && s.version === cv.row.version))) out.add(ws);
    }
    return [...out].sort();
  }

  // ReferenceSource (Secrets & env FR19, FR23).
  referencing(name: string): { poolId: string; poolName: string }[] {
    return this.#revisions()
      .filter((p) => p.contents.some((c) => namesIn(c).includes(name)))
      .map((p) => ({ poolId: p.poolId, poolName: p.poolName }));
  }

  namesUsedBy(workspaceId: string): Map<string, { poolId: string; poolName: string }[]> {
    const out = new Map<string, { poolId: string; poolName: string }[]>();
    for (const a of this.pools.assignedPools<McpSetContent>(workspaceId, 'mcpset'))
      for (const name of namesIn(a.content)) out.set(name, [...(out.get(name) ?? []), { poolId: a.pool.id, poolName: a.pool.name }]);
    return out;
  }
}
