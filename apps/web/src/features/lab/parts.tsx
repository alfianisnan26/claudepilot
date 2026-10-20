// T-1852: the pieces the Lab and Crew pages share, so both read the same way: a stat (value big, label small with its tip, the trend
// subtle), a state as an icon with its word for screen readers, and compact rows with a thin bar instead of sentences.
import { ArrowDown, ArrowUp, CircleCheck, CircleMinus, CircleX, Minus, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { UNAVAILABLE, type BasisLabel, type MiniRow, type Section, type TileState } from './scorecardModel';
import type { Trend } from './summaryModel';

export const STATE_CLASS: Record<TileState, string> = {
  ok: 'text-ink',
  warn: 'text-amber-600 dark:text-amber-400',
  breach: 'text-red-600 dark:text-red-400',
  unavailable: 'text-muted',
};

const STATE_ICON = { ok: CircleCheck, warn: TriangleAlert, breach: CircleX, unavailable: CircleMinus } as const;
const STATE_ICON_CLASS: Record<TileState, string> = { ...STATE_CLASS, ok: 'text-emerald-600 dark:text-emerald-400' };

/** A state as an icon (shape and colour both differ, so it never rests on colour alone), its word for screen readers. */
export function StateMark({ state }: { state: TileState }) {
  const Icon = STATE_ICON[state];
  return (
    <span className={`inline-flex shrink-0 items-center ${STATE_ICON_CLASS[state]}`} data-state-mark={state}>
      <Icon size={14} aria-hidden="true" />
      <span className="sr-only">{state === 'unavailable' ? 'n/a' : state}</span>
    </span>
  );
}

/** A value; "unavailable" reads as a state (muted, smaller), never as a number. */
export function Value({ v, className = '' }: { v: string; className?: string }) {
  return v === UNAVAILABLE ? <span className="text-[12px] font-normal text-muted">{v}</span> : <span className={`tabular-nums ${className}`}>{v}</span>;
}

const TREND_ICON: Record<Trend, typeof ArrowUp> = { up: ArrowUp, down: ArrowDown, same: Minus };

/**
 * One number: the label small with its tip (what it is, its source and basis, the reason when unavailable), the value big in its state's
 * colour, an icon when it warns or breaches, "est." for an estimate, and in compare the value before, subtle. `data` names it for the checks.
 */
export function Stat({
  label,
  tip,
  value,
  state,
  basis,
  was,
  trend = null,
  trendWord,
  sub = null,
  data,
}: {
  label: string;
  tip: ReactNode;
  value: string;
  state: TileState;
  basis: BasisLabel;
  was: string | null;
  trend?: Trend | null;
  trendWord?: string;
  sub?: string | null;
  data: Record<string, string>;
}) {
  const T = trend ? TREND_ICON[trend] : null;
  return (
    <div className="min-w-0" data-state={state} data-basis={basis} {...data}>
      <dt className="flex min-w-0 items-center text-[11.5px] text-muted">
        <span className="truncate">{label}</span>
        <InfoTip label={`About ${label}`}>{tip}</InfoTip>
      </dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          {value === UNAVAILABLE ? <span className="text-[12px] text-muted">{UNAVAILABLE}</span> : <span className={`text-[20px] leading-tight font-semibold tabular-nums ${STATE_CLASS[state]}`}>{value}</span>}
          {(state === 'warn' || state === 'breach') && <StateMark state={state} />}
          {basis === 'ESTIMATE' && <span className="text-[11px] text-muted">est.</span>}
        </span>
        {was !== null && (
          <span data-was="" className="flex items-center gap-0.5 text-[11.5px] text-muted tabular-nums">
            {T && <T size={12} aria-hidden="true" />}
            {trend && trendWord && <span className="sr-only">{trendWord}, </span>}
            was {was}
          </span>
        )}
        {sub && <span className="block text-[11.5px] text-muted">{sub}</span>}
      </dd>
    </div>
  );
}

/** A thin bar (0 to 1) with an optional tick; static, so reduced motion has nothing to stop. */
function Bar({ value, mark }: { value: number; mark?: number | null }) {
  return (
    <span className="relative mt-1 block h-1 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
      <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${Math.round(value * 100)}%` }} />
      {mark !== null && mark !== undefined && <span className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `calc(${Math.round(mark * 100)}% - 1px)` }} />}
    </span>
  );
}

function Row({ r }: { r: MiniRow }) {
  return (
    <li className="min-w-0 py-1.5" data-mini-row={r.key} data-state={r.state ?? undefined}>
      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <span dir="auto" className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
          {r.label}
        </span>
        {r.state && r.state !== 'ok' && r.state !== 'unavailable' && <StateMark state={r.state} />}
        <Value v={r.value} className={`shrink-0 font-semibold ${r.state ? STATE_CLASS[r.state] : ''}`} />
      </div>
      {r.sub && (
        <p dir="auto" className="break-words text-[11.5px] text-muted [overflow-wrap:anywhere] tabular-nums">
          {r.sub}
        </p>
      )}
      {r.bar !== null && <Bar value={r.bar} mark={r.mark} />}
    </li>
  );
}

/** Sections of compact rows, two side by side from 640 px; an empty one says "None". */
export function Sections({ sections, data }: { sections: Section[]; data: Record<string, string> }) {
  return (
    <div className="grid gap-x-6 gap-y-3 border-t border-line px-4 pt-2 pb-3 sm:grid-cols-2" {...data}>
      {sections.map((s) => (
        <section key={s.title} className="min-w-0">
          <h4 className="text-[12px] font-semibold text-muted">{s.title}</h4>
          {s.rows.length === 0 ? (
            <p className="text-[12.5px] text-muted">None</p>
          ) : (
            <ul className="divide-y divide-line">
              {s.rows.map((r) => (
                <Row key={r.key} r={r} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
