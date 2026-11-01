// Where a usage row counts for the org context (owner request 2026-11-01, Usage per org; authz/orgScope.ts). A usage row (a request in
// `chat_usage`, a spike) records the workspace and the Claude it RAN on, and relocation leaves those as history (chat/relocate.ts). So a row
// is anchored, in this order:
//   1. through its session, where the session still exists: the workspace the session lives in now (a relocated chat's usage follows it);
//   2. a workspace that was decommissioned is the workspace that inherited it (RETIRED_WORKSPACES, below);
//   3. otherwise the workspace it ran on.
// The anchor only decides which org context a row is shown in; the row itself is never rewritten.

import type { DatabaseSync } from 'node:sqlite';
import { cachedStatement } from '../store/stmtCache.js';

/**
 * The shared workspaces decommissioned after the per-org migration (owner, 2026-11-01): their sessions were relocated, and the history that
 * still names them goes to the workspace that inherited them. `kubernetes/kohi-event` held every org's work: its Konfersi repository's
 * sessions went to Konfersi, the rest to isnan. `kubernetes/memorid-project` was Kohilabs'.
 */
export const RETIRED_WORKSPACES: Readonly<Record<string, { heir: string; byFolder?: readonly { match: RegExp; heir: string }[] }>> = {
  'kubernetes/kohi-event': { heir: 'isnan/isnan', byFolder: [{ match: /(^|\/)konfersi[^/]*(\/|$)/i, heir: 'konfersi/konfersi' }] },
  'kubernetes/memorid-project': { heir: 'kohilabs/kohilabs' },
};

/** Whether a workspace is one of the decommissioned ones (its Claudes are shown as "(old)"). */
export const isRetiredWorkspace = (workspaceId: string | null | undefined): boolean => !!workspaceId && Object.prototype.hasOwnProperty.call(RETIRED_WORKSPACES, workspaceId);

/** A Claude of a decommissioned workspace (its login went with it) reads "<name> (old)" (owner request 2026-11-01). */
export const oldName = (name: string, workspaceId: string | null | undefined): string => (isRetiredWorkspace(workspaceId) ? `${name} (old)` : name);

/** The workspace that inherited a decommissioned one (a session folder, when known, picks the repository's org); null for any other. */
export function heirOf(workspaceId: string | null | undefined, cwd?: string | null): string | null {
  if (!isRetiredWorkspace(workspaceId)) return null;
  const r = RETIRED_WORKSPACES[workspaceId!]!;
  const hit = cwd ? r.byFolder?.find((f) => f.match.test(cwd)) : undefined;
  return hit?.heir ?? r.heir;
}

/** The org context as a predicate on a workspace key (null: no workspace, e.g. a budget on everything): `byWorkspace(orgScopeFilter(…))`. */
export type InWorkspace = (workspaceId: string | null) => boolean;

/** Where a session lives now: its workspace's key (`<target>/<name>`) and its folder. */
export interface SessionPlace {
  workspaceId: string;
  cwd: string;
}

/** The workspace a usage row counts under (the order above). `session` is the row's session as it is now; null when it is gone or unknown. */
export function anchorWorkspace(workspaceId: string, session: SessionPlace | null | undefined): string {
  const ws = session?.workspaceId || workspaceId;
  return heirOf(ws, session?.cwd) ?? ws;
}

/**
 * A reader of sessions' current places, memoised for one request (one small read per session). A stable workspace id (`ws_…`, what
 * chat_sessions stores) is read as its key through `workspace_identities`; a store that cannot answer reads every session as gone.
 */
export function sessionPlaces(db: () => DatabaseSync | null): (sessionId: string | null | undefined) => SessionPlace | null {
  const seen = new Map<string, SessionPlace | null>();
  let joined = true;
  // Prepared once (stmtCache.ts; owner request 2026-11-01, performance): a month of usage names thousands of sessions, and preparing the
  // statement for each one was most of /api/usage-spend's time on a large database.
  const read = (d: DatabaseSync, sessionId: string): SessionPlace | null => {
    const sql = joined
      ? 'SELECT COALESCE(i.legacy_id, s.workspace_id) AS ws, s.cwd AS cwd FROM chat_sessions s LEFT JOIN workspace_identities i ON i.id = s.workspace_id WHERE s.id = ?'
      : 'SELECT workspace_id AS ws, cwd FROM chat_sessions WHERE id = ?';
    const row = cachedStatement(d, sql).get(sessionId) as { ws: string; cwd: string } | undefined;
    return row ? { workspaceId: row.ws, cwd: row.cwd ?? '' } : null;
  };
  return (sessionId) => {
    if (!sessionId) return null;
    if (seen.has(sessionId)) return seen.get(sessionId)!;
    let place: SessionPlace | null = null;
    const d = db();
    if (d) {
      try {
        place = read(d, sessionId);
      } catch {
        // An older store without workspace_identities: read the stored form as it is (once); anything else reads as gone.
        if (joined) {
          joined = false;
          try {
            place = read(d, sessionId);
          } catch {
            place = null;
          }
        }
      }
    }
    seen.set(sessionId, place);
    return place;
  };
}
