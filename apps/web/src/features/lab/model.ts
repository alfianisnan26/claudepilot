// The Lab tab's figures as text: one rule each, and "unavailable" as a state (a figure the lab could not compute is never shown as 0).
import type { LabInterval, LabStat, LabSummaryRow } from '@portal/contracts';
import { formatCost, formatShare, formatTokens, prettyModel } from '@/lib/usage/format';

export const UNAVAILABLE = 'unavailable';

const or = <T,>(v: T | null | undefined, f: (x: T) => string): string => (v === null || v === undefined ? UNAVAILABLE : f(v));

/** "Implementer · Opus 5.5"; the main thread reads "Main". */
export function rowTitle(r: Pick<LabSummaryRow, 'role' | 'model'>): string {
  const role = r.role.charAt(0).toUpperCase() + r.role.slice(1);
  return r.model ? `${role} · ${prettyModel(r.model)}` : role;
}

export const fmtCount = (v: number | null | undefined) => or(v, (x) => formatTokens(Math.round(x)));
export const fmtMinutes = (v: number | null | undefined) => or(v, (x) => `${x.toFixed(x < 10 ? 1 : 0)} min`);
export const fmtCost = (v: number | null | undefined) => or(v, formatCost);
export const fmtShare = (v: number | null | undefined) => or(v, formatShare);
/** The median, with the p90 after a slash when it differs: "47 / 120". */
export function fmtStat(s: LabStat | null, f: (v: number | null) => string): string {
  if (!s || s.median === null) return UNAVAILABLE;
  return s.p90 !== null && s.p90 !== s.median ? `${f(s.median)} / ${f(s.p90)}` : f(s.median);
}
/** "$1.20–$1.90" or "n too small". */
export function fmtInterval(i: LabInterval): string {
  return i === 'n too small' ? i : `${formatCost(i.low)}–${formatCost(i.high)}`;
}

export interface Figure {
  key: string;
  label: string;
  value: string;
  /** The basis key whose source line the InfoTip shows. */
  basis: string;
}

/** The figures of one row, in the order the card and the table show them. */
export function figures(r: LabSummaryRow): Figure[] {
  return [
    { key: 'n', label: 'Slices', value: String(r.n), basis: 'slices' },
    { key: 'req', label: 'Requests', value: fmtStat(r.requests, fmtCount), basis: 'requests' },
    { key: 'ctx', label: 'Context', value: fmtStat(r.ctxP50, fmtCount), basis: 'ctxP50' },
    { key: 'min', label: 'Minutes', value: fmtStat(r.minutes, fmtMinutes), basis: 'minutes' },
    { key: 'cost', label: 'Cost', value: fmtStat(r.costUsd, fmtCost), basis: 'costUsd' },
    { key: 'insp', label: 'Inspect', value: r.bashCalls ? fmtShare(r.bashShare.inspect ?? 0) : UNAVAILABLE, basis: 'bashShare' },
    { key: 'rew', label: 'Re-write', value: fmtShare(r.rewriteShare), basis: 'rewriteTokens' },
    { key: 'fpy', label: 'First pass', value: fmtShare(r.firstPassYield), basis: 'firstPassYield' },
    { key: 'cpa', label: 'Per accepted', value: fmtCost(r.costPerAccepted), basis: 'costPerAccepted' },
  ];
}
