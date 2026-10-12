// Claude usage: how fast a plan window fills and where it is heading (docs/prd/claude-usage.md §20.2). Pure: the store, the clock and the
// readings come in as arguments, so every formula is checked against a hand-computed fixture (pace.test.ts).
//
// The speed is the slope of the percent a probe or a live session READ, never of tokens; each figure says how it is known (an estimate, or why
// it is not available). Nothing here is invented: with too little to stand on a figure is unavailable with a reason code.

import {
  ALL_MODEL_WINDOWS,
  estimatedFigure,
  measuredFigure,
  unavailableFigure,
  type ClaudeRunsOn,
  type ClaudeUsageWindow,
  type Figure,
  type LimitOutlook,
  type NextReset,
  type PaceStatus,
  type UnavailableReason,
  type WindowPace,
} from '@portal/contracts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Readings closer than this say nothing about a rate: one percent of rounding is a huge speed over a few minutes (§20.2). */
export const MIN_SPAN_MS = 10 * MIN;
/** Reset times this close are one period (the same tolerance the alerts use). */
export const SAME_PERIOD_MS = 60_000;
/** A reading dated later than the clock by more than this is out of order. */
const SKEW_MS = 60_000;

/** The nominal length of a window, from what Claude Code names it: five hours for the session, a week for the weekly ones, else unknown. */
export function windowLengthMs(key: string): number | null {
  if (key === 'session') return 5 * HOUR;
  if (key === 'week' || key.startsWith('week_') || key.startsWith('model:')) return 7 * DAY;
  return null;
}

/** A stored reading of one window: when it was taken, the percent, and the reset time it carried (its period). */
export interface PaceSample {
  atMs: number;
  usedPct: number;
  resetsAtMs: number | null;
}

export interface PaceInput {
  key: string;
  /** The latest reading of the window: its percent and reset time, and when it was taken (null when never). */
  usedPct: number | null;
  resetsAtMs: number | null;
  readAtMs: number | null;
  /** Stored readings of this window, any period, any order (the other periods are left out here). */
  samples: PaceSample[];
  nowMs: number;
  /** The Claude's reading is old, or its workspace is stopped. */
  stale: boolean;
}

/** To a tenth; `+ 0` keeps a rounded -0 from showing as one. */
const round1 = (v: number): number => Math.round(v * 10) / 10 + 0;
/** An instant to the nearest second: an estimate is not worth a millisecond, and floating point would otherwise show one. */
const iso = (ms: number): string => new Date(Math.round(ms / 1000) * 1000).toISOString();

/** Every figure unavailable for one reason; the readings behind it say what little there was. */
function noPace(reason: UnavailableReason, readings = 0, spanMs = 0): WindowPace {
  return {
    speed: unavailableFigure(reason),
    projectedPct: unavailableFigure(reason),
    etaAt: unavailableFigure<string>(reason),
    status: unavailableFigure<PaceStatus>(reason),
    evenPct: unavailableFigure(reason),
    aheadPts: unavailableFigure(reason),
    readings,
    spanMin: Math.round(spanMs / MIN),
    method: null,
    lowConfidence: true,
  };
}

/** What an even spend would show now, and how far ahead of it the percent is: from the window's length and the reading's place in it. */
function evenPace(used: number, readAtMs: number, resetsAtMs: number, key: string): Pick<WindowPace, 'evenPct' | 'aheadPts'> {
  const length = windowLengthMs(key);
  if (length === null) return { evenPct: unavailableFigure('window_length_unknown'), aheadPts: unavailableFigure('window_length_unknown') };
  const share = Math.min(1, Math.max(0, (readAtMs - (resetsAtMs - length)) / length));
  const even = share * 100;
  return { evenPct: estimatedFigure(round1(even)), aheadPts: estimatedFigure(round1(used - even)) };
}

/** Slope in percentage points per hour: least squares through three or more points, first to last for two. Null when the times coincide. */
function slopePerHour(points: { atMs: number; usedPct: number }[]): number | null {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  // The same percent every time is no growth, exactly: the mean of equal fractions can differ from them in the last bit, which would read as a tiny fall.
  if (last.atMs !== first.atMs && points.every((p) => p.usedPct === first.usedPct)) return 0;
  if (points.length === 2) return last.atMs === first.atMs ? null : ((last.usedPct - first.usedPct) / (last.atMs - first.atMs)) * HOUR;
  const xs = points.map((p) => (p.atMs - first.atMs) / HOUR);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = points.reduce((a, p) => a + p.usedPct, 0) / points.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < points.length; i++) {
    sxy += (xs[i]! - meanX) * (points[i]!.usedPct - meanY);
    sxx += (xs[i]! - meanX) ** 2;
  }
  return sxx === 0 ? null : sxy / sxx;
}

