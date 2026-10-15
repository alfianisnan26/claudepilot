// T-547 (D-65): use it or lose it. Pure helpers for two things: how `claude auto` scores a Claude for a NEW worker (unused room per minute to
// its reset) and the scorecard's "quota left unused at reset" (from the readings just before each reset). No clock, no store: the caller passes both.

import { measuredFigure, unavailableFigure, type Figure } from '@portal/contracts';

/** A Claude with a reset in under this many minutes counts as this many: a reset a minute away must not divide by zero or dominate. */
export const MIN_MINUTES_TO_RESET = 1;

/**
 * Unused room per minute to the reset: `leftPct / minutes`. A Claude with less room but a sooner reset scores higher, because that room is
 * lost sooner. An unknown or past reset time scores 0 (the Claude is ranked last among equals, never guessed at). `load` divides the score
 * by `1 + load` so a burst of spawns spreads instead of piling onto one Claude.
 */
export function useItScore(leftPct: number | null, resetsAt: string | null, nowMs: number, load = 0): number {
  if (leftPct === null || !Number.isFinite(leftPct) || leftPct <= 0 || !resetsAt) return 0;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= nowMs) return 0;
  const minutes = Math.max(MIN_MINUTES_TO_RESET, (at - nowMs) / 60_000);
  return leftPct / minutes / (1 + Math.max(0, load));
}

/** The words of the choice for the spawn result: the figures that decided it. */
export function useItWhy(name: string, leftPct: number | null, resetsAt: string | null, nowMs: number): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (leftPct === null || !Number.isFinite(at) || at <= nowMs) return `${name}: room by a measured reading`;
  const min = Math.max(MIN_MINUTES_TO_RESET, Math.round((at - nowMs) / 60_000));
  return `${name}: ${Math.round(leftPct)} % left, resets in ${min} min (use it or lose it)`;
}

/** One reading of one window: when it was taken, how much was used, and the reset time it carried. */
export interface WindowSample {
  atMs: number;
  usedPct: number;
  resetsAtMs: number | null;
}

/** One finished window period of one Claude: how much of it went unused. `unusedPct` is unavailable when no reading came close enough before the reset. */
export interface UnusedAtReset {
  claudeId: string;
  window: string;
  resetAtMs: number;
  /** The last reading before the reset: when, and the percent used then (null when there was none close enough). */
  readingAtMs: number | null;
  usedPct: number | null;
  unusedPct: Figure<number>;
}

/** A reading older than this before the reset is not "just before" it: the figure is unavailable, not guessed (probe cadence is minutes). */
export const JUST_BEFORE_MS = 30 * 60_000;

/**
 * Per finished period (reset time in `(sinceMs, nowMs]`) of one window of one Claude: 100 minus the percent used in the last reading taken at or
 * before the reset, when that reading is within JUST_BEFORE_MS of it. Samples of a period share its reset time (rounded to the minute: the
 * probe's reset times wander by seconds). Oldest period first. A period with no usable reading is listed as unavailable; a period that has not
 * ended is not listed.
 */
export function unusedAtReset(claudeId: string, window: string, samples: readonly WindowSample[], sinceMs: number, nowMs: number): UnusedAtReset[] {
  const byReset = new Map<number, WindowSample[]>();
  for (const s of samples) {
    if (s.resetsAtMs === null || !Number.isFinite(s.usedPct)) continue;
    const key = Math.round(s.resetsAtMs / 60_000) * 60_000;
    if (key > nowMs || key <= sinceMs) continue;
    (byReset.get(key) ?? byReset.set(key, []).get(key)!).push(s);
  }
  return [...byReset]
    .sort((a, b) => a[0] - b[0])
    .map(([resetAtMs, list]) => {
      const before = list.filter((s) => s.atMs <= resetAtMs).sort((a, b) => b.atMs - a.atMs)[0];
      if (!before || resetAtMs - before.atMs > JUST_BEFORE_MS) {
        return { claudeId, window, resetAtMs, readingAtMs: null, usedPct: null, unusedPct: unavailableFigure<number>('no_reading') };
      }
      const used = Math.min(100, Math.max(0, before.usedPct));
      return { claudeId, window, resetAtMs, readingAtMs: before.atMs, usedPct: used, unusedPct: measuredFigure(100 - used) };
    });
}
