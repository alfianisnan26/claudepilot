import { cn } from '@isnanme/ui';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** A clean axis top: 1, 2 or 5 times a power of ten, at or above `v`. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** The element's width, kept current. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
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
  const markerPath = columns.reduce((d, c, i) => (c.marker == null ? d : `${d}${d && columns[i - 1]?.marker != null ? ' L' : ' M'}${cx(i).toFixed(1)},${y(c.marker).toFixed(1)}`), '').trim();

  return (
    <div ref={ref} className={cn('relative w-full transition-opacity', dim && 'opacity-60')}>
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label={ariaLabel} className="block overflow-visible">
          <defs>{defs}</defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} shapeRendering="crispEdges" />
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
                {c.value > 0 && !bands.length && <path d={columnPath(x, base, top, barW)} fill="var(--chart-1)" opacity={opacity} className="transition-opacity duration-150" />}
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
                          return <line key={s.key} x1={x} x2={x + barW} y1={y(a)} y2={y(a)} stroke="var(--color-surface)" strokeWidth={2} />;
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
          {markerPath && <path d={markerPath} fill="none" stroke="var(--color-ink-soft)" strokeWidth={1.5} strokeDasharray="4 3" strokeLinejoin="round" className="pointer-events-none" />}
          {picked?.marker != null && <circle cx={cx(active!)} cy={y(picked.marker)} r={3.5} fill="var(--color-surface)" stroke="var(--color-ink-soft)" strokeWidth={1.5} className="pointer-events-none" />}
        </svg>
      )}
      {allZero && empty && (
        <p className="pointer-events-none absolute inset-x-0 top-[38%] text-center text-[13px] text-muted" style={{ paddingLeft: PAD.left }}>
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
              <button type="button" onClick={() => onPick(r.key)} aria-pressed={picked === r.key} title={r.title} className="press block w-full rounded-xl px-2 py-2 hover:bg-surface-2">
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
