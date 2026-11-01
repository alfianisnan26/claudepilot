// What the seam asks about organizations (authz/seam.ts `OrgAuthority`; organizations slice 5, §6.5): the role in an ACTIVE org, the org's
// owners, the grants (authz/grants.ts) and the break-glass entries (./breakGlass.ts). Installed once by `createOrgs`. Every answer is read
// on every decision and fails closed (a database that cannot be read: no role, no grant, no entry, "an org owns something" so the founding
// user's list fast path is not taken).

import type { DatabaseSync } from 'node:sqlite';
import type { OrgRole, UserId } from '@portal/contracts';
import type { Grants } from '../authz/grants.js';
import type { OrgAuthority } from '../authz/seam.js';
import type { BreakGlassService } from './breakGlass.js';
import type { OrgsService } from './service.js';
import type { OrgSharing } from './sharing.js';

/** The tables whose rows an org may own (slice 5 moves workspaces, buckets and vaults; sets, accounts and endpoints already take 'org'). */
const OWNED_TABLES = ['workspace_owners', 'ticket_buckets', 'kg_vaults', 'pools', 'accounts', 'endpoints'] as const;

export function orgAuthority(deps: { db: () => DatabaseSync | null; orgs: OrgsService; grants: Grants; breakGlass: BreakGlassService; sharing?: OrgSharing }): OrgAuthority {
  return {
    roleIn(orgId: string, userId: UserId): OrgRole | null {
      return deps.orgs.stateOf(orgId) === 'active' ? deps.orgs.roleOf(orgId, userId) : null;
    },
    ownersOf: (orgId) => deps.orgs.activeOwners(orgId),
    grantLevel: (object, userId, found) => deps.grants.levelFor(object, userId, found),
    breakGlass: (orgId, userId) => deps.breakGlass.isOpen(orgId, userId),
    onBreakGlassUse: (entryId, userId, orgId, verb, object) => deps.breakGlass.recordAccess(entryId, userId, orgId, verb, object),
    onTranscriptRead: (orgId, viewerId, sessionId, ownerId) => deps.sharing?.transcriptRead(orgId, viewerId, sessionId, ownerId),
    anyOrgOwned(): boolean {
      const db = deps.db();
      if (!db) return false;
      try {
        const sql = OWNED_TABLES.map((t) => `SELECT 1 AS hit FROM ${t} WHERE owner_kind = 'org'`).join(' UNION ALL ');
        const r = db.prepare(`SELECT EXISTS (${sql}) AS hit`).get() as { hit?: unknown } | undefined;
        return r?.hit !== 0;
      } catch {
        return true;
      }
    },
  };
}
