import { cn, Segmented } from '@isnanme/ui';
import type { TicketFlow, TicketFlowSpan } from '@portal/contracts';
import { useMemo, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { actorName } from '../labels';
import { axisTicks, chartRange, chartWidth, durationShort, fitScale, layoutBars, SCALE_LABEL, SCALES, STATE_BAR, STATE_LABEL, tickLabel, type Scale } from './layout';

export interface FlowChartRow {
  id: string;
  title: string;
  flow: TicketFlow;
}

/** Width of the label column. */
const LABEL_PX = 88;
const ROW = 'h-11';
const LEGEND = ['open', 'in_progress', 'blocked', 'in_review', 'waiting', 'done', 'wont_do'] as const;

const clock = (iso: string): string => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function Details({ row, span, now, onClose }: { row: FlowChartRow; span: TicketFlowSpan; now: number; onClose: () => void }) {
  const closed = span.state === 'done' || span.state === 'wont_do';
  return (
    <div role="region" aria-label="Span details" className="rounded-xl border border-line bg-surface px-3 py-2.5 text-sm [overflow-wrap:anywhere]">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 font-semibold">
          {row.id} · {STATE_LABEL[span.state]}
        </p>
        <button type="button" onClick={onClose} className="press -m-2 inline-flex h-11 min-w-11 items-center justify-center rounded-lg px-2 text-xs text-muted hover:bg-surface-2 hover:text-ink">
          Close
        </button>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ink-soft">
        <dt className="text-muted">{closed ? 'At' : 'From'}</dt>
        <dd>{closed ? clock(span.start) : `${clock(span.start)} to ${span.end ? clock(span.end) : 'now'}`}</dd>
        {!closed && (
          <>
            <dt className="text-muted">Time</dt>
            <dd>{durationShort(span.end === null ? Math.max(0, now - Date.parse(span.start)) : span.durationMs)}</dd>
          </>
        )}
        {span.by && (
          <>
            <dt className="text-muted">By</dt>
            <dd>{actorName(span.by.actor, span.by.label)}</dd>
          </>
        )}
        {span.reason && (
          <>
            <dt className="text-muted">Why</dt>
            <dd>{span.reason}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * T-119 S2a: the flow chart. One row per ticket, one bar per state; a closed state is a mark. The chart scrolls inside its own box (the
 * page never scrolls sideways) with the ticket names pinned on the left; Min / Hour / Day change the scale; a bar is a button (tap or Enter)
 * that opens the details under the chart. `now` is passed in: the chart has no clock of its own.
 */
export function FlowChart({ rows, now, initialScale }: { rows: readonly FlowChartRow[]; now: number; initialScale?: Scale }) {
  const range0 = useMemo(() => chartRange(rows.map((r) => ({ id: r.id, title: r.title, spans: r.flow.spans })), now, 'minute'), [rows, now]);
  const [scale, setScale] = useState<Scale>(() => initialScale ?? (range0 ? fitScale(range0, 390 - LABEL_PX) : 'hour'));
  const [picked, setPicked] = useState<{ row: string; index: number } | null>(null);
  const range = useMemo(() => chartRange(rows.map((r) => ({ id: r.id, title: r.title, spans: r.flow.spans })), now, scale), [rows, now, scale]);
  if (!range) return <p className="text-sm text-muted">Nothing to show yet.</p>;

  const width = chartWidth(range, scale);
  const ticks = axisTicks(range, scale);
  const pickedRow = picked ? rows.find((r) => r.id === picked.row) : undefined;
  const pickedSpan = pickedRow && picked ? pickedRow.flow.spans[picked.index] : undefined;

  return (
    <section aria-label="Flow" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1 text-sm font-semibold">
          Flow
          <InfoTip label="About the flow chart">
            <span className="block">One row per ticket, one bar for each time it stayed in a state. A dot is something that happened (a claim, a comment, a tag). A diamond is when it closed.</span>
            <span className="mt-1 block">Tap a bar for who moved it and why. Min, Hour and Day change how wide time is.</span>
          </InfoTip>
        </h2>
        <Segmented<Scale> label="Scale" value={scale} onChange={setScale} options={SCALES.map((s) => ({ value: s, label: SCALE_LABEL[s] }))} />
      </div>

      <div className="flex min-w-0 max-w-full overflow-x-auto rounded-xl border border-line bg-surface [overscroll-behavior-x:contain]" tabIndex={0} role="group" aria-label="Flow chart, scrolls sideways">
        <div className="flex" style={{ width: width + LABEL_PX }}>
          <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-surface" style={{ width: LABEL_PX }}>
            <div className="h-7 border-b border-line" />
            {rows.map((r) => (
              <div key={r.id} className={cn(ROW, 'flex flex-col justify-center border-b border-line px-2 text-xs last:border-b-0')}>
                <span className="font-semibold">{r.id}</span>
                <span className="truncate text-muted">{r.title}</span>
              </div>
            ))}
          </div>
          <div className="relative shrink-0" style={{ width }}>
            <div className="relative h-7 border-b border-line" aria-hidden>
              {ticks.map((t) => (
                <span key={t.at} className="absolute top-1.5 -translate-x-1/2 text-[10px] text-muted tabular-nums" style={{ left: t.left }}>
                  {tickLabel(t.at, scale)}
                </span>
              ))}
            </div>
            {rows.map((r) => (
              <div key={r.id} className={cn(ROW, 'relative border-b border-line last:border-b-0')}>
                {ticks.map((t) => (
                  <span key={t.at} aria-hidden className="absolute inset-y-0 w-px bg-line/60" style={{ left: t.left }} />
                ))}
                {layoutBars(r.flow.spans, range, scale, now).map((b) => (
                  <button
                    key={b.index}
                    type="button"
                    aria-label={`${r.id} ${STATE_LABEL[b.state]}${b.running ? ', running' : ''}`}
                    aria-pressed={picked?.row === r.id && picked.index === b.index}
                    onClick={() => setPicked((p) => (p && p.row === r.id && p.index === b.index ? null : { row: r.id, index: b.index }))}
                    className="press group absolute inset-y-0 flex items-center focus-visible:outline-none"
                    style={{ left: b.left, width: b.width }}
                  >
                    <span className="absolute -inset-x-2 inset-y-0" aria-hidden />
                    <span
                      className={cn(
                        'block group-focus-visible:ring-2 group-focus-visible:ring-accent group-aria-pressed:ring-2 group-aria-pressed:ring-ink',
                        STATE_BAR[b.state],
                        b.point ? 'mx-auto size-3 rotate-45 rounded-[2px]' : cn('h-5 w-full', b.running ? 'rounded-l-md' : 'rounded-md'),
                      )}
                    />
                  </button>
                ))}
                {r.flow.markers.map((m, i) => {
                  const left = (Date.parse(m.at) - range.from) * (width / (range.to - range.from));
                  return <span key={i} aria-hidden className="pointer-events-none absolute top-1 size-2 -translate-x-1/2 rounded-full bg-ink/70" style={{ left }} />;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted" aria-label="States">
        {LEGEND.map((s) => (
          <li key={s} className="flex items-center gap-1">
            <span className={cn('size-2.5 rounded-sm', STATE_BAR[s])} aria-hidden />
            {STATE_LABEL[s]}
          </li>
        ))}
      </ul>

      {pickedRow && pickedSpan && <Details row={pickedRow} span={pickedSpan} now={now} onClose={() => setPicked(null)} />}
    </section>
  );
}
