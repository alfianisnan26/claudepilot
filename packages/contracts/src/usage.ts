// Usage insight (docs/prd/claude-usage.md §20): how fast requests spend, how fast a plan window fills and where it is heading, what changed
// since the previous period, the cache split, the colour each Claude and model keeps, the summary strip, the Move recommendation and the
// export. Nothing here names an account.
//
// NUMBERS ARE NEVER INVENTED (round 4 plan, P1). A derived figure travels as a `Figure`: its value, how it is known and, when it is not
// known, a fixed reason code. The page labels an estimate "est." (the formula in an InfoTip) and shows "-" with the reason in an InfoTip.
//   measured     a stored value, or exact arithmetic on stored values (a sum, a ratio, a difference): tokens, requests, a percent a probe
//                read, a reset time Claude Code reported, the cache hit rate, a change between two periods of tokens.
//   estimate     rests on an assumption: a rate (a request counts when it finishes), a projection, dollars (Claude Code prices tokens at API
//                list prices: for a plan that is what the use would cost, not a bill).
//   unavailable  no number; `reason` says why.

import type { ChatUsageRange, ChatUsageReport, ChatUsageTotals } from './chat.js';
import type { ClaudeRunsOn, ClaudeUsageState } from './claudeusage.js';

export type FigureBasis = 'measured' | 'estimate' | 'unavailable';

