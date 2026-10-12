import type { WorkspaceDeliveryState } from './accounts.js';

/**
 * Pool types on the shared pool API (foundation PRD §3, §5): secrets & env, skillsets and MCP sets, which
 * a workspace can have several of, and the personas and browser & desktop pools, which it has at most
 * one of (that kind's `beforeAssign` enforces it). A type with no kind registered is simply not served:
 * `GET /api/pools` omits it and its routes answer 404. Account pools keep their own API (`ACCOUNT_API`).
 */
export type MultiPoolType = 'secrets' | 'skillset' | 'mcpset' | 'persona' | 'context' | 'browser';

export const MULTI_POOL_TYPES: readonly MultiPoolType[] = ['secrets', 'skillset', 'mcpset', 'persona', 'context', 'browser'];

/**
 * A revision's status (Skillset PRD §18 A3). Only `deliverable` revisions reach workspaces, and only
 * a deliverable revision can be the pool's current one. `waiting_review`: the pool type wants a review
 * first (a skill not yet approved). `draft`: saved, not released.
 */
export type PoolStatus = 'draft' | 'waiting_review' | 'deliverable';

/** A paused rollout (Skillset PRD FR23): the revision reaches no more workspaces until resumed. */
export interface PoolRolloutPause {
  at: string;
  reason: string;
}

export interface PoolRevisionInfo {
  revision: number;
  status: PoolStatus;
  /** What changed, as the editor's revision note said. */
  note: string;
  createdAt: string;
  /** The revision workspaces follow unless pinned. */
  current: boolean;
  rolloutPaused: PoolRolloutPause | null;
}

