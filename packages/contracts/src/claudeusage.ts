// Claude usage (docs/prd/claude-usage.md): the plan limits of each Claude, read from Claude Code itself.
// Nothing here names an account: no email, organization or id. A Claude is the portal's own record of one.

import type { LimitOutlook, PaletteSlot, WindowPace } from './usage.js';

/** Where a window stands. `reset`: its reset time has passed, so the number is old. */
export type UsageLevel = 'ok' | 'near' | 'high' | 'exhausted' | 'reset' | 'unknown';

/** A Claude as a whole: `no_limits` is a pool or an API key (no plan, so nothing to run out of). */
export type ClaudeUsageState = 'ok' | 'near' | 'exhausted' | 'unknown' | 'signed_out' | 'no_limits';

/** What a Claude runs on: its own claude.ai plan, an API key, the workspace's account pool, nothing (signed out), or not known yet. */
export type ClaudeRunsOn = 'plan' | 'key' | 'pool' | 'none' | 'unknown';

/** `probe`: a short-lived Claude Code process asked for its usage. `live`: a running chat session reported it. */
export type UsageSource = 'probe' | 'live';

/** Why the last probe gave no numbers (fixed codes; Claude Code's own output is never kept or shown). */
export type UsageProblem = 'not_installed' | 'timeout' | 'unreadable' | 'unavailable' | 'no_scope';

/** Percent used at and above which a window is `near` and `high`. */
export const USAGE_THRESHOLDS = { warn: 80, critical: 95 } as const;

export interface ClaudeUsageWindow {
  /** `session`, `week`, `week_opus`, `week_sonnet`, `week_apps`, `week_models`, `model:<name>`, `other:<kind>`. */
  key: string;
  /** Short and fit to show as is: "Session", "Week", "Opus". */
  label: string;
  /** Percent of the window used (above 100 once over); null when Claude Code gave no number. */
  usedPct: number | null;
  /** ISO time the window resets; null when unknown. */
  resetsAt: string | null;
  level: UsageLevel;
  /** How fast this window fills and where it is heading (docs/prd/claude-usage.md §20.2). Set by the portal's snapshot; absent where only the window's reading is given (`headroomFrom`'s input). */
  pace?: WindowPace;
}

/** Extra usage (billed beyond the plan). Amounts are in minor units of `currency` (cents for USD). */
export interface ClaudeUsageExtra {
  enabled: boolean;
  usedPct: number | null;
  limit: number | null;
  used: number | null;
  currency: string | null;
}

export interface ClaudeUsage {
  claudeId: string;
  claudeName: string;
  workspaceId: string;
  workspaceName: string;
  runsOn: ClaudeRunsOn;
  state: ClaudeUsageState;
  /** The plan's tier name from Claude Code ("pro", "max", "team", "enterprise"); null without a plan or a reading. */
  plan: string | null;
  windows: ClaudeUsageWindow[];
  extra: ClaudeUsageExtra | null;
  /** When the numbers were read; null when they never were. */
  checkedAt: string | null;
  source: UsageSource | null;
  /** The reading is old, or its workspace is stopped: show it dimmed. */
  stale: boolean;
  workspaceRunning: boolean;
  /** Why the last probe gave no numbers. */
  problem: UsageProblem | null;
  /** Alerts are silenced until this ISO time. */
  snoozedUntil: string | null;
  /** Only the "will run out before reset" alerts are silenced until this ISO time (§20.4); the threshold alerts are not. */
  projectionSnoozedUntil: string | null;
  /** The colour this Claude keeps everywhere (a palette slot, or null: the neutral grey). */
  slot: PaletteSlot;
  /** Where the limits that stop this Claude are heading: will one run out before it resets (§20.2). */
  outlook: LimitOutlook;
  /** The last 7 days of the week window (else the session's), a few dozen points: the row's sparkline. */
  trend: { key: string; label: string; points: { at: string; usedPct: number }[] } | null;
}

export type UsageAlertLevel = 'near' | 'high' | 'exhausted';

/** `level`: a window crossed a threshold. `projection`: at its current speed a window will run out before it resets (§20.4). */
export type UsageAlertKind = 'level' | 'projection';

/** One crossing of a threshold by one window in one period (a period ends when the window resets). */
export interface ClaudeUsageAlert {
  /** `<claudeId>|<window>|<level>|<reset time in ms>`: stable, so a page shows each only once. */
  id: string;
  claudeId: string;
  claudeName: string;
  workspaceName: string;
  window: string;
  label: string;
  level: UsageAlertLevel;
  usedPct: number | null;
  resetsAt: string | null;
  at: string;
  /** Absent means `level`. For `projection`, `level` is `near` and carries no meaning, `id` reads `<claudeId>|<window>|projection|<reset ms>`, and the estimate follows. */
  kind?: UsageAlertKind;
  /** `projection`: when it is estimated to reach 100 %, and where it is estimated to stand at the reset. */
  etaAt?: string | null;
  projectedPct?: number | null;
}

