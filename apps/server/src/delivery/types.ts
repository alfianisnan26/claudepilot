/** Pool types (foundation PRD §3), and the foundation itself, which owns shared files. */
export type PoolType = 'policy' | 'secrets' | 'mcpset' | 'account' | 'persona' | 'skillset' | 'browser';
export type Owner = PoolType | 'foundation';

export const ROOT = 0;
export const NODE = 1000;

export interface DeliveredFile {
  /** Absolute path in the workspace. */
  path: string;
  content: string;
  mode: number;
  uid: number;
  gid: number;
  /** Set for files that carry a secret: recorded in `exposures` (foundation §5). */
  secretRef?: string;
  /** Additive: `base64` when `content` holds a file's bytes (a binary asset in a skill); otherwise it is text. */
  encoding?: 'base64';
}

export interface DeliveredDir {
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

/** One owner's contribution to a workspace (foundation §6.1). */
export interface Fragment {
  owner: Owner;
  pool?: { id: string; revision: number };
  dirs?: DeliveredDir[];
  files?: DeliveredFile[];
  /** Managed-settings keys, written as this owner's drop-in in `managed-settings.d`. */
  settings?: Record<string, unknown>;
  /** Lowest Claude Code version this fragment needs; below it, the fragment is left out. */
  minClaudeVersion?: string;
  /**
   * Plugins this owner ships in the portal marketplace (skillsets, MCP sets, personas). Each becomes a
   * version folder named by its tree hash plus an entry in the foundation's catalog. Enabling one is
   * still the owner's job: `"<name>@claudepilot": true` in its own `enabledPlugins` (false to keep a
   * plugin whose folders may linger switched off).
   */
  plugins?: PluginBundle[];
  /**
   * Version folders of this owner's plugins to delete at once, ignoring retention, as `<name>/<hash12>`:
   * a revoked skill or server version (skillset §11.3, MCP set FR13b). A running workspace loses them in
   * the same reconcile, right after the catalog stops naming them; a stopped one at its next start, and
   * the catalog never names them meanwhile. Only folders that are no longer current; keep listing one
   * until the provider's `delivered` callback no longer reports it in `pluginFolders`.
   */
  revokePluginFolders?: string[];
  /**
   * Tombstones (secrets PRD A6, foundation §6.4): opts this owner's `env` names in to being kept, with a
   * safe value, after they leave `settings.env`. A changed `env` value reaches running sessions at their
   * next request, but a removed one only reaches new sessions, so a removed name stays in this owner's
   * drop-in until no `claude` process that started before the removal still runs. A stopped workspace
   * drops it at once. Without this field names are removed outright, as before.
   */
  envTombstones?: EnvTombstones;
  /**
   * Hooks in the image this owner's files need (secrets PRD A3, §10.3), for workspaces whose image predates
   * them. `shell`: login and interactive bash source `/etc/claudepilot/secrets/env.sh`. The foundation then
   * delivers its hook files with the bundle (and removes them with the last fragment asking for them), and
   * appends each hook's line to a file nobody owns (`/etc/bash.bashrc`) once per workspace, on a running
   * workspace: never repaired, never removed. Owners declare which hooks they may ask for.
   */
  hooks?: HookName[];
  /**
   * Secrets PRD FR12: after a write to a running workspace, check as the workspace user that this fragment's
   * files, and its owner's drop-in, are readable (Claude Code starts without a drop-in it can't read). One
   * that isn't fails the delivery, naming the paths.
   */
  checkReadable?: boolean;
}

/** The image hooks a fragment can ask the foundation for (secrets PRD A3). */
export type HookName = 'shell';

/** A line a hook appends once to a file nobody owns (secrets PRD A3). */
export interface HookLine {
  path: string;
  line: string;
}

export interface EnvTombstones {
  /** Safe value per name, recorded when the name is delivered; names not listed fall back to `''`. */
  safeValues?: Record<string, string>;
  /** Names removed outright instead (harmless leftovers, such as MCP sets' `MCP_TIMEOUT`). */
  except?: string[];
}

/** A plugin an owner ships in the portal marketplace (foundation F6, skillset A2). */
export interface PluginBundle {
  /** Plugin name; must satisfy the owner's naming rule (MCP sets: `cpm-<set>`; skillsets: the set's own prefix, which may not start with another owner's reserved prefix). */
  name: string;
  /** Label shown by Claude Code, e.g. `<revision>.0.0+<hash8>`. */
  version: string;
  description?: string;
  /** Files inside the plugin root: relative paths, no leading slash, no `..`. `.claude-plugin/plugin.json` is generated from name, version and description unless the owner provides one. `encoding: 'base64'` marks bytes (binary assets). */
  files: { path: string; content: string; mode?: number; encoding?: 'base64' }[];
}

/** A compiled plugin: one version folder, complete before the catalog names it. */
export interface BundlePlugin {
  owner: Owner;
  name: string;
  version: string;
  description?: string;
  /** Skillset FR6 tree hash of the folder's files. The folder is named by its first 12 hex digits. */
  treeHash: string;
  /** `/etc/claudepilot/marketplace/plugins/<name>/<hash12>`. */
  dir: string;
  /** Folders inside `dir`, parents first: root-owned, 0755. */
  dirs: DeliveredDir[];
  /** Its files at their final paths: root-owned, 0644, or 0755 when the owner asked for an executable mode. */
  files: DeliveredFile[];
}

/**
 * An `env` name an owner stopped delivering, kept in its drop-in with a safe value (secrets PRD A6).
 * Stored per workspace in `workspace_delivery.pending_deletes`, next to the files on their way out.
 */
export interface Tombstone {
  owner: Owner;
  name: string;
  value: string;
  /** When the safe value reached the workspace (epoch ms). A `claude` process started before it may hold the old value. */
  since: number;
}

/** A version folder the manifest says is current (the catalog points at it). */
export interface ManifestPlugin {
  owner: Owner;
  name: string;
  version: string;
  treeHash: string;
}

export interface Manifest {
  portalId: string;
  generation: number;
  compiledAt: string;
  pools: { type: Owner; id: string; revision: number }[];
  /** path → sha256 of the delivered content. */
  files: Record<string, string>;
  /** Plugin version folders the catalog points at (F6), checked by tree hash rather than file by file. */
  plugins?: ManifestPlugin[];
  /** `env` names delivered under tombstone tracking, with the safe value each one falls back to: owner → name → value. */
  env?: Partial<Record<Owner, Record<string, string>>>;
  /** Hook lines already appended (A3), so they're appended once: never again, even after an edit by hand. */
  lines?: HookLine[];
}

/** Everything a workspace should have, in write order (foundation §6.4). */
export interface Bundle {
  dirs: DeliveredDir[];
  /**
   * Referenced files first, then the marketplace catalog, then drop-ins. Plugin version folders go after
   * the referenced files and before the catalog. The manifest is written last, separately.
   */
  files: DeliveredFile[];
  /** Plugin version folders (F6), each written whole before the catalog points at it. */
  plugins: BundlePlugin[];
  /** Tombstones in this bundle's drop-ins: the ones carried in, plus names removed by this compile (`since` = compile time). */
  tombstones: Tombstone[];
  /** Version folders to delete at once (`revokePluginFolders`), as absolute paths ending in `/`. */
  revoked: string[];
  manifest: Manifest;
  /** Hash of what is delivered (not of generation or time): equal hashes mean nothing to write. */
  hash: string;
  /** Fragments left out, and why (for example a Claude Code version too old). */
  skipped: { owner: Owner; reason: string }[];
  /** Lines the requested hooks append once (A3); empty when no fragment asks for a hook. */
  lines?: HookLine[];
  /** Files to check as the workspace user after a write to a running workspace (FR12). */
  readable?: string[];
}

export const MANIFEST_PATH = '/etc/claudepilot/state.json';
export const DROPIN_DIR = '/etc/claude-code/managed-settings.d';

/** The portal's plugin marketplace (foundation §7, skillset A2): one directory, registered once by the foundation. */
export const MARKETPLACE_NAME = 'claudepilot';
export const MARKETPLACE_DIR = '/etc/claudepilot/marketplace';
export const MARKETPLACE_JSON = `${MARKETPLACE_DIR}/.claude-plugin/marketplace.json`;
export const PLUGINS_DIR = `${MARKETPLACE_DIR}/plugins`;