/** Why a figure is unavailable (fixed codes; `UNAVAILABLE_TEXT` has one short line for each, the page shows it in an InfoTip). */
export const UNAVAILABLE_REASONS = [
  'no_samples', // nothing recorded yet (no reading of this window, no request)
  'single_sample', // one reading in this period: a speed needs two
  'short_span', // the readings are too close together for a rate (under 10 minutes)
  'period_reset', // the window reset and no reading of the new period exists yet
  'decreasing', // the percentage fell inside the period, so no rate is taken
  'no_growth', // the window is not filling, so it never reaches 100 % at this speed
  'clock_skew', // reading times are out of order or in the future
  'stale', // the reading is old, or its workspace is stopped
  'signed_out', // the Claude is not signed in
  'no_limits', // a pool or an API key: no plan limits
  'no_reading', // a plan Claude whose limits have not been read yet
  'no_window', // a plan Claude with windows, but none of the session or week that stop it altogether
  'no_number', // Claude Code gave no percentage for the window
  'no_reset_time', // the window has no reset time, so nothing to project to
  'window_length_unknown', // the window's length is not known, so no even pace
  'no_requests', // no request recorded in the span
  'no_baseline', // the previous period is zero, so a percent change has no base
  'no_history', // too little earlier use to compare with
  'not_recorded', // the portal did not record this (the previous period predates its history)
  'session_deleted', // the session was deleted before its links were kept
  'no_cost', // requests exist but Claude Code reported no dollars for them (a share of the dollars means nothing)
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** One line each, short enough for an InfoTip. Unknown codes (another module's) fall back to {@link reasonText}'s default. */
export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  no_samples: 'Nothing recorded yet.',
  single_sample: 'Needs a second reading in this period.',
  short_span: 'Readings are too close together for a rate.',
  period_reset: 'The window just reset; no reading of the new period yet.',
  decreasing: 'The percentage fell inside this period.',
  no_growth: 'Not filling, so it never reaches 100 % at this speed.',
  clock_skew: 'Reading times are out of order.',
  stale: 'The reading is old.',
  signed_out: 'Not signed in.',
  no_limits: 'No plan limits (a pool or an API key).',
  no_reading: 'Not read yet.',
  no_window: 'No session or week window to look at.',
  no_number: 'Claude Code gave no percentage.',
  no_reset_time: 'No reset time to project to.',
  window_length_unknown: 'The window’s length is not known.',
  no_requests: 'No requests recorded.',
  no_baseline: 'Nothing in the previous period to compare with.',
  no_history: 'Too little earlier use to compare with.',
  not_recorded: 'Not recorded then.',
  session_deleted: 'The session was deleted.',
  no_cost: 'Claude Code reported no cost.',
};

export const reasonText = (reason: string | null | undefined): string => (reason && (UNAVAILABLE_TEXT as Record<string, string>)[reason]) || 'Not available.';

/**
 * A derived figure with its basis. `value` is null exactly when `basis` is `unavailable`, and then `reason` is set.
 * Narrow on `basis`: `if (f.basis === 'unavailable') show('-', f.reason) else show(f.value)`.
 */
export type Figure<T = number> = { value: T; basis: 'measured' | 'estimate'; reason?: undefined } | { value: null; basis: 'unavailable'; reason: UnavailableReason };

export const measuredFigure = <T = number>(value: T): Figure<T> => ({ value, basis: 'measured' });
export const estimatedFigure = <T = number>(value: T): Figure<T> => ({ value, basis: 'estimate' });
export const unavailableFigure = <T = number>(reason: UnavailableReason): Figure<T> => ({ value: null, basis: 'unavailable', reason });

/** The basis of each plain total in a request report: tokens and requests are stored counts; dollars are Claude Code's price estimate. */
export const REQUEST_BASIS = { costUsd: 'estimate', tokens: 'measured', requests: 'measured' } as const;

/* ---------- Palette (one colour per Claude and per model, everywhere) ---------- */

/** Slots 0 to 7 are the palette's eight colours (colour-blind safe; the page owns the values, `apps/web/src/lib/usage`). */
export const USAGE_PALETTE_SLOTS = 8;

/** A palette slot (0 to 7), or null: every slot of that kind is taken by something seen in the last 45 days, so draw it in the neutral grey ("Others"). */
export type PaletteSlot = number | null;

export type PaletteKind = 'claude' | 'model';

/**
 * `GET CLAUDE_USAGE_API.palette`: every assignment, for a place that shows a Claude or a model without a report (a chip, a dialog).
 * A Claude is keyed by its id (`default:<workspaceId>` for requests recorded without a Claude whose workspace's Default is gone), a
 * model by its id (`claude-opus-4-5`). The server gives a slot on first sight and keeps it (§20.6).
 */
export interface UsagePalette {
  slots: number;
  claudes: Record<string, PaletteSlot>;
  models: Record<string, PaletteSlot>;
}

/* ---------- Spend speed (from the requests the portal recorded) ---------- */

/**
 * How fast requests spend over a span (PRD §20.1). A request counts when it finishes, so a long request reads as a burst: every rate is an
 * estimate. Terminal use of Claude Code in a workspace is not recorded, so it is not in here.
 * - `15m`: what finished in the last 15 minutes, over 15 minutes.
 * - `today`: what finished since this device's midnight, over the time from the first request's start (its finish minus its own
 *   duration, not before midnight) to now. Unavailable with `no_requests` (none today) and `short_span` (under 5 minutes).
 * Tokens are input + output + cache writes; cache reads are given apart (they are read, not spent).
 */
export interface SpendRate {
  window: '15m' | 'today';
  /** The minutes it was taken over. */
  spanMin: number;
  /** Requests that finished in the span. */
  requests: number;
  tokensPerMin: Figure;
  cacheReadPerMin: Figure;
  costPerMin: Figure;
}

export interface SpendSpeed {
  trailing: SpendRate;
  today: SpendRate;
}

/** What was spent since this device's midnight. Tokens are input + output + cache writes. */
export interface SpendToday {
  from: string;
  costUsd: Figure;
  tokens: Figure;
  cacheRead: Figure;
  requests: Figure;
}

/* ---------- Quota speed and pace (from the percentages Claude Code reported) ---------- */

/** `under`: not projected to run out before the reset. `over`: projected to run out first. `exhausted`: already at 100 %. */
export type PaceStatus = 'under' | 'over' | 'exhausted';

/**
 * One plan window's speed and pace (PRD §20.2), from its readings in the CURRENT period only (the same reset time, plus the latest
 * reading) and NEVER from tokens. `U` is the percent used at the latest reading, `t` its time, `R` the reset time, `L` the window's length.
 * - `speed`: percentage points per hour, the least-squares slope through the readings (three or more), else first to last (two);
 *   unavailable below two readings or when they span under 10 minutes; unavailable when the percent fell (`decreasing`).
 * - `projectedPct` = U + speed x (R - t). Above 100 means it runs out first.
 * - `etaAt` = t + (100 - U) / speed; unavailable (`no_growth`) at speed 0.
 * - `status`: `exhausted` when U >= 100, `over` when projectedPct > 100, else `under`.
 * - `evenPct` = 100 x (t - (R - L)) / L, where an even spend would stand now; L is 5 h for `session` and 7 days for the weekly windows,
 *   else unavailable. `aheadPts` = U - evenPct (positive: ahead of an even spend).
 * Each is an estimate; with no reading to stand on each says why.
 */
export interface WindowPace {
  speed: Figure;
  projectedPct: Figure;
  etaAt: Figure<string>;
  status: Figure<PaceStatus>;
  evenPct: Figure;
  aheadPts: Figure;
  /** The readings behind `speed` (this period's, with the latest) and the minutes between the first and the last. */
  readings: number;
  spanMin: number;
  method: 'least_squares' | 'first_last' | null;
  /** Fewer than three readings, or they span under a tenth of the window (at least 10 minutes): shown, never alerted on. */
  lowConfidence: boolean;
}

/**
 * Where a Claude stands against the limits that stop it altogether (`session` and `week`, the windows `ALL_MODEL_WINDOWS` names; a model's
 * own week stops only that model and is not in here).
 * - `exhausted`: one of them is used up. `over`: one is projected to run out before it resets: `window` and `etaAt` are the one that runs out
 *   first. `under`: none is. `status` is unavailable (with the reason) for a pool or key (`no_limits`), signed out, not read, or no usable pace.
 */
export interface LimitOutlook {
  status: Figure<PaceStatus>;
  /** The window that decides; null when `status` is unavailable for lack of any window. */
  window: { key: string; label: string; usedPct: number | null; resetsAt: string | null } | null;
  etaAt: Figure<string>;
  projectedPct: Figure;
}

/** The soonest reset among a Claude's windows (a time Claude Code reported: measured). */
export interface NextReset {
  at: Figure<string>;
  window: { key: string; label: string } | null;
}

/* ---------- The summary strip ---------- */

/** One Claude's part of the strip. */
export interface UsageSummaryClaude {
  claudeId: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  slot: PaletteSlot;
  runsOn: ClaudeRunsOn;
  state: ClaudeUsageState;
  today: SpendToday;
  speed: SpendSpeed;
  limit: LimitOutlook;
  nextReset: NextReset;
}

/**
 * `GET CLAUDE_USAGE_API.summary?claudeId=&tz=`: the strip (spend today, speed, time until the limit, next reset). `tz` is
 * `Date.getTimezoneOffset()` of the viewer, so "today" starts at their midnight. Without `claudeId` every Claude counts:
 * `limit` is the Claude that runs out soonest (the soonest `over`, else the fullest), `nextReset` the soonest reset of any.
 * "Time until the limit" is `limit.etaAt` minus the clock; the page counts it down on its own clock.
 */
export interface UsageSummary {
  now: string;
  scope: { claudeId: string | null; claudeName: string | null };
  today: SpendToday;
  speed: SpendSpeed;
  limit: LimitOutlook & { claudeId: string | null; claudeName: string | null };
  nextReset: NextReset & { claudeId: string | null; claudeName: string | null };
  claudes: UsageSummaryClaude[];
}

/* ---------- The Requests report: previous period, cache split, stacked series ---------- */

/**
 * Tokens split by how the prompt cache served them (PRD §20.3). `hitRate` = read / (read + uncached + written): the share of input
 * tokens served from the cache. Exact arithmetic on stored counts: measured; unavailable (`no_requests`) when no input was recorded.
 */
export interface CacheSplit {
  uncached: number;
  written: number;
  read: number;
  hitRate: Figure;
}

/** The one rule for the split, for the server and the page both. */
export function cacheSplit(t: Pick<ChatUsageTotals, 'input' | 'cacheRead' | 'cacheWrite'>): CacheSplit {
  const all = t.input + t.cacheRead + t.cacheWrite;
  return { uncached: t.input, written: t.cacheWrite, read: t.cacheRead, hitRate: all > 0 ? measuredFigure(t.cacheRead / all) : unavailableFigure('no_requests') };
}

/** Percent change of the period against the one before: (this - before) / before x 100. */
export interface UsageChange {
  /** An estimate when it is (both are dollars). */
  costUsd: Figure;
  tokens: Figure;
  requests: Figure;
}

/**
 * The previous period of the same length, bucket for bucket (the i-th bucket here lines up with the i-th of the report).
 * `coverage`: `full` when the portal had recorded requests by the period's start (an empty bucket then means nothing ran), `partial` when
 * its history began inside it, `none` when it began after it: then `change` is unavailable (`not_recorded`). A zero base is
 * `no_baseline`. The totals and buckets are shown as they are recorded either way.
 */
export interface UsageComparison {
  from: string;
  to: string;
  coverage: 'full' | 'partial' | 'none';
  totals: ChatUsageTotals;
  buckets: (ChatUsageTotals & { at: string })[];
  change: UsageChange;
}

/** One Claude or one model across the report's buckets, for a stacked chart. Sorted most dollars first (then requests). */
export interface UsageSeries {
  kind: PaletteKind;
  /** A Claude's id (or `default:<workspaceId>`), a model's id. */
  key: string;
  /** A Claude's name, a model's id (the page may prettify it). */
  label: string;
  /** A Claude's workspace name; null for a model. */
  sub: string | null;
  workspaceId: string | null;
  slot: PaletteSlot;
  totals: ChatUsageTotals;
  cache: CacheSplit;
  /** In the order of `RequestsReport.buckets`; null where the series ran nothing. */
  buckets: (ChatUsageTotals | null)[];
}

/**
 * `GET CLAUDE_USAGE_API.requests?range=&claudeId=&tz=`: the Requests tab's report (`ChatUsageReport`) with a palette slot and the cache
 * split on every Claude and model row, the previous period, and the per-bucket series for stacked charts. Differences from
 * `GET /api/chat/usage`: a request recorded without a Claude (before Claudes existed) is counted under its workspace's Default Claude, and
 * `claudeId` of a Default Claude includes them. Percent figures here are fractions only where named so (`hitRate` is 0 to 1).
 */
export interface RequestsReport extends ChatUsageReport {
  byClaude: (ChatUsageReport['byClaude'][number] & { slot: PaletteSlot; cache: CacheSplit })[];
  byModel: (ChatUsageReport['byModel'][number] & { slot: PaletteSlot; cache: CacheSplit })[];
  cache: CacheSplit;
  previous: UsageComparison;
  /** Per Claude and per model, every one seen in the window (the page folds all but its top N into "Others"). */
  claudes: UsageSeries[];
  models: UsageSeries[];
  basis: typeof REQUEST_BASIS;
}

/* ---------- Move recommendation ---------- */

/**
 * Why a Claude ranks where it does for taking a chat (PRD §20.5).
 * `room`: at least 20 % of its fullest window left (100 minus the warn threshold). `over_pace`: the same, but at its current pace
 * it runs out before it resets (an estimate). `tight`: under 20 % left. `no_limits`: a pool or an API key (nothing to run out of; it
 * bills per use). `exhausted`: out until `availableAt`. `signed_out`. `unknown`: no reading yet (never recommended).
 */
export type MoveReason = 'room' | 'over_pace' | 'tight' | 'no_limits' | 'exhausted' | 'signed_out' | 'unknown';

export interface MoveCandidate {
  claudeId: string;
  name: string;
  workspaceId: string;
  slot: PaletteSlot;
  /** 1 and up among the Claudes that can take the chat now; null for those that cannot (exhausted, signed out, unknown). */
  rank: number | null;
  /** Only the best-ranked, and only when it is `room`, `over_pace` or `no_limits`: never a `tight`, signed-out, exhausted or unknown Claude. */
  recommended: boolean;
  reason: MoveReason;
  /** `measured`: the order follows readings only. `estimate`: its pace moved it (`over_pace`). `unavailable`: it cannot be ranked. */
  basis: FigureBasis;
  /** Of its fullest window. */
  leftPct: Figure;
  window: { key: string; label: string } | null;
  resetsAt: Figure<string>;
  /** For an exhausted Claude, when it can be used again. */
  availableAt: Figure<string>;
  pace: Figure<PaceStatus>;
  stale: boolean;
  checkedAt: string | null;
}

/** Why nothing is recommended: no other Claude, none that can take a chat now, or every one that can is `tight`. */
export type MoveNone = 'no_other_claude' | 'none_ready' | 'all_tight';

/**
 * `GET CLAUDE_USAGE_API.recommend?workspaceId=&from=`: the Claudes a chat can move to, ranked. A chat stays in its workspace, so
 * `workspaceId` picks the candidates (every Claude of it but `from`, the one the chat leaves). Order: `room` and `over_pace` Claudes
 * by percent left of their fullest window minus 20 points when `over_pace`, then the sooner reset; then `no_limits`; then `tight` by
 * percent left. Candidates that cannot take the chat follow, in a fixed order (exhausted by the time they return, unknown, signed out).
 */
export interface MoveRecommendation {
  now: string;
  workspaceId: string;
  from: string | null;
  /** The recommended Claude's id, or null (then `none` says why). */
  recommended: string | null;
  none: MoveNone | null;
  candidates: MoveCandidate[];
}

/* ---------- Export ---------- */

export const USAGE_EXPORT_WHAT = ['requests', 'quota'] as const;
export const USAGE_EXPORT_FORMATS = ['csv', 'json'] as const;
export type UsageExportWhat = (typeof USAGE_EXPORT_WHAT)[number];
export type UsageExportFormat = (typeof USAGE_EXPORT_FORMATS)[number];

/**
 * `GET CLAUDE_USAGE_API.export?what=&format=&range=&claudeId=&tz=`, a file download (`Content-Disposition: attachment`).
 * - `requests`: JSON is the whole `RequestsReport`. CSV is one row per bucket, Claude and model that ran something: `bucket_start`,
 *   `claude`, `workspace`, `model`, `requests`, `agents`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
 *   `cost_usd_estimate` (the column name says the dollars are an estimate; the token columns are measured).
 * - `quota`: the plan readings behind the Claudes tab. `range` is 1d, 7d or 30d; `claudeId` narrows to one Claude. JSON is a list
 *   of `ClaudeUsageHistory`; CSV is one row per reading: `at`, `claude`, `workspace`, `window`, `used_pct` (as Claude Code reported it).
 * A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` (spreadsheet formula injection).
 */
export interface UsageExportQuery {
  what: UsageExportWhat;
  format: UsageExportFormat;
  range?: ChatUsageRange;
  claudeId?: string;
  /** `Date.getTimezoneOffset()` of the viewer: buckets start at their midnights. */
  tz?: number;
}

/** The download's URL, for a link or a button. */
export function usageExportUrl(path: string, q: UsageExportQuery): string {
  const p = new URLSearchParams({ what: q.what, format: q.format });
  if (q.range) p.set('range', q.range);
  if (q.claudeId) p.set('claudeId', q.claudeId);
  if (q.tz !== undefined && Number.isFinite(q.tz)) p.set('tz', String(q.tz));
  return `${path}?${p.toString()}`;
}
