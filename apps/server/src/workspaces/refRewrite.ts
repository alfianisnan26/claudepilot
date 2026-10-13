// T-42 slice 3 (docs/prd/targets-connect.md §24.4): the one-time background rewrite of stored workspace references, from the key
// `<target>/<name>` to the stable id, for the columns whose module already reads either form (`REF_COLUMNS`). Converted modules write the id
// on save themselves; this moves the rows written before. It is safe to stop at any point and to run again:
//   - it touches only rows that still hold a key (not `ws_…`), and each UPDATE changes a row only if it still holds the value read;
//   - a key with no live workspace (removed, never known) is left as it is: readers resolve it through the alias, as before;
//   - a column is marked done (`workspace_ref_rewrites`) only when a pass reached its end; a later run skips it.
// It runs in small batches with a pause between them, so the portal's own writes are never held up for long.

import type { DatabaseSync } from 'node:sqlite';
import type { WorkspaceIdentities } from './identity.js';

/** A column that holds workspace references, in a module that reads either form. Only names from this list ever reach SQL. */
export interface RefColumn {
  table: string;
  column: string;
  /**
   * The column is unique (a primary key: one row per workspace). A key row whose id row already exists is the same fact twice: the key row is
   * dropped instead of rewritten.
   */
  unique?: boolean;
}

/** The converted columns, in the order they are rewritten. A module joins this list when it reads and writes through the registry. */
export const REF_COLUMNS: readonly RefColumn[] = [
  { table: 'tickets', column: 'workspace_id' },
  { table: 'chat_sessions', column: 'workspace_id' },
  { table: 'pmcp_agent_access', column: 'workspace_id', unique: true },
  { table: 'pmcp_agent_tokens', column: 'workspace_id' },
];

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A workspace is being removed: rows of the converted columns that still hold its key are given its id now, before the name is freed, so a
 * new workspace that takes the name never inherits them (the rewrite may not have reached them yet). Synchronous: the remove waits for it.
 * Failures are logged and the remove goes on (the rows then read as the key, as before slice 3).
 */
export function pinRefsOfRemoved(db: DatabaseSync, key: string, id: string, columns: readonly RefColumn[] = REF_COLUMNS): number {
  let changed = 0;
  for (const col of columns) {
    if (!IDENT.test(col.table) || !IDENT.test(col.column)) throw new Error(`not a column name: ${col.table}.${col.column}`);
    try {
      changed += Number(db.prepare(`UPDATE ${col.unique ? 'OR IGNORE ' : ''}${col.table} SET ${col.column} = ? WHERE ${col.column} = ?`).run(id, key).changes);
      if (col.unique) db.prepare(`DELETE FROM ${col.table} WHERE ${col.column} = ?`).run(key);
    } catch (e) {
      console.error(`[workspaces] could not move ${col.table}.${col.column} of ${key} to its stable id: ${(e as Error).message}`);
    }
  }
  return changed;
}

export interface RewriteResult extends RefColumn {
  rewritten: number;
  /** Rows left with a key: no live workspace has it. */
  kept: number;
  done: boolean;
}

export interface RewriteOptions {
  columns?: readonly RefColumn[];
  batch?: number;
  pauseMs?: number;
  /** Stops between two rows when aborted; what was done stays done. */
  signal?: AbortSignal;
  now?: () => Date;
}

/** Runs the rewrite once over every column not yet done. Never throws for a column it cannot read (logged; tried on the next run). */
export async function rewriteWorkspaceRefs(
  store: { db: DatabaseSync | null; writable: boolean },
  identities: WorkspaceIdentities,
  o: RewriteOptions = {},
): Promise<RewriteResult[]> {
  const db = store.db;
  if (!db || !store.writable) return [];
  const batch = o.batch ?? 200;
  const pause = o.pauseMs ?? 25;
  const now = o.now ?? (() => new Date());
  const done = new Set(
    (db.prepare('SELECT table_name, column_name FROM workspace_ref_rewrites').all() as { table_name: string; column_name: string }[]).map((r) => `${r.table_name}.${r.column_name}`),
  );
  const out: RewriteResult[] = [];
  for (const col of o.columns ?? REF_COLUMNS) {
    if (!IDENT.test(col.table) || !IDENT.test(col.column)) throw new Error(`not a column name: ${col.table}.${col.column}`);
    if (done.has(`${col.table}.${col.column}`)) continue;
    if (o.signal?.aborted) break;
    const result: RewriteResult = { ...col, rewritten: 0, kept: 0, done: false };
    out.push(result);
    try {
      // Walk by rowid, so a key that stays a key (no live workspace) is passed over once, not read again and again.
      const page = db.prepare(
        `SELECT rowid AS rid, ${col.column} AS ref FROM ${col.table} WHERE rowid > ? AND ${col.column} IS NOT NULL AND ${col.column} NOT LIKE 'ws\\_%' ESCAPE '\\' ORDER BY rowid LIMIT ?`,
      );
      const write = db.prepare(`UPDATE ${col.table} SET ${col.column} = ? WHERE rowid = ? AND ${col.column} = ?`);
      const holds = col.unique ? db.prepare(`SELECT 1 AS x FROM ${col.table} WHERE ${col.column} = ?`) : null;
      const drop = col.unique ? db.prepare(`DELETE FROM ${col.table} WHERE rowid = ? AND ${col.column} = ?`) : null;
      let after = 0;
      for (;;) {
        if (o.signal?.aborted) break;
        const rows = page.all(after, batch) as { rid: number; ref: string }[];
        if (!rows.length) {
          result.done = true;
          break;
        }
        for (const r of rows) {
          if (o.signal?.aborted) break;
          after = r.rid;
          const id = identities.storedRef(r.ref);
          if (!id || id === r.ref) result.kept++;
          else if (holds?.get(id)) result.rewritten += Number(drop!.run(r.rid, r.ref).changes);
          else result.rewritten += Number(write.run(id, r.rid, r.ref).changes);
        }
        if (pause) await new Promise((res) => setTimeout(res, pause));
      }
      if (result.done)
        db.prepare('INSERT INTO workspace_ref_rewrites (table_name, column_name, rewritten, done_at) VALUES (?, ?, ?, ?) ON CONFLICT (table_name, column_name) DO NOTHING').run(
          col.table,
          col.column,
          result.rewritten,
          now().toISOString(),
        );
    } catch (e) {
      console.error(`[workspaces] rewriting ${col.table}.${col.column} to stable ids failed (tried again on the next start): ${(e as Error).message}`);
    }
  }
  return out;
}
