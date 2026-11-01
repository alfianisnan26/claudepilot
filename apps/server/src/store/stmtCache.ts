// Prepared statements kept per database (owner request 2026-11-01, performance). node:sqlite prepares a statement on every `prepare()`,
// and the authorization of a list asks a few single-row reads per row (an owner, a grant, the run itself): on a large database preparing
// them was most of the time of /api/tickets, /api/ci/runs and /api/usage-spend (scripts/perf-api.mjs). Only for reads with `get()` or
// `all()`: a cached statement is shared, so it must not be iterated or given per-call options (setReadBigInts and the like).
import type { DatabaseSync, StatementSync } from 'node:sqlite';

const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** Distinct statements kept per database, so a caller that builds SQL with varying text cannot grow it without end. */
const MAX_PER_DB = 500;

/** The statement for `sql` on `db`, prepared on first use. SQLite re-prepares it by itself after a schema change. */
export function cachedStatement(db: DatabaseSync, sql: string): StatementSync {
  let byDb = cache.get(db);
  if (!byDb) cache.set(db, (byDb = new Map()));
  let stmt = byDb.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    if (byDb.size >= MAX_PER_DB) byDb.clear();
    byDb.set(sql, stmt);
  }
  return stmt;
}
