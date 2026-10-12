import type { ClaudeUsageSeries } from '@portal/contracts';
import { TONE_TEXT, type Tone } from './format';

interface Point {
  at: string;
  usedPct: number;
}

/** A step line of percent used over time, from `fromMs` to `toMs`: the value holds until the next reading. */
function pathOf(points: Point[], fromMs: number, toMs: number, w: number, h: number): { line: string; area: string } | null {
  if (!points.length) return null;
  const span = Math.max(1, toMs - fromMs);
  const x = (ms: number) => Math.min(w, Math.max(0, ((ms - fromMs) / span) * w));
  const y = (v: number) => h - (Math.min(100, Math.max(0, v)) / 100) * (h - 2) - 1;
  let line = `M${x(Date.parse(points[0]!.at)).toFixed(1)},${y(points[0]!.usedPct).toFixed(1)}`;
  for (const p of points.slice(1)) line += ` H${x(Date.parse(p.at)).toFixed(1)} V${y(p.usedPct).toFixed(1)}`;
  line += ` H${w}`;
  const start = x(Date.parse(points[0]!.at)).toFixed(1);
  return { line, area: `${line} V${h} H${start} Z` };
}

/**
 * A small history line. No axes: the number and the time are in the label beside it, and the 80 % and 95 % marks sit faint behind
 * (`marks`). Stretches to its box; the stroke keeps its width.
 */
export function Spark({
  points,
  fromMs,
  toMs,
  tone = 'ok',
  marks = false,
  className,
  label,
}: {
  points: Point[];
  fromMs: number;
  toMs: number;
  tone?: Tone;
  marks?: boolean;
  className?: string;
  label: string;
}) {
  const W = 200;
  const H = 40;
  const p = pathOf(points, fromMs, toMs, W, H);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={`${TONE_TEXT[tone]} ${className ?? ''}`}>
      {marks &&
        [80, 95].map((m) => <line key={m} x1="0" x2={W} y1={H - (m / 100) * (H - 2) - 1} y2={H - (m / 100) * (H - 2) - 1} stroke="currentColor" strokeOpacity="0.18" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />)}
      {p ? (
        <>
          <path d={p.area} fill="currentColor" fillOpacity="0.12" />
          <path d={p.line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="currentColor" strokeOpacity="0.25" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

/** The last value of a series, for its label. */
export const lastPct = (s: ClaudeUsageSeries): number | null => s.points.at(-1)?.usedPct ?? null;
