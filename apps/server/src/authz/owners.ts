// Owners of the object types the seam decides by ownership (docs/prd/organizations.md §13 P3, migration 410). One resolver per type, each a
// small synchronous read of the owner columns: workspace (`workspace_owners`), vault (`kg_vaults`), set (`pools`, every multi-pool type),
// account pool (`pools` of type 'account'), account (`accounts`) and endpoint (`endpoints`). CI runs and remotes take their workspace's owner
// (ci/authz.ts asks the workspace resolver registered here). A workspace Claude (`workspace_claudes`) and a repository (`repos`) are their
// workspace's too (org isolation, owner request 2026-11-01): the workspace's owner, its grants, and it as their parent, so an org workspace's
// Claudes and repositories follow the org (its quota alerts reach the org's owners) and never another admin outside it. Templates have no
// table yet: the type fails closed (no resolver, required).
//
// Fail closed, three ways:
//   - `registerOwnerResolvers` also marks every type it registers as RESOLVER_REQUIRED (seam.ts `requireResolvers`), so once the portal has
//     started, a type whose resolver went missing refuses (not found) instead of falling back to the founding user;
//   - an owner the seam cannot read (a user id that is not one, an org id that is not one) is UNOWNED: the same 404 as a missing object,
//     for everyone, the founding user too. An org owner (slice 5) is decided by the org's roles and grants (seam.ts);
//   - a database that cannot be read resolves nothing (not found).
// A workspace is the exception that keeps today's portal working: one found in a runtime with no `workspace_owners` row (or a row made for an
// earlier workspace of the same name, another `uid`) is UNCLAIMED, owned by the platform: the founding user and the admin accounts that hold
// its rights (D-82) keep it, nobody else sees it (Authorization §11, Identity FR6 "Unclaimed (admins only)").

import type { DatabaseSync } from 'node:sqlite';
import { isOrgId, isUserId, objectRef, workspaceRef, type ObjectType, type Owner } from '@portal/contracts';
import { WORKSPACE_ID } from '../names.js';
import { registerResolver, requireResolvers, type ResolvedObject } from './seam.js';

/** The types this file resolves; `template` is required with no resolver (no table yet). */
export const OWNED_TYPES = ['workspace', 'vault', 'pool', 'account_pool', 'account', 'endpoint'] as const satisfies readonly ObjectType[];
/** Every type P3 puts behind a resolver (fail closed): the owned ones, CI's two (via their workspace) and templates. */
export const P3_REQUIRED_TYPES: readonly ObjectType[] = [...OWNED_TYPES, 'ci_run', 'ci_repo', 'template', 'claude', 'repo'];

/** An owner as the columns store it, or null when the seam cannot read it yet (unowned). */
export function ownerFromColumns(kind: unknown, id: unknown): Owner | null {
  if (kind === 'platform') return { kind: 'platform' };
  if (kind === 'user' && isUserId(id)) return { kind: 'user', id };
  if (kind === 'team' && typeof id === 'string' && id.startsWith('tm_')) return { kind: 'team', id };
  // Organizations slice 5: an org owns it; the seam decides by the org's roles, grants and break-glass (seam.ts, orgs/authority.ts).
  if (kind === 'org' && isOrgId(id)) return { kind: 'org', id };
  return null; // a value that is not an owner
}

export interface OwnerResolverDeps {
  /** The database (read handle); null when there is none. */
  db(): DatabaseSync | null;
  /** The workspace registry's one resolver (WorkspaceIdentities.resolve): any form of a workspace id to its stable id and key. */
  workspace(ref: string): { id: string; legacyId: string } | null;
}

type OwnerRow = { owner_kind: string; owner_id: string };

function read<T>(deps: OwnerResolverDeps, sql: string, ...args: string[]): T | null | 'error' {
  const db = deps.db();
  if (!db) return 'error';
  try {
    return (db.prepare(sql).get(...args) as T | undefined) ?? null;
  } catch {
    return 'error';
  }
}

/** The one live workspace called `name` (its name or its label) on any target, or null when none or several are. */
function uniqueByName(deps: OwnerResolverDeps, name: string): { id: string; legacyId: string } | null {
  const db = deps.db();
  if (!db) return null;
  try {
    const rows = db.prepare('SELECT legacy_id FROM workspace_identities WHERE removed_at IS NULL AND (name = ? OR label = ?) LIMIT 2').all(name, name) as { legacy_id: string }[];
    return rows.length === 1 ? deps.workspace(rows[0]!.legacy_id) : null;
  } catch {
    return null;
  }
}

