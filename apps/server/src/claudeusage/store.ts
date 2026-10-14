// Claude usage: the two tables (docs/prd/claude-usage.md §9), over the portal's database. Numbers, times and a
// coarse plan tier only. Every read is tolerant (a missing table or a locked store reads as nothing), because the
// portal must start and explain itself on a database it cannot use (foundation PRD §6.5).

import type { ClaudeRunsOn, UsageAlertLevel, UsageProblem, UsageSource } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { windowLevel, type ExtraReading, type WindowReading } from './parse.js';

/** One crossing already told: the level, the period it was for (the window's reset time) and when. */
export interface AlertMark {
  level: UsageAlertLevel;
  resetsAtMs: number | null;
  atMs: number;
  /** It crossed while the Claude was snoozed: kept so it isn't told later, never shown. */
  quiet?: boolean;
}

/** A "will run out before reset" alert already told: the period it was for (the window's reset time), when, and the estimate it carried (§20.4). */
export interface ProjectionMark {
  resetsAtMs: number;
  atMs: number;
  usedPct: number;
  etaMs: number;
  projectedPct: number;
  /** It was told while the Claude was snoozed: kept so it isn't told later, never shown. */
  quiet?: boolean;
}

export interface LatestRow {
  claudeId: string;
  workspaceId: string;
  /** When the numbers were read; null when they never were. */
  checkedAtMs: number | null;
  lastProbeAtMs: number;
  runsOn: ClaudeRunsOn;
  plan: string | null;
  windows: WindowReading[];
  extra: ExtraReading | null;
  source: UsageSource | null;
  problem: UsageProblem | null;
  fails: number;
  snoozedUntilMs: number | null;
  alerted: Record<string, AlertMark>;
  /** Projection alerts told, per window (§20.4), and the snooze that silences only those. */
  projAlerted: Record<string, ProjectionMark>;
  projSnoozedUntilMs: number | null;
  /** T-255: a chat answered with Claude Code's limit message; the window counts as used up until `untilMs` (kept across probes). */
  limitReport?: LimitReportMark | null;
}

/** A limit a chat reported (T-255): which window, when, until when (`guessed`: no time in the message), and the chat. */
export interface LimitReportMark {
  window: string;
  atMs: number;
  untilMs: number;
  guessed: boolean;
  sessionId: string | null;
}

export interface SampleRow {
  win: string;
  atMs: number;
  usedPct: number;
}

/** A reading under this old, equal to the last one of its window, is not stored again (FR8). */
const SAME_FOR_MS = 30 * 60_000;
const DAY = 86_400_000;
/** Everything is kept this long, then one a window an hour (the last of it), then nothing (§9 Retention). */
export const KEEP_ALL_MS = 2 * DAY;
export const KEEP_MS = 30 * DAY;

interface LatestSql {
  claude_id: string;
  workspace_id: string;
  checked_at_ms: number | null;
  last_probe_at_ms: number;
  runs_on: string;
  plan: string | null;
  windows: string;
  extra: string | null;
  source: string | null;
  problem: string | null;
  fails: number;
  snoozed_until_ms: number | null;
  alerted: string;
  proj_alerted: string;
  proj_snoozed_until_ms: number | null;
  limit_report?: string | null;
}

const RUNS_ON: readonly string[] = ['plan', 'key', 'pool', 'none', 'unknown'];
const PROBLEMS: readonly string[] = ['not_installed', 'timeout', 'unreadable', 'unavailable', 'no_scope'];

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function limitReportOf(v: unknown): LimitReportMark | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.window !== 'string' || typeof o.atMs !== 'number' || typeof o.untilMs !== 'number') return null;
  return { window: o.window, atMs: o.atMs, untilMs: o.untilMs, guessed: o.guessed === true, sessionId: typeof o.sessionId === 'string' ? o.sessionId : null };
}

