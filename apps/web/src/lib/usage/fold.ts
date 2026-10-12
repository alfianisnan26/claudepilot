// Top N plus "Others" for a stacked chart (docs/prd/claude-usage.md §20.6): the Claudes (or models) that spent most keep their own colour
// and the rest fold into one grey segment whose tooltip names them. Pure, so the rule is tested without a browser.

import type { ChatUsageTotals, PaletteSlot, UsageSeries } from '@portal/contracts';
import { OTHERS_KEY, slotIndex } from './palette.js';

/** Segments a stack shows at most before the rest fold into "Others". */
export const TOP_N = 6;

/** What one segment of a stack measures. */
export type Measure = (t: ChatUsageTotals) => number;

/** One member of "Others", for its tooltip: its total and what it ran in each bucket. */
export interface FoldedMember {
  key: string;
  label: string;
  /** A Claude's workspace; null for a model. */
  sub: string | null;
  total: number;
  values: number[];
}

/** One series of a stacked chart: a colour, a name, and a value per bucket. */
export interface StackItem {
  /** The series' key, or {@link OTHERS_KEY}. */
  key: string;
  label: string;
  /** A Claude's workspace; null for a model and for Others. */
  sub: string | null;
  /** Null for Others (the neutral grey). */
  slot: PaletteSlot;
  /** The measure over the whole window. */
  total: number;
  /** In the order of the report's buckets; 0 where the series ran nothing. */
  values: number[];
  /** Others only: what was folded in, biggest first. */
  members: FoldedMember[] | null;
}

const byTotal = (a: StackItem, b: StackItem) => b.total - a.total || a.label.localeCompare(b.label) || a.key.localeCompare(b.key);

/**
 * The series of a report as stack items: the `topN` biggest by `measure` that have a palette slot, in slot order (a Claude sits at the same
 * height in every column, so its band can be followed), then "Others" on top when anything folded.
 * - A series with no slot (the server ran out of colours) is drawn grey, so it always folds into "Others".
 * - A series that measured nothing is left out.
 * - One series is never folded alone: with `topN + 1` series or fewer (and none without a slot) all of them show, since "Others" that
 *   names a single Claude says less than the Claude does.
 */
export function stackItems(series: readonly UsageSeries[], measure: Measure, topN: number = TOP_N): StackItem[] {
  const items: StackItem[] = series
    .map((s) => ({
      key: s.key,
      label: s.label,
      sub: s.sub,
      slot: slotIndex(s.slot),
      total: measure(s.totals),
      values: s.buckets.map((b) => (b ? measure(b) : 0)),
      members: null,
    }))
    .filter((s) => s.total > 0)
    .sort(byTotal);
  const slotted = items.filter((s) => s.slot !== null);
  const grey = items.filter((s) => s.slot === null);
  const fitsAll = slotted.length <= topN + (grey.length === 0 ? 1 : 0);
  const kept = fitsAll ? slotted : slotted.slice(0, topN);
  const folded = [...(fitsAll ? [] : slotted.slice(topN)), ...grey].sort(byTotal);
  const out = kept.sort((a, b) => a.slot! - b.slot!);
  if (folded.length) {
    const buckets = Math.max(0, ...folded.map((f) => f.values.length));
    out.push({
      key: OTHERS_KEY,
      label: 'Others',
      sub: null,
      slot: null,
      total: folded.reduce((sum, f) => sum + f.total, 0),
      values: Array.from({ length: buckets }, (_, i) => folded.reduce((sum, f) => sum + (f.values[i] ?? 0), 0)),
      members: folded.map((f) => ({ key: f.key, label: f.label, sub: f.sub, total: f.total, values: f.values })),
    });
  }
  return out;
}

/** One column of a stack: what each shown series ran in one bucket, bottom first. Hidden series add nothing. */
export interface StackColumn {
  segments: { key: string; value: number }[];
  total: number;
}

/** The columns of a stack with some series switched off in its legend. Folding was decided before this, so switching one off never repaints the others. */
export function stackColumns(items: readonly StackItem[], buckets: number, hidden: ReadonlySet<string>): StackColumn[] {
  return Array.from({ length: buckets }, (_, i) => {
    const segments = items.filter((it) => !hidden.has(it.key)).map((it) => ({ key: it.key, value: it.values[i] ?? 0 }));
    return { segments, total: segments.reduce((sum, s) => sum + s.value, 0) };
  });
}
