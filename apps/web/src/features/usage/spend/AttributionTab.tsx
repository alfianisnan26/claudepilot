import { LoadError, RowsSkeleton, Segmented } from '@isnanme/ui';
import type { AttributionBy, AttributionRow, ChatUsageRange } from '@portal/contracts';
import { ATTRIBUTION_LEAD_BASIS, reasonText } from '@portal/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { ClaudeSwatch, formatCost, useSlot, slotColor } from '@/lib/usage';
import { ExportMenu } from '../ExportMenu';
import { DOLLARS_FORMULA } from '../figure';
import { RANGE_OPTIONS, saveRange, savedRange } from '../range';
import { usageSpendApi } from './api';
import { BY_OPTIONS, countsLine, coverageNote, maxTotal, rowName, sessionLine, shareText, ticketLine } from './attribution';
import { NotAvailable } from './shared';
import { useLoad } from './useLoad';

/** A tree this deep is drawn no deeper: the indent would eat the row on a phone. */
const MAX_INDENT = 4;

const WHAT: Record<AttributionBy, string> = {
  session: 'Each agent’s requests, with the agents it started rolled up into it (own is its requests alone). A sub-agent inside a request counts once, in that request.',
  workspace: 'Where the requests ran.',
  ticket: 'The agent’s ticket; an agent started by another with no ticket of its own counts under its parent’s. A lead’s own dollars are split over the tickets of its workers (via lead).',
  persona: 'The persona assigned to the workspace when the agent’s process started, recorded from now on. Earlier requests are not recorded, and never guessed.',
  claude: 'Which Claude the requests ran as.',
};

/** A bar under a row, as long as the row's total is of the biggest: in the Claude's own colour for a session, the chart colour otherwise. */
function RowBar({ value, max, claudeId }: { value: number; max: number; claudeId?: string }) {
  const slot = useSlot('claude', claudeId);
  return (
    <span className="mt-1.5 block h-1.5 w-full" aria-hidden="true">
      <span className="block h-full rounded-full" style={{ width: `${max > 0 ? Math.max(1.5, (value / max) * 100) : 0}%`, background: claudeId ? slotColor(slot) : 'var(--chart-1)' }} />
    </span>
  );
}

function Row({ r, max, indent }: { r: AttributionRow; max: number; indent: number }) {
  const line = sessionLine(r);
  const tk = ticketLine(r);
  const name = rowName(r);
  const title =
    r.by === 'session' && line && !line.deleted ? (
      <Link to={`/admin/sessions/${encodeURIComponent(r.key)}`} dir="auto" className="press min-w-0 flex-1 truncate font-semibold hover:text-accent tap:-my-3 tap:py-3" title={name}>
        {name}
      </Link>
    ) : (
      <span dir="auto" className="min-w-0 flex-1 truncate font-semibold" title={name}>
        {name}
      </span>
    );
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className={indent ? 'border-l border-line pl-3' : undefined} style={indent ? { marginLeft: Math.min(indent, MAX_INDENT) * 16 } : undefined}>
        <div className="flex items-baseline gap-2 text-[14px]">
          {title}
          {r.state === 'unknown' && <InfoTip label="Why not recorded">{reasonText(r.reason)}</InfoTip>}
          <span className="shrink-0 text-ink-soft tabular-nums">
            {formatCost(r.total.costUsd)}
            <span className="ml-1.5 inline-flex items-center text-muted">
              {shareText(r.share)}
              {r.share.basis === 'unavailable' && <InfoTip label="Why not available">{reasonText(r.share.reason)}</InfoTip>}
            </span>
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
          {line ? (
            <>
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <ClaudeSwatch claudeId={line.claudeId} />
                <span dir="auto" className="min-w-0 truncate" title={line.claude}>
                  {line.claude}
                </span>
              </span>
              {line.ticket && (
                <span dir="auto" className="min-w-0 max-w-full truncate" title={line.ticket}>
                  {line.ticket}
                </span>
              )}
              {line.own && <span className="tabular-nums">{line.own}</span>}
              {line.deleted && <span>deleted</span>}
            </>
          ) : tk ? (
            <>
              <span>{tk.type}</span>
              <span>{tk.status}</span>
              {tk.viaLead && (
                <span className="inline-flex items-center tabular-nums">
                  {tk.viaLead}
                  <InfoTip label="About via lead">{ATTRIBUTION_LEAD_BASIS}</InfoTip>
                </span>
              )}
              <span className="tabular-nums">{countsLine(r)}</span>
            </>
          ) : (
            <span className="tabular-nums">{countsLine(r)}</span>
          )}
        </div>
        <RowBar value={r.total.costUsd} max={max} claudeId={line?.claudeId} />
      </div>
    </li>
  );
}

