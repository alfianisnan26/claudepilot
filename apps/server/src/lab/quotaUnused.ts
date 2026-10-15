// T-547 (D-65): the scorecard's "quota left unused at reset": per Claude per window, for the resets inside the scorecard window, from the usage
// samples (`claude_usage_samples`) just before each reset. No reading close enough: unavailable, never a guess.

import type { DatabaseSync } from 'node:sqlite';
import type { QuotaUnusedRow } from '@portal/contracts';
import { JUST_BEFORE_MS, unusedAtReset, type WindowSample } from '../claudeusage/placement.js';

export function loadQuotaUnused(db: DatabaseSync | null, nowMs: number, sinceMs: number): QuotaUnusedRow[] {
  if (!db) return [];
  let rows: { claude_id: string; win: string; at_ms: number; used_pct: number; resets_at_ms: number }[];
  try {
    rows = db
      .prepare('SELECT claude_id, win, at_ms, used_pct, resets_at_ms FROM claude_usage_samples WHERE at_ms >= ? AND used_pct IS NOT NULL AND resets_at_ms IS NOT NULL ORDER BY claude_id, win, at_ms')
      .all(sinceMs - JUST_BEFORE_MS) as typeof rows;
  } catch {
    return [];
  }
  const groups = new Map<string, { claudeId: string; win: string; samples: WindowSample[] }>();
  for (const r of rows) {
    const key = `${r.claude_id}\u0000${r.win}`;
    const g = groups.get(key) ?? groups.set(key, { claudeId: r.claude_id, win: r.win, samples: [] }).get(key)!;
    g.samples.push({ atMs: r.at_ms, usedPct: r.used_pct, resetsAtMs: r.resets_at_ms });
  }
  return [...groups.values()].flatMap((g) =>
    unusedAtReset(g.claudeId, g.win, g.samples, sinceMs, nowMs).map((u) => ({
      claudeId: u.claudeId,
      window: u.window,
      resetAt: new Date(u.resetAtMs).toISOString(),
      unusedPct: u.unusedPct,
      readingAt: u.readingAtMs === null ? null : new Date(u.readingAtMs).toISOString(),
    })),
  );
}
