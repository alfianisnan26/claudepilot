import type { CrewSummary } from '@portal/contracts';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { Sections, Stat } from './parts';
import { shownSub, SUMMARY_GRID_CLASS, summarySections, summaryTiles, TREND_WORD, type SummaryTile } from './summaryModel';

export function SummaryTileView({ t }: { t: SummaryTile }) {
  return (
    <Stat
      label={t.label}
      tip={t.tip}
      value={t.value}
      state={t.state}
      basis={t.basis}
      was={t.was}
      trend={t.trend}
      trendWord={t.trend ? TREND_WORD[t.trend] : undefined}
      sub={shownSub(t)}
      data={{ 'data-summary-tile': t.key }}
    />
  );
}

/** The five figures of T-600 as stat tiles, with their rows behind a chevron when `expandable`. Read only. */
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
          {open && <Sections sections={summarySections(summary)} data={{ 'data-summary-detail': '' }} />}
        </>
      )}
    </div>
  );
}

/** Top of the Crew page: "Summary", or the word unavailable (the reason in a tip) when the server does not send it yet. */
export function SummaryBlock({ summary }: { summary: CrewSummary | undefined }) {
  return (
    <Card>
      <div className="px-4 pt-3 text-[14px] font-semibold" data-summary-title="">
        Summary
      </div>
      {summary ? (
        <SummaryView summary={summary} />
      ) : (
        <p className="flex items-center px-4 py-3 text-[13px] text-muted">
          unavailable
          <InfoTip label="Why unavailable">This portal does not report the summary yet.</InfoTip>
        </p>
      )}
    </Card>
  );
}