export interface ClaudeUsageReport {
  claudes: ClaudeUsage[];
  /** Alerts of the last day for Claudes that aren't snoozed, newest first. */
  alerts: ClaudeUsageAlert[];
  thresholds: { warn: number; critical: number };
  /** The wait between probes of one Claude, in ms (shorter while a page is open). */
  intervalMs: number;
  now: string;
}

export const USAGE_RANGES = ['1d', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface ClaudeUsageSeries {
  key: string;
  label: string;
  points: { at: string; usedPct: number }[];
}

export interface ClaudeUsageHistory {
  claudeId: string;
  range: UsageRange;
  from: string;
  to: string;
  series: ClaudeUsageSeries[];
}

/** What a person (or the switch dialog) needs to know before using a Claude. */
export interface Headroom {
  claudeId: string;
  /** `plan`: the numbers below. `no_limits`: a pool or an API key. `signed_out`. `unknown`: no reading yet. */
  kind: 'plan' | 'no_limits' | 'signed_out' | 'unknown';
  /** The fullest window that has a number. */
  limiting: { key: string; label: string; usedPct: number; leftPct: number; resetsAt: string | null } | null;
  /** The session or the week is used up: nothing runs until then. */
  exhausted: boolean;
  /** When an exhausted Claude can be used again (the latest reset among its exhausted all-model windows). */
  availableAt: string | null;
  /** Labels of exhausted per-model windows (the Claude still runs other models). */
  blockedModels: string[];
  checkedAt: string | null;
  stale: boolean;
}

export type SnoozeUntil = '1h' | '4h' | 'reset';

/** What a snooze silences: absent, every alert of the Claude; `projection`, only its "will run out before reset" alerts (PUT `/snooze` `{ until, kind }`, DELETE `/snooze?kind=projection`). */
export type SnoozeKind = 'projection';

export const CLAUDE_USAGE_API = {
  list: '/api/claude-usage',
  /** `/api/claude-usage/<claudeId>/history?range=1d|7d|30d`, `/check` (POST), `/snooze` (PUT, DELETE). */
  one: (claudeId: string) => `/api/claude-usage/${encodeURIComponent(claudeId)}`,
  /** GET `?claudeId=&tz=`: the summary strip (`UsageSummary`). */
  summary: '/api/claude-usage/summary',
  /** GET `?range=30m|1h|12h|1d|7d|30d&claudeId=&tz=`: the Requests report with the previous period, the cache split and palette slots (`RequestsReport`). */
  requests: '/api/claude-usage/requests',
  /** GET `?workspaceId=&from=`: the Claudes a chat can move to, ranked (`MoveRecommendation`). */
  recommend: '/api/claude-usage/recommend',
  /** GET: every palette assignment (`UsagePalette`). */
  palette: '/api/claude-usage/palette',
  /** GET `?what=requests|quota&format=csv|json&range=&claudeId=&tz=`: a file download (`UsageExportQuery`; build the URL with `usageExportUrl`). */
  export: '/api/claude-usage/export',
} as const;

/** The windows whose exhaustion stops a Claude altogether; a model's weekly window stops only that model. */
export const ALL_MODEL_WINDOWS: readonly string[] = ['session', 'week'];

/**
 * What a Claude has left, from its windows as {@link ClaudeUsageWindow} says them (each `level` worked out at the time the
 * caller cares about). One function for the server's `headroom(claudeId)` and for the page, so both answer the same.
 */
export function headroomFrom(input: { claudeId: string; runsOn: ClaudeRunsOn; windows: ClaudeUsageWindow[]; checkedAt: string | null; stale: boolean }): Headroom {
  const base = { claudeId: input.claudeId, limiting: null, exhausted: false, availableAt: null, blockedModels: [] as string[], checkedAt: input.checkedAt, stale: input.stale };
  if (input.runsOn === 'pool') return { ...base, kind: 'no_limits', checkedAt: null, stale: false };
  if (input.runsOn === 'key') return { ...base, kind: 'no_limits' };
  if (input.runsOn === 'none') return { ...base, kind: 'signed_out' };
  if (input.runsOn !== 'plan') return { ...base, kind: 'unknown' };
  const live = input.windows.filter((w) => w.usedPct !== null && w.level !== 'reset' && w.level !== 'unknown');
  if (!live.length) return { ...base, kind: 'unknown' };
  const fullest = live.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
  const stopped = live.filter((w) => w.level === 'exhausted' && ALL_MODEL_WINDOWS.includes(w.key));
  const resets = stopped.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)).filter((t) => Number.isFinite(t));
  return {
    ...base,
    kind: 'plan',
    limiting: { key: fullest.key, label: fullest.label, usedPct: fullest.usedPct!, leftPct: Math.max(0, Math.round((100 - fullest.usedPct!) * 10) / 10), resetsAt: fullest.resetsAt },
    exhausted: stopped.length > 0,
    availableAt: stopped.length && resets.length === stopped.length ? new Date(Math.max(...resets)).toISOString() : null,
    blockedModels: live.filter((w) => w.level === 'exhausted' && !ALL_MODEL_WINDOWS.includes(w.key) && /^(week_(opus|sonnet|models)|model:)/.test(w.key)).map((w) => w.label),
  };
}

