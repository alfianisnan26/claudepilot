import { createHash } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  SKILLSET_MIN_CLAUDE_VERSION,
  skillsetPrefixProblem,
  type SkillsetContentView,
  type SkillsetEntryView,
  type SkillsetMode,
} from '@portal/contracts';
import { mayNamePlugin } from '../delivery/ownership.js';
import { dropInPath } from '../delivery/ownership.js';
import { MARKETPLACE_NAME, type Fragment } from '../delivery/types.js';
import type { AssignedPool, KindContext, ParseContext, PoolKind } from '../pools/kinds.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { SkillsLibrary } from './library.js';
import { compileSet, type CompiledSet, type StoredEntry, type StoredSkillset } from './plugin.js';

/** Revoked skills stay denied this long (`Skill(<prefix>:<name>)`, Skillset §11.3). */
export const REVOCATION_DENY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SKILLS = 300;
const MODES: SkillsetMode[] = ['on', 'manual', 'off'];
const HASH12 = /^[0-9a-f]{12}$/;

/** What one delivery shipped for one set: what verification expects to find (FR21). */
export interface Expected {
  poolId: string;
  poolName: string;
  revision: number;
  prefix: string;
  /** The current version folder's `<hash12>`. */
  folder: string;
  skills: string[];
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const pluginId = (prefix: string) => `${prefix}@${MARKETPLACE_NAME}`;
/** `Frontend Tools` → `frontend-tools`. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

/**
 * The skillset pool type (Skillset PRD §8–§11). A revision's content is a command prefix and a list of
 * skill versions, each On, Manual or Off. A revision that turns on a skill not yet approved waits for
 * review and becomes current once every such skill is approved (FR14). Each assigned set is delivered
 * as one plugin in the portal marketplace, switched on by `enabledPlugins` in the skillset drop-in.
 *
 * Revoked versions are never delivered, whatever revision a workspace is on or pinned to: the compiler
 * leaves them out, names every version folder that still holds one for deletion at once, and denies
 * the skill by name for 14 days so sessions that loaded it can't run it (§11.3).
 */
export class SkillsetKind implements PoolKind<StoredSkillset> {
  readonly type = 'skillset' as const;
  /** What each fragments() call compiled, for the delivered() that follows it. */
  readonly #compiled = new Map<string, { expected: Expected[]; settings: boolean }>();
  /** Compiled sets by content, so the 60 s reconcile doesn't rebuild unchanged plugins from blobs. */
  readonly #cache = new Map<string, CompiledSet>();
  /** Called after each delivery with what shipped (verification, FR21). */
  onDelivered: (workspaceId: string, ctx: { running: boolean; now: Date; expected: Expected[] | null }) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly library: SkillsLibrary,
    private readonly service: () => PoolService,
    private readonly opts: { minClaudeVersion?: string } = {},
  ) {}

  get minClaudeVersion() {
    return this.opts.minClaudeVersion ?? SKILLSET_MIN_CLAUDE_VERSION;
  }

  /* ---------- Content ---------- */

