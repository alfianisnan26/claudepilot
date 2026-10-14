// Efficiency lab (T-287 slice 2, docs/prd/claude-usage.md §28.9): retention. The per-request and per-tool rows are kept 14 days; a slice
// whose last request is older than that has its numbers frozen on its own row (migration 852, counts only) and then its request and tool
// rows go. Slices, and so the summaries and the experiments over them, are kept. Runs once a day (Lab.start) and is safe to run again.
// T-292 slice 3: a draw no slice bound within the same 14 days goes too (its held assignment rows and its `lab_draws` row); a bound draw's
// row is kept with its slice.

import type { DatabaseSync } from 'node:sqlite';
import { sliceMetrics } from './metrics.js';
import { DAY_MS } from './outcomes.js';

export const KEEP_REQUESTS_MS = 14 * DAY_MS;

export interface PruneResult {
  frozen: number;
  requests: number;
  tools: number;
  /** Unbound draws dropped (older than the horizon). */
  draws: number;
}

export function pruneLab(db: DatabaseSync, nowMs: number): PruneResult {
  const cutoff = nowMs - KEEP_REQUESTS_MS;
  const old = db
    .prepare(
      `SELECT r.session_id AS sessionId, r.slice_id AS sliceId FROM lab_requests r JOIN lab_slices s ON s.session_id = r.session_id AND s.slice_id = r.slice_id
       WHERE s.frozen IS NULL GROUP BY r.session_id, r.slice_id HAVING MAX(r.at_ms) < ?`,
    )
    .all(cutoff) as { sessionId: string; sliceId: string }[];
  db.exec('BEGIN');
  try {
    const freeze = db.prepare('UPDATE lab_slices SET frozen = ?, frozen_ms = ? WHERE session_id = ? AND slice_id = ?');
    let frozen = 0;
    for (const m of old.length ? sliceMetrics(db, { keys: old }) : []) {
      freeze.run(JSON.stringify(m), nowMs, m.sessionId, m.sliceId);
      frozen++;
    }
    const frozenSlices = 'SELECT 1 FROM lab_slices s WHERE s.session_id = t.session_id AND s.slice_id = t.slice_id AND s.frozen IS NOT NULL';
    const requests = Number(db.prepare(`DELETE FROM lab_requests AS t WHERE EXISTS (${frozenSlices}) OR (t.at_ms < ? AND NOT EXISTS (SELECT 1 FROM lab_slices s WHERE s.session_id = t.session_id AND s.slice_id = t.slice_id))`).run(cutoff).changes);
    const tools = Number(db.prepare(`DELETE FROM lab_tools AS t WHERE EXISTS (${frozenSlices}) OR (t.at_ms < ? AND t.slice_id IS NULL)`).run(cutoff).changes);
    db.prepare("DELETE FROM lab_assignments WHERE substr(slice_id, 1, 5) = 'draw:' AND assigned_ms < ?").run(cutoff);
    const draws = Number(db.prepare("DELETE FROM lab_draws WHERE status <> 'bound' AND drawn_ms < ?").run(cutoff).changes);
    db.exec('COMMIT');
    return { frozen, requests, tools, draws };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
