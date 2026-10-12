import type { Fragment } from '../delivery/types.js';

/**
 * Pool types on the shared pool service (foundation PRD §3, §5): secrets & env, skillsets and MCP sets,
 * which a workspace can have several of, and personas and browser & desktop, which it has at most one of
 * (the kind's `beforeAssign` enforces that). The same union as `MultiPoolType` in @portal/contracts. A
 * type nobody registered a kind for is not served: routes answer 404 and listings leave it out.
 */
export type MultiPoolType = 'secrets' | 'skillset' | 'mcpset' | 'persona' | 'context' | 'browser';

/** A pool as one workspace gets it. */
export interface PoolRef {
  id: string;
  /** Its name now. Renaming makes no revision, so it suits labels and messages better than delivered names. */
  name: string;
  /** The revision `content` comes from: the workspace's effective revision. */
  revision: number;
}

/** One assigned pool at the revision the workspace gets, as `fragments` and other kinds see it. */
export interface AssignedPool<C> {
  pool: PoolRef;
  /** That revision's content, as `parse` stored it (so it may hold references to side data). */
  content: C;
  /** This workspace's own settings for the pool (`assignments.options`), as `parseOptions` returned them. */
  options: Record<string, unknown>;
}

/** What a kind knows about the delivery it compiles for. */
export interface KindContext {
  /** `<target>/<name>`; '' when previewing a pool on its own, without a workspace. */
  workspaceId: string;
  /** Whether the workspace is running (a stopped one gets files without anything reading them). */
  running: boolean;
  now: Date;
  /**
   * Additive: set when compiling for "Preview files" (foundation PRD §10). Put a placeholder where a
   * secret value would go in `settings`: drop-ins are shown as they are, while files with a
   * `secretRef` are redacted for you.
   */
  preview?: boolean;
}

/** Additive: where the content `parse` returns will be stored. */
export interface ParseContext {
  /**
   * The pool the new revision belongs to. Its `pools` row already exists inside the same transaction,
   * also for a pool being created or a preview of a pool not saved yet (rolled back afterwards).
   */
  poolId: string;
  /** The revision number the content will get. */
  revision: number;
}

/**
 * One multi-assignment pool type, registered with `PoolService.register`. The service owns pools,
 * immutable revisions, statuses, rollout pauses and assignments (foundation tables); a kind only says
 * what its content is and what it delivers. Every method is synchronous and runs inside the portal's
 * single database connection.
 */