function toRow(r: LatestSql): LatestRow {
  const windows = json<unknown>(r.windows, []);
  const alerted = json<unknown>(r.alerted, {});
  const proj = json<unknown>(r.proj_alerted, {});
  return {
    claudeId: r.claude_id,
    workspaceId: r.workspace_id,
    checkedAtMs: r.checked_at_ms,
    lastProbeAtMs: r.last_probe_at_ms,
    runsOn: (RUNS_ON.includes(r.runs_on) ? r.runs_on : 'unknown') as ClaudeRunsOn,
    plan: r.plan,
    windows: Array.isArray(windows) ? (windows as WindowReading[]) : [],
    extra: json<ExtraReading | null>(r.extra, null),
    source: r.source === 'probe' || r.source === 'live' ? r.source : null,
    problem: r.problem && PROBLEMS.includes(r.problem) ? (r.problem as UsageProblem) : null,
    fails: r.fails,
    snoozedUntilMs: r.snoozed_until_ms,
    alerted: alerted && typeof alerted === 'object' && !Array.isArray(alerted) ? (alerted as Record<string, AlertMark>) : {},
    projAlerted: proj && typeof proj === 'object' && !Array.isArray(proj) ? (proj as Record<string, ProjectionMark>) : {},
    projSnoozedUntilMs: r.proj_snoozed_until_ms ?? null,
    limitReport: limitReportOf(json<unknown>(r.limit_report ?? null, null)),
  };
}

export class UsageStore {
  constructor(private readonly store: Store) {}

  /** The portal can write: no readings are taken or kept otherwise. */
  get writable(): boolean {
    return this.store.writable;
  }

  latest(claudeId: string): LatestRow | null {
    const db = this.store.db;
    if (!db) return null;
    try {
      const r = db.prepare('SELECT * FROM claude_usage_latest WHERE claude_id = ?').get(claudeId) as unknown as LatestSql | undefined;
      return r ? toRow(r) : null;
    } catch {
      return null;
    }
  }

