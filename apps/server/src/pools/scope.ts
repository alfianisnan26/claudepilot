// The Pools lists in the org context (owner 2026-11-01, "pool also still not per org"; D-111; docs/prd/organizations.md §16). Read this
// before changing what a set list shows.
//
// The list keeps its normal visibility first (`visible()`: the sets the caller may view), and THEN narrows, so a context only takes rows away:
//   - no `?org=`: no narrowing (an API caller, a tool);
//   - `?org=personal`: the sets no org owns (the person's own; the instance's);
//   - `?org=<org>`: the sets that org owns, and the sets SHARED to that org (a grant to the org or to one of its teams), marked `shared`;
//     an org the caller holds no role in is the one empty scope (authz/orgScope.ts `effectiveOrgScope`): never wider, never an error;
//   - `?for=<workspace>` (assigning sets to a workspace): the context of that workspace's owner (its org, else Personal), plus the sets
//     already assigned to it (so a picker never drops one it shows as on). A workspace the caller may not view keeps nothing.
// Account pools follow the same owner rule (`?org=` through `orgScopeFilter` on `account_pool`); none is org-owned yet (D-111 D5).

import type { DatabaseSync } from 'node:sqlite';
import { poolRef, workspaceRef, type Actor, type MultiPoolType, type PoolSummary } from '@portal/contracts';
import { effectiveOrgScope, orgScopeFilter, type OrgScope } from '../authz/orgScope.js';
import { can, resolve } from '../authz/seam.js';

/** The ids among `ids` shared to `orgId` (a grant whose subject is the org, or one of its teams), read now; empty when unreadable. */
export function sharedToOrg(db: DatabaseSync | null, orgId: string, ids: readonly string[]): Set<string> {
  if (!db || !ids.length) return new Set();
  try {
    const now = new Date().toISOString();
    const rows = db
      .prepare(
        `SELECT DISTINCT g.object_id AS id FROM grants g
          WHERE g.object_type = 'pool' AND (g.expires_at IS NULL OR g.expires_at > ?)
            AND ((g.subject_kind = 'org' AND g.subject_id = ?) OR (g.subject_kind = 'team' AND g.subject_id IN (SELECT id FROM teams WHERE org_id = ?)))`,
      )
      .all(now, orgId, orgId) as { id: string }[];
    const want = new Set(ids);
    return new Set(rows.map((r) => r.id).filter((id) => want.has(id)));
  } catch {
    return new Set();
  }
}

/**
 * The context a workspace's sets come from (its org when an org owns it, else Personal) and its key (`<target>/<name>`, what assignments are
 * stored under); null when the caller may not view it or it is not one.
 */
export function workspaceScope(actor: Actor, workspaceId: string): { scope: OrgScope; key: string } | null {
  const ref = workspaceRef(workspaceId);
  if (!can(actor, 'view', ref).allow) return null;
  const found = resolve(ref);
  if (!found) return null;
  const owner = found.owner;
  return { scope: owner?.kind === 'org' ? { kind: 'org', id: owner.id } : { kind: 'personal' }, key: found.ref.id };
}

/**
 * `seen` (already the sets the caller may view) narrowed to `scope`, with `shared: true` on a set shared to the scope's org. `keep`: ids kept
 * whatever the scope (a workspace's assigned sets).
 */
export function scopeSets(actor: Actor, type: MultiPoolType, seen: PoolSummary[], scope: OrgScope | null, db: DatabaseSync | null, keep: ReadonlySet<string> = new Set()): PoolSummary[] {
  if (!scope) return seen;
  const owned = orgScopeFilter(actor, scope)!;
  const eff = effectiveOrgScope(actor, scope);
  const shared = eff?.kind === 'org' && eff.id ? sharedToOrg(db, eff.id, seen.map((p) => p.id)) : new Set<string>();
  const out: PoolSummary[] = [];
  for (const p of seen) {
    if (owned(poolRef(p.id, type))) out.push(p);
    else if (shared.has(p.id)) out.push({ ...p, shared: true });
    else if (keep.has(p.id)) out.push(p);
  }
  return out;
}
