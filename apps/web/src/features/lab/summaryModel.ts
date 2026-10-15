// What the Crew summary block and its Glance widget say (T-600): pace (effectiveness) and usage, resolved, per cost, created per closed
// (efficiency). Pure, so the wording is tested without a browser. "unavailable" is a state with its reason, never a number or a division by zero.

import type { CrewFigure, CrewPace, CrewSummary, CrewSummaryWindow } from '@portal/contracts';
import { formatCost } from '@/lib/usage/format';
import { basisLabel, fmtFigure, fmtPerHour, reasonText, UNAVAILABLE, type BasisLabel, type TileState } from './scorecardModel';

/** Pace is "effective" between these (docs: under 0.9 quota is left unused at reset, over 1.1 it runs out early). */
export const PACE_LOW = 0.9;
export const PACE_HIGH = 1.1;

/**
 * Columns of the five figures follow the width of the card they sit in (container query), not the viewport:
 * the Home Pace card is about 415 px wide at 1280 px. 2 columns below 366 px (a phone card is 358), 3 up to 576 px (the Home block is 374 at 1280), 5 from there.
 */
export const SUMMARY_GRID_CLASS = 'grid grid-cols-2 gap-x-3 gap-y-3 pb-3 @min-[366px]:grid-cols-3 @xl:grid-cols-5';

export type SummaryKey = 'pace' | 'usage' | 'resolved' | 'perCost' | 'createdPerClosed';
export type Trend = 'up' | 'down' | 'same';

export interface SummaryTile {
  key: SummaryKey;
  /** One or two words. */
  label: string;
  value: string;
  /** One short line under the value (the state in words, or the reason when unavailable). */
  sub: string | null;
  state: TileState;
  basis: BasisLabel;
  /** The InfoTip: what it is, its source, and the reason when unavailable. */
  tip: string;
  /** Against the window before; null when not compared or either side is unavailable. Pace is a snapshot of now and has none. */
  trend: Trend | null;
  /** The previous window's figure as text ("was 2"), null with `trend`. */
  was: string | null;
}

/** "0.75 : 1". Null and unavailable read as the word. */
export function fmtRatio(f: CrewFigure | undefined | null): string {
  if (!f || f.basis === 'unavailable' || f.value === null) return UNAVAILABLE;
  return `${f.value.toFixed(2)} : 1`;
}

const fmtRate = (n: number): string => `${fmtPerHour(n)} / h`;
const fmtPlain = (n: number): string => String(Math.round(n));
const fmtTwo = (n: number): string => n.toFixed(2);

export function trendOf(cur: CrewFigure | undefined, prev: CrewFigure | undefined | null): Trend | null {
  if (!prev || !cur || cur.value === null || prev.value === null || cur.basis === 'unavailable' || prev.basis === 'unavailable') return null;
  const d = cur.value - prev.value;
  return Math.abs(d) < 0.005 ? 'same' : d > 0 ? 'up' : 'down';
}

export const TREND_WORD: Record<Trend, string> = { up: 'up', down: 'down', same: 'no change' };

function tip(what: string, f: CrewFigure): string {
  const why = f.basis === 'unavailable' ? ` Unavailable: ${reasonText(f.reason)}.` : '';
  return `${what} ${basisLabel(f)}. Source: ${f.source}.${why}`;
}

export function paceState(p: CrewPace): TileState {
  const v = p.ratio.value;
  if (p.ratio.basis === 'unavailable' || v === null) return 'unavailable';
  return v < PACE_LOW || v > PACE_HIGH ? 'warn' : 'ok';
}

export function paceSub(p: CrewPace): string {
  const v = p.ratio.value;
  if (p.ratio.basis === 'unavailable' || v === null) return reasonText(p.ratio.reason);
  if (v > PACE_HIGH) return 'runs out early';
  if (v < PACE_LOW) return p.unusedAtResetPct === null ? 'quota left unused at reset' : `about ${Math.round(p.unusedAtResetPct)} % unused at reset`;
  return 'on pace';
}

