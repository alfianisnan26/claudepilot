// What the Crew scorecard page says (docs/prd/claude-usage.md §28.14): the five headline numbers of a program with their state, basis and source.
// Pure, so the wording is tested without a browser. "unavailable" is a state with a reason, never a number.

import { CREW_D65_TARGETS, type CrewD65TargetId, type CrewFigure, type CrewProgramScore, type CrewUnavailable, type CrewWindow } from '@portal/contracts';
import { formatCost } from '@/lib/usage/format';

export const WINDOW_OPTIONS: { value: CrewWindow; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
];

export const UNAVAILABLE = 'unavailable';

/** A review waiting longer than this is a warn (a default of this page, not a standing decision: the tile's tip says so). */
export const REVIEW_WARN_MS = 24 * 3_600_000;

export type TileState = 'ok' | 'warn' | 'breach' | 'unavailable';
export type TileKey = 'donePerHour' | 'costPerDone' | 'leadShare' | 'reviewBacklog' | 'breaches';
export type BasisLabel = 'MEASURED' | 'ESTIMATE' | 'UNAVAILABLE';

export interface Tile {
  key: TileKey;
  label: string;
  /** The number as text, or "unavailable". */
  value: string;
  state: TileState;
  basis: BasisLabel;
  /** The InfoTip text: the source, the reason when unavailable, and how the state is told. */
  tip: string;
  /** The same figure in the previous window ("was 2"), null when not compared or not available. */
  was: string | null;
}

const REASON: Record<CrewUnavailable, string> = {
  no_source: 'the portal has no table for it',
  no_samples: 'nothing to divide by in this window',
  not_recorded: 'it was never recorded',
  windows_just_reset: 'the quota windows just reset',
  no_claude: 'no Claude is signed in and readable',
};

export const reasonText = (r: CrewUnavailable | undefined): string => (r ? REASON[r] : 'not available');

export const basisLabel = (f: CrewFigure): BasisLabel => (f.basis === 'measured' ? 'MEASURED' : f.basis === 'estimate' ? 'ESTIMATE' : 'UNAVAILABLE');

export const fmtPerHour = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(1));
export const fmtPercent = (n: number): string => `${Math.round(n)} %`;
export const fmtCount = (n: number): string => String(Math.round(n));

/** A figure as text; unavailable (or a null value) reads as the word, never as 0. */
export function fmtFigure(f: CrewFigure | undefined | null, fmt: (n: number) => string): string {
  if (!f || f.basis === 'unavailable' || f.value === null) return UNAVAILABLE;
  return fmt(f.value);
}

function tip(f: CrewFigure, rule: string): string {
  const why = f.basis === 'unavailable' ? ` Unavailable: ${reasonText(f.reason)}.` : '';
  return `${basisLabel(f)}. Source: ${f.source}.${why} ${rule}`;
}

const stateOf = (f: CrewFigure): TileState => (f.basis === 'unavailable' ? 'unavailable' : 'ok');

