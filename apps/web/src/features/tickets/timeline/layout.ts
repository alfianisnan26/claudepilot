// T-119 S2a: the maths of the flow chart (Gantt), pure, so it is tested without a browser. A scale is pixels per unit of time; a bar is a span
// placed on that scale. A closed state (done, wont_do) is a point: it gets a fixed-width mark, never zero width. "now" is always passed in.

import type { TicketFlowSpan, TicketFlowState } from '@portal/contracts';

export const SCALES = ['minute', 'hour', 'day'] as const;
export type Scale = (typeof SCALES)[number];

export const SCALE_LABEL: Record<Scale, string> = { minute: 'Min', hour: 'Hour', day: 'Day' };
export const UNIT_MS: Record<Scale, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
/** How wide one unit is on screen. Tuned so a tick is never closer than about 30 px. */
export const UNIT_PX: Record<Scale, number> = { minute: 6, hour: 40, day: 64 };
/** The distance between two axis ticks, in ms (minute: every 5, so a label has room). */
export const TICK_MS: Record<Scale, number> = { minute: 5 * 60_000, hour: 3_600_000, day: 86_400_000 };

/** The narrowest a bar is drawn (a span of a few seconds is still tappable), and the width of a closed state's mark. */
export const MIN_BAR_PX = 6;
export const POINT_PX = 12;
/** Room around the chart's range so the first and last bar do not touch the edge. */
export const PAD_MS: Record<Scale, number> = { minute: 5 * 60_000, hour: 3_600_000, day: 86_400_000 };

export const STATE_LABEL: Record<TicketFlowState, string> = {
  open: 'Open',
  in_progress: 'Working',
  blocked: 'Blocked',
  in_review: 'Review',
  done: 'Done',
  wont_do: 'Dropped',
  waiting: 'Waiting',
};

/** A bar colour per state (the legend names them too: colour is never the only cue). */
export const STATE_BAR: Record<TicketFlowState, string> = {
  open: 'bg-slate-400 dark:bg-slate-500',
  in_progress: 'bg-sky-500 dark:bg-sky-400',
  blocked: 'bg-rose-500 dark:bg-rose-400',
  in_review: 'bg-amber-500 dark:bg-amber-400',
  done: 'bg-emerald-600 dark:bg-emerald-400',
  wont_do: 'bg-slate-600 dark:bg-slate-300',
  waiting: 'bg-violet-500 dark:bg-violet-400',
};

export const pxPerMs = (scale: Scale): number => UNIT_PX[scale] / UNIT_MS[scale];

export interface FlowRow {
  id: string;
  title: string;
  spans: readonly TicketFlowSpan[];
}

export interface Range {
  from: number;
  to: number;
}

const ms = (iso: string): number => Date.parse(iso);

/** The time the chart covers: from the earliest start to the latest end (an open span ends at now), padded. Null when no row has a readable span. */
export function chartRange(rows: readonly FlowRow[], now: number, scale: Scale): Range | null {
  let from = Infinity;
  let to = -Infinity;
  for (const row of rows) {
    for (const s of row.spans) {
      const a = ms(s.start);
      if (!Number.isFinite(a)) continue;
      const b = s.end === null ? now : ms(s.end);
      from = Math.min(from, a);
      to = Math.max(to, Number.isFinite(b) ? Math.max(a, b) : a);
    }
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from: from - PAD_MS[scale], to: to + PAD_MS[scale] };
}

export interface Bar {
  state: TicketFlowState;
  /** Pixels from the chart's left edge. */
  left: number;
  width: number;
  /** A closed state: drawn as a mark, not a stretch. */
  point: boolean;
  /** Still running: drawn with an open right end. */
  running: boolean;
  startMs: number;
  endMs: number;
  /** The index in the row's spans (the details read it). */
  index: number;
}

/** Spans of one row as bars on a scale. A span with an unreadable start is left out. */
export function layoutBars(spans: readonly TicketFlowSpan[], range: Range, scale: Scale, now: number): Bar[] {
  const k = pxPerMs(scale);
  const bars: Bar[] = [];
  spans.forEach((s, index) => {
    const a = ms(s.start);
    if (!Number.isFinite(a)) return;
    const running = s.end === null;
    const rawEnd = running ? now : ms(s.end!);
    const b = Number.isFinite(rawEnd) ? Math.max(a, rawEnd) : a;
    const point = s.state === 'done' || s.state === 'wont_do';
    const left = (a - range.from) * k;
    // A point is centred on its time, so a close at 10:00 sits over 10:00 on the axis.
    const width = point ? POINT_PX : Math.max(MIN_BAR_PX, (b - a) * k);
    bars.push({ state: s.state, left: point ? left - POINT_PX / 2 : left, width, point, running, startMs: a, endMs: b, index });
  });
  return bars;
}

/** The chart's width in pixels. */
export const chartWidth = (range: Range, scale: Scale): number => Math.ceil((range.to - range.from) * pxPerMs(scale));

export interface Tick {
  at: number;
  left: number;
}

/** Axis ticks on multiples of the scale's step (UTC-aligned: the label is formatted in local time by the caller). */
export function axisTicks(range: Range, scale: Scale): Tick[] {
  const step = TICK_MS[scale];
  const k = pxPerMs(scale);
  const ticks: Tick[] = [];
  for (let at = Math.ceil(range.from / step) * step; at <= range.to; at += step) ticks.push({ at, left: (at - range.from) * k });
  return ticks;
}

/** A tick's label: a clock time at minute and hour scale, a date at day scale. */
export function tickLabel(at: number, scale: Scale, locale?: string): string {
  const d = new Date(at);
  return scale === 'day' ? d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** The scale that shows the whole range in about `width` pixels, for a first view: the largest unit that still fits. */
export function fitScale(range: Range, width: number): Scale {
  for (const s of ['minute', 'hour'] as const) if ((range.to - range.from) * pxPerMs(s) <= width) return s;
  return 'day';
}

/** A duration as short as a label wants it: "45s", "12m", "3h 5m", "2d 4h". */
export function durationShort(durationMs: number): string {
  const s = Math.max(0, Math.round(durationMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
