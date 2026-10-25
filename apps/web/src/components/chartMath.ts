// T-2360: the pure parts of the metric charts (scales, ticks, paths, bins, formatting), apart from React so each one has a unit test.
// `charts.tsx` re-exports everything here: import from there.

/** What a missing number says, in a chart, a tooltip and a table. A gap is never drawn as 0. */
export const UNAVAILABLE = 'unavailable';

const trimZero = (s: string) => s.replace(/\.0$/, '');

/**
 * A span of time in the shortest honest unit: "850ms", "42s", "42m", "3.5h", "2.1d". Rounds first and then picks the unit, so 59.6 minutes
 * reads "1h", never "60m". Not a number (null, NaN, Infinity) is "unavailable", never "0".
 */
export function formatSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNAVAILABLE;
  const sign = ms < 0 ? '-' : '';
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${Math.round(a)}ms`;
  const s = a / 1000;
  if (Math.round(s) < 60) return `${sign}${Math.round(s)}s`;
  const m = s / 60;
  if (Math.round(m) < 60) return `${sign}${Math.round(m)}m`;
  const h = m / 60;
  if (Number(h.toFixed(1)) < 24) return `${sign}${trimZero(h.toFixed(1))}h`;
  const d = h / 24;
  return `${sign}${d < 100 ? trimZero(d.toFixed(1)) : Math.round(d)}d`;
}

/** The y grid: the bottom, the middle and the top, as `ColumnChart` draws them. */
export const axisTicks = (max: number): number[] => [0, max / 2, max];

/** A straight map from a domain to a range. A domain of one value maps to the middle of the range (one point has no direction). */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** `count` evenly spaced values from `from` to `to` (both included): where the x axis labels go. */
export function timeTicks(from: number, to: number, count: number): number[] {
  if (count <= 1 || to <= from) return [from];
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

export interface XY {
  x: number;
  /** Null is a gap in the data. */
  y: number | null;
}

/** The unbroken runs of a line: a null breaks it in two, a gap is never bridged and never dropped to zero. */
export function lineRuns(points: XY[]): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ x: p.x, y: p.y });
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The SVG path of a line: one "M … L …" per run of two or more points (a lone point has no line; the chart draws it as a dot). */
export function linePath(points: XY[]): string {
  return lineRuns(points)
    .filter((r) => r.length > 1)
    .map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
    .join(' ');
}

/**
 * Labels beside the line ends, kept `gap` apart and inside [lo, hi] so two series that end near each other don't print on top of each other.
 * Returns the y of each label, in the order given. Labels are laid in order of their wanted y; a pile that overflows hi is pushed back up.
 */
export function spreadLabels(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => i).sort((a, b) => ys[a]! - ys[b]!);
  const out = [...ys];
  let prev = lo - gap;
  for (const i of order) {
    out[i] = Math.max(ys[i]!, prev + gap, lo);
    prev = out[i]!;
  }
  let next = hi + gap;
  for (const i of [...order].reverse()) {
    out[i] = Math.min(out[i]!, next - gap, hi);
    next = out[i]!;
  }
  return out;
}

/** The index of the value in `xs` (sorted) nearest to `x`; -1 when there are none. */
export function nearestIndex(xs: number[], x: number): number {
  let best = -1;
  let dist = Infinity;
  xs.forEach((v, i) => {
    const d = Math.abs(v - x);
    if (d < dist) (dist = d), (best = i);
  });
  return best;
}

export interface LinePoint {
  /** Milliseconds since the epoch. */
  t: number;
  /** Null or undefined: nothing was recorded; drawn as a gap, labelled "unavailable". */
  v: number | null | undefined;
}

/** Every timestamp any of the series has, ascending and without repeats: the chart's columns of points. */
export function unionTimes(series: { points: LinePoint[] }[]): number[] {
  return [...new Set(series.flatMap((s) => s.points.filter((p) => Number.isFinite(p.t)).map((p) => p.t)))].sort((a, b) => a - b);
}

/** A series' value at one timestamp; null where it has none (or a null). */
export function valueAt(points: LinePoint[], t: number): number | null {
  const v = points.find((p) => p.t === t)?.v;
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/** The latest recorded (non-null) point of a series, or null when it has none. */
export function lastPoint(points: LinePoint[]): { t: number; v: number } | null {
  let best: { t: number; v: number } | null = null;
  for (const p of points) if (p.v !== null && p.v !== undefined && Number.isFinite(p.v) && Number.isFinite(p.t) && (!best || p.t >= best.t)) best = { t: p.t, v: p.v };
  return best;
}

/**
 * Equal-width bins of raw values: `edges` has one more entry than `counts`; a value on an inner edge falls in the bin above it and the
 * highest value counts in the last bin. Values that are not numbers, or fall outside `range`, are left out. All values equal: one bin.
 */
export function histogramBins(values: number[], binCount = 10, range?: { min: number; max: number }): { edges: number[]; counts: number[] } {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length && !range) return { edges: [], counts: [] };
  const min = range?.min ?? Math.min(...xs);
  let max = range?.max ?? Math.max(...xs);
  if (max <= min) max = min + 1;
  const n = Math.max(1, Math.floor(binCount));
  const w = (max - min) / n;
  const edges = Array.from({ length: n + 1 }, (_, i) => (i === n ? max : min + i * w));
  const counts = new Array<number>(n).fill(0);
  for (const v of xs) {
    if (v < min || v > max) continue;
    const k = Math.min(n - 1, Math.floor((v - min) / w));
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { edges, counts };
}

/** The median of the finite values; null when there are none. */
export function medianOf(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/** The path of an arc on a half circle, from `from` to `to` as fractions (0 is the left end, 1 the right end), over the top. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const a = (f: number) => Math.PI * (1 - Math.min(1, Math.max(0, f)));
  const pt = (f: number) => `${(cx + r * Math.cos(a(f))).toFixed(2)},${(cy - r * Math.sin(a(f))).toFixed(2)}`;
  return `M${pt(from)} A${r},${r} 0 0 1 ${pt(to)}`;
}

export interface ScoreDelta {
  /** Score minus previous, to one decimal. */
  delta: number;
  direction: 'up' | 'down' | 'same';
  /** "+4", "-2.5" or "0": the sign is part of the text, so the change never rests on colour. */
  text: string;
  /** Good or bad for the reader (an up arrow is bad where lower is better); neutral when nothing changed. */
  tone: 'good' | 'bad' | 'neutral';
}

/** The change since the previous period; null when either number is missing (there is no change to show, not a change of 0). */
export function scoreDelta(score: number | null | undefined, previous: number | null | undefined, higherIsBetter = true): ScoreDelta | null {
  if (score === null || score === undefined || previous === null || previous === undefined || !Number.isFinite(score) || !Number.isFinite(previous)) return null;
  const delta = Math.round((score - previous) * 10) / 10;
  if (delta === 0) return { delta: 0, direction: 'same', text: '0', tone: 'neutral' };
  const up = delta > 0;
  return { delta, direction: up ? 'up' : 'down', text: `${up ? '+' : ''}${delta}`, tone: up === higherIsBetter ? 'good' : 'bad' };
}

/** One row of a stage chart: the median is the bar, the p90 the whisker. A null median is a row with no data (not a zero-length bar). */
export interface StageRow {
  key: string;
  label: string;
  sub?: string;
  median: number | null;
  p90: number | null;
  /** How many samples the row rests on. */
  n: number;
  /** How many were left out (open, cancelled, outliers the page names), when any. */
  excluded?: number;
  /** Why the row has no figure, shown in place of the bar. */
  note?: string;
}

/** Where a row's bar and whisker end, as percentages of the shared axis (0 to 100). The whisker never ends before the bar (a p90 under the median is a data slip: it is held at the median). */
export function stageGeometry(row: Pick<StageRow, 'median' | 'p90'>, max: number): { median: number; p90: number | null } | null {
  if (row.median === null || !Number.isFinite(row.median) || !(max > 0)) return null;
  const pct = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  const p90 = row.p90 !== null && Number.isFinite(row.p90) ? pct(Math.max(row.p90, row.median)) : null;
  return { median: pct(row.median), p90 };
}

/** What a screen reader (and the table) says for a stage row. */
export function stageSummary(row: StageRow, format: (v: number) => string): string {
  const m = row.median === null ? UNAVAILABLE : format(row.median);
  const p = row.p90 === null ? UNAVAILABLE : format(row.p90);
  return `${row.label}: median ${m}, p90 ${p}, n ${row.n}${row.excluded ? `, ${row.excluded} excluded` : ''}${row.median === null && row.note ? `, ${row.note}` : ''}`;
}

/** A table: what each chart shows, as numbers, for the "Table" toggle (and for anyone who can't read a picture). */
export interface ChartTableData {
  caption: string;
  head: string[];
  rows: string[][];
}

const cell = (v: number | null | undefined, format: (v: number) => string) => (v === null || v === undefined || !Number.isFinite(v) ? UNAVAILABLE : format(v));

export function lineTable(series: { label: string; points: LinePoint[] }[], formatY: (v: number) => string, formatT: (t: number) => string, caption: string): ChartTableData {
  return { caption, head: ['Time', ...series.map((s) => s.label)], rows: unionTimes(series).map((t) => [formatT(t), ...series.map((s) => cell(valueAt(s.points, t), formatY))]) };
}

export function stageTable(rows: StageRow[], format: (v: number) => string, caption: string): ChartTableData {
  return { caption, head: ['Stage', 'Median', 'p90', 'n', 'Excluded'], rows: rows.map((r) => [r.label, cell(r.median, format), cell(r.p90, format), String(r.n), String(r.excluded ?? 0)]) };
}

export function histogramTable(edges: number[], counts: number[], format: (v: number) => string, caption: string): ChartTableData {
  return { caption, head: ['From', 'To', 'Count'], rows: counts.map((c, i) => [format(edges[i]!), format(edges[i + 1]!), String(c)]) };
}

/** What a screen reader says for a line chart: per series its latest value and its range, or that it has none. */
export function lineSummary(title: string, series: { label: string; points: LinePoint[] }[], formatY: (v: number) => string, formatT: (t: number) => string): string {
  const parts = series.map((s) => {
    const last = lastPoint(s.points);
    if (!last) return `${s.label}: ${UNAVAILABLE}`;
    const vs = s.points.map((p) => p.v).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    return `${s.label}: latest ${formatY(last.v)} at ${formatT(last.t)}, from ${formatY(Math.min(...vs))} to ${formatY(Math.max(...vs))}`;
  });
  return `${title}. ${parts.join('. ')}`;
}
