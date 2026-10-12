// Usage spend: spike detection (docs/prd/claude-usage.md §24). Three rules of thumb, each a pure comparison of one number against a
// baseline the portal can show. They are HEURISTICS: an event says "this looks unusual, here is the evidence", never "this is wrong", and
// the only thing one ever does is raise an alert. Nothing here is a model; every threshold is a Settings value (`usage.spikes.*`).
//
//   rate     spend in the trailing 15 minutes of one Claude  >=  rateFactor x P90, where P90 is the 90th percentile (nearest rank) of that
//            Claude's ACTIVE 15-minute periods (spend above 0) over the 7 days before, and at least `minUsd`.
//            Needs 8 active periods; with fewer there is no baseline (`no_history`), and nothing is said.
//   burst    one session finished  >=  burstRequests requests inside burstWindowMin minutes. A loop BETWEEN turns (a ticket, CI or another
//            session answering each other) looks like this; a runaway INSIDE one turn only shows when that turn ends (as an outlier).
//   outlier  one request cost  >=  outlierFactor x the median request of that Claude over the 7 days before, and at least `minUsd`.
//            Needs 20 earlier requests that cost something; with fewer there is no median (`no_history`).
//
// Why a percentile and not a mean for `rate`: spend per active period is right-skewed, so "5 x the median" is exceeded by about one active
// period in twenty on ordinary days; "3 x the 90th percentile" is exceeded by about one in a hundred. Pure.

import { estimatedFigure, type SpendFigure, type SpikeEvidence, type SpikeKind, type SpikeSettings } from '@portal/contracts';

export const MIN = 60_000;
export const RATE_WINDOW_MIN = 15;
export const RATE_WINDOW_MS = RATE_WINDOW_MIN * MIN;
export const BASELINE_MS = 7 * 24 * 60 * MIN;
export const BURST_WINDOW_MIN = 10;
/** Active 15-minute periods the rate baseline needs. */
export const MIN_PERIODS = 8;
/** Earlier requests the outlier median needs. */
export const MIN_REQUESTS = 20;
/** After an event, the same subject raises no other of its kind for this long. */
export const COOLDOWN_MS: Record<SpikeKind, number> = { rate: 30 * MIN, burst: 60 * MIN, outlier: 5 * MIN };

/** The value at rank ceil(p/100 x n) of the sorted values (nearest rank, 1-based); null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p * sorted.length) / 100)));
  return sorted[rank - 1]!;
}

/** The middle value; with an even count the mean of the two middle ones. Null for no values. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** `hit`: raise an event. `quiet`: nothing unusual (or under the floor). `no_history`: not enough earlier use to compare with, so nothing can be said. */
export type Verdict<E> = { state: 'hit'; evidence: E } | { state: 'quiet' } | { state: 'no_history'; have: number; need: number };

export interface RateFacts {
  baselineUsd: number;
  factor: number;
  periods: number;
}

/** `spentUsd`: the trailing 15 minutes; `periods`: the spend of each earlier ACTIVE 15-minute period of the 7 days. */
export function rateVerdict(spentUsd: number, periods: readonly number[], cfg: SpikeSettings): Verdict<RateFacts> {
  if (!(spentUsd >= cfg.minUsd) || !(spentUsd > 0)) return { state: 'quiet' };
  if (periods.length < MIN_PERIODS) return { state: 'no_history', have: periods.length, need: MIN_PERIODS };
  const baselineUsd = percentile(periods, 90)!;
  if (!(baselineUsd > 0)) return { state: 'quiet' };
  const factor = spentUsd / baselineUsd;
  return factor >= cfg.rateFactor ? { state: 'hit', evidence: { baselineUsd, factor, periods: periods.length } } : { state: 'quiet' };
}

/** `requests`: finished requests by one session in the window. */
export function burstVerdict(requests: number, cfg: SpikeSettings): Verdict<{ requests: number; threshold: number }> {
  return requests >= cfg.burstRequests ? { state: 'hit', evidence: { requests, threshold: cfg.burstRequests } } : { state: 'quiet' };
}

export interface OutlierFacts {
  medianUsd: number;
  factor: number;
  requests: number;
}

/** `costUsd`: the request; `history`: what each earlier request of the Claude over the 7 days cost (those that cost something). */
export function outlierVerdict(costUsd: number, history: readonly number[], cfg: SpikeSettings): Verdict<OutlierFacts> {
  if (!(costUsd >= cfg.minUsd) || !(costUsd > 0)) return { state: 'quiet' };
  if (history.length < MIN_REQUESTS) return { state: 'no_history', have: history.length, need: MIN_REQUESTS };
  const medianUsd = median(history)!;
  if (!(medianUsd > 0)) return { state: 'quiet' };
  const factor = costUsd / medianUsd;
  return factor >= cfg.outlierFactor ? { state: 'hit', evidence: { medianUsd, factor, requests: history.length } } : { state: 'quiet' };
}

const usd = (v: number): string => `$${v < 10 ? v.toFixed(2) : Math.round(v).toString()}`;
const times = (v: number): string => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}x`;

const rounded = (v: number): number => Math.round(v * 1e6) / 1e6;
const est = (v: number): SpendFigure => estimatedFigure(rounded(v));

/** The evidence as the contract carries it: dollars and ratios are estimates, counts are measured. */
export function rateEvidence(spentUsd: number, f: RateFacts, topSession: { sessionId: string; share: number } | null): SpikeEvidence {
  return { kind: 'rate', windowMin: RATE_WINDOW_MIN, spentUsd: est(spentUsd), baselineUsd: est(f.baselineUsd), factor: est(f.factor), periods: f.periods, topSession };
}

export function burstEvidence(requests: number, threshold: number, spentUsd: number): SpikeEvidence {
  return { kind: 'burst', requests, windowMin: BURST_WINDOW_MIN, threshold, spentUsd: est(spentUsd) };
}

export function outlierEvidence(costUsd: number, f: OutlierFacts): SpikeEvidence {
  return { kind: 'outlier', costUsd: est(costUsd), medianUsd: est(f.medianUsd), factor: est(f.factor), requests: f.requests };
}

const figure = (f: SpendFigure): number => (f.value ?? 0);

/** One terse line for the event (a toast, a tool's summary): what happened, against what. */
export function spikeSummary(e: SpikeEvidence): string {
  switch (e.kind) {
    case 'rate':
      return `${usd(figure(e.spentUsd))} in ${e.windowMin} min, ${times(figure(e.factor))} the usual`;
    case 'burst':
      return `${e.requests} requests in ${e.windowMin} min (limit ${e.threshold})`;
    case 'outlier':
      return `A ${usd(figure(e.costUsd))} request, ${times(figure(e.factor))} the median`;
  }
}