  allLatest(): LatestRow[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      return (db.prepare('SELECT * FROM claude_usage_latest').all() as unknown as LatestSql[]).map(toRow);
    } catch {
      return [];
    }
  }

  saveLatest(row: LatestRow): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare(
      `INSERT INTO claude_usage_latest (claude_id, workspace_id, checked_at_ms, last_probe_at_ms, runs_on, plan, windows, extra, source, problem, fails, snoozed_until_ms, alerted, proj_alerted, proj_snoozed_until_ms, limit_report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (claude_id) DO UPDATE SET workspace_id = excluded.workspace_id, checked_at_ms = excluded.checked_at_ms, last_probe_at_ms = excluded.last_probe_at_ms,
         runs_on = excluded.runs_on, plan = excluded.plan, windows = excluded.windows, extra = excluded.extra, source = excluded.source, problem = excluded.problem,
         fails = excluded.fails, snoozed_until_ms = excluded.snoozed_until_ms, alerted = excluded.alerted, proj_alerted = excluded.proj_alerted,
         proj_snoozed_until_ms = excluded.proj_snoozed_until_ms, limit_report = excluded.limit_report`,
    ).run(
      row.claudeId,
      row.workspaceId,
      row.checkedAtMs,
      row.lastProbeAtMs,
      row.runsOn,
      row.plan,
      JSON.stringify(row.windows),
      row.extra ? JSON.stringify(row.extra) : null,
      row.source,
      row.problem,
      row.fails,
      row.snoozedUntilMs,
      JSON.stringify(row.alerted),
      JSON.stringify(row.projAlerted),
      row.projSnoozedUntilMs,
      row.limitReport ? JSON.stringify(row.limitReport) : null,
    );
  }

  /**
   * Keeps a reading's windows as samples, except a window equal to its last sample (same percent and reset time)
   * that is under 30 minutes old (FR8). Returns how many rows it added.
   */
  addSamples(claudeId: string, workspaceId: string, atMs: number, windows: WindowReading[], source: UsageSource): number {
    const db = this.store.db;
    if (!db || !this.store.writable) return 0;
    const last = db.prepare('SELECT used_pct, resets_at_ms, at_ms FROM claude_usage_samples WHERE claude_id = ? AND win = ? ORDER BY at_ms DESC, id DESC LIMIT 1');
    const insert = db.prepare('INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let added = 0;
    for (const w of windows) {
      const prev = last.get(claudeId, w.key) as { used_pct: number | null; resets_at_ms: number | null; at_ms: number } | undefined;
      if (prev && prev.used_pct === w.usedPct && prev.resets_at_ms === w.resetsAtMs && atMs - prev.at_ms < SAME_FOR_MS) continue;
      insert.run(atMs, claudeId, workspaceId, w.key, w.usedPct, w.resetsAtMs, windowLevel(w.usedPct, w.resetsAtMs, atMs), source);
      added++;
    }
    return added;
  }

  /** The samples of a Claude since `sinceMs` (of one window when `win` is given), oldest first. Windows with no number are left out. */
  history(claudeId: string, sinceMs: number, win?: string): SampleRow[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      const rows = db
        .prepare(`SELECT win, at_ms, used_pct FROM claude_usage_samples WHERE claude_id = ? AND at_ms >= ? AND used_pct IS NOT NULL ${win ? 'AND win = ?' : ''} ORDER BY at_ms, id`)
        .all(...(win ? [claudeId, sinceMs, win] : [claudeId, sinceMs])) as { win: string; at_ms: number; used_pct: number }[];
      return rows.map((r) => ({ win: r.win, atMs: r.at_ms, usedPct: r.used_pct }));
    } catch {
      return [];
    }
  }

  /**
   * One window's samples since `sinceMs` with the reset time each carried (its period), oldest first: what the pace stands on (§20.2).
   * Samples with no percent are left out.
   */
  windowSamples(claudeId: string, win: string, sinceMs: number): { atMs: number; usedPct: number; resetsAtMs: number | null }[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      const rows = db
        .prepare('SELECT at_ms, used_pct, resets_at_ms FROM claude_usage_samples WHERE claude_id = ? AND win = ? AND at_ms >= ? AND used_pct IS NOT NULL ORDER BY at_ms, id')
        .all(claudeId, win, sinceMs) as { at_ms: number; used_pct: number; resets_at_ms: number | null }[];
      return rows.map((r) => ({ atMs: r.at_ms, usedPct: r.used_pct, resetsAtMs: r.resets_at_ms }));
    } catch {
      return [];
    }
  }

  /**
   * Retention (§9): after two days one sample per window per hour (the last of the hour), after thirty days none; and
   * the rows of Claudes that no longer exist, when the caller knows who exists.
   */
  prune(nowMs: number, existing?: ReadonlySet<string>): void {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('DELETE FROM claude_usage_samples WHERE at_ms < ?').run(nowMs - KEEP_MS);
    const cut = nowMs - KEEP_ALL_MS;
    db.prepare(
      `DELETE FROM claude_usage_samples WHERE at_ms < ?1
       AND id NOT IN (SELECT MAX(id) FROM claude_usage_samples WHERE at_ms < ?1 GROUP BY claude_id, win, at_ms / 3600000)`,
    ).run(cut);
    if (existing && existing.size) {
      const gone = (db.prepare('SELECT claude_id FROM claude_usage_latest UNION SELECT DISTINCT claude_id FROM claude_usage_samples').all() as { claude_id: string }[])
        .map((r) => r.claude_id)
        .filter((id) => !existing.has(id));
      for (const id of gone) {
        db.prepare('DELETE FROM claude_usage_samples WHERE claude_id = ?').run(id);
        db.prepare('DELETE FROM claude_usage_latest WHERE claude_id = ?').run(id);
      }
    }
  }

  /** Samples and latest rows, for a test or a Claude that is gone. */
  counts(): { samples: number; latest: number } {
    const db = this.store.db;
    if (!db) return { samples: 0, latest: 0 };
    try {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      return { samples: n('SELECT COUNT(*) AS n FROM claude_usage_samples'), latest: n('SELECT COUNT(*) AS n FROM claude_usage_latest') };
    } catch {
      return { samples: 0, latest: 0 };
    }
  }
}
