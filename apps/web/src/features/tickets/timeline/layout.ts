// T-119: the maths of the Timeline (a Gantt of ticket states), pure, so it is tested without a browser. A scale is pixels per unit of time;
// the chart covers the window the API answered for (from..to), and a bar is a span placed on that scale, clipped to the window. A closed
// state (done, wont_do) is a point: it gets a fixed-width mark, never zero width. "now" is always passed in.

import { TICKET_STATUS_LABEL, TICKET_TIMELINE_LIMITS, type TicketFlowSpan, type TicketFlowState } from '@portal/contracts';

export const SCALES = ['minute', 'hour', 'day'] as const;
export type Scale = (typeof SCALES)[number];
export const isScale = (v: string | null | undefined): v is Scale => !!v && (SCALES as readonly string[]).includes(v);

export const SCALE_LABEL: Record<Scale, string> = { minute: 'Min', hour: 'Hour', day: 'Day' };
export const UNIT_MS: Record<Scale, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
/** How wide one unit is on screen. Tuned so a tick is never closer than about 30 px. */
export const UNIT_PX: Record<Scale, number> = { minute: 6, hour: 40, day: 64 };
/** The finest distance between two axis ticks, in ms; axisTicks thins it to the next step that leaves a label room (TICK_GAP_PX). */
export const TICK_MS: Record<Scale, number> = { minute: 5 * 60_000, hour: 3_600_000, day: 86_400_000 };
/** Round tick steps, finest first: 1, 2, 5, 10, 15, 30 minutes; 1, 2, 3, 6, 12 hours; 1, 2, 7 days. */
export const TICK_STEPS_MS: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10_080].map((m) => m * 60_000);
/**
 * The least distance between two labelled ticks (T-1988). A label ("14:05", "Oct 21") at 10.5 px is up to about 34 px wide, so 40 px
 * keeps a gap between neighbours at every width (at 30 px, the old minute step, they touched).
 */
export const TICK_GAP_PX = 40;
/** Half a label's width: a label is centred on its tick, and is only shown when all of it is in view (labelledTicks). */
export const LABEL_HALF_PX = 18;

/** The narrowest a bar is drawn (a span of a few seconds is still tappable), and the width of a closed state's mark. */
export const MIN_BAR_PX = 6;
export const POINT_PX = 12;
/** A bar shows its state's letter from this width (colour is never the only cue: the letter, the pattern and the legend are). */
export const LETTER_PX = 16;

/** The words of the list (Open, In progress, ...) plus the flow's own `waiting`. */
export const STATE_LABEL: Record<TicketFlowState, string> = { ...TICKET_STATUS_LABEL, waiting: 'Waiting' };

export type Pattern = 'none' | 'hatch' | 'dots' | 'strike';

/**
 * A look per state, from the ticket status palette (the badges' tokens: neutral, accent for in progress, amber for warning, danger) plus the
 * flame token for waiting and Done's own violet (index.css, T-1988). Each has a letter and, where two could be confused, a pattern, so colour is never the only signal.
 */
export const STATE_LOOK: Record<TicketFlowState, { bar: string; ink: string; letter: string; pattern: Pattern }> = {
  open: { bar: 'bg-line-strong', ink: 'text-ink', letter: 'O', pattern: 'none' },
  in_progress: { bar: 'bg-accent', ink: 'text-surface', letter: 'P', pattern: 'none' },
  blocked: { bar: 'bg-danger', ink: 'text-surface', letter: 'B', pattern: 'hatch' },
  in_review: { bar: 'bg-amber-500', ink: 'text-black/80', letter: 'R', pattern: 'none' },
  waiting: { bar: 'bg-flame', ink: 'text-surface', letter: 'W', pattern: 'dots' },
  done: { bar: 'bg-done', ink: 'text-white', letter: 'D', pattern: 'none' },
  wont_do: { bar: 'bg-muted', ink: 'text-surface', letter: 'X', pattern: 'strike' },
};

/** The legend's order: the life of a ticket. */
export const LEGEND: readonly TicketFlowState[] = ['open', 'in_progress', 'blocked', 'in_review', 'waiting', 'done', 'wont_do'];

/** The CSS of a pattern, laid over the bar's colour (a white wash, so it reads in both themes). */
export function patternStyle(p: Pattern): { backgroundImage?: string; backgroundSize?: string } {
  if (p === 'hatch') return { backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.38) 0 3px, transparent 3px 7px)' };
  if (p === 'dots') return { backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.6) 1px, transparent 1.6px)', backgroundSize: '6px 6px' };
  if (p === 'strike') return { backgroundImage: 'linear-gradient(135deg, transparent 44%, rgb(255 255 255 / 0.85) 44% 56%, transparent 56%)' };
  return {};
}

export const pxPerMs = (scale: Scale): number => UNIT_PX[scale] / UNIT_MS[scale];

export interface Range {
  from: number;
  to: number;
}

const ms = (iso: string): number => Date.parse(iso);

/**
 * The window the chart asks for at a scale: the scale's default length (6 hours, 3 days, 30 days: the API's) up to now, with its end on the
 * next whole minute, so the same question within a minute is the same request (the server's short cache answers it).
 */
export function windowFor(scale: Scale, now: number): Range {
  const to = Math.ceil(now / 60_000) * 60_000;
  return { from: to - TICKET_TIMELINE_LIMITS[scale].defaultWindowMs, to };
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
  /** It began before the window (its left end is cut). */
  cutStart: boolean;
  startMs: number;
  endMs: number;
  /** The index in the row's spans (the details read it). */
  index: number;
}

