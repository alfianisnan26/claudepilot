import { cn, Dialog, useMediaQuery } from '@isnanme/ui';
import type { TicketFlowMarker, TicketFlowSpan, TicketTimelineRow } from '@portal/contracts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { Popover } from '@/components/Popover';
import { actorName } from '../labels';
import { PriorityMark } from '../parts';
import {
  axisTicks,
  chartWidth,
  labelledTicks,
  durationShort,
  initials,
  layoutBars,
  LEGEND,
  LETTER_PX,
  moveFocus,
  patternStyle,
  SCALE_LABEL,
  SCALES,
  shading,
  STATE_LABEL,
  STATE_LOOK,
  tickLabel,
  timeLeft,
  type Bar,
  type Range,
  type Scale,
  type Tick,
} from './layout';

/** Width of the label column: key, priority and initials on a phone; the title too where there is room. */
const LABEL = 'w-(--label-w)';
/** 44 px rows on touch (a bar is a tap target), 28 px with a mouse. */
const ROW = 'h-7 tap:h-11';
const MARKER_WORD: Record<TicketFlowMarker['kind'], string> = {
  assigned: 'Assigned',
  claimed: 'Claimed',
  bumped: 'Bumped',
  comment: 'Comment',
  priority: 'Priority',
  tags: 'Tags',
  ci: 'CI',
  waiting: 'Needs a person',
};

const clock = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

interface Picked {
  row: TicketTimelineRow;
  span: TicketFlowSpan;
  bar: Bar;
}

