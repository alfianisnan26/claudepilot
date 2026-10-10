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
}

export interface Manifest {
  portalId: string;
  generation: number;
  compiledAt: string;
  pools: { type: Owner; id: string; revision: number }[];
  /** path → sha256 of the delivered content. */
  files: Record<string, string>;
}

/** Everything a workspace should have, in write order (foundation §6.4). */
export interface Bundle {
  dirs: DeliveredDir[];
  /** Referenced files first, then drop-ins. The manifest is written last, separately. */
  files: DeliveredFile[];
  manifest: Manifest;
  /** Hash of what is delivered (not of generation or time): equal hashes mean nothing to write. */
  hash: string;
  /** Fragments left out, and why (for example a Claude Code version too old). */
  skipped: { owner: Owner; reason: string }[];
}

export const MANIFEST_PATH = '/etc/claudepilot/state.json';
export const DROPIN_DIR = '/etc/claude-code/managed-settings.d';