/** Spans of one row as bars on a scale, clipped to the range. A span outside the range, or with an unreadable start, is left out. */
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
    if (point ? a < range.from || a > range.to : b < range.from || a > range.to) return;
    if (point) {
      // A point is centred on its time, so a close at 10:00 sits over 10:00 on the axis.
      bars.push({ state: s.state, left: (a - range.from) * k - POINT_PX / 2, width: POINT_PX, point, running: false, cutStart: false, startMs: a, endMs: a, index });
      return;
    }
    const a1 = Math.max(a, range.from);
    const b1 = Math.min(b, range.to);
    bars.push({ state: s.state, left: (a1 - range.from) * k, width: Math.max(MIN_BAR_PX, (b1 - a1) * k), point, running, cutStart: a < range.from, startMs: a, endMs: b, index });
  });
  return bars;
}

/** The chart's width in pixels. */
export const chartWidth = (range: Range, scale: Scale): number => Math.ceil((range.to - range.from) * pxPerMs(scale));

/** Where a time sits on the chart, or null outside the range (a marker, the now line). */
export function timeLeft(at: number, range: Range, scale: Scale): number | null {
  if (!Number.isFinite(at) || at < range.from || at > range.to) return null;
  return (at - range.from) * pxPerMs(scale);
}

export interface Tick {
  at: number;
  left: number;
}

/** The tick step at a scale: the finest round step from the scale's own that puts ticks at least `gap` pixels apart. */
export function tickStep(scale: Scale, gap: number = TICK_GAP_PX): number {
  const k = pxPerMs(scale);
  return TICK_STEPS_MS.find((s) => s >= TICK_MS[scale] && s * k >= gap) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/** Axis ticks on multiples of the scale's step, thinned so labels never crowd (UTC-aligned: the label is formatted in local time by the caller). */
export function axisTicks(range: Range, scale: Scale, gap: number = TICK_GAP_PX): Tick[] {
  const step = tickStep(scale, gap);
  const k = pxPerMs(scale);
  const ticks: Tick[] = [];
  for (let at = Math.ceil(range.from / step) * step; at <= range.to; at += step) ticks.push({ at, left: (at - range.from) * k });
  return ticks;
}

/**
 * The ticks whose label fits whole inside the part of the chart in view (chart pixels: from the scroll offset, which is where the sticky
 * label column ends, to that plus the visible chart width). A label half under the label column or past the box's edge is left out, never
 * drawn cut (T-1988); the grid line stays.
 */
export function labelledTicks(ticks: readonly Tick[], view: { from: number; to: number }, half: number = LABEL_HALF_PX): Tick[] {
  return ticks.filter((t) => t.left - half >= view.from && t.left + half <= view.to);
}

/**
 * The part of the chart in view, in chart pixels, from the box's scroll offset and width and the sticky label column's width: the column
 * covers the box's left, so what shows of the chart starts at the scroll offset and is the box less the column wide.
 */
export function axisView(scrollLeft: number, boxWidth: number, labelWidth: number): { from: number; to: number } {
  const from = Math.max(0, scrollLeft);
  return { from, to: from + Math.max(0, boxWidth - labelWidth) };
}

/** A tick's label: a clock time at minute and hour scale (the date at midnight), a date at day scale. */
export function tickLabel(at: number, scale: Scale, locale?: string): string {
  const d = new Date(at);
  if (scale === 'day' || (scale === 'hour' && d.getHours() === 0 && d.getMinutes() === 0)) return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * The shaded stretches: weekends at the day scale, nights (22:00 to 06:00, local time) at the hour scale, none at the minute scale. Each is
 * clipped to the range, in pixels.
 */
export function shading(range: Range, scale: Scale): { left: number; width: number }[] {
  if (scale === 'minute') return [];
  const k = pxPerMs(scale);
  const out: { left: number; width: number }[] = [];
  const d = new Date(range.from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  for (; d.getTime() < range.to; d.setDate(d.getDate() + 1)) {
    const day = d.getTime();
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const stretches: [number, number][] = [];
    if (scale === 'day') {
      if (d.getDay() === 0 || d.getDay() === 6) stretches.push([day, next.getTime()]);
    } else {
      const six = new Date(d);
      six.setHours(6);
      const ten = new Date(d);
      ten.setHours(22);
      stretches.push([day, six.getTime()], [ten.getTime(), next.getTime()]);
    }
    for (const [a, b] of stretches) {
      const a1 = Math.max(a, range.from);
      const b1 = Math.min(b, range.to);
      if (b1 > a1) out.push({ left: (a1 - range.from) * k, width: (b1 - a1) * k });
    }
  }
  return out;
}

/** Up to two letters for a name: "Build lane" is BL, "frontend" is FR, "" is "?". */
export function initials(label: string): string {
  const words = label.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]!];
  return (words.length > 1 ? `${first[0]}${[...words[1]!][0]}` : first.slice(0, 2).join('')).toUpperCase();
}

/**
 * Keyboard: the bar focus moves to after an arrow key. Left and Right step within a row; Up and Down go to the nearest row above or below
 * that has bars, keeping the position as close as its bar count allows. Null: nowhere to go.
 */
export function moveFocus(counts: readonly number[], at: { row: number; bar: number }, key: string): { row: number; bar: number } | null {
  if (key === 'ArrowLeft') return at.bar > 0 ? { row: at.row, bar: at.bar - 1 } : null;
  if (key === 'ArrowRight') return at.bar < (counts[at.row] ?? 0) - 1 ? { row: at.row, bar: at.bar + 1 } : null;
  const step = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  if (!step) return null;
  for (let r = at.row + step; r >= 0 && r < counts.length; r += step) if ((counts[r] ?? 0) > 0) return { row: r, bar: Math.min(at.bar, counts[r]! - 1) };
  return null;
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