  /** The pool other than `exceptPoolId` whose newest or current revision uses `prefix`, by name. */
  #prefixOwner(prefix: string, exceptPoolId: string | undefined): string | null {
    const rows = (this.store.db?.prepare(
      `SELECT p.id, p.name, r.content FROM pools p JOIN pool_revisions r ON r.pool_id = p.id
       WHERE p.type = 'skillset' AND p.id IS NOT ? AND (r.revision = p.current_revision OR r.revision = (SELECT max(revision) FROM pool_revisions WHERE pool_id = p.id))`,
    ).all(exceptPoolId ?? null) ?? []) as { id: string; name: string; content: string }[];
    for (const r of rows) if (json<Partial<StoredSkillset>>(r.content, {}).prefix === prefix) return r.name;
    return null;
  }

  /** A free prefix for a copy (Duplicate asks for a new prefix, FR15): from the copy's name, else `<prefix>-copy`. */
  #freePrefix(base: string, poolId: string): string {
    const name = (this.store.db?.prepare('SELECT name FROM pools WHERE id = ?').get(poolId) as { name: string } | undefined)?.name ?? '';
    const stem = slug(name) || `${base}-copy`;
    for (let i = 1; i < 100; i++) {
      const candidate = i === 1 ? stem : `${stem.slice(0, 36)}-${i}`;
      if (!skillsetPrefixProblem(candidate) && mayNamePlugin('skillset', candidate) && !this.#prefixOwner(candidate, poolId)) return candidate;
    }
    return base;
  }

  parse(input: unknown, prev: StoredSkillset | null, ctx?: ParseContext): StoredSkillset {
    const i = isObject(input) ? input : {};
    let prefix = typeof i.prefix === 'string' ? i.prefix.trim() : '';
    // Duplicating: the copy can't keep the source's prefix (FR12: unique across portal plugins).
    if (ctx && ctx.revision === 1 && prev !== null) prefix = this.#freePrefix(prefix, ctx.poolId);
    const problem = skillsetPrefixProblem(prefix) ?? (mayNamePlugin('skillset', prefix) ? null : 'Claude Code or another pool type reserves that name.');
    if (problem) throw invalid('prefix', problem);
    const owner = this.#prefixOwner(prefix, ctx?.poolId);
    if (owner) throw invalid('prefix', `${owner} already uses /${prefix}:. Pick another prefix.`);

    if (i.skills !== undefined && !Array.isArray(i.skills)) throw invalid('skills', 'Send the list of skills.');
    const list = (i.skills ?? []) as unknown[];
    if (list.length > MAX_SKILLS) throw invalid('skills', `A set holds at most ${MAX_SKILLS} skills.`);
    const ids = list.map((s) => (isObject(s) && typeof s.versionId === 'string' ? s.versionId : ''));
    const versions = this.library.versions(ids.filter(Boolean));
    const reviews = this.library.reviewStates([...versions.values()].map((v) => v.treeHash));
    const names = new Set<string>();
    const seen = new Set<string>();
    const skills: StoredEntry[] = list.map((raw, n) => {
      if (!isObject(raw) || typeof raw.versionId !== 'string') throw invalid('skills', `Skill ${n + 1} needs a version.`);
      const v = versions.get(raw.versionId);
      if (!v) throw invalid('skills', 'One of the skills is no longer in the library.');
      if (seen.has(v.id)) throw invalid('skills', `${v.name} is listed twice.`);
      seen.add(v.id);
      if (names.has(v.name)) throw invalid('skills', `Two skills are named “${v.name}”. Names must be unique in a set.`);
      names.add(v.name);
      const mode = raw.mode === undefined ? 'on' : raw.mode;
      if (!MODES.includes(mode as SkillsetMode)) throw invalid('skills', `${v.name}: pick On, Manual or Off.`);
      const state = reviews.get(v.treeHash)?.state;
      if (mode !== 'off' && (state === 'revoked' || state === 'rejected')) throw invalid('skills', `${v.name} was ${state}. Turn it off or remove it.`);
      return { versionId: v.id, treeHash: v.treeHash, mode: mode as SkillsetMode, stripAllowedTools: raw.stripAllowedTools === true && v.allowedTools };
    });
    return { prefix, skills };
  }

  view(content: StoredSkillset): SkillsetContentView {
    const versions = this.library.versions(content.skills.map((s) => s.versionId));
    const reviews = this.library.reviewStates(content.skills.map((s) => s.treeHash));
    return {
      prefix: content.prefix,
      skills: content.skills.map((s): SkillsetEntryView => {
        const v = versions.get(s.versionId);
        return {
          versionId: s.versionId,
          mode: s.mode,
          stripAllowedTools: s.stripAllowedTools,
          name: v?.name ?? 'Removed skill',
          description: v?.description ?? '',
          treeHash: s.treeHash,
          scripted: v?.scripted ?? false,
          risk: v?.risk ?? 'low',
          review: reviews.get(s.treeHash)?.state ?? 'needs_review',
          allowedTools: v?.allowedTools ?? false,
          listingChars: v?.listingChars ?? 0,
          ...(v ? {} : { missing: true }),
        };
      }),
    };
  }

  /** Skills a revision turns on that aren't approved, by name. */
  #unapproved(content: StoredSkillset): string[] {
    const on = content.skills.filter((s) => s.mode !== 'off');
    const reviews = this.library.reviewStates(on.map((s) => s.treeHash));
    const versions = this.library.versions(on.map((s) => s.versionId));
    return on.filter((s) => reviews.get(s.treeHash)?.state !== 'approved').map((s) => versions.get(s.versionId)?.name ?? 'a removed skill');
  }

  /** FR14: deliverable once every skill it turns on is approved; turning skills off never waits. */
  review(content: StoredSkillset): 'deliverable' | 'waiting_review' {
    return this.#unapproved(content).length ? 'waiting_review' : 'deliverable';
  }

  approve(content: StoredSkillset): void {
    const missing = this.#unapproved(content);
    if (missing.length) throw new AppError('CONFLICT', `Approve ${missing.join(', ')} in the Library first.`);
  }

  beforeUnassign(workspaceId: string): string[] {
    return workspaceId ? ['Open Claude Code sessions keep its skills until /reload-plugins or a restart.'] : [];
  }

  forgetWorkspace(workspaceId: string): void {
    this.#compiled.delete(workspaceId);
    if (this.store.writable) this.store.db!.prepare('DELETE FROM skill_inventory WHERE workspace_id = ?').run(workspaceId);
  }

  /* ---------- Delivery ---------- */

  /** A set compiled at a revision, cached by everything that decides its output. */
  compiled(pool: { name: string; revision: number }, content: StoredSkillset, preview = false): CompiledSet {
    const reviews = this.library.reviewStates(content.skills.map((s) => s.treeHash));
    const key = JSON.stringify([preview, pool.name, pool.revision, content.prefix, content.skills.map((s) => [s.versionId, s.treeHash, s.mode, s.stripAllowedTools, reviews.get(s.treeHash)?.state])]);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const set = compileSet(this.library, pool, content, { preview });
    if (this.#cache.size >= 200) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(key, set);
    return set;
  }

  /** Skillset plugin version folders in the workspace, as the engine last reported them: plugin → `<hash12>`s. */
  folders(workspaceId: string): Record<string, string[]> {
    const row = this.store.db?.prepare('SELECT folders FROM skill_inventory WHERE workspace_id = ?').get(workspaceId) as { folders: string } | undefined;
    const raw = json<Record<string, unknown>>(row?.folders, {});
    const out: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(raw))
      if (mayNamePlugin('skillset', name) && Array.isArray(list)) out[name] = list.filter((h): h is string => typeof h === 'string' && HASH12.test(h));
    return out;
  }

  /** Tree hashes each known version folder holds (`skill_plugin_folders`). */
  #folderContents(name: string, hash12: string): string[] {
    const row = this.store.db?.prepare('SELECT tree_hashes FROM skill_plugin_folders WHERE plugin = ? AND hash12 = ?').get(name, hash12) as { tree_hashes: string } | undefined;
    return json<string[]>(row?.tree_hashes, []);
  }

  /**
   * Deny rules for skills revoked in the last 14 days (§11.3), from every revision of the workspace's
   * sets (a session may have loaded an older one), with the prefix that revision used.
   */
  denyRules(poolIds: string[], now: Date): { rule: string; command: string; until: string }[] {
    const recent = this.library.revokedSince(new Date(now.getTime() - REVOCATION_DENY_MS));
    if (!recent.size) return [];
    const out = new Map<string, { rule: string; command: string; until: string }>();
    for (const poolId of poolIds) {
      const revisions = (this.store.db?.prepare('SELECT content FROM pool_revisions WHERE pool_id = ?').all(poolId) ?? []) as { content: string }[];
      for (const r of revisions) {
        const c = json<Partial<StoredSkillset>>(r.content, {});
        if (typeof c.prefix !== 'string' || !mayNamePlugin('skillset', c.prefix) || !Array.isArray(c.skills)) continue;
        const hits = c.skills.filter((s) => recent.has(s.treeHash));
        if (!hits.length) continue;
        const versions = this.library.versions(hits.map((s) => s.versionId));
        for (const s of hits) {
          const name = versions.get(s.versionId)?.name;
          if (!name || !/^[^\s():]+$/.test(name)) continue;
          const until = new Date(new Date(recent.get(s.treeHash)!).getTime() + REVOCATION_DENY_MS).toISOString();
          for (const rule of [`Skill(${c.prefix}:${name})`, `Skill(${c.prefix}:${name} *)`]) out.set(rule, { rule, command: `/${c.prefix}:${name}`, until });
        }
      }
    }
    return [...out.values()];
  }

  fragments(assigned: AssignedPool<StoredSkillset>[], ctx: KindContext): Fragment[] {
    const out: Fragment[] = [];
    const enabled: Record<string, boolean> = {};
    const expected: Expected[] = [];
    const record = !ctx.preview && this.store.writable;
    const min = this.minClaudeVersion;
    for (const a of assigned) {
      const set = this.compiled(a.pool, a.content, ctx.preview);
      const fragment: Fragment = { owner: 'skillset', pool: { id: a.pool.id, revision: a.pool.revision }, minClaudeVersion: min };
      if (set.bundle && set.hash12) {
        fragment.plugins = [set.bundle];
        enabled[pluginId(a.content.prefix)] = true;
        expected.push({ poolId: a.pool.id, poolName: a.pool.name, revision: a.pool.revision, prefix: a.content.prefix, folder: set.hash12, skills: set.skills.map((s) => s.name) });
        if (record)
          this.store
            .db!.prepare('INSERT OR IGNORE INTO skill_plugin_folders (plugin, hash12, tree_hashes, created_at) VALUES (?, ?, ?, ?)')
            .run(a.content.prefix, set.hash12, JSON.stringify(set.skills.map((s) => s.treeHash)), ctx.now.toISOString());
      }
      out.push(fragment);
    }

    // Plugins whose folders are still in the workspace but no longer shipped stay switched off until
    // they're gone (unassigned, renamed, emptied or revoked), and folders holding a revoked version go
    // at once, retained ones included (§10.2, §11.3).
    const present = ctx.workspaceId ? this.folders(ctx.workspaceId) : {};
    const revoked = this.library.revokedHashes();
    const revoke: string[] = [];
    for (const [name, hashes] of Object.entries(present)) {
      if (!(pluginId(name) in enabled)) enabled[pluginId(name)] = false;
      const current = expected.find((e) => e.prefix === name)?.folder;
      for (const h of hashes) if (h !== current && this.#folderContents(name, h).some((t) => revoked.has(t))) revoke.push(`${name}/${h}`);
    }
    const deny = this.denyRules(
      assigned.map((a) => a.pool.id),
      ctx.now,
    ).map((d) => d.rule);
    const settings: Record<string, unknown> = {};
    if (Object.keys(enabled).length) settings.enabledPlugins = enabled;
    if (deny.length) settings.permissions = { deny: deny.sort() };
    if (Object.keys(settings).length || revoke.length)
      out.push({ owner: 'skillset', settings, minClaudeVersion: min, ...(revoke.length ? { revokePluginFolders: revoke.sort() } : {}) });
    if (ctx.workspaceId && !ctx.preview) this.#compiled.set(ctx.workspaceId, { expected, settings: Object.keys(settings).length > 0 });
    return out;
  }

  delivered(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string>; pluginFolders?: Map<string, string[]> }): void {
    const compiled = this.#compiled.get(workspaceId);
    this.#compiled.delete(workspaceId);
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    const folders: Record<string, string[]> = {};
    for (const [name, hashes] of ctx.pluginFolders ?? []) if (mayNamePlugin('skillset', name)) folders[name] = [...new Set(hashes)].filter((h) => HASH12.test(h)).sort();
    db.prepare('INSERT INTO skill_inventory (workspace_id, folders) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET folders = excluded.folders').run(workspaceId, JSON.stringify(folders));
    if (!compiled) return;
    // The drop-in is only written when this kind's fragments weren't left out (a Claude Code too old).
    const applied = !compiled.settings || ctx.delivered.has(dropInPath('skillset')!);
    this.onDelivered(workspaceId, { running: ctx.running, now: ctx.now, expected: applied ? compiled.expected : null });
  }
}

/** Stable hash of what shipped, to tell whether verification is about the current delivery. */
export const expectedHash = (expected: Expected[]) =>
  createHash('sha256')
    .update(JSON.stringify([...expected].sort((a, b) => a.prefix.localeCompare(b.prefix)).map((e) => [e.poolId, e.revision, e.prefix, e.folder, [...e.skills].sort()])))
    .digest('hex')
    .slice(0, 16);
