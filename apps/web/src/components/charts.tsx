import { cn } from '@isnanme/ui';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  type ChartTableData,
  type LinePoint,
  type ScoreDelta,
  type StageRow,
  UNAVAILABLE,
  arcPath,
  axisTicks,
  histogramTable,
  lastPoint,
  lineRuns,
  linePath,
  lineSummary,
  lineTable,
  linearScale,
  nearestIndex,
  scoreDelta,
  spreadLabels,
  stageGeometry,
  stageSummary,
  stageTable,
  timeTicks,
  unionTimes,
  valueAt,
} from './chartMath';

// T-2360: the pure parts (scales, bins, paths, formatSpan, table builders) live in chartMath.ts; import them from here.
export * from './chartMath';

/**
 * A clean axis top at or above `v`, as close as a readable number allows: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten
 * (each with a clean half, for the middle grid line). Owner, 2026-10-18: with only 1, 2 and 5, a peak of $210 drew an axis to $500 and the
 * chart used less than half its height.
 */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  // A tiny margin for floating point (0.3 / 0.1 is 2.9999999999999996, not 3).
  const step = NICE_STEPS.find((s) => n <= s * (1 + 1e-9)) ?? 10;
  return Number((step * p).toPrecision(12));
}

/** The element's width, kept current. */
function useWidth(fixed?: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setWidth] = useState(0);
  const width = fixed ?? measured;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** One band of a stacked column: a value in a colour, with a pattern laid over it when patterns are on (`overlay` is a `url(#...)` fill). */
export interface ChartSegment {
  key: string;
  value: number;
  fill: string;
  overlay?: string | null;
}

/** One line of a stack's tooltip: a swatch, a name, a value, and for a folded "Others" the names inside it. */
export interface ChartRow {
  key: string;
  label: string;
  value: string;
  fill: string;
  overlay?: string | null;
  sub?: { key: string; label: string; value: string }[];
}

export interface ChartColumn {
  key: string;
  /** The column's height: its value, or for a stack the sum of its visible segments. */
  value: number;
  /** Under the axis, on the columns that get a label ("14:00"). */
  tick: string;
  /** What the column covers, in its tooltip ("14:00–15:00"). */
  span: string;
  /** More for the tooltip, under the value ("12.3k in · 480 out"). */
  detail?: string;
  /** A stack: its bands, bottom first. Without it the column is one band in the chart colour. */
  segments?: ChartSegment[];
  /** A stack's tooltip: one row per band, top first. */
  rows?: ChartRow[];
  /** Where the previous period stood at this column, in the same measure, drawn as a dashed line through the columns; null where nothing was recorded. */
  marker?: number | null;
  /** One more tooltip line under the rest, e.g. "Before $3.10 · +12 %". */
  compare?: string;
  /** What a screen reader says for the column (default: its span and value). */
  label?: string;
}

const PAD = { top: 12, right: 6, bottom: 24, left: 44 };
const BAR_MAX = 24;
const TICK_LABELS = 4;

/** The path of a column's outline: a square foot on the baseline and a 4 px rounded top. */
const columnPath = (x: number, base: number, top: number, w: number): string => {
  const r = Math.min(4, w / 2, base - top);
  return `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${base} Z`;
};

/** A swatch for a tooltip row: the colour, with the pattern over it when there is one (the pattern is defined in the chart's `defs`). */
function RowSwatch({ fill, overlay }: { fill: string; overlay?: string | null }) {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5 shrink-0">
      <rect width="10" height="10" rx="2.5" fill={fill} />
      {overlay && <rect width="10" height="10" rx="2.5" fill={overlay} />}
    </svg>
  );
}

/**
 * Columns over time: one series (the card's title names it, so there's no legend), or a stack of bands, one per Claude or model, in
 * the order the columns give them (the legend is the page's). Columns are at most 24 px wide with a 4 px rounded top and a square foot
 * on the baseline, 2 px apart at the least, over hairline gridlines at clean values; the bands of a stack are 2 px apart too. A
 * dashed line through the columns is the previous period. Each column is a button: hover, focus or a tap shows its value and time (for
 * a stack, one row per band; the others dim while one is picked). The chart is one tab stop; arrow keys, Home and End move between columns.
 */