export interface PoolSummary {
  id: string;
  type: MultiPoolType;
  name: string;
  description: string;
  /** The current revision: what workspaces get unless pinned. 0 while no revision is deliverable yet. */
  revision: number;
  /** The newest revision. Above `revision` while a newer one waits for review, is a draft, or is held back. */
  latestRevision: number;
  /** The newest revision's status. */
  status: PoolStatus;
  /** Set while the current revision's rollout is paused. */
  rolloutPaused: PoolRolloutPause | null;
  /** Workspaces it's assigned to. */
  workspaces: number;
  /** The newest revision's content, as the pool type shows it: never a secret value. */
  content: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PoolDetail extends PoolSummary {
  /** Newest first. */
  revisions: PoolRevisionInfo[];
  /** Where it's assigned, and which revision each workspace gets and last received. */
  assignedTo: { workspaceId: string; pinnedRevision: number | null; revision: number; deliveredRevision: number | null }[];
}

/** `POST /api/pools/:type`; `PUT /api/pools/:type/:id` takes any subset. */
export interface PoolRequest {
  name: string;
  description?: string;
  /** The pool type's content. Write-only values left out keep their stored value. */
  content: unknown;
  /** Revision note: what changed. */
  note?: string;
  /** Save the content as a draft revision: kept, never delivered until approved. */
  draft?: boolean;
  /** Keep the current revision where it is: workspaces pinned to the new one try it first (MCP set FR4). */
  hold?: boolean;
  /**
   * On an update: the newest revision the editor loaded. If the pool has moved on since (another tab, a proposal a
   * person approved while this one was open), the save is refused with a 409 instead of overwriting it.
   */
  baseRevision?: number;
}

/**
 * `POST /api/pools/:type/:id/revisions/:rev/current`. Rolling back a Secrets & env set publishes a new
 * revision with the old entries and plain values whose secrets keep their CURRENT versions (FR18), so a
 * value rotated away after a leak never comes back by accident; `restoreSecretVersions` asks for the
 * old versions instead (refused for any that was revoked).
 */
export interface PoolCurrentRequest {
  restoreSecretVersions?: boolean;
}

/** `POST /api/pools/:type/:id/rollout`: pause the current revision's rollout, or resume it. */
export interface PoolRolloutRequest {
  paused: boolean;
  reason?: string;
}

/** `POST /api/pools/:type/:id/duplicate`. */
export interface DuplicatePoolRequest {
  name: string;
}

/** `POST /api/pools/:type/:id/assign`: add the pool to several workspaces at once (bulk assignment). */
export interface AssignPoolRequest {
  workspaceIds: string[];
}

export interface AssignPoolResult {
  /** Workspaces that got the pool now. */
  assigned: string[];
  /** Workspaces that already had it. */
  already: string[];
  /** Of `assigned`, those that had another pool of a one-per-workspace type (personas), now replaced. */
  replaced?: string[];
}

/** One pool a workspace has (or is losing). */
export interface WorkspacePoolAssignment {
  type: MultiPoolType;
  poolId: string;
  poolName: string;
  /** The revision it gets now: its pin, else the current one (a paused rollout may hold it back). 0 when there's none. */
  revision: number;
  currentRevision: number;
  pinnedRevision: number | null;
  /** The pool type's settings for this workspace alone. */
  options: Record<string, unknown>;
  /** `removing` until the workspace's files no longer carry it. */
  state: 'assigned' | 'removing';
  assignedAt: string;
}

/** `GET /api/workspaces/:target/:name/pools`. */
export interface WorkspacePools {
  workspaceId: string;
  /** One entry per pool type the portal knows, in a fixed order. */
  types: { type: MultiPoolType; assignments: WorkspacePoolAssignment[] }[];
  /** What the portal last delivered into the workspace; null when nothing ever was. */
  delivery: (WorkspaceDeliveryState & { checkedAt: string | null }) | null;
}

/**
 * `PUT /api/workspaces/:target/:name/pools/:type`: the type's whole list for this workspace. Pools
 * left out are removed. For a pool it already has, an omitted `pinnedRevision` or `options` keeps
 * what's there; `pinnedRevision: null` follows the current revision again.
 */
export interface SetWorkspacePoolsRequest {
  items: { poolId: string; pinnedRevision?: number | null; options?: Record<string, unknown> }[];
}

export interface SetWorkspacePoolsResult {
  assignments: WorkspacePoolAssignment[];
  /** Things the change affects that the pool types want shown (it went ahead). */
  warnings: string[];
}

/** `POST /api/pools/:type/:id/preview` (or `/api/pools/:type/preview` for a pool not saved yet). */
export interface PoolPreviewRequest {
  /** Compile as this workspace would get it (its options, its other pools); otherwise on its own. */
  workspaceId?: string;
  /** Unsaved content from the editor; otherwise the stored revision. */
  content?: unknown;
}

/** Exactly what a pool would write (foundation PRD §10 "Preview files"). */
export interface PoolPreview {
  /** The revision compiled; for unsaved content, the number it would get. */
  revision: number;
  workspaceId: string | null;
  dirs: { path: string; mode: number; uid: number; gid: number }[];
  /** In write order. Files that carry a secret show `‹redacted›` and `redacted: true`. */
  files: { path: string; mode: number; uid: number; gid: number; content: string; redacted: boolean }[];
  /** Parts left out, and why (a Claude Code too old for them). */
  skipped: { owner: string; reason: string }[];
}

export const POOL_REDACTED = '‹redacted›';
export const POOL_NAME_MAX = 60;

export const POOLS_API = {
  /** `GET`: the pool types this portal has. */
  types: '/api/pools',
  list: (type: MultiPoolType) => `/api/pools/${type}`,
  one: (type: MultiPoolType, id: string) => `/api/pools/${type}/${id}`,
  duplicate: (type: MultiPoolType, id: string) => `/api/pools/${type}/${id}/duplicate`,
  approve: (type: MultiPoolType, id: string, revision: number) => `/api/pools/${type}/${id}/revisions/${revision}/approve`,
  /** Make a deliverable revision the current one: roll back, or promote one held back. */
  current: (type: MultiPoolType, id: string, revision: number) => `/api/pools/${type}/${id}/revisions/${revision}/current`,
  rollout: (type: MultiPoolType, id: string) => `/api/pools/${type}/${id}/rollout`,
  assign: (type: MultiPoolType, id: string) => `/api/pools/${type}/${id}/assign`,
  preview: (type: MultiPoolType, id: string | null) => (id ? `/api/pools/${type}/${id}/preview` : `/api/pools/${type}/preview`),
  /** `/api/workspaces/<target>/<name>/pools` */
  workspace: (workspaceId: string) => `/api/workspaces/${workspaceId}/pools`,
  workspaceType: (workspaceId: string, type: MultiPoolType) => `/api/workspaces/${workspaceId}/pools/${type}`,
} as const;