/** What a tap on a bar shows: the state, from and to, how long, who moved it there and why, and what happened inside the span. */
function SpanDetails({ picked, now, search }: { picked: Picked; now: number; search: string }) {
  const { row, span, bar } = picked;
  const closed = bar.point;
  const end = span.end === null ? null : Date.parse(span.end);
  const inside = row.flow.markers.filter((m) => {
    const at = Date.parse(m.at);
    return at >= bar.startMs && at <= (end ?? now);
  });
  return (
    <div className="text-sm [overflow-wrap:anywhere]">
      <p className="font-semibold">
        {row.key} · {STATE_LABEL[span.state]}
      </p>
      <p className="line-clamp-2 text-ink-soft">{row.summary}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-soft">
        <dt className="text-muted">{closed ? 'At' : 'From'}</dt>
        <dd>{closed ? clock(bar.startMs) : `${clock(bar.startMs)} to ${end === null ? 'now (running)' : clock(end)}`}</dd>
        {!closed && (
          <>
            <dt className="text-muted">Time</dt>
            <dd>{durationShort(end === null ? Math.max(0, now - bar.startMs) : span.durationMs)}</dd>
          </>
        )}
        {span.by && (
          <>
            <dt className="text-muted">By</dt>
            <dd>
              {span.by.session ? (
                <Link to={`/admin/sessions/${span.by.session}`} className="font-semibold text-ink underline-offset-2 hover:underline">
                  {actorName(span.by.actor, span.by.label)}
                </Link>
              ) : (
                actorName(span.by.actor, span.by.label)
              )}
            </dd>
          </>
        )}
        {span.reason && (
          <>
            <dt className="text-muted">Why</dt>
            <dd>{span.reason}</dd>
          </>
        )}
      </dl>
      {inside.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-[13px] text-ink-soft" aria-label="In this span">
          {inside.map((m, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-muted tabular-nums">{clock(Date.parse(m.at))}</span>
              <span className="min-w-0">
                <span className="font-semibold">{MARKER_WORD[m.kind]}</span>
                {m.detail ? ` · ${m.detail}` : ''}
                <span className="text-muted"> · {actorName(m.by.actor, m.by.label)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link
        to={{ pathname: `/admin/tickets/${row.key}`, search }}
        className="press mt-3 inline-flex h-11 items-center rounded-full border border-line px-4 font-semibold text-ink hover:bg-surface-2"
      >
        Open ticket
      </Link>
    </div>
  );
}

/**
 * The axis labels (T-1988): only those whose whole label is in view, so none sits half under the sticky label column or past the box's
 * edge. It follows the box's own scroll and size, so a pan re-renders the labels only, not the rows.
 */
function AxisLabels({ ticks, scale, box, labels }: { ticks: readonly Tick[]; scale: Scale; box: RefObject<HTMLDivElement | null>; labels: RefObject<HTMLDivElement | null> }) {
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const from = el.scrollLeft;
      const to = from + el.clientWidth - (labels.current?.offsetWidth ?? 0);
      setView((v) => (v && v.from === from && v.to === to ? v : { from, to }));
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      ro?.disconnect();
    };
  }, [box, labels, ticks]);
  const shown = view ? labelledTicks(ticks, view) : [];
  return (
    <div className="relative h-7 border-b border-line" aria-hidden>
      {shown.map((t) => (
        <span key={t.at} className="absolute top-1.5 -translate-x-1/2 text-[10.5px] whitespace-nowrap text-muted tabular-nums" style={{ left: t.left }}>
          {tickLabel(t.at, scale)}
        </span>
      ))}
    </div>
  );
}

/** Min / Hour / Day: a radio group with 44 px targets on touch (the kit's Segmented is 40). */
function ScaleSwitch({ value, onChange }: { value: Scale; onChange: (s: Scale) => void }) {
  return (
    <div role="radiogroup" aria-label="Scale" className="flex shrink-0 rounded-full border border-line bg-surface p-0.5 tap:border-0 tap:p-0 tap:ring-1 tap:ring-line tap:ring-inset">
      {SCALES.map((s, i) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          tabIndex={value === s ? 0 : -1}
          onClick={() => onChange(s)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = SCALES[(i + step + SCALES.length) % SCALES.length]!;
            onChange(next);
            (e.currentTarget.parentElement?.children[SCALES.indexOf(next)] as HTMLElement | undefined)?.focus();
          }}
          className={cn(
            'press h-10 min-w-12 rounded-full px-3 text-[13.5px] font-semibold tap:h-11',
            value === s ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink',
          )}
        >
          {SCALE_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

/**
 * T-119: the Timeline. One row per ticket (oldest number first, so a new ticket lands at the bottom and nothing moves under the finger), one
 * bar per state from the window's spans. The chart pans sideways inside its own box (the page never does), with the label column pinned;
 * it opens at "now". A bar is a button: tap, click or Enter opens its details (a popover where there is room, a sheet on a phone); arrow
 * keys move between bars; Esc closes. The row label opens the ticket.
 */
export function FlowChart({
  rows,
  range,
  now,
  scale,
  onScale,
  search,
}: {
  rows: readonly TicketTimelineRow[];
  range: Range;
  now: number;
  scale: Scale;
  onScale: (s: Scale) => void;
  search: string;
}) {
  const roomy = useMediaQuery('(min-width: 640px)');
  const box = useRef<HTMLDivElement>(null);
  const labelCol = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<{ id: string; index: number } | null>(null);
  const width = chartWidth(range, scale);
  const ticks = useMemo(() => axisTicks(range, scale), [range, scale]);
  const shade = useMemo(() => shading(range, scale), [range, scale]);
  const bars = useMemo(() => rows.map((r) => layoutBars(r.flow.spans, range, scale, now)), [rows, range, scale, now]);
  const nowLeft = timeLeft(now, range, scale);

  // The chart opens at its right end (now); a scale change does it again. Live updates keep where the person panned to.
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [scale]);

  const pickedRow = picked ? rows.find((r) => r.id === picked.id) : undefined;
  const pickedSpan = pickedRow && picked ? pickedRow.flow.spans[picked.index] : undefined;
  const pickedBar = pickedRow && picked ? bars[rows.indexOf(pickedRow)]?.find((b) => b.index === picked.index) : undefined;
  const details = pickedRow && pickedSpan && pickedBar ? { row: pickedRow, span: pickedSpan, bar: pickedBar } : null;
  const close = () => setPicked(null);
  useEffect(() => {
    if (picked && !details) setPicked(null);
  }, [picked, details]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const row = Number(el.dataset.row);
    const bar = Number(el.dataset.bar);
    if (!Number.isFinite(row) || !Number.isFinite(bar) || el.dataset.row === undefined) return;
    const to = moveFocus(bars.map((b) => b.length), { row, bar }, e.key);
    if (!to) return;
    e.preventDefault();
    box.current?.querySelector<HTMLElement>(`[data-row="${to.row}"][data-bar="${to.bar}"]`)?.focus();
  };

  return (
    <section aria-label="Timeline" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1 text-sm font-semibold">
          Timeline
          <InfoTip label="About the timeline">
            <span className="block">One row per ticket, one bar for each stretch it stayed in a state, in the window up to now. A diamond is when it closed; a bar that touches the now line is still running. Marks on a row are things that happened: a claim, a comment, a tag, a CI result.</span>
            <span className="mt-1 block">Tap a bar for who moved it there, why and what happened in it. Min, Hour and Day change the scale and the window (6 hours, 3 days, 30 days). The name opens the ticket.</span>
          </InfoTip>
        </h2>
        <ScaleSwitch value={scale} onChange={onScale} />
      </div>

      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-soft" aria-label="States">
        {LEGEND.map((s) => (
          <li key={s} className="flex items-center gap-1">
            <span
              className={cn('inline-flex size-3.5 items-center justify-center rounded-sm text-[9px] leading-none font-bold', STATE_LOOK[s].bar, STATE_LOOK[s].ink)}
              style={patternStyle(STATE_LOOK[s].pattern)}
              aria-hidden
            >
              {STATE_LOOK[s].letter}
            </span>
            {STATE_LABEL[s]}
          </li>
        ))}
      </ul>

      <div
        ref={box}
        className="relative min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-line bg-surface"
        role="group"
        aria-label="Timeline chart, scrolls sideways"
        onKeyDown={onKey}
      >
        <div className="flex [--label-w:7.5rem] medium:[--label-w:14rem]" style={{ width: `calc(${width}px + var(--label-w))` }} data-timeline="">
          <div ref={labelCol} className={cn('sticky left-0 z-20 shrink-0 border-r border-line bg-surface', LABEL)}>
            <div className="h-7 border-b border-line" />
            {rows.map((r) => (
              <Link
                key={r.id}
                to={{ pathname: `/admin/tickets/${r.key}`, search }}
                title={`${r.key} ${r.summary}`}
                className={cn(ROW, 'flex min-w-0 items-center gap-1.5 border-b border-line px-2 text-[12.5px] last:border-b-0 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden focus-visible:ring-inset')}
              >
                <PriorityMark priority={r.priority} className="size-4" />
                <span className="shrink-0 font-semibold tabular-nums">{r.key}</span>
                <span className="hidden min-w-0 flex-1 truncate text-muted medium:block">{r.summary}</span>
                <span
                  className={cn('ml-auto flex size-5 shrink-0 items-center justify-center rounded-full text-[9.5px] font-bold', r.assignee ? 'bg-surface-2 text-ink-soft' : 'text-muted')}
                  title={r.assignee ? r.assignee.label : 'Unassigned'}
                >
                  {r.assignee ? initials(r.assignee.kind === 'user' && r.assignee.label === 'admin' ? 'You' : r.assignee.label) : '·'}
                  <span className="sr-only">{r.assignee ? `, ${r.assignee.label}` : ', unassigned'}</span>
                </span>
              </Link>
            ))}
          </div>

          <div className="relative shrink-0" style={{ width }}>
            <AxisLabels ticks={ticks} scale={scale} box={box} labels={labelCol} />
            {/* One layer for the grid, the shading and the now line under every row, not a copy per row. */}
            <div className="pointer-events-none absolute inset-x-0 top-7 bottom-0" aria-hidden>
              {shade.map((s, i) => (
                <span key={i} className="absolute inset-y-0 bg-ink/[0.04]" style={{ left: s.left, width: s.width }} />
              ))}
              {ticks.map((t) => (
                <span key={t.at} className="absolute inset-y-0 w-px bg-line/60" style={{ left: t.left }} />
              ))}
              {nowLeft !== null && <span className="absolute inset-y-0 z-10 w-0.5 bg-primary/70" style={{ left: nowLeft }} />}
            </div>
            {rows.map((r, ri) => (
              <div key={r.id} className={cn(ROW, 'relative border-b border-line last:border-b-0')}>
                {bars[ri]!.map((b, bi) => {
                  const look = STATE_LOOK[b.state];
                  const on = picked?.id === r.id && picked.index === b.index;
                  return (
                    <button
                      key={b.index}
                      type="button"
                      data-row={ri}
                      data-bar={bi}
                      aria-label={`${r.key} ${STATE_LABEL[b.state]}${b.point ? ` at ${clock(b.startMs)}` : `, ${durationShort(b.endMs - b.startMs)}`}${b.running ? ', running' : ''}`}
                      aria-haspopup="dialog"
                      aria-expanded={on}
                      onClick={(e) => {
                        anchor.current = e.currentTarget;
                        setPicked(on ? null : { id: r.id, index: b.index });
                      }}
                      className="group absolute inset-y-0 z-[1] flex items-center focus-visible:outline-none"
                      style={{ left: b.left, width: b.width }}
                    >
                      {/* A thin bar still has a finger-wide target. */}
                      <span className="absolute -inset-x-1.5 inset-y-0" aria-hidden />
                      <span
                        aria-hidden
                        className={cn(
                          'flex items-center justify-center overflow-hidden text-[10px] leading-none font-bold group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-1',
                          look.bar,
                          look.ink,
                          on && 'ring-2 ring-ink ring-offset-1',
                          b.point ? 'mx-auto size-3 rotate-45 rounded-[2px]' : cn('h-4 w-full tap:h-6', b.running ? 'rounded-l-md' : b.cutStart ? 'rounded-r-md' : 'rounded-md'),
                        )}
                        style={patternStyle(look.pattern)}
                      >
                        {!b.point && b.width >= LETTER_PX && look.letter}
                      </span>
                    </button>
                  );
                })}
                {r.flow.markers.map((m, i) => {
                  const left = timeLeft(Date.parse(m.at), range, scale);
                  return left === null ? null : (
                    <span
                      key={i}
                      aria-hidden
                      title={`${MARKER_WORD[m.kind]} · ${clock(Date.parse(m.at))}`}
                      className="pointer-events-none absolute top-0 z-[2] size-0 -translate-x-1/2 border-x-[4px] border-t-[6px] border-x-transparent border-t-ink/70"
                      style={{ left }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {details && roomy && (
        <Popover anchor={anchor} open onClose={close} label="Span" prefer="below">
          <SpanDetails picked={details} now={now} search={search} />
        </Popover>
      )}
      {!roomy && (
        <Dialog open={!!details} onClose={close} title={details ? `${details.row.key} · ${STATE_LABEL[details.span.state]}` : 'Span'} size="sm">
          {details && <SpanDetails picked={details} now={now} search={search} />}
        </Dialog>
      )}
    </section>
  );
}