/**
 * One window's speed and pace (docs §20.2). `U` is the percent at the latest reading, `t` its time, `R` the reset time, `L` the window's length.
 * The speed stands on this period's readings only (a reset time within a minute of `R`) plus the latest reading, which counts at its own time
 * because an unchanged reading is not stored again for half an hour.
 */
export function windowPace(input: PaceInput): WindowPace {
  const { usedPct: used, resetsAtMs: reset, readAtMs: readAt, nowMs } = input;
  if (used === null) return noPace('no_number');
  if (readAt === null) return noPace('no_reading');
  if (reset === null) return noPace('no_reset_time');
  if (reset <= nowMs || reset <= readAt) return noPace('period_reset');
  if (input.stale) return noPace('stale');
  if (readAt > nowMs + SKEW_MS) return noPace('clock_skew');

  const points = input.samples.filter((s) => s.resetsAtMs !== null && Math.abs(s.resetsAtMs - reset) < SAME_PERIOD_MS).map((s) => ({ atMs: s.atMs, usedPct: s.usedPct }));
  // The latest reading is one more reading of the period, unless a stored one is the same instant.
  if (!points.some((p) => p.atMs === readAt)) points.push({ atMs: readAt, usedPct: used });
  points.sort((a, b) => a.atMs - b.atMs);
  const readings = points.length;
  const span = points[readings - 1]!.atMs - points[0]!.atMs;
  const even = evenPace(used, readAt, reset, input.key);
  const withEven = (p: WindowPace): WindowPace => ({ ...p, ...even });
  if (points.some((p) => p.atMs > nowMs + SKEW_MS)) return noPace('clock_skew', readings, span);

  const length = windowLengthMs(input.key);
  const base = { readings, spanMin: Math.round(span / MIN), lowConfidence: readings < 3 || span < Math.max(MIN_SPAN_MS, (length ?? 0) / 10) };
  const exhausted = used >= 100;
  // An exhausted window needs no rate: the reading itself says it is used up.
  const finish = (speedFig: Figure, method: WindowPace['method'], speed: number | null): WindowPace => {
    if (exhausted) {
      return { ...base, ...even, speed: speedFig, method, projectedPct: measuredFigure(used), etaAt: measuredFigure(iso(readAt)), status: measuredFigure<PaceStatus>('exhausted') };
    }
    if (speed === null) return { ...withEven(noPace((speedFig.reason ?? 'single_sample') as UnavailableReason, readings, span)), speed: speedFig, method };
    const projected = round1(used + speed * ((reset - readAt) / HOUR));
    return {
      ...base,
      ...even,
      speed: speedFig,
      method,
      projectedPct: estimatedFigure(projected),
      etaAt: speed > 0 ? estimatedFigure(iso(readAt + ((100 - used) / speed) * HOUR)) : unavailableFigure<string>('no_growth'),
      status: estimatedFigure<PaceStatus>(projected > 100 ? 'over' : 'under'),
    };
  };

  if (readings < 2) return finish(unavailableFigure('single_sample'), null, null);
  if (span < MIN_SPAN_MS) return finish(unavailableFigure('short_span'), null, null);
  const slope = slopePerHour(points);
  const method = readings >= 3 ? 'least_squares' : 'first_last';
  if (slope === null) return finish(unavailableFigure('short_span'), method, null);
  if (slope < 0) return finish(unavailableFigure('decreasing'), method, null);
  return finish(estimatedFigure(round1(slope)), method, slope);
}

/* ---------- A Claude's outlook, and the soonest reset ---------- */

interface ClaudeWindows {
  runsOn: ClaudeRunsOn;
  windows: ClaudeUsageWindow[];
  /** When the windows were read (ISO), for an exhausted window's "already at the limit". */
  checkedAt: string | null;
}

/** An outlook that says why there is none. */
export const unavailableOutlook = (reason: UnavailableReason, window: LimitOutlook['window'] = null): LimitOutlook => ({
  status: unavailableFigure<PaceStatus>(reason),
  window,
  etaAt: unavailableFigure<string>(reason),
  projectedPct: unavailableFigure(reason),
});

const outlookWindow = (w: ClaudeUsageWindow): NonNullable<LimitOutlook['window']> => ({ key: w.key, label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt });

/** Why a Claude has no windows to look at: the reason a pool, a key, a signed-out login or an unread plan gives. */
export function noWindowsReason(runsOn: ClaudeRunsOn): UnavailableReason {
  return runsOn === 'pool' || runsOn === 'key' ? 'no_limits' : runsOn === 'none' ? 'signed_out' : 'no_reading';
}

/**
 * Where the limits that stop a Claude altogether (`session`, `week`) are heading (docs §20.2): `exhausted` if one is used up, else `over` with the
 * one that runs out first, else `under`; unavailable with the reason when no such window has a usable pace.
 */