export function ColumnChart({
  columns,
  format,
  ariaLabel,
  height = 188,
  empty,
  dim,
  defs,
}: {
  columns: ChartColumn[];
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
  /** Shown over an empty chart. */
  empty?: ReactNode;
  /** Data is reloading: hold the frame, faded. */
  dim?: boolean;
  /** SVG definitions the bands' `overlay` fills point at (patterns). */
  defs?: ReactNode;
}) {
  const [ref, width] = useWidth();
  const clip = `cc-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [active, setActive] = useState<number | null>(null);
  // One tab stop for the whole chart, not one per column (a day is 24, a month 30 or more): arrow keys move between columns.
  const [roving, setRoving] = useState(0);
  const cells = useRef<(SVGRectElement | null)[]>([]);
  const n = columns.length;
  const max = niceMax(Math.max(0, ...columns.map((c) => Math.max(c.value, c.marker ?? 0))));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(BAR_MAX, slot - 2));
  const y = (v: number) => PAD.top + plotH * (1 - v / max);
  const base = PAD.top + plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(n / TICK_LABELS));
  const allZero = columns.every((c) => c.value === 0);
  const picked = active !== null ? columns[active] : null;
  const cx = (i: number) => PAD.left + (i + 0.5) * slot;
  // The previous period as dashed runs: a gap in the data breaks the line instead of dropping it to zero.
  const markerPath = columns
    .reduce(
      (d, c, i) =>
        c.marker == null ? d : `${d}${d && columns[i - 1]?.marker != null ? ' L' : ' M'}${cx(i).toFixed(1)},${y(c.marker).toFixed(1)}`,
      '',
    )
    .trim();

  return (
    <div ref={ref} className={cn('relative w-full transition-opacity', dim && 'opacity-60')}>
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label={ariaLabel} className="block overflow-visible">
          <defs>{defs}</defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--color-line)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                {format(t)}
              </text>
            </g>
          ))}
          {columns.map((c, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const top = y(c.value);
            const opacity = active === null || active === i ? 1 : 0.4;
            const bands = c.segments?.filter((s) => s.value > 0) ?? [];
            let acc = 0;
            return (
              <g key={c.key}>
                {c.value > 0 && !bands.length && (
                  <path
                    d={columnPath(x, base, top, barW)}
                    fill="var(--chart-1)"
                    opacity={opacity}
                    className="transition-opacity duration-150"
                  />
                )}
                {c.value > 0 && bands.length > 0 && (
                  <g opacity={opacity} className="transition-opacity duration-150">
                    <clipPath id={`${clip}-${i}`}>
                      <path d={columnPath(x, base, top, barW)} />
                    </clipPath>
                    <g clipPath={`url(#${clip}-${i})`}>
                      {bands.map((s) => {
                        const from = y(acc);
                        acc += s.value;
                        const to = y(acc);
                        return (
                          <g key={s.key}>
                            <rect x={x} y={to} width={barW} height={Math.max(0, from - to)} fill={s.fill} />
                            {s.overlay && <rect x={x} y={to} width={barW} height={Math.max(0, from - to)} fill={s.overlay} />}
                          </g>
                        );
                      })}
                      {/* The 2 px gap between bands: the surface's own colour over each boundary. */}
                      {(() => {
                        let a = 0;
                        return bands.slice(0, -1).map((s) => {
                          a += s.value;
                          return (
                            <line key={s.key} x1={x} x2={x + barW} y1={y(a)} y2={y(a)} stroke="var(--color-surface)" strokeWidth={2} />
                          );
                        });
                      })()}
                    </g>
                  </g>
                )}
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
                    {c.tick}
                  </text>
                )}
                {/* The hit area is the whole slot, not just the painted column. */}
                <rect
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  ref={(el) => {
                    cells.current[i] = el;
                  }}
                  role="button"
                  tabIndex={i === Math.min(roving, n - 1) ? 0 : -1}
                  aria-label={c.label ?? `${c.span}: ${format(c.value)}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => (setRoving(i), setActive(i))}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  onClick={() => setActive(i)}
                  onKeyDown={(e) => {
                    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
                    if (next === undefined || next < 0 || next >= n) return;
                    e.preventDefault();
                    cells.current[next]?.focus();
                  }}
                  className="cursor-pointer outline-hidden"
                />
              </g>
            );
          })}
          {markerPath && (
            <path
              d={markerPath}
              fill="none"
              stroke="var(--color-ink-soft)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              strokeLinejoin="round"
              className="pointer-events-none"
            />
          )}
          {picked?.marker != null && (
            <circle
              cx={cx(active!)}
              cy={y(picked.marker)}
              r={3.5}
              fill="var(--color-surface)"
              stroke="var(--color-ink-soft)"
              strokeWidth={1.5}
              className="pointer-events-none"
            />
          )}
        </svg>
      )}
      {allZero && empty && (
        <p
          className="pointer-events-none absolute inset-x-0 top-[38%] text-center text-[13px] text-muted"
          style={{ paddingLeft: PAD.left }}
        >
          {empty}
        </p>
      )}
      {picked && active !== null && (
        // Beside the picked column, at the top of the plot, on the side with more room: it never covers
        // the column it describes.
        <div
          role="status"
          className={cn(
            'pointer-events-none absolute z-10 max-w-[15rem] rounded-xl border border-line bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-lift',
            PAD.left + (active + 0.5) * slot > width / 2 ? '-translate-x-full text-right' : 'text-left',
          )}
          style={{
            left: PAD.left + (active + 0.5) * slot + (PAD.left + (active + 0.5) * slot > width / 2 ? -(barW / 2 + 8) : barW / 2 + 8),
            top: PAD.top,
          }}
        >
          <p className="text-[14px] font-semibold text-ink">{format(picked.value)}</p>
          <p className="text-[11.5px] text-muted">{picked.span}</p>
          {picked.rows && picked.rows.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5 text-left">
              {picked.rows.map((r) => (
                <li key={r.key}>
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                    <RowSwatch fill={r.fill} overlay={r.overlay} />
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    <span className="pl-2 tabular-nums">{r.value}</span>
                  </span>
                  {r.sub?.map((m) => (
                    <span key={m.key} className="flex items-center gap-1.5 pl-4 text-[11.5px] text-muted">
                      <span className="min-w-0 flex-1 truncate">{m.label}</span>
                      <span className="pl-2 tabular-nums">{m.value}</span>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {picked.detail && <p className="text-[11.5px] text-muted tabular-nums">{picked.detail}</p>}
          {picked.compare && <p className="mt-0.5 text-[11.5px] text-muted tabular-nums">{picked.compare}</p>}
        </div>
      )}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  sub?: string;
  value: number;
  /** The bar's colour (a usage palette colour); the chart colour when absent. */
  color?: string;
  /** A hover note on the row (a native title). */
  title?: string;
}

/**
 * A ranked list with a bar each, longest first: one hue unless the rows carry a colour of their own, so identity is in the words. The value sits at
 * the row's end. Rows are buttons when `onPick` is set (the picked one stays full, the rest dim).
 */
export function BarList({
  rows,
  format,
  onPick,
  picked,
  empty,
}: {
  rows: BarRow[];
  format: (v: number) => string;
  onPick?: (key: string) => void;
  picked?: string | null;
  empty?: ReactNode;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-3 text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="flex items-baseline gap-2">
              <span dir="auto" className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-ink">
                {r.label}
                {r.sub && <span className="ml-1.5 font-normal text-muted">{r.sub}</span>}
              </span>
              <span className="shrink-0 text-[13.5px] text-ink-soft tabular-nums">{format(r.value)}</span>
            </span>
            <span className="mt-1.5 block h-1.5 w-full">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{ width: `${max > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%`, background: r.color ?? 'var(--chart-1)' }}
              />
            </span>
          </>
        );
        const dimmed = picked && picked !== r.key;
        return (
          <li key={r.key} className={cn('transition-opacity', dimmed && 'opacity-45')}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(r.key)}
                aria-pressed={picked === r.key}
                title={r.title}
                className="press block w-full rounded-xl px-2 py-2 hover:bg-surface-2"
              >
                {inner}
              </button>
            ) : (
              <div className="px-2 py-2" title={r.title}>
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────────────────── T-2360: the metric charts ─────────────────────────
 * LineChart, ScoreTile, StageBars and Histogram, for the metrics pages. Same rules as above: pure SVG, no dependency, the chart colours
 * (`--chart-1..3`), hairline grid, 4 px rounded data ends, a 2 px surface ring on dots. Each has a "Table" toggle with the same numbers,
 * a summary for a screen reader, and shows a missing number as "unavailable" (a gap), never as 0.
 */

/** The "Table" / "Chart" toggle every chart carries: a 44 px target. */
function TableButton({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        aria-pressed={show}
        onClick={onToggle}
        className="press inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-3 text-[12.5px] font-medium text-ink-soft hover:bg-surface-2"
      >
        {show ? 'Chart' : 'Table'}
      </button>
    </div>
  );
}

/** The chart's numbers as a table. Wraps long words; scrolls down, never sideways. */
function ChartTable({ data }: { data: ChartTableData }) {
  const cls = 'min-w-0 px-1.5 py-1 break-words [overflow-wrap:anywhere]';
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="w-full table-fixed border-collapse text-left text-[12px] tabular-nums">
        <caption className="sr-only">{data.caption}</caption>
        <thead>
          <tr>
            {data.head.map((h) => (
              <th key={h} scope="col" className={cn(cls, 'font-semibold text-ink-soft')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row" className={cn(cls, 'font-medium text-ink')}>
                    {c}
                  </th>
                ) : (
                  <td key={j} className={cn(cls, c === UNAVAILABLE ? 'text-muted' : 'text-ink-soft')}>
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One tab stop for a row of marks, arrow keys (and Home, End) between them, like `ColumnChart`. */
function useRoving(n: number) {
  const [roving, setRoving] = useState(0);
  const cells = useRef<(SVGElement | null)[]>([]);
  return {
    cells,
    setRoving,
    tab: (i: number) => (i === Math.min(roving, n - 1) ? 0 : -1),
    onKey: (i: number, e: KeyboardEvent) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
      if (next === undefined || next < 0 || next >= n) return;
      e.preventDefault();
      cells.current[next]?.focus();
    },
  };
}

/** The tooltip box: beside the point, on the side with more room. */
function ChartTip({ x, width, top, offset, children }: { x: number; width: number; top: number; offset: number; children: ReactNode }) {
  const right = x > width / 2;
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-none absolute z-10 max-w-[15rem] rounded-xl border border-line bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-lift',
        right ? '-translate-x-full text-right' : 'text-left',
      )}
      style={{ left: x + (right ? -offset : offset), top }}
    >
      {children}
    </div>
  );
}

/** The x axis label of a time: "14:30" over a day or two, "Oct 25" over longer. */
export function timeLabel(spanMs: number): (t: number) => string {
  return spanMs <= 2 * 86_400_000
    ? (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const longTime = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export interface LineSeries {
  key: string;
  /** In the legend, the tooltip and the table. */
  label: string;
  points: LinePoint[];
  /** A CSS colour; by default the series' slot in `--chart-1..3` (green, violet, orange). */
  color?: string;
}

export interface LineTarget {
  value: number;
  /** "Target", "SLA". */
  label: string;
}

/** The most series a line chart draws: the validated palette holds three (a fourth folds elsewhere, into another chart). */
export const LINE_SERIES_MAX = 3;
const LINE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];
const LINE_PAD = { top: 14, right: 56, bottom: 24, left: 44 };

/**
 * One to three series over time. x is milliseconds; the y axis tops at a clean number (`niceMax`, from 0) with the bottom, middle and top
 * gridlines; an optional dashed target line. A null value breaks the line (never bridged, never dropped to 0) and sits as a hollow dot on
 * the baseline, "unavailable" in the tooltip and the table. The last value of each line is labelled at its end. Two or more series get a
 * legend. Hover, tap or focus shows every series at that time; the points are one tab stop, arrow keys move between times.
 */
export function LineChart({
  series,
  format,
  formatX,
  formatXLong = longTime,
  ariaLabel,
  height = 188,
  target,
  empty,
  dim,
  width: fixedWidth,
  defaultTable = false,
}: {
  series: LineSeries[];
  format: (v: number) => string;
  /** The x axis labels (default: the time of day over two days or less, the date over longer). */
  formatX?: (t: number) => string;
  /** The tooltip and table time (default: date and time). */
  formatXLong?: (t: number) => string;
  ariaLabel: string;
  height?: number;
  target?: LineTarget | null;
  /** Shown over a chart with no numbers at all. */
  empty?: ReactNode;
  /** Data is reloading: hold the frame, faded. */
  dim?: boolean;
  /** A fixed width in px instead of the measured one (tests, server rendering). */
  width?: number;
  /** Start on the table. */
  defaultTable?: boolean;
}) {
  const [ref, width] = useWidth(fixedWidth);
  const [table, setTable] = useState(defaultTable);
  const [active, setActive] = useState<number | null>(null);
  const lines = series.slice(0, LINE_SERIES_MAX).map((s, i) => ({ ...s, color: s.color ?? LINE_COLORS[i]! }));
  const ts = unionTimes(lines);
  const n = ts.length;
  const rove = useRoving(n);
  const t0 = ts[0] ?? 0;
  const t1 = ts[n - 1] ?? 0;
  const values = lines.flatMap((s) =>
    s.points.map((p) => p.v).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)),
  );
  const hasData = values.length > 0;
  const max = niceMax(Math.max(0, ...values, target?.value ?? 0));
  const plotW = Math.max(0, width - LINE_PAD.left - LINE_PAD.right);
  const plotH = height - LINE_PAD.top - LINE_PAD.bottom;
  const base = LINE_PAD.top + plotH;
  const x = linearScale(t0, t1, LINE_PAD.left, LINE_PAD.left + plotW);
  const y = linearScale(0, max, base, LINE_PAD.top);
  const xLabel = formatX ?? timeLabel(t1 - t0);
  const xTicks = n > 1 ? timeTicks(t0, t1, width < 480 ? 3 : 5) : [t0];
  const ends = lines
    .map((s) => ({ s, last: lastPoint(s.points) }))
    .filter((e): e is { s: (typeof lines)[number]; last: { t: number; v: number } } => e.last !== null);
  const endY = spreadLabels(
    ends.map((e) => y(e.last.v)),
    14,
    LINE_PAD.top + 4,
    base - 2,
  );
  const summary = lineSummary(ariaLabel, lines, format, formatXLong);
  const data = lineTable(lines, format, formatXLong, ariaLabel);
  const at = active !== null ? ts[active] : undefined;

  return (
    <div className={cn('w-full transition-opacity', dim && 'opacity-60')}>
      {lines.length > 1 && (
        <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[12px] text-ink-soft">
          {lines.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg viewBox="0 0 16 4" aria-hidden="true" className="h-1 w-4 shrink-0">
                <rect width="16" height="4" rx="2" fill={s.color} />
              </svg>
              <span dir="auto" className="min-w-0 truncate">
                {s.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="relative w-full">
        {table ? (
          <ChartTable data={data} />
        ) : (
          width > 0 && (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
              <g role="img" aria-label={summary}>
                {axisTicks(max).map((t) => (
                  <g key={t}>
                    <line
                      x1={LINE_PAD.left}
                      x2={width - LINE_PAD.right}
                      y1={y(t)}
                      y2={y(t)}
                      stroke="var(--color-line)"
                      strokeWidth={1}
                      shapeRendering="crispEdges"
                    />
                    <text x={LINE_PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                      {format(t)}
                    </text>
                  </g>
                ))}
                {hasData &&
                  xTicks.map((t) => (
                    <text key={t} x={x(t)} y={height - 6} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
                      {xLabel(t)}
                    </text>
                  ))}
                {target && (
                  <g className="pointer-events-none">
                    <line
                      x1={LINE_PAD.left}
                      x2={width - LINE_PAD.right}
                      y1={y(target.value)}
                      y2={y(target.value)}
                      stroke="var(--color-ink-soft)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                    <text
                      x={LINE_PAD.left + 4}
                      y={y(target.value) - 4}
                      className="fill-ink-soft text-[11px] tabular-nums"
                      style={{ paintOrder: 'stroke', stroke: 'var(--color-surface)', strokeWidth: 3 }}
                    >
                      {target.label} {format(target.value)}
                    </text>
                  </g>
                )}
                {lines.map((s) => {
                  const pts = s.points
                    .filter((p) => Number.isFinite(p.t))
                    .map((p) => ({ x: x(p.t), y: p.v === null || p.v === undefined ? null : y(p.v) }));
                  return (
                    <g key={s.key} className="pointer-events-none">
                      <path d={linePath(pts)} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                      {/* A point with no neighbour has no line: a dot. */}
                      {lineRuns(pts)
                        .filter((r) => r.length === 1)
                        .map((r) => (
                          <circle
                            key={r[0]!.x}
                            cx={r[0]!.x}
                            cy={r[0]!.y}
                            r={4}
                            fill={s.color}
                            stroke="var(--color-surface)"
                            strokeWidth={2}
                          />
                        ))}
                      {/* A gap: a hollow dot on the baseline at the time with nothing recorded. */}
                      {pts
                        .filter((p) => p.y === null)
                        .map((p) => (
                          <circle key={p.x} cx={p.x} cy={base} r={3} fill="var(--color-surface)" stroke={s.color} strokeWidth={1.5} />
                        ))}
                    </g>
                  );
                })}
                {ends.map((e, i) => (
                  <g key={e.s.key} className="pointer-events-none">
                    <circle cx={x(e.last.t)} cy={y(e.last.v)} r={4} fill={e.s.color} stroke="var(--color-surface)" strokeWidth={2} />
                    <text
                      x={x(e.last.t) + 9}
                      y={endY[i]}
                      dy="0.32em"
                      className="fill-ink text-[12px] font-semibold tabular-nums"
                      style={{ paintOrder: 'stroke', stroke: 'var(--color-surface)', strokeWidth: 3 }}
                    >
                      {format(e.last.v)}
                    </text>
                  </g>
                ))}
              </g>
              {at !== undefined && (
                <g className="pointer-events-none">
                  <line x1={x(at)} x2={x(at)} y1={LINE_PAD.top} y2={base} stroke="var(--color-ink-soft)" strokeWidth={1} opacity={0.5} />
                  {lines.map((s) => {
                    const v = valueAt(s.points, at);
                    return v === null ? null : (
                      <circle key={s.key} cx={x(at)} cy={y(v)} r={4} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} />
                    );
                  })}
                </g>
              )}
              {hasData && (
                <rect
                  x={LINE_PAD.left}
                  y={LINE_PAD.top}
                  width={plotW}
                  height={plotH}
                  fill="transparent"
                  style={{ touchAction: 'pan-y' }}
                  onPointerMove={(e) => {
                    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    if (box) setActive(nearestIndex(ts.map(x), e.clientX - box.left));
                  }}
                  onPointerDown={(e) => {
                    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    if (box) setActive(nearestIndex(ts.map(x), e.clientX - box.left));
                  }}
                  onPointerLeave={() => setActive(null)}
                />
              )}
              {hasData && (
                <g role="group" aria-label={`${ariaLabel}: values by time`}>
                  {ts.map((t, i) => (
                    <circle
                      key={t}
                      cx={x(t)}
                      cy={LINE_PAD.top + plotH / 2}
                      r={Math.max(6, Math.min(14, plotW / Math.max(1, n) / 2))}
                      fill="transparent"
                      className="pointer-events-none outline-hidden"
                      ref={(el) => {
                        rove.cells.current[i] = el;
                      }}
                      role="button"
                      tabIndex={rove.tab(i)}
                      aria-label={`${formatXLong(t)}: ${lines.map((s) => `${s.label} ${format2(valueAt(s.points, t), format)}`).join(', ')}`}
                      onFocus={() => (rove.setRoving(i), setActive(i))}
                      onBlur={() => setActive((a) => (a === i ? null : a))}
                      onKeyDown={(e) => rove.onKey(i, e)}
                    />
                  ))}
                </g>
              )}
            </svg>
          )
        )}
        {!table && !hasData && empty && (
          <p
            className="pointer-events-none absolute inset-x-0 top-[38%] text-center text-[13px] text-muted"
            style={{ paddingLeft: LINE_PAD.left }}
          >
            {empty}
          </p>
        )}
        {!table && at !== undefined && active !== null && (
          <ChartTip x={x(at)} width={width} top={LINE_PAD.top} offset={12}>
            <p className="text-[11.5px] text-muted">{formatXLong(at)}</p>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {lines.map((s) => {
                const v = valueAt(s.points, at);
                return (
                  <li key={s.key} className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                    <RowSwatch fill={s.color} />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {v === null ? (
                      <span className="pl-2 text-muted">{UNAVAILABLE}</span>
                    ) : (
                      <span className="pl-2 font-semibold text-ink tabular-nums">{format(v)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </ChartTip>
        )}
      </div>
      <TableButton show={table} onToggle={() => setTable((t) => !t)} />
    </div>
  );
}

const format2 = (v: number | null, format: (v: number) => string) => (v === null ? UNAVAILABLE : format(v));

const TONE_CLASS: Record<ScoreDelta['tone'], string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  bad: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted',
};
const DELTA_ICON = { up: ArrowUp, down: ArrowDown, same: Minus } as const;
const DELTA_WORD = { up: 'up', down: 'down', same: 'unchanged' } as const;
const TONE_WORD = { good: 'better', bad: 'worse', neutral: '' } as const;

/**
 * A 0 to 100 score on a half-circle gauge, the number inside it, and under it the change since the previous period: an arrow, a signed
 * number and a word for a screen reader (up or down is never told by colour alone; the colour says whether it is better or worse, which
 * `higherIsBetter` decides). Without a score the tile says "unavailable" and why. The number is text, so it is its own table.
 */
export function ScoreTile({
  label,
  score,
  previous,
  reason,
  higherIsBetter = true,
  max = 100,
  format = (v) => String(Math.round(v * 10) / 10),
}: {
  label: string;
  /** Null or undefined: no score (shown as "unavailable", with `reason`). */
  score: number | null | undefined;
  /** The previous period's score; without it no change is shown. */
  previous?: number | null;
  /** Why there is no score ("no samples in this window"). */
  reason?: string;
  /** False where a lower score is the better one (an up arrow then turns red). */
  higherIsBetter?: boolean;
  /** The top of the gauge. */
  max?: number;
  format?: (v: number) => string;
}) {
  const has = score !== null && score !== undefined && Number.isFinite(score);
  const frac = has ? Math.min(1, Math.max(0, score / max)) : 0;
  const d = has ? scoreDelta(score, previous, higherIsBetter) : null;
  const Icon = d ? DELTA_ICON[d.direction] : null;
  return (
    <div className="min-w-0 text-center" data-score={has ? 'value' : 'unavailable'}>
      <p className="truncate text-[11.5px] text-muted">{label}</p>
      <div className="relative mx-auto mt-1 w-full max-w-36">
        <svg viewBox="0 0 120 68" aria-hidden="true" className="block w-full">
          <path d={arcPath(60, 62, 50, 0, 1)} fill="none" stroke="var(--color-line)" strokeWidth={10} strokeLinecap="round" />
          {frac > 0 && <path d={arcPath(60, 62, 50, 0, frac)} fill="none" stroke="var(--chart-1)" strokeWidth={10} strokeLinecap="round" />}
        </svg>
        <p className="absolute inset-x-0 bottom-0 leading-none">
          {has ? (
            <span className="text-[22px] font-semibold text-ink tabular-nums">{format(score)}</span>
          ) : (
            <span className="text-[12px] text-muted">{UNAVAILABLE}</span>
          )}
        </p>
      </div>
      {!has && reason && <p className="mt-1 text-[11.5px] break-words text-muted [overflow-wrap:anywhere]">{reason}</p>}
      {has && d && Icon && (
        <p
          className={cn('mt-1 flex items-center justify-center gap-1 text-[12.5px] font-medium tabular-nums', TONE_CLASS[d.tone])}
          data-delta={d.direction}
          data-tone={d.tone}
        >
          <Icon size={12} aria-hidden="true" />
          <span>{d.text}</span>
          <span className="font-normal text-muted">vs previous</span>
          <span className="sr-only">{`${DELTA_WORD[d.direction]}${TONE_WORD[d.tone] ? `, ${TONE_WORD[d.tone]}` : ''}`}</span>
        </p>
      )}
      {has && !d && <p className="mt-1 text-[11.5px] text-muted">previous {UNAVAILABLE}</p>}
    </div>
  );
}

/**
 * One row per stage or group: the median is the bar, the p90 a whisker past it (a line and a cap), on one shared axis; under it the
 * sample count n and how many were left out. A row with no median has no bar, it says "unavailable" and its note. With `onSelect` each
 * row is a button of at least 44 px (the selected one stays full, the rest dim) for a drill-down.
 */
export function StageBars({
  rows,
  format,
  ariaLabel,
  onSelect,
  selected,
  empty,
  defaultTable = false,
}: {
  rows: StageRow[];
  /** Median and p90 as text; `formatSpan` for durations. */
  format: (v: number) => string;
  ariaLabel: string;
  onSelect?: (key: string) => void;
  selected?: string | null;
  empty?: ReactNode;
  defaultTable?: boolean;
}) {
  const [table, setTable] = useState(defaultTable);
  const max = niceMax(Math.max(0, ...rows.map((r) => Math.max(r.p90 ?? 0, r.median ?? 0))));
  if (!rows.length) return <p className="py-3 text-[13px] text-muted">{empty}</p>;
  return (
    <div className="w-full" role="group" aria-label={ariaLabel}>
      {table ? (
        <ChartTable data={stageTable(rows, format, ariaLabel)} />
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {rows.map((r) => {
              const g = stageGeometry(r, max);
              const inner = (
                <>
                  <span className="flex items-baseline gap-2">
                    <span dir="auto" className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-ink">
                      {r.label}
                      {r.sub && <span className="ml-1.5 font-normal text-muted">{r.sub}</span>}
                    </span>
                    {g ? (
                      <span className="shrink-0 text-[13.5px] text-ink-soft tabular-nums">
                        {format(r.median!)}
                        {r.p90 !== null && <span className="ml-1.5 text-[12px] text-muted">p90 {format(r.p90)}</span>}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[12px] text-muted">{UNAVAILABLE}</span>
                    )}
                  </span>
                  <span aria-hidden="true" className="relative mt-1.5 block h-2 w-full">
                    {g && (
                      <>
                        {/* The whisker: a line from the bar's end to the p90, with a cap. */}
                        {g.p90 !== null && g.p90 > g.median && (
                          <>
                            <span
                              className="absolute top-1/2 h-px -translate-y-1/2 bg-ink-soft"
                              style={{ left: `${g.median}%`, width: `${g.p90 - g.median}%` }}
                            />
                            <span
                              className="absolute top-0 h-2 w-0.5 -translate-x-1/2 rounded-full bg-ink-soft"
                              style={{ left: `${g.p90}%` }}
                            />
                          </>
                        )}
                        <span
                          className="absolute inset-y-0 left-0 block rounded-full"
                          style={{ width: `${Math.max(1.5, g.median)}%`, background: 'var(--chart-1)' }}
                        />
                      </>
                    )}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-2 text-left text-[11.5px] text-muted tabular-nums">
                    <span>n {r.n}</span>
                    {r.excluded ? <span>{r.excluded} excluded</span> : null}
                    {!g && r.note && <span className="min-w-0 break-words [overflow-wrap:anywhere]">{r.note}</span>}
                  </span>
                </>
              );
              const dimmed = selected && selected !== r.key;
              return (
                <li key={r.key} className={cn('transition-opacity', dimmed && 'opacity-45')}>
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(r.key)}
                      aria-pressed={selected === r.key}
                      aria-label={stageSummary(r, format)}
                      className="press block min-h-11 w-full rounded-xl px-2 py-2 hover:bg-surface-2"
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="min-h-11 px-2 py-2" aria-label={stageSummary(r, format)} role="group">
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="px-2 pt-1 text-[11.5px] text-muted">Bar: median. Whisker: p90.</p>
        </>
      )}
      <TableButton show={table} onToggle={() => setTable((t) => !t)} />
    </div>
  );
}

const HIST_PAD = { top: 18, right: 8, bottom: 24, left: 44 };

/**
 * How values spread: one column per bin, touching (2 px apart), 4 px rounded tops on the baseline, over gridlines at clean counts, with
 * edge labels under the axis and an optional vertical line at the median. Give `edges` (one more than `counts`), or make them with
 * `histogramBins`. Each bin is focusable (one tab stop, arrow keys) and shows its range and count.
 */
export function Histogram({
  edges,
  counts,
  format,
  formatCount = String,
  median,
  ariaLabel,
  height = 160,
  empty,
  dim,
  width: fixedWidth,
  defaultTable = false,
}: {
  edges: number[];
  counts: number[];
  /** The bin edges and the median as text (`formatSpan` for durations). */
  format: (v: number) => string;
  formatCount?: (v: number) => string;
  /** Where the median falls, to mark it; none when null or outside the bins. */
  median?: number | null;
  ariaLabel: string;
  height?: number;
  empty?: ReactNode;
  dim?: boolean;
  width?: number;
  defaultTable?: boolean;
}) {
  const [ref, width] = useWidth(fixedWidth);
  const [table, setTable] = useState(defaultTable);
  const [active, setActive] = useState<number | null>(null);
  const ok = counts.length > 0 && edges.length === counts.length + 1;
  const n = ok ? counts.length : 0;
  const rove = useRoving(n);
  const total = counts.reduce((a, c) => a + c, 0);
  const max = niceMax(Math.max(0, ...counts));
  const plotW = Math.max(0, width - HIST_PAD.left - HIST_PAD.right);
  const plotH = height - HIST_PAD.top - HIST_PAD.bottom;
  const base = HIST_PAD.top + plotH;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(1, slot - 2);
  const y = linearScale(0, max, base, HIST_PAD.top);
  const lo = ok ? edges[0]! : 0;
  const hi = ok ? edges[n]! : 1;
  const x = linearScale(lo, hi, HIST_PAD.left, HIST_PAD.left + plotW);
  const hasMedian = median !== null && median !== undefined && Number.isFinite(median);
  const mx = hasMedian && median >= lo && median <= hi ? x(median) : null;
  const nLabels = Math.min(n + 1, width < 480 ? 3 : 5);
  const labelAt = ok ? [...new Set(Array.from({ length: nLabels }, (_, i) => Math.round((i * n) / Math.max(1, nLabels - 1))))] : [];
  const medianText = hasMedian ? `, median ${format(median)}` : '';
  const summary = ok
    ? `${ariaLabel}: ${total} values in ${n} bins from ${format(lo)} to ${format(hi)}${medianText}`
    : `${ariaLabel}: ${UNAVAILABLE}`;
  const picked = active !== null && ok ? active : null;

  return (
    <div className={cn('w-full transition-opacity', dim && 'opacity-60')}>
      <div ref={ref} className="relative w-full">
        {table && ok ? (
          <ChartTable data={histogramTable(edges, counts, format, `${ariaLabel}${medianText}`)} />
        ) : (
          width > 0 && (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
              <g role="img" aria-label={summary}>
                {axisTicks(max).map((t) => (
                  <g key={t}>
                    <line
                      x1={HIST_PAD.left}
                      x2={width - HIST_PAD.right}
                      y1={y(t)}
                      y2={y(t)}
                      stroke="var(--color-line)"
                      strokeWidth={1}
                      shapeRendering="crispEdges"
                    />
                    <text x={HIST_PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                      {formatCount(t)}
                    </text>
                  </g>
                ))}
                {ok &&
                  counts.map((c, i) =>
                    c > 0 ? (
                      <path
                        key={i}
                        d={columnPath(HIST_PAD.left + i * slot + 1, base, y(c), barW)}
                        fill="var(--chart-1)"
                        opacity={picked === null || picked === i ? 1 : 0.4}
                        className="pointer-events-none transition-opacity duration-150"
                      />
                    ) : null,
                  )}
                {labelAt.map((i) => (
                  <text
                    key={i}
                    x={HIST_PAD.left + i * slot}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-muted text-[11px] tabular-nums"
                  >
                    {format(edges[i]!)}
                  </text>
                ))}
                {mx !== null && (
                  <g className="pointer-events-none">
                    <line
                      x1={mx}
                      x2={mx}
                      y1={HIST_PAD.top - 4}
                      y2={base}
                      stroke="var(--color-ink)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                    <text
                      x={mx}
                      y={HIST_PAD.top - 7}
                      textAnchor={mx > width / 2 ? 'end' : 'start'}
                      dx={mx > width / 2 ? -3 : 3}
                      className="fill-ink-soft text-[11.5px] tabular-nums"
                    >
                      median {format(median!)}
                    </text>
                  </g>
                )}
              </g>
              {ok && (
                <g role="group" aria-label={`${ariaLabel}: bins`}>
                  {counts.map((c, i) => (
                    <rect
                      key={i}
                      x={HIST_PAD.left + i * slot}
                      y={HIST_PAD.top}
                      width={slot}
                      height={plotH}
                      fill="transparent"
                      ref={(el) => {
                        rove.cells.current[i] = el;
                      }}
                      role="button"
                      tabIndex={rove.tab(i)}
                      aria-label={`${format(edges[i]!)} to ${format(edges[i + 1]!)}: ${formatCount(c)}`}
                      onPointerEnter={() => setActive(i)}
                      onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                      onFocus={() => (rove.setRoving(i), setActive(i))}
                      onBlur={() => setActive((a) => (a === i ? null : a))}
                      onClick={() => setActive(i)}
                      onKeyDown={(e) => rove.onKey(i, e)}
                      className="cursor-pointer outline-hidden"
                    />
                  ))}
                </g>
              )}
            </svg>
          )
        )}
        {(!ok || total === 0) && !table && empty && (
          <p
            className="pointer-events-none absolute inset-x-0 top-[38%] text-center text-[13px] text-muted"
            style={{ paddingLeft: HIST_PAD.left }}
          >
            {empty}
          </p>
        )}
        {!table && picked !== null && (
          <ChartTip x={HIST_PAD.left + (picked + 0.5) * slot} width={width} top={HIST_PAD.top} offset={barW / 2 + 8}>
            <p className="text-[14px] font-semibold text-ink tabular-nums">{formatCount(counts[picked]!)}</p>
            <p className="text-[11.5px] text-muted tabular-nums">
              {format(edges[picked]!)} to {format(edges[picked + 1]!)}
            </p>
          </ChartTip>
        )}
      </div>
      <TableButton show={table} onToggle={() => setTable((t) => !t)} />
    </div>
  );
}
