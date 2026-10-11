import { cn } from '@isnanme/ui';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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

export interface ChartColumn {
  key: string;
  value: number;
  /** Under the axis, on the columns that get a label ("14:00"). */
  tick: string;
  /** What the column covers, in its tooltip ("14:00–15:00"). */
  span: string;
  /** More for the tooltip, under the value ("12.3k in · 480 out"). */
  detail?: string;
}

const PAD = { top: 12, right: 6, bottom: 24, left: 44 };
const BAR_MAX = 24;
const TICK_LABELS = 4;

/**
 * Columns over time, one series: the card's title names it, so there's no legend. Columns are at most
 * 24 px wide with a 4 px rounded top and a square foot on the baseline, 2 px apart at the least, over
 * hairline gridlines at clean values. Each column is a button: hover, focus or a tap shows its value
 * and time; the others dim while one is picked.
 */
export function ColumnChart({
  columns,
  format,
  ariaLabel,
  height = 188,
  empty,
  dim,
}: {
  columns: ChartColumn[];
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
  /** Shown over an empty chart. */
  empty?: ReactNode;
  /** Data is reloading: hold the frame, faded. */
  dim?: boolean;
}) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = columns.length;
  const max = niceMax(Math.max(0, ...columns.map((c) => c.value)));
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

  return (
    <div ref={ref} className={cn('relative w-full transition-opacity', dim && 'opacity-60')}>
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label={ariaLabel} className="block overflow-visible">
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
            const h = base - top;
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={c.key}>
                {c.value > 0 && (
                  <path
                    d={`M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${base} Z`}
                    fill="var(--chart-1)"
                    opacity={active === null || active === i ? 1 : 0.4}
                    className="transition-opacity duration-150"
                  />
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
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.span}: ${format(c.value)}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  onClick={() => setActive(i)}
                  className="cursor-pointer outline-none"
                />
              </g>
            );
          })}
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
            'pointer-events-none absolute z-10 rounded-xl border border-line bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-lift',
            PAD.left + (active + 0.5) * slot > width / 2 ? '-translate-x-full text-right' : 'text-left',
          )}
          style={{
            left: PAD.left + (active + 0.5) * slot + (PAD.left + (active + 0.5) * slot > width / 2 ? -(barW / 2 + 8) : barW / 2 + 8),
            top: PAD.top,
          }}
        >
          <p className="text-[14px] font-semibold text-ink">{format(picked.value)}</p>
          <p className="text-[11.5px] text-muted">{picked.span}</p>
          {picked.detail && <p className="text-[11.5px] text-muted tabular-nums">{picked.detail}</p>}
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
}

/**
 * A ranked list with a bar each, longest first: one hue, so identity is in the words. The value sits at
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
              <span className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-ink">
                {r.label}
                {r.sub && <span className="ml-1.5 font-normal text-muted">{r.sub}</span>}
              </span>
              <span className="shrink-0 text-[13.5px] text-ink-soft tabular-nums">{format(r.value)}</span>
            </span>
            <span className="mt-1.5 block h-1.5 w-full">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{ width: `${max > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%`, background: 'var(--chart-1)' }}
              />
            </span>
          </>
        );
        const dimmed = picked && picked !== r.key;
        return (
          <li key={r.key} className={cn('transition-opacity', dimmed && 'opacity-45')}>
            {onPick ? (
              <button type="button" onClick={() => onPick(r.key)} aria-pressed={picked === r.key} className="press block w-full rounded-xl px-2 py-2 hover:bg-surface-2">
                {inner}
              </button>
            ) : (
              <div className="px-2 py-2">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