/** The tiles of the block, in order. `s.previous` is null when the page is not comparing. */
export function summaryTiles(s: CrewSummary): SummaryTile[] {
  const c = s.current;
  const prev = s.previous;
  const mk = (key: SummaryKey, label: string, f: CrewFigure, fmt: (n: number) => string, what: string, sub: string | null, pick?: (w: CrewSummaryWindow) => CrewFigure): SummaryTile => {
    const before = prev && pick ? pick(prev) : null;
    const trend = pick ? trendOf(f, before) : null;
    return {
      key,
      label,
      value: key === 'createdPerClosed' || key === 'pace' ? fmtRatio(f) : fmtFigure(f, fmt),
      sub: f.basis === 'unavailable' ? reasonText(f.reason) : sub,
      state: f.basis === 'unavailable' ? 'unavailable' : 'ok',
      basis: basisLabel(f),
      tip: tip(what, f),
      trend,
      was: trend === null || !before ? null : key === 'createdPerClosed' ? fmtRatio(before) : fmtFigure(before, fmt),
    };
  };

  const pace: SummaryTile = {
    key: 'pace',
    label: 'Pace',
    value: fmtRatio(s.pace.ratio),
    sub: paceSub(s.pace),
    state: paceState(s.pace),
    basis: basisLabel(s.pace.ratio),
    tip: tip('Quota used against an even spend over the 5-hour window, all signed-in Claudes together. 1 : 1 spends the quota exactly by its reset.', s.pace.ratio),
    trend: null,
    was: null,
  };

  const usd = c.usdPerHour;
  const usage = mk('usage', 'Usage', c.requestsPerHour, fmtRate, 'Requests per hour in the window, all crews.', usd.basis === 'unavailable' ? null : `${formatCost(usd.value ?? 0)} / h est.`, (w) => w.requestsPerHour);
  usage.tip += ` Dollars: ${usd.basis === 'unavailable' ? `unavailable, ${reasonText(usd.reason)}` : `ESTIMATE, source ${usd.source}`}.`;

  const resolved = mk('resolved', 'Resolved', c.resolved, fmtPlain, 'Tickets closed done in the window, all programs.', c.wontDo.basis === 'unavailable' ? null : `${fmtPlain(c.wontDo.value ?? 0)} won’t do`, (w) => w.resolved);
  const perCost = mk('perCost', 'Per cost', c.perResolvedUsd, formatCost, 'Estimated dollars of the window per resolved ticket.', 'per resolved, est.', (w) => w.perResolvedUsd);
  const ratio = c.createdPerClosed.value;
  const cpc = mk(
    'createdPerClosed',
    'Created : closed',
    c.createdPerClosed,
    fmtTwo,
    'Tickets created per ticket closed (done and won’t do). Under 1 the backlog shrinks.',
    ratio === null ? null : ratio < 1 ? 'backlog shrinks' : ratio > 1 ? 'backlog grows' : 'backlog holds',
    (w) => w.createdPerClosed,
  );
  return [pace, usage, resolved, perCost, cpc];
}

export interface SummaryList {
  title: string;
  rows: string[];
}

/** The expanded view: each Claude's own pace, resolved and created per closed per program. */
export function summaryLists(s: CrewSummary): SummaryList[] {
  const c = s.current;
  return [
    {
      title: 'Pace by Claude',
      rows: s.pace.claudes.map((k) => `${k.label}: ${fmtRatio(k.ratio)} (${Math.round(k.usedPct)} % used, ${Math.round(k.evenPct)} % even)`),
    },
    { title: 'Weekly pace', rows: s.pace.weekly.basis === 'unavailable' ? [`unavailable: ${reasonText(s.pace.weekly.reason)}`] : [fmtRatio(s.pace.weekly)] },
    { title: 'Resolved by program', rows: c.resolvedByProgram.map((r) => `${r.title || r.program}: ${r.count}`) },
    {
      title: 'Created : closed by program',
      rows: c.createdPerClosedByProgram.map((r) => `${r.title || r.program}: ${r.created} created, ${r.closed} closed${r.ratio.basis === 'unavailable' ? ' (unavailable)' : `, ${fmtTwo(r.ratio.value ?? 0)}`}`),
    },
  ];
}

export interface PaceCompact {
  value: string | null;
  level: 'ok' | 'warn' | 'unknown';
  title: string;
}

/** The Glance chip: the global pace ("0.75"), never more than five characters. */
export function paceCompact(s: CrewSummary | null, failed: boolean): PaceCompact {
  if (!s) return { value: '-', level: 'unknown', title: failed ? 'Pace: could not be read' : 'Pace: loading' };
  const st = paceState(s.pace);
  if (st === 'unavailable') return { value: '-', level: 'unknown', title: `Pace: unavailable, ${paceSub(s.pace)}` };
  return { value: (s.pace.ratio.value ?? 0).toFixed(2), level: st === 'warn' ? 'warn' : 'ok', title: `Pace ${fmtRatio(s.pace.ratio)}: ${paceSub(s.pace)}` };
}