export function outlookOf(c: ClaudeWindows): LimitOutlook {
  if (c.runsOn !== 'plan') return unavailableOutlook(noWindowsReason(c.runsOn));
  const stops = c.windows.filter((w) => ALL_MODEL_WINDOWS.includes(w.key) && w.usedPct !== null);
  const live = stops.filter((w) => w.level !== 'reset' && w.level !== 'unknown');
  if (!live.length) return unavailableOutlook(stops.length ? 'period_reset' : c.windows.length ? 'no_window' : 'no_reading');
  const out = live.filter((w) => w.level === 'exhausted');
  if (out.length) {
    // The one that holds the Claude longest decides when it is usable again.
    const w = out.reduce((a, b) => ((b.resetsAt ?? '') > (a.resetsAt ?? '') ? b : a));
    return {
      status: measuredFigure<PaceStatus>('exhausted'),
      window: outlookWindow(w),
      etaAt: c.checkedAt ? measuredFigure(c.checkedAt) : unavailableFigure<string>('no_reading'),
      projectedPct: measuredFigure(w.usedPct!),
    };
  }
  const withPace = live.filter((w) => w.pace && w.pace.status.basis !== 'unavailable');
  const over = withPace.filter((w) => w.pace!.status.value === 'over');
  if (over.length) {
    const w = over.reduce((a, b) => (Date.parse(b.pace!.etaAt.value ?? '') < Date.parse(a.pace!.etaAt.value ?? '') ? b : a));
    return { status: w.pace!.status, window: outlookWindow(w), etaAt: w.pace!.etaAt, projectedPct: w.pace!.projectedPct };
  }
  if (withPace.length) {
    const w = withPace.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
    return { status: w.pace!.status, window: outlookWindow(w), etaAt: w.pace!.etaAt, projectedPct: w.pace!.projectedPct };
  }
  // No window has a usable pace: say why for the fullest one.
  const w = live.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
  const reason = (w.pace?.status.reason ?? 'no_samples') as UnavailableReason;
  return unavailableOutlook(reason, outlookWindow(w));
}

/** The soonest future reset among a Claude's windows (a time Claude Code reported); unavailable with the reason when there is none. */
export function nextResetOf(c: ClaudeWindows, nowMs: number): NextReset {
  if (c.runsOn !== 'plan') return { at: unavailableFigure<string>(noWindowsReason(c.runsOn)), window: null };
  const future = c.windows.filter((w) => w.resetsAt !== null && w.level !== 'reset' && Date.parse(w.resetsAt) > nowMs);
  if (!future.length) return { at: unavailableFigure<string>(c.windows.some((w) => w.resetsAt !== null) ? 'period_reset' : c.windows.length ? 'no_reset_time' : 'no_reading'), window: null };
  const w = future.reduce((a, b) => (Date.parse(b.resetsAt!) < Date.parse(a.resetsAt!) ? b : a));
  return { at: measuredFigure(w.resetsAt!), window: { key: w.key, label: w.label } };
}

/**
 * The outlook of several Claudes as one: the one that runs out first (`over`), else the fullest that is `under`, else an exhausted one, else the
 * first reason. `from` says which Claude decided.
 */
export function soonestOutlook<T extends { outlook: LimitOutlook }>(claudes: T[]): { outlook: LimitOutlook; from: T | null } {
  if (!claudes.length) return { outlook: unavailableOutlook('no_reading'), from: null };
  const status = (c: T) => c.outlook.status.value;
  const over = claudes.filter((c) => status(c) === 'over');
  if (over.length) {
    const from = over.reduce((a, b) => (Date.parse(b.outlook.etaAt.value ?? '') < Date.parse(a.outlook.etaAt.value ?? '') ? b : a));
    return { outlook: from.outlook, from };
  }
  const under = claudes.filter((c) => status(c) === 'under');
  if (under.length) {
    const from = under.reduce((a, b) => ((b.outlook.window?.usedPct ?? 0) > (a.outlook.window?.usedPct ?? 0) ? b : a));
    return { outlook: from.outlook, from };
  }
  const out = claudes.filter((c) => status(c) === 'exhausted');
  if (out.length) return { outlook: out[0]!.outlook, from: out[0]! };
  return { outlook: claudes[0]!.outlook, from: claudes[0]! };
}

/** The soonest of several Claudes' next resets. */
export function soonestReset<T extends { nextReset: NextReset }>(claudes: T[]): { reset: NextReset; from: T | null } {
  const known = claudes.filter((c) => c.nextReset.at.basis !== 'unavailable');
  if (!known.length) return { reset: claudes[0]?.nextReset ?? { at: unavailableFigure<string>('no_reading'), window: null }, from: claudes[0] ?? null };
  const from = known.reduce((a, b) => (Date.parse(b.nextReset.at.value!) < Date.parse(a.nextReset.at.value!) ? b : a));
  return { reset: from.nextReset, from };
}