/** The five numbers of a program, in the order the card shows them. */
export function tiles(p: CrewProgramScore): Tile[] {
  const c = p.current;
  const prev = p.previous;
  const was = (pick: (w: NonNullable<typeof prev>) => CrewFigure, fmt: (n: number) => string): string | null => {
    if (!prev) return null;
    const t = fmtFigure(pick(prev), fmt);
    return t === UNAVAILABLE ? null : t;
  };

  const done = c.effectiveness.donePerHour;
  const cost = c.cost.perDoneAllIn;
  const share = c.cost.leadShare;
  const backlog = c.effectiveness.reviewBacklog;
  const oldest = c.effectiveness.review.reduce((m, r) => Math.max(m, r.ageMs), 0);
  const backlogState: TileState = backlog.basis === 'unavailable' ? 'unavailable' : oldest > REVIEW_WARN_MS ? 'warn' : 'ok';

  const breaches = p.targets.filter((t) => t.state === 'breach').length;
  const warns = p.targets.filter((t) => t.state === 'warn').length;
  const allUnavailable = p.targets.length === 0 || p.targets.every((t) => t.state === 'unavailable');
  const breachState: TileState = allUnavailable ? 'unavailable' : breaches > 0 ? 'breach' : warns > 0 ? 'warn' : 'ok';
  const breachList = p.targets.map((t) => `${t.decision} ${t.id.replace(/_/g, ' ')}: ${t.state}`).join('; ');

  return [
    { key: 'donePerHour', label: 'Done / h', value: fmtFigure(done, fmtPerHour), state: stateOf(done), basis: basisLabel(done), tip: tip(done, 'Tickets closed as done in the window, per hour. No target: the state is ok when measured.'), was: was((w) => w.effectiveness.donePerHour, fmtPerHour) },
    { key: 'costPerDone', label: '$ / done', value: fmtFigure(cost, formatCost), state: stateOf(cost), basis: basisLabel(cost), tip: tip(cost, 'The window’s dollars over its done tickets, lead included. No target: the state is ok when available.'), was: was((w) => w.cost.perDoneAllIn, formatCost) },
    { key: 'leadShare', label: 'Lead share', value: fmtFigure(share, fmtPercent), state: stateOf(share), basis: basisLabel(share), tip: tip(share, 'The lead chain’s part of the window’s dollars. No target: the state is ok when available.'), was: was((w) => w.cost.leadShare, fmtPercent) },
    { key: 'reviewBacklog', label: 'In review', value: fmtFigure(backlog, fmtCount), state: backlogState, basis: basisLabel(backlog), tip: tip(backlog, 'Tickets in review at the window’s end. Warn when one has waited more than a day (this page’s default).'), was: was((w) => w.effectiveness.reviewBacklog, fmtCount) },
    {
      key: 'breaches',
      label: 'Breaches',
      // A warn with no breach reads "1 warn", not "0" beside a WARN state; breaches keep the plain count (the state word says breach).
      value: allUnavailable ? UNAVAILABLE : breaches === 0 && warns > 0 ? `${fmtCount(warns)} warn` : fmtCount(breaches),
      state: breachState,
      basis: allUnavailable ? 'UNAVAILABLE' : 'MEASURED',
      tip: `${allUnavailable ? 'UNAVAILABLE' : 'MEASURED'}. Source: the D-61, D-62, D-63 and D-65 checks (${breachList || 'none ran'}). Breach when any is a breach, warn when any is a warn.`,
      was: null,
    },
  ];
}

/** T-549 (D-65): a target row as the page shows it. */
export interface D65Row {
  id: CrewD65TargetId;
  /** One or two words. */
  label: string;
  value: string;
  state: TileState;
  basis: BasisLabel;
  /** Session, ticket or Claude ids behind a warn or a breach (at most 5 shown). */
  offenders: string[];
  /** The InfoTip text: the rule, the source, the reason when unavailable. */
  tip: string;
}

const pct1 = (n: number): string => `${n.toFixed(1)} %`;
const D65_FORMAT: Record<CrewD65TargetId, { label: string; fmt: (n: number) => string }> = {
  cost_per_done: { label: 'Cost / done', fmt: formatCost },
  lead_share: { label: 'Lead share', fmt: pct1 },
  qa_opus_share: { label: 'QA on opus', fmt: pct1 },
  done_rate: { label: 'Done / day', fmt: fmtPerHour },
  quota_unused: { label: 'Quota unused', fmt: pct1 },
  wasted_tool_calls: { label: 'Wasted calls', fmt: pct1 },
};

/** The D-65 rows of a program in a fixed order; a row the server did not send reads unavailable, never a number. */
export function d65Rows(p: CrewProgramScore): D65Row[] {
  return CREW_D65_TARGETS.map((id) => {
    const t = p.targets.find((x) => x.id === id);
    const { label, fmt } = D65_FORMAT[id];
    if (!t) return { id, label, value: UNAVAILABLE, state: 'unavailable', basis: 'UNAVAILABLE', offenders: [], tip: 'UNAVAILABLE. This server did not send the row.' };
    return { id, label, value: fmtFigure(t.figure, fmt), state: t.state, basis: basisLabel(t.figure), offenders: t.offenders, tip: tip(t.figure, t.rule) };
  });
}

/**
 * T-490 (D-63): the opus share of a program's QA and review workers in the window, as one line: "QA/review on opus: 50 % (1 of 2, 1 with a
 * why)". With none in the window, the word unavailable and its reason, never 0 %.
 */
export function qaOpusLine(p: CrewProgramScore): string {
  const q = p.current.efficiency.qaReviewOpus;
  if (!q || q.share.basis === 'unavailable' || q.share.value === null) return `QA/review on opus: ${UNAVAILABLE} (${reasonText(q?.share.reason)})`;
  return `QA/review on opus: ${fmtPercent(q.share.value)} (${q.opus} of ${q.sessions}${q.opus ? `, ${q.opusWithWhy} with a why` : ''})`;
}

/** A review item's wait as text: "3 h", "2 d". */
export function fmtAge(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
}