/** The workspace resolver alone (also what CI's resolvers ask for a run's or a remote's owner). */
export function workspaceOwnerResolver(deps: OwnerResolverDeps) {
  return {
    type: 'workspace' as const,
    resolve(id: string): ResolvedObject | null {
      if (typeof id !== 'string' || !id || id.length > 200) return null;
      // A tool may name a workspace by its bare name when it is unique among the live ones (portalmcp/tools/workspaces.ts).
      const known = deps.workspace(id) ?? (id.includes('/') ? null : uniqueByName(deps, id));
      const key = known?.legacyId ?? (WORKSPACE_ID.test(id) ? id : null);
      if (!key) return null;
      const ref = workspaceRef(key);
      const row = read<OwnerRow & { uid: string }>(deps, 'SELECT uid, owner_kind, owner_id FROM workspace_owners WHERE workspace_id = ?', key);
      if (row === 'error') return null;
      if (row && known && row.uid === known.id) return { ref, owner: ownerFromColumns(row.owner_kind, row.owner_id), attrs: { claimed: true, uid: row.uid } };
      return { ref, owner: { kind: 'platform' }, attrs: { claimed: false } };
    },
  };
}

/**
 * Registers the resolvers of every owned type and marks them (and CI's, and templates) required. Called once at start-up (index.ts), after the
 * store and the workspace registry exist; a test calls it with its own store.
 */
export function registerOwnerResolvers(deps: OwnerResolverDeps): void {
  registerResolver(workspaceOwnerResolver(deps));
  const byRow = (type: ObjectType, sql: string, extra?: (row: Record<string, unknown>, poolType?: string) => boolean) =>
    registerResolver({
      type,
      resolve(id, poolType) {
        if (typeof id !== 'string' || !id || id.length > 200) return null;
        const row = read<OwnerRow & Record<string, unknown>>(deps, sql, id);
        if (!row || row === 'error') return null;
        if (extra && !extra(row, poolType)) return null;
        return { ref: objectRef(type, id, poolType as never), owner: ownerFromColumns(row.owner_kind, row.owner_id) };
      },
    });
  byRow('vault', 'SELECT owner_kind, owner_id FROM kg_vaults WHERE id = ? AND deleted_at IS NULL');
  // A set of any multi-pool type: the URL's type must be the set's own (OBJECT_TYPES `pool`), and an account pool is not a set.
  byRow('pool', "SELECT type, owner_kind, owner_id FROM pools WHERE id = ? AND type != 'account'", (row, poolType) => !poolType || row.type === poolType);
  byRow('account_pool', "SELECT owner_kind, owner_id FROM pools WHERE id = ? AND type = 'account'");
  byRow('account', 'SELECT owner_kind, owner_id FROM accounts WHERE id = ?');
  byRow('endpoint', 'SELECT owner_kind, owner_id FROM endpoints WHERE id = ?');
  // Children of a workspace (OBJECT_TYPES parent 'workspace'): the workspace's owner and grants. A removed Claude still resolves, so its
  // history (usage, a budget on it) stays its workspace's people's; `default:<workspace>` is a workspace's default Claude (usage spend).
  const ws = workspaceOwnerResolver(deps);
  const child = (type: 'claude' | 'repo', workspaceOf: (id: string) => string | null) =>
    registerResolver({
      type,
      resolve(id) {
        if (typeof id !== 'string' || !id || id.length > 200) return null;
        const wsId = workspaceOf(id);
        const parent = wsId ? ws.resolve(wsId) : null;
        if (!parent) return null;
        return { ref: objectRef(type, id), owner: parent.owner, parent: parent.ref, attrs: { workspaceId: parent.ref.id }, grantsFrom: parent.ref };
      },
    });
  const column = (sql: string) => (id: string) => {
    const row = read<{ workspace_id: string }>(deps, sql, id);
    return row && row !== 'error' ? row.workspace_id : null;
  };
  const claudeWorkspace = column('SELECT workspace_id FROM workspace_claudes WHERE id = ?');
  child('claude', (id) => (id.startsWith('default:') ? id.slice('default:'.length) : claudeWorkspace(id)));
  child('repo', column('SELECT workspace_id FROM repos WHERE id = ?'));
  requireResolvers(P3_REQUIRED_TYPES);
}
