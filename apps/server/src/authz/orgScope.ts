// The org context of a list (docs/prd/organizations.md §7): the web client's `scopedList` (apps/web/src/lib/orgContext.ts) adds `?org=` to
// every list it asks for. The list keeps its normal visibility first (`visible()` / its `keep`), and THEN narrows by the owner of the row's
// anchor object, so `?org=` can only ever take rows away:
//   - no `?org=` (or empty): no narrowing, today's behaviour (everything the caller may see);
//   - `?org=personal`: only rows whose anchor is NOT org-owned;
//   - `?org=<orgId>`: only rows whose anchor that org owns, and only when the caller holds an active role in that active org; an org they are
//     not in, a suspended one, or a value that is not an org id answers an empty list (never an error, never wider).
// The anchor is the object that carries the owner: a workspace, a ticket bucket or a vault itself; a session, a CI run or a CI remote through
// its workspace (the seam resolver's `parent`); a ticket through its bucket.

import { actorUserId, isOrgId, objectRef, type Actor, type ObjectRef, type ObjectType } from '@portal/contracts';
import { orgRoleIn, resolve } from './seam.js';

export type OrgScope = { kind: 'personal' } | { kind: 'org'; id: string };

/** The `?org=` of a request; null when absent or empty (no narrowing). Any other value that is not `personal` is taken as an org id. */
export function orgScopeOf(c: { req: { query(name: string): string | undefined } }): OrgScope | null {
  const raw = c.req.query('org');
  if (raw === undefined || raw === '') return null;
  if (raw === 'personal') return { kind: 'personal' };
  return { kind: 'org', id: raw.slice(0, 100) };
}

/** A predicate on a row's anchor (null: the row has none, e.g. a ticket with no bucket), or null when there is nothing to narrow. */
export type AnchorFilter = (anchor: ObjectRef | null) => boolean;

/**
 * The narrowing for `scope`, memoised per anchor for one request. Null when `scope` is null. In an org the caller is not an active member of
 * (or an id that is not an org's), every row is refused.
 */
export function orgScopeFilter(actor: Actor, scope: OrgScope | null): AnchorFilter | null {
  if (!scope) return null;
  if (scope.kind === 'org') {
    const userId = actorUserId(actor);
    if (!isOrgId(scope.id) || !userId || !orgRoleIn(scope.id, userId)) return () => false;
  }
  const seen = new Map<string, boolean>();
  return (anchor) => {
    if (!anchor) return scope.kind === 'personal';
    const key = `${anchor.type}:${anchor.id}`;
    let hit = seen.get(key);
    if (hit === undefined) {
      const owner = resolve(anchor)?.owner ?? null;
      hit = scope.kind === 'personal' ? owner?.kind !== 'org' : owner?.kind === 'org' && owner.id === scope.id;
      seen.set(key, hit);
    }
    return hit;
  };
}

/** The anchor of a child object (session, CI run, CI remote): its parent as the seam resolves it; null when it has none or is gone. */
export const parentAnchor = (type: ObjectType, id: string): ObjectRef | null => resolve(objectRef(type, id))?.parent ?? null;