/**
 * Usage → Attribution: who spent what in a window, by session (a tree, children rolled up into their parent), workspace, ticket or persona
 * (docs/prd/claude-usage.md §21). Dollars are estimates (the header says so); a persona or ticket that was never recorded is "Not recorded",
 * not zero.
 */
export function AttributionTab() {
  const [range, setRange] = useState<ChatUsageRange>(savedRange);
  const [by, setBy] = useState<AttributionBy>('session');
  const [done, setDone] = useState<'all' | 'done'>('all');
  const doneOnly = by === 'ticket' && done === 'done';
  const { data, failed, forbidden, loading, reload } = useLoad(() => usageSpendApi.attribution(by, range, doneOnly), `${by}|${range}|${doneOnly}`, { live: false });
  const max = data ? maxTotal(data.rows) : 0;
  const coverage = data ? coverageNote(data) : null;
  return (
    <>
      <PageHeader
        title="Attribution"
        description="Who spent what: each agent, workspace, ticket or persona in the window. An agent’s children are rolled up into it."
        action={
          <ExportMenu
            items={[
              { label: 'Attribution · CSV', url: usageSpendApi.attributionCsv(by, range, doneOnly) },
            ]}
          />
        }
      />
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="sm:w-[360px]">
          <Segmented
            label="Window"
            value={range}
            options={RANGE_OPTIONS}
            onChange={(r) => {
              setRange(r);
              saveRange(r);
            }}
          />
        </div>
        <div className="sm:w-[360px]">
          <Segmented label="Group by" value={by} options={BY_OPTIONS} onChange={setBy} />
        </div>
        {by === 'ticket' && (
          <div className="flex items-center sm:w-[200px]">
            <div className="min-w-0 flex-1">
              <Segmented
                label="Tickets"
                value={done}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'done', label: 'Done' },
                ]}
                onChange={setDone}
              />
            </div>
            <InfoTip label="About Done">Only tickets closed as done inside the window. Cost per done ticket, by type, is listed below.</InfoTip>
          </div>
        )}
      </div>
      {forbidden ? (
        <NotAvailable />
      ) : failed ? (
        <LoadError onRetry={reload} />
      ) : !data ? (
        <RowsSkeleton rows={4} trailing label="Loading attribution" />
      ) : data.rows.length === 0 ? (
        <p className="py-3 text-[13px] text-muted">{doneOnly ? 'No done tickets in this window.' : 'No requests in this window.'}</p>
      ) : (
        <Card className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2 text-[12.5px] text-muted sm:px-5">
            <span className="inline-flex items-center">
              {coverage && `${coverage.pct} % recorded`}
              <InfoTip label={`About ${by}`}>{WHAT[by]}</InfoTip>
            </span>
            <span className="inline-flex items-center">
              Cost
              <InfoTip text="est." label="How cost is estimated">
                {DOLLARS_FORMULA} The percent is the row’s share of the window’s dollars.
              </InfoTip>
            </span>
          </div>
          {by === 'ticket' && data.doneByType && data.doneByType.length > 0 && (
            <div className="border-b border-line px-4 py-2 text-[12.5px] sm:px-5">
              <div className="mb-1 inline-flex items-center text-muted">
                Done, per ticket
                <InfoTip label="About per ticket">Dollars of the tickets closed as done in the window, own plus via lead, over their number, by type. Estimates.</InfoTip>
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                {data.doneByType.map((t) => (
                  <li key={t.type}>
                    {t.type} {formatCost(t.perTicketUsd)} <span className="text-muted">× {t.tickets}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="divide-y divide-line">
            {data.rows.map((r) => (
              <Row key={`${r.state}|${r.key}`} r={r} max={max} indent={r.session?.depth ?? 0} />
            ))}
            {data.more > 0 && (
              <li className="px-4 py-3 text-[13px] text-muted sm:px-5">
                {data.more} more in Others
              </li>
            )}
          </ul>
        </Card>
      )}
    </>
  );
}
