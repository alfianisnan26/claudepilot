import type { CrewSummary } from '@portal/contracts';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Minus } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { UNAVAILABLE, type TileState } from './scorecardModel';
import { SUMMARY_GRID_CLASS, summaryLists, summaryTiles, TREND_WORD, type SummaryTile, type Trend } from './summaryModel';

const STATE_CLASS: Record<TileState, string> = {
  ok: 'text-ink',
  warn: 'text-amber-600 dark:text-amber-400',
  breach: 'text-red-600 dark:text-red-400',
  unavailable: 'text-muted',
};

const TREND_ICON: Record<Trend, typeof ArrowUp> = { up: ArrowUp, down: ArrowDown, same: Minus };

export function SummaryTileView({ t }: { t: SummaryTile }) {
  const Trend = t.trend ? TREND_ICON[t.trend] : null;
  return (
    <div className="min-w-0" data-summary-tile={t.key} data-state={t.state}>
      <dt className="flex items-center text-[11.5px] text-muted">
        <span className="truncate">{t.label}</span>
        <InfoTip label={`About ${t.label}`}>{t.tip}</InfoTip>
      </dt>
      <dd className="break-words [overflow-wrap:anywhere]">
        {t.value === UNAVAILABLE ? (
          <span className="text-[12px] text-muted">{UNAVAILABLE}</span>
        ) : (
          <span className={`text-[17px] font-semibold tabular-nums ${STATE_CLASS[t.state]}`}>{t.value}</span>
        )}
        {Trend && t.trend && (
          <span data-trend={t.trend} className="ml-1.5 inline-flex items-center gap-0.5 text-[11.5px] text-muted tabular-nums">
            <Trend size={12} aria-hidden="true" />
            <span className="sr-only">{TREND_WORD[t.trend]}, </span>was {t.was}
          </span>
        )}
        {t.sub && <span className="mt-0.5 block text-[11.5px] text-muted">{t.sub}</span>}
        <span className="block text-[10.5px] uppercase tracking-wide text-muted">{t.basis}</span>
      </dd>
    </div>
  );
}

/** The five figures of T-600 as a grid, with the lists behind them when `expandable`. Read only. */
export function SummaryView({ summary, expandable = true }: { summary: CrewSummary; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-crew-summary="" className="@container">
      <dl className={`${SUMMARY_GRID_CLASS} ${expandable ? 'px-4 pt-3' : 'pt-1'}`}>
        {summaryTiles(summary).map((t) => (
          <SummaryTileView key={t.key} t={t} />
        ))}
      </dl>
      {expandable && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide summary details' : 'Show summary details'}
            onClick={() => setOpen((o) => !o)}
            className="press flex min-h-11 w-full items-center justify-center border-t border-line text-muted"
          >
            {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          </button>
          {open && (
            <div className="border-t border-line px-4 pb-3 pt-1" data-summary-detail="">
              {summaryLists(summary).map((l) => (
                <div key={l.title} className="mt-3">
                  <h4 className="text-[12.5px] font-semibold">{l.title}</h4>
                  {l.rows.length === 0 ? (
                    <p className="text-[12.5px] text-muted">None in this window.</p>
                  ) : (
                    <ul className="mt-1 space-y-1 text-[12.5px]">
                      {l.rows.map((r, i) => (
                        <li key={i} dir="auto" className="break-words [overflow-wrap:anywhere] tabular-nums">
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Top of the Crew page: "Summary", or a quiet line when the server does not send it yet. */
export function SummaryBlock({ summary }: { summary: CrewSummary | undefined }) {
  return (
    <Card>
      <div className="px-4 pt-3 text-[14px] font-semibold" data-summary-title="">
        Summary
      </div>
      {summary ? <SummaryView summary={summary} /> : <p className="px-4 py-3 text-[13px] text-muted">unavailable: this portal does not report it yet.</p>}
    </Card>
  );
}
