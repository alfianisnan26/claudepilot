// Pilot metrics (T-2360, docs/prd/claude-usage.md §28.16): the snapshot store. Every 10 minutes the lab writes one row per program with the
// values the trend reads (migration 856, `lab_metric_snapshots`); rows older than 30 days go with the lab's daily retention. Numbers only.

import type { DatabaseSync } from 'node:sqlite';
import { METRICS_TREND_KEYS, type MetricsTrendKey, type MetricsTrendPoint } from '@portal/contracts';
import { DAY_MS } from './outcomes.js';

export const SNAPSHOT_EVERY_MS = 10 * 60_000;
export const KEEP_SNAPSHOTS_MS = 30 * DAY_MS;

export type SnapshotValues = Partial<Record<MetricsTrendKey, number | null>>;

const KEYS = new Set<string>(METRICS_TREND_KEYS);

/** Writes one snapshot per program at `atMs`, in one transaction. Unknown keys and non-finite numbers are dropped. */
export function writeSnapshots(db: DatabaseSync, atMs: number, rows: readonly { program: string; values: SnapshotValues }[]): number {
  const ins = db.prepare('INSERT INTO lab_metric_snapshots (at_ms, program, metrics) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const clean: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(r.values)) if (KEYS.has(k)) clean[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
      ins.run(atMs, r.program, JSON.stringify(clean));
    }
    db.exec('COMMIT');
    return rows.length;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** One metric of one program in [fromMs, toMs], oldest first (the (program, at_ms) index). */
export function readTrend(db: DatabaseSync, program: string, metric: MetricsTrendKey, fromMs: number, toMs: number): MetricsTrendPoint[] {
  const rows = db
    .prepare(`SELECT at_ms, json_extract(metrics, '$.' || ?) AS v FROM lab_metric_snapshots WHERE program = ? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms`)
    .all(metric, program, fromMs, toMs) as unknown as { at_ms: number; v: number | null }[];
  return rows.map((r) => ({ atMs: r.at_ms, value: typeof r.v === 'number' ? r.v : null }));
}

/** The program's newest snapshot at or before `atMs` and not older than `atMs - toleranceMs`, or null. */
export function snapshotNear(db: DatabaseSync, program: string, atMs: number, toleranceMs: number): { atMs: number; values: SnapshotValues } | null {
  const r = db
    .prepare('SELECT at_ms, metrics FROM lab_metric_snapshots WHERE program = ? AND at_ms <= ? AND at_ms >= ? ORDER BY at_ms DESC LIMIT 1')
    .get(program, atMs, atMs - toleranceMs) as { at_ms: number; metrics: string } | undefined;
  if (!r) return null;
  try {
    return { atMs: r.at_ms, values: JSON.parse(r.metrics) as SnapshotValues };
  } catch {
    return null;
  }
}

/** Drops snapshots older than 30 days; the count dropped. */
export function pruneMetricSnapshots(db: DatabaseSync, nowMs: number): number {
  return Number(db.prepare('DELETE FROM lab_metric_snapshots WHERE at_ms < ?').run(nowMs - KEEP_SNAPSHOTS_MS).changes);
}
