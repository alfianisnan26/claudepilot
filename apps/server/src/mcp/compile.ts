import { createHash } from 'node:crypto';
import type { McpDeliveryState, McpMatcher, McpOAuthFields, McpSetContent, McpSlot } from '@portal/contracts';
import { SECRET_FILE_REF } from '@portal/contracts';
import { versionAtLeast } from '../delivery/compile.js';
import { compilePlugin } from '../delivery/marketplace.js';
import { MARKETPLACE_NAME, ROOT, type DeliveredFile, type Fragment, type PluginBundle } from '../delivery/types.js';
import type { PoolRef } from '../pools/kinds.js';
import type { SecretName } from '../pools/references.js';
import type { CatalogVersion } from './catalog.js';
import { MCP_HEADERS, MCP_LAUNCH } from './scripts.js';
import { HEADERS_HELPER, LAUNCHER, MCP_MIN_CLAUDE, MCP_TIMEOUT_MS } from './spec.js';

/**
 * The MCP fragment (MCP set PRD FR14, §10.2–§10.4): one plugin per assigned set, `cpm-<slug>`, whose
 * `.mcp.json` points stdio servers at the launcher and remote servers at their URL (with the headers
 * helper), and whose `servers/<key>.json` maps hold parts — literal text or a Secrets & env file's
 * name — never values. The drop-in enables the plugins, sets `MCP_TIMEOUT` and denies revoked servers'
 * tools. A server missing a prerequisite is left out with the reason as its delivery state; the rest
 * of its set still goes.
 */

/** A revoked server's tools stay denied this long, unless an approved version replaces it (FR13b). */
export const REVOKE_DENY_MS = 14 * 24 * 60 * 60_000;

export interface SetInput {
  pool: PoolRef;
  content: McpSetContent;
}

/** A server some earlier compile took out for a revocation, still within its deny window. */
export interface RevokedHistory {
  plugin: string;
  key: string;
  revokedAt: string;
}

export interface CompileInput {
  sets: SetInput[];
  find: (entryId: string, version: string) => CatalogVersion | null;
  /** Names the workspace's Secrets & env sets provide; null resolves every name (a preview without a workspace). */
  names: Map<string, SecretName> | null;
  claudeVersion: string | null;
  running: boolean;
  now: Date;
  history?: RevokedHistory[];
  /** Version folders holding a revoked version, `<plugin>/<hash12>`, to delete at once. */
  revokeFolders?: string[];
}

/** What happened to one server. */
export interface ServerOutcome {
  poolId: string;
  poolName: string;
  plugin: string;
  key: string;
  versionId: string | null;
  /** The launcher target, or the URL. */
  target: string | null;
  state: McpDeliveryState;
  reason: string | null;
  /** Set for revoked servers: when the version was revoked. */
  revokedAt?: string;
  /** Delivered npm servers: what to pre-install (§12). */
  install?: { ref: string; pkg: string; version: string; allowScripts: boolean };
  /** Delivered servers: what an MCP allowlist must admit (FR19). */
  matcher?: McpMatcher;
}

export interface PluginOutcome {
  poolId: string;
  plugin: string;
  /** `<revision>.0.0+<hash8>` (Skillset A2). */
  version: string;
  treeHash: string;
  hash12: string;
  /** Keys of the servers in it. */
  servers: string[];
  /** Catalog versions it holds. */
  versionIds: string[];
}

export interface CompileOutput {
  fragments: Fragment[];
  servers: ServerOutcome[];
  plugins: PluginOutcome[];
  /** Tool deny rules for revoked servers. */
  deny: string[];
}

