import { LoadError, RowsSkeleton, Segmented } from '@isnanme/ui';
import type { CrewProgramScore, CrewScorecard, CrewWindow } from '@portal/contracts';
import { ChevronDown, ChevronUp, Users } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { NotAvailable } from '../usage/spend/shared';
import { useLoad } from '../usage/spend/useLoad';
import { labApi } from './api';
import { Sections, Stat, STATE_CLASS, StateMark, Value } from './parts';
import { SummaryBlock } from './SummaryBlock';
import { d65Rows, detailSections, tiles, WINDOW_OPTIONS, type Tile } from './scorecardModel';

function TileView({ t }: { t: Tile }) {
  return <Stat label={t.label} tip={t.tip} value={t.value} state={t.state} basis={t.basis} was={t.was} data={{ 'data-tile': t.key }} />;
}

/** T-549 (D-65): the efficiency targets, a compact row each: label (rule and source in the tip), value, a state icon; the offenders under it. */
function D65Rows({ p }: { p: CrewProgramScore }) {
  return (
    <div className="border-t border-line px-4 py-2" data-d65="">
      <h4 className="text-[12px] font-semibold text-muted">D-65</h4>
      <ul className="mt-0.5 grid gap-x-6 sm:grid-cols-2">
        {d65Rows(p).map((r) => (
          <li key={r.id} className="min-w-0" data-d65-row={r.id} data-state={r.state}>
            <div className="flex min-h-11 items-center gap-2 text-[13px]">
              <span className="flex min-w-0 flex-1 items-center">
                <span className="truncate">{r.label}</span>
                <InfoTip label={`About ${r.label}`}>{r.tip}</InfoTip>
              </span>
              <Value v={r.value} className={`shrink-0 font-semibold ${STATE_CLASS[r.state]}`} />
              <StateMark state={r.state} />
            </div>
            {r.offenders.length > 0 && (
              <p className="-mt-2 pb-1 break-words text-[11.5px] text-muted [overflow-wrap:anywhere]" data-d65-offenders="">
                {r.offenders.slice(0, 5).join(', ')}
                {r.offenders.length > 5 ? ` +${r.offenders.length - 5}` : ''}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProgramCard({ p }: { p: CrewProgramScore }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="px-4 pt-3" data-scorecard-program={p.program}>
        <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
          <span dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
            {p.title || p.program}
          </span>
          {p.workspaceId && <InfoTip label="About this program">Workspace: {p.workspaceId}</InfoTip>}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] font-normal text-muted tabular-nums" aria-label={`${p.workers} workers`} role="img">
            <Users size={14} aria-hidden="true" />
            {p.workers}
          </span>
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-3 pb-3 sm:grid-cols-3 lg:grid-cols-5">
          {tiles(p).map((t) => (
            <TileView key={t.key} t={t} />
          ))}
        </dl>
      </div>
      <D65Rows p={p} />
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide details' : 'Show details'}
        onClick={() => setOpen((o) => !o)}
        className="press flex min-h-11 w-full items-center justify-center border-t border-line text-muted"
      >
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {open && <Sections sections={detailSections(p)} data={{ 'data-scorecard-detail': '' }} />}
    </Card>
  );
}

function Programs({ data, loading }: { data: CrewScorecard; loading: boolean }) {
  return (
    <div className={`space-y-3 transition-opacity motion-reduce:transition-none ${loading ? 'opacity-70' : ''}`}>
      <SummaryBlock summary={data.headline} />
      {data.programs.length === 0 ? (
        <p className="py-3 text-[13px] text-muted">No programs</p>
      ) : (
        <ul className="space-y-3">
          {data.programs.map((p) => (
            <li key={p.program}>
              <ProgramCard p={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Usage → Crew (docs/prd/claude-usage.md §28.14): one card per program with five numbers (done per hour, dollars per done ticket, the lead's
 * share, the review backlog, breaches) as stat tiles: a state icon when one warns or breaches, "est." on an estimate, the source, the basis
 * and the reason when unavailable in each tile's tip (T-1852 text diet). Read only.
 */
export function ScorecardTab() {
  const [window, setWindow] = useState<CrewWindow>('day');
  const [compare, setCompare] = useState<'0' | '1'>('0');
  const { data, failed, forbidden, loading, reload } = useLoad(() => labApi.scorecard(window, compare === '1'), `${window}|${compare}`, { live: false });
  return (
    <>
      <PageHeader title="Crew" />
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="flex items-center sm:w-[340px]">
          <div className="min-w-0 flex-1">
            <Segmented label="Window" value={window} options={WINDOW_OPTIONS} onChange={setWindow} />
          </div>
          {data && (
            <InfoTip label="Sources of the numbers">
              {Object.entries(data.basis).map(([k, v]) => (
                <span key={k} className="mb-1 block">
                  <b>{k}</b>: {v}
                </span>
              ))}
            </InfoTip>
          )}
        </div>
        <div className="flex items-center sm:w-[220px]">
          <div className="min-w-0 flex-1">
            <Segmented
              label="Compare"
              value={compare}
              options={[
                { value: '0', label: 'Alone' },
                { value: '1', label: 'Compare' },
              ]}
              onChange={setCompare}
            />
          </div>
          <InfoTip label="About compare">Compare shows each number of the window before this one, the same length, as “was”. “est.” marks an estimate.</InfoTip>
        </div>
      </div>
      {forbidden ? <NotAvailable /> : failed ? <LoadError onRetry={reload} /> : !data ? <RowsSkeleton rows={2} lines={3} label="Loading the scorecard" /> : <Programs data={data} loading={loading} />}
    </>
  );
}