export interface PoolKind<C = unknown> {
  /** The pool type this kind handles; one kind per type. */
  type: MultiPoolType;
  /**
   * Additive: a workspace has at most one pool of this type (personas, browser & desktop). The list a
   * workspace sets may hold one; bulk assignment replaces the pool it had, with a removal record for the
   * old one, instead of adding a second; the create dialog's Add-ons take one.
   */
  single?: boolean;
  /**
   * Validates API input into stored content. `prev` is the current revision's content (null on create),
   * so write-only values the input omits can be carried over. May persist side data (e.g. encrypted
   * value versions) and return references to it. Throws AppError('VALIDATION_FAILED', message, { details })
   * on bad input.
   *
   * More precisely, `prev` is the pool's newest revision: the current one, or a newer one waiting for
   * review (or a draft), since edits continue from what the editor showed. Runs inside the service's
   * transaction, which is rolled back when anything fails and always for "Preview files": write side
   * data with plain statements, never BEGIN or COMMIT. Duplicating a pool calls
   * `parse(view(source), source, { poolId: <the copy> })`, so side data that belongs to one pool must be
   * copied when `prev` refers to another pool's.
   */
  parse(input: unknown, prev: C | null, ctx?: ParseContext): C;
  /**
   * Content as the API returns it: never a secret value. Its shape must be valid `parse` input (with
   * write-only values left out), since editors send it back.
   */
  view(content: C): unknown;
  /**
   * Status of a new revision: 'deliverable' (default) or 'waiting_review' when the kind requires a
   * review first. `prev` is what workspaces get now (the current revision's content; null when none),
   * so a change that only takes things away can skip the review.
   */
  review?(content: C, prev: C | null): 'deliverable' | 'waiting_review';
  /**
   * Additive: before a revision waiting for review (or a draft) becomes deliverable through `approve`.
   * Throw AppError('CONFLICT', …) to refuse, for example while a skill it turns on is still unreviewed.
   */
  approve?(content: C): void;
  /**
   * Additive: what a roll back publishes (Secrets & env FR18). `makeCurrent` calls it when it moves to a
   * revision older than the current one. `target` is that revision's content and `current` what workspaces
   * get now (null when nothing is current). Return the content to publish as a NEW revision, so history
   * is never rewritten, or `target` itself when it can move as it is. A kind that keeps values outside its
   * revisions uses it so an old revision can't bring back what was rotated or removed since: its secret
   * values keep their current versions unless `restoreSecrets` says the admin chose otherwise. Throw
   * AppError('CONFLICT', …) to refuse. Without this hook, a roll back just points at the old revision.
   * Runs inside the service's transaction: write side data with plain statements, never BEGIN or COMMIT.
   */
  rollback?(target: C, current: C | null, opts: { poolId: string; restoreSecrets: boolean }): C;
  /**
   * Additive: refuses (throws AppError('CONFLICT', …)) making `next` the current revision when that would
   * break what others rely on (Secrets & env FR9 and FR23: a name another pool uses, a clash across a
   * workspace's sets), the checks an edit goes through in `parse`. Called for every `makeCurrent` with
   * the content that would become current (after `rollback`); `current` is what workspaces get now.
   */
  beforeCurrent?(next: C, current: C | null, poolId: string): void;
  /**
   * Additive: why a revision can't be pinned to or rolled back to as it is, or null (Secrets & env FR18:
   * it holds a secret version that was revoked). Checked when a workspace is pinned to the revision.
   */
  unusable?(content: C): string | null;
  /**
   * Validates per-workspace options (assignments.options); default: must be an empty object. `content`
   * is the revision the workspace gets. New assignments without options pass `{}`.
   */
  parseOptions?(input: unknown, content: C): Record<string, unknown>;
  /**
   * The workspace's fragments from ALL of its assigned pools of this kind, each at its effective revision
   * (pinned, else the newest deliverable, not past a rollout pause). [] when nothing to deliver.
   *
   * Every fragment's `owner` must be this kind's type. Only one of them may carry `settings` (a type
   * has one drop-in), so merge the pools' settings there. Name each pool you deliver in some fragment's
   * `pool` (an otherwise empty fragment will do): the manifest then lists it, and a pool the database
   * forgot freezes the workspace instead of losing its files (foundation §6.5). Pools whose files must
   * be revoked at once are simply left out: removal follows from absence.
   */
  fragments(assigned: AssignedPool<C>[], ctx: KindContext): Fragment[];
  /**
   * After a successful write (exposure bookkeeping and the like). Called after every successful
   * reconcile of the workspace, also when nothing needed writing: `delivered` then holds every path
   * the workspace has from the portal. Additive: `pluginFolders`, when the engine reports it, maps
   * each portal plugin with a version folder still in the workspace to those folders' `<hash12>` names
   * (how a kind tells that a revoked plugin version is really gone).
   */
  delivered?(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string>; pluginFolders?: Map<string, string[]> }): void;
  /**
   * Refuses (throws AppError('CONFLICT', …)) deleting a pool or removing it from a workspace when
   * something else depends on it; returns warnings to show otherwise. A pool can be deleted only once
   * it's assigned nowhere, so deleting calls this once with `workspaceId` ''.
   */
  beforeUnassign?(workspaceId: string, poolId: string): string[];
  /**
   * Additive: refuses (throws AppError('CONFLICT', …)) giving a workspace pools, before anything is
   * written: `adding` are new to it, `keeping` the pools of this type it keeps. Secrets & env FR9: names
   * must be unique across a workspace's sets. Bulk assignment asks once per workspace.
   */
  beforeAssign?(workspaceId: string, adding: string[], keeping: string[]): void;
  /** Additive: the workspace was removed; drop rows of your own about it. */
  forgetWorkspace?(workspaceId: string): void;
}