type Part = { text: string } | { file: string } | { path: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
export const pluginName = (slug: string) => `cpm-${slug}`;
export const denyRule = (plugin: string, key: string) => `mcp__plugin_${plugin}_${key}__*`;
const and = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * A version's OAuth fields as `.mcp.json` takes them (§13.3). `scopes` is ONE space-separated string there: given the
 * catalog's list, Claude Code drops the whole server from the plugin without an error ✅ (2.1.296, B3 experiment).
 * The other fields are written as they are, in the same order.
 */
export function mcpJsonOauth(oauth: McpOAuthFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(oauth)) {
    if (k === 'scopes') {
      if (Array.isArray(v) && v.length) out.scopes = v.join(' ');
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A slot's value as parts: secrets by file name (or path), the rest as literal text. */
function slotParts(slot: McpSlot, value: Part): Part[] {
  if (slot.target !== 'header') return [value];
  const [before = '', after = ''] = (slot.template ?? '{value}').split('{value}');
  return [...(before ? [{ text: before }] : []), value, ...(after ? [{ text: after }] : [])];
}

export function compileMcp(input: CompileInput): CompileOutput {
  const now = input.now.getTime();
  const servers: ServerOutcome[] = [];
  const plugins: PluginOutcome[] = [];
  const fragments: Fragment[] = [];
  const bundles: PluginBundle[] = [];
  /** Remote URLs delivered so far in this workspace: the same URL in two sets is refused (FR11). */
  const urls = new Map<string, string>();
  const tooOld = !!input.claudeVersion && !versionAtLeast(input.claudeVersion, MCP_MIN_CLAUDE);

  for (const { pool, content } of input.sets) {
    const plugin = pluginName(content.slug);
    const mcpServers: Record<string, unknown> = {};
    const maps: [string, unknown][] = [];
    const versionIds: string[] = [];
    for (const s of content.servers) {
      const base = { poolId: pool.id, poolName: pool.name, plugin, key: s.key };
      const cv = input.find(s.entry, s.version);
      const target = cv ? (cv.target ?? cv.spec.url ?? null) : null;
      const out = (state: McpDeliveryState, reason: string | null, extra: Partial<ServerOutcome> = {}) =>
        void servers.push({ ...base, versionId: cv?.row.id ?? null, target, state, reason, ...extra });
      if (!cv) {
        out('unsupported', `${s.entry ? 'This version' : 'The server'} is no longer in the catalog.`);
        continue;
      }
      // A revoked version leaves every delivery at once, pinned revisions included (FR13b).
      if (cv.row.review_state === 'revoked') {
        out('revoked', `${cv.entry.display_name} ${cv.row.version} was revoked.`, { revokedAt: cv.row.revoked_at ?? input.now.toISOString() });
        continue;
      }
      if (!s.enabled) {
        out('disabled', 'Turned off in the set.');
        continue;
      }
      if (cv.row.review_state === 'draft') {
        out('unsupported', `${cv.entry.display_name} ${cv.row.version} isn’t approved.`);
        continue;
      }
      if (cv.entry.kind === 'pypi') {
        out('uv_missing', 'PyPI servers need uv in the workspace image.');
        continue;
      }
      if (tooOld) {
        out('claude_too_old', `Needs Claude Code ${MCP_MIN_CLAUDE} or newer; this workspace has ${input.claudeVersion}.`);
        continue;
      }

      // Values: secrets by reference to the workspace's own Secrets & env names (FR10, Secrets & env FR22).
      const values = new Map<McpSlot, Part[]>();
      const missing: string[] = [];
      const unset: string[] = [];
      for (const slot of cv.slots) {
        if (slot.secret) {
          const ref = s.secrets[slot.name];
          const name = ref ? SECRET_FILE_REF.exec(ref)?.[1] : undefined;
          if (!name) {
            if (slot.required) unset.push(slot.name);
            continue;
          }
          if (input.names && !input.names.get(name)?.file) {
            missing.push(name);
            continue;
          }
          values.set(slot, slotParts(slot, slot.target === 'path' ? { path: name } : { file: name }));
        } else {
          const v = s.config[slot.name] ?? slot.default;
          if (v === undefined || v === '') {
            if (slot.required) unset.push(slot.name);
            continue;
          }
          values.set(slot, slotParts(slot, { text: v }));
        }
      }
      if (missing.length) {
        out('missing_secret', `MCP set '${pool.name}' needs ${and([...new Set(missing)])}.`);
        continue;
      }
      if (unset.length) {
        out('unsupported', `Fill in ${and(unset)} in the set.`);
        continue;
      }

      const id = `${plugin}/${s.key}`;
      if (cv.entry.kind === 'remote') {
        const url = cv.spec.url!;
        const clash = urls.get(url);
        if (clash) {
          out('unsupported', `Same URL as ${clash}: which plugin wins is undocumented, so a workspace can’t have both.`);
          continue;
        }
        urls.set(url, id);
        const headers = Object.fromEntries([...values].filter(([slot]) => slot.target === 'header').map(([slot, parts]) => [slot.name, parts]));
        const entry: Record<string, unknown> = { type: cv.spec.transport === 'sse' ? 'sse' : 'http', url };
        if (Object.keys(headers).length) entry.headersHelper = `${HEADERS_HELPER} ${id}`;
        if (cv.spec.auth === 'oauth' && cv.spec.oauth) entry.oauth = mcpJsonOauth(cv.spec.oauth);
        mcpServers[s.key] = entry;
        maps.push([s.key, { url, headers }]);
        out(input.running ? 'delivered' : 'pending_start', null, { matcher: { serverUrl: url } });
      } else {
        const args = cv.spec.args ?? [];
        const env = Object.fromEntries([...values].map(([slot, parts]) => [slot.name, parts]));
        const launch = [`${id}`, '--', cv.target!, ...args];
        mcpServers[s.key] = { command: LAUNCHER, args: launch };
        maps.push([s.key, { target: cv.target, args, env, ...(cv.spec.bin ? { bin: cv.spec.bin } : {}), ...(cv.spec.allowScripts ? { allowScripts: true } : {}) }]);
        const install =
          cv.entry.kind === 'npm' ? { ref: cv.target!, pkg: cv.spec.package!, version: cv.row.version, allowScripts: !!cv.spec.allowScripts } : undefined;
        out(input.running ? 'delivered' : 'pending_start', null, { matcher: { serverCommand: [LAUNCHER, ...launch] }, ...(install ? { install } : {}) });
      }
      versionIds.push(cv.row.id);
    }

    if (maps.length) {
      const files = [{ path: '.mcp.json', content: json({ mcpServers }) }, ...maps.map(([key, map]) => ({ path: `servers/${key}.json`, content: json(map) }))];
      const hash8 = sha256(files.map((f) => `${f.path}\0${f.content}`).join('\0')).slice(0, 8);
      const bundle: PluginBundle = { name: plugin, version: `${pool.revision}.0.0+${hash8}`, description: `MCP set ${pool.name}`, files };
      const compiled = compilePlugin('mcpset', bundle);
      if (typeof compiled === 'string') throw new Error(`mcpset: ${compiled}`);
      bundles.push(bundle);
      plugins.push({
        poolId: pool.id,
        plugin,
        version: bundle.version,
        treeHash: compiled.treeHash,
        hash12: compiled.treeHash.slice(0, 12),
        servers: maps.map(([key]) => key),
        versionIds,
      });
      fragments.push({ owner: 'mcpset', pool: { id: pool.id, revision: pool.revision }, plugins: [bundle] });
    } else {
      // Nothing of it to deliver here: still named, so the manifest accounts for the pool (§6.5).
      fragments.push({ owner: 'mcpset', pool: { id: pool.id, revision: pool.revision } });
    }
  }

  // Revoked servers' tools stay denied for 14 days, unless an approved version now takes their place.
  const delivered = new Set(servers.filter((s) => s.state === 'delivered' || s.state === 'pending_start').map((s) => `${s.plugin}/${s.key}`));
  const recent = (at: string) => now - Date.parse(at) < REVOKE_DENY_MS;
  const deny = new Set<string>();
  for (const s of servers) if (s.state === 'revoked' && recent(s.revokedAt!) && !delivered.has(`${s.plugin}/${s.key}`)) deny.add(denyRule(s.plugin, s.key));
  for (const h of input.history ?? []) if (recent(h.revokedAt) && !delivered.has(`${h.plugin}/${h.key}`)) deny.add(denyRule(h.plugin, h.key));

  const settings: Record<string, unknown> = {};
  if (plugins.length) {
    settings.enabledPlugins = Object.fromEntries(plugins.map((p) => [`${p.plugin}@${MARKETPLACE_NAME}`, true]));
    settings.env = { MCP_TIMEOUT: MCP_TIMEOUT_MS };
  }
  if (deny.size) settings.permissions = { deny: [...deny].sort() };
  const current = new Set(plugins.map((p) => `${p.plugin}/${p.hash12}`));
  const revoke = [...new Set(input.revokeFolders ?? [])].filter((f) => !current.has(f)).sort();
  const scripts: DeliveredFile[] = plugins.length
    ? [
        { path: LAUNCHER, content: MCP_LAUNCH, mode: 0o755, uid: ROOT, gid: ROOT },
        { path: HEADERS_HELPER, content: MCP_HEADERS, mode: 0o755, uid: ROOT, gid: ROOT },
      ]
    : [];
  if (scripts.length || Object.keys(settings).length || revoke.length)
    fragments.push({
      owner: 'mcpset',
      ...(scripts.length ? { files: scripts } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(revoke.length ? { revokePluginFolders: revoke } : {}),
    });
  return { fragments, servers, plugins, deny: [...deny].sort() };
}
