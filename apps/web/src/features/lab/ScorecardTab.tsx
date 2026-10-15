import { LoadError, RowsSkeleton, Segmented } from '@isnanme/ui';
import type { CrewProgramScore, CrewScorecard, CrewWindow } from '@portal/contracts';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { formatCost } from '@/lib/usage/format';
import { NotAvailable } from '../usage/spend/shared';
import { useLoad } from '../usage/spend/useLoad';
import { labApi } from './api';
import { fmtAge, fmtFigure, fmtPerHour, tiles, UNAVAILABLE, WINDOW_OPTIONS, type Tile, type TileState } from './scorecardModel';

const STATE_CLASS: Record<TileState, string> = {
  ok: 'text-ink',
  warn: 'text-amber-600 dark:text-amber-400',
  breach: 'text-red-600 dark:text-red-400',
  unavailable: 'text-muted',
};

function TileView({ t }: { t: Tile }) {
  return (
    <div className="min-w-0" data-tile={t.key} data-state={t.state}>
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
        {t.was !== null && <span data-was="" className="ml-1.5 text-[11.5px] text-muted tabular-nums">was {t.was}</span>}
        <span className="mt-0.5 block text-[10.5px] uppercase tracking-wide text-muted">
          {t.state === 'unavailable' ? t.basis : `${t.state} · ${t.basis}`}
        </span>
      </dd>
    </div>
  );
}

function List({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="mt-3">
      <h4 className="text-[12.5px] font-semibold">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted">None in this window.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-[12.5px]">
          {rows.map((r, i) => (
            <li key={i} dir="auto" className="break-words [overflow-wrap:anywhere] tabular-nums">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The tables the API returns, as lists (a table would scroll sideways on a phone). */
function Detail({ p }: { p: CrewProgramScore }) {
  const e = p.current.effectiveness;
  return (
    <div className="border-t border-line px-4 pb-3 pt-1" data-scorecard-detail="">
      <List
        title="Done by type"
        rows={e.byType.map((r) => `${r.type}: ${r.done} done, ${fmtPerHour(r.perHour)} / h, ${formatCost(r.perTicketAllInUsd)} each${r.noStart ? `, ${r.noStart} no start` : ''}`)}
      />
      <List title="In review" rows={e.review.map((r) => `${r.ticket} (${r.type}) ${fmtAge(r.ageMs)}${r.waitsFor ? `, waits ${r.waitsFor}${r.waitsBasis === 'derived' ? ' (read now)' : ''}` : ''}`)} />
      <List title="CI" rows={e.ci.map((r) => `${r.pipeline}: ${r.passed} passed, ${r.failed} failed, ${r.cancelled} cancelled`)} />
      <List title="Deploys" rows={e.deploys.map((d) => `#${d.runNumber} ${d.pipeline} → ${d.environment}, ${d.approval}${d.outcome ? `, ${d.outcome}` : ''}`)} />
      <List
        title="Targets"
        rows={p.targets.map((t) => `${t.decision} ${t.id.replace(/_/g, ' ')}: ${t.state}${t.figure.basis === 'unavailable' ? ' (unavailable)' : ''}${t.offenders.length ? `, ${t.offenders.slice(0, 5).join(', ')}` : ''}`)}
      />
      <p className="mt-2 text-[12px] text-muted">
        Cost {fmtFigure(p.current.cost.total, formatCost)} · lead {fmtFigure(p.current.cost.lead, formatCost)} · workers {fmtFigure(p.current.cost.workers, formatCost)}
      </p>
    </div>
  );
}

function ProgramCard({ p }: { p: CrewProgramScore }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="px-4 pt-3" data-scorecard-program={p.program}>
        <p className="flex min-w-0 items-baseline gap-2 text-[14px] font-semibold">
          <span dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
            {p.title || p.program}
          </span>
          <span className="ml-auto shrink-0 text-[12px] font-normal text-muted">{p.workers} workers</span>
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-3 pb-2 sm:grid-cols-3 lg:grid-cols-5">
          {tiles(p).map((t) => (
            <TileView key={t.key} t={t} />
          ))}
        </dl>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="press flex min-h-11 w-full items-center justify-between border-t border-line px-4 text-[13px] text-muted"
      >
        <span>{open ? 'Hide' : 'Details'}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <Detail p={p} />}
    </Card>
  );
}

function Programs({ data, loading }: { data: CrewScorecard; loading: boolean }) {
  if (data.programs.length === 0) return <p className="py-3 text-[13px] text-muted">No program active in this window.</p>;
  return (
    <ul className={`space-y-3 ${loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}`}>
      {data.programs.map((p) => (
        <li key={p.program}>
          <ProgramCard p={p} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Usage → Crew (docs/prd/claude-usage.md §28.14): one card per program with five numbers (done per hour, dollars per done ticket, the lead's
 * share, the review backlog, breaches), each with its state and whether it is measured or an estimate, its source in a tip. Read only.
 */
export function ScorecardTab() {
  const [window, setWindow] = useState<CrewWindow>('day');
  const [compare, setCompare] = useState<'0' | '1'>('0');
  const { data, failed, forbidden, loading, reload } = useLoad(() => labApi.scorecard(window, compare === '1'), `${window}|${compare}`, { live: false });
  return (
    <>
      <PageHeader title="Crew" />
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="sm:w-[300px]">
          <Segmented label="Window" value={window} options={WINDOW_OPTIONS} onChange={setWindow} />
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
          <InfoTip label="About compare">Compare shows each number of the window before this one, the same length, as “was”.</InfoTip>
        </div>
        {data && (
          <InfoTip label="Sources">
            {Object.entries(data.basis).map(([k, v]) => (
              <span key={k} className="mb-1 block">
                <b>{k}</b>: {v}
              </span>
            ))}
          </InfoTip>
        )}
      </div>
      {forbidden ? <NotAvailable /> : failed ? <LoadError onRetry={reload} /> : !data ? <RowsSkeleton rows={2} lines={3} label="Loading the scorecard" /> : <Programs data={data} loading={loading} />}
    </>
  );
}
