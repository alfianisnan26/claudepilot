// Claude usage: what a stored reading says at a given moment (docs/prd/claude-usage.md FR7, FR15). Pure.

import { ALL_MODEL_WINDOWS, headroomFrom, type ClaudeRunsOn, type ClaudeUsageState, type ClaudeUsageWindow, type Headroom, type UsageAlertLevel } from '@portal/contracts';
import { labelOf, sortWindows, windowLevel, type WindowReading } from './parse.js';
import type { LimitReportMark } from './store.js';

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** A reading's windows as the page shows them, with each level worked out at `nowMs`. */
export function viewWindows(windows: WindowReading[], nowMs: number): ClaudeUsageWindow[] {
  return windows.map((w) => ({ key: w.key, label: w.label, usedPct: w.usedPct, resetsAt: iso(w.resetsAtMs), level: windowLevel(w.usedPct, w.resetsAtMs, nowMs) }));
}

/**
 * The windows with a limit a chat reported laid over them (T-255): until its reset, the window it names is used up, whatever a probe read
 * meanwhile (Claude Code's probe can say 0 % with no reset time for an account at its limit). Past the reset the report is ignored.
 */
export function withLimitReport(windows: WindowReading[], report: LimitReportMark | null | undefined, nowMs: number): WindowReading[] {
  if (!report || report.untilMs <= nowMs) return windows;
  const old = windows.find((w) => w.key === report.window);
  const w: WindowReading = { key: report.window, label: old?.label || labelOf(report.window), usedPct: Math.max(old?.usedPct ?? 0, 100), resetsAtMs: report.untilMs };
  return old ? windows.map((x) => (x.key === report.window ? w : x)) : sortWindows([...windows, w]);
}

/** A Claude's state: the worst of its windows that are not old (`reset`) or empty (`unknown`). */
export function stateOf(runsOn: ClaudeRunsOn, windows: WindowReading[], nowMs: number): ClaudeUsageState {
  if (runsOn === 'pool' || runsOn === 'key') return 'no_limits';
  if (runsOn === 'none') return 'signed_out';
  if (runsOn !== 'plan') return 'unknown';
  const live = windows.map((w) => ({ key: w.key, level: windowLevel(w.usedPct, w.resetsAtMs, nowMs) })).filter((w) => w.level !== 'reset' && w.level !== 'unknown');
  if (!live.length) return 'unknown';
  if (live.some((w) => w.level === 'exhausted' && ALL_MODEL_WINDOWS.includes(w.key))) return 'exhausted';
  return live.some((w) => w.level !== 'ok') ? 'near' : 'ok';
}

/** What `headroom(claudeId)` answers from one Claude's stored reading (FR15): the shared rule, on the windows as read at `nowMs`. */
export function headroomOf(
  claudeId: string,
  row: { runsOn: ClaudeRunsOn; windows: WindowReading[]; checkedAtMs: number | null } | null,
  opts: { pooled: boolean; stale: boolean },
  nowMs: number,
): Headroom {
  const runsOn: ClaudeRunsOn = opts.pooled ? 'pool' : row?.runsOn ?? 'unknown';
  return headroomFrom({ claudeId, runsOn, windows: viewWindows(row?.windows ?? [], nowMs), checkedAt: iso(row?.checkedAtMs ?? null), stale: opts.stale });
}

export const ALERT_RANK: Record<UsageAlertLevel | 'none', number> = { none: 0, near: 1, high: 2, exhausted: 3 };

/** The alert level a window's level maps to; `ok`, `reset` and `unknown` raise none. */
export function alertLevelOf(level: ClaudeUsageWindow['level']): UsageAlertLevel | null {
  return level === 'near' || level === 'high' || level === 'exhausted' ? level : null;
}
