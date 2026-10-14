import { LoadError, RowsSkeleton, Segmented } from '@isnanme/ui';
import type { LabExperimentView, LabPeriod, LabSummary, LabSummaryRow } from '@portal/contracts';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { formatCost } from '@/lib/usage/format';
import { NotAvailable } from '../usage/spend/shared';
import { useLoad } from '../usage/spend/useLoad';
import { labApi } from './api';
import { figures, fmtInterval, rowTitle, UNAVAILABLE, type Figure } from './model';

const PERIODS: { value: LabPeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
];

/** A value; "unavailable" reads as a state (muted, smaller), never as a number. */
function Value({ v }: { v: string }) {
  return v === UNAVAILABLE ? <span className="text-[12px] font-normal text-muted">{v}</span> : <span className="tabular-nums">{v}</span>;
}

/** Where every figure comes from: one tip per section, a line per figure. */
function Sources({ basis }: { basis: Record<string, string> }) {
  return (
    <InfoTip label="Sources">
      {Object.entries(basis).map(([k, v]) => (
        <span key={k} className="mb-1 block">
          <b>{k}</b>: {v}
        </span>
      ))}
    </InfoTip>
  );
}

/** Phone: one card per row, the figures in a three-column grid (median / p90 where they differ). */
function RowCard({ r }: { r: LabSummaryRow }) {
  return (
    <li className="px-4 py-3" data-lab-row="">
      <p className="flex min-w-0 items-baseline gap-2 text-[14px] font-semibold">
        <span dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
          {rowTitle(r)}
        </span>
        <span className="ml-auto shrink-0 text-[12px] font-normal text-muted">{r.period}</span>
      </p>
      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
        {figures(r).map((f: Figure) => (
          <div key={f.key} className="min-w-0">
            <dt className="truncate text-[11.5px] text-muted">{f.label}</dt>
            <dd className="break-words text-[13.5px] font-semibold [overflow-wrap:anywhere]">
              <Value v={f.value} />
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/** A table cell: the median, and the p90 under it (muted) when the figure has one. */
function Stacked({ v }: { v: string }) {
  const [median, p90] = v.split(' / ');
  return (
    <>
      <Value v={median!} />
      {p90 && <span className="block text-[12px] text-muted tabular-nums">{p90}</span>}
    </>
  );
}

/** Desktop: one table, a row per period, role and model. */
function RowsTable({ rows }: { rows: LabSummaryRow[] }) {
  const head = figures(rows[0]!).map((f) => f.label);
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-line text-left text-[12px] text-muted">
          <th className="px-4 py-2 font-normal">Role</th>
          {head.map((h) => (
            <th key={h} className="px-2 py-2 text-right font-normal">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((r) => (
          <tr key={`${r.period}|${r.role}|${r.model ?? ''}`} data-lab-row="">
            <td className="min-w-[9.5rem] px-4 py-2">
              <span dir="auto" className="block font-semibold [overflow-wrap:anywhere]">
                {rowTitle(r)}
              </span>
              <span className="block text-[12px] text-muted">{r.period}</span>
            </td>
            {figures(r).map((f) => (
              <td key={f.key} className="whitespace-nowrap px-2 py-2 text-right">
                <Stacked v={f.value} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ data, loading }: { data: LabSummary; loading: boolean }) {
  return (
    <Card className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <div className="flex items-center gap-1 border-b border-line px-4 py-2 text-[12.5px] text-muted">
        median / p90
        <Sources basis={data.basis} />
      </div>
      {data.rows.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted">No slices in this window.</p>
      ) : (
        <>
          <ul className="divide-y divide-line lg:hidden">
            {data.rows.map((r) => (
              <RowCard key={`${r.period}|${r.role}|${r.model ?? ''}`} r={r} />
            ))}
          </ul>
          <div className="hidden lg:block">
            <RowsTable rows={data.rows} />
          </div>
        </>
      )}
    </Card>
  );
}

function Experiments({ list }: { list: LabExperimentView[] }) {
  if (list.length === 0) return <p className="py-3 text-[13px] text-muted">No experiments yet.</p>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {list.map((v) => (
          <li key={v.experiment.id} className="px-4 py-3" data-lab-experiment="">
            <p className="flex min-w-0 items-baseline gap-2 text-[14px] font-semibold">
              <span dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
                {v.experiment.name}
              </span>
              <span className="ml-auto shrink-0 text-[12px] font-normal text-muted">{v.experiment.status}</span>
            </p>
            <ul className="mt-1.5 space-y-1 text-[13px]">
              {v.arms.map((a) => (
                <li key={a.arm} className="flex flex-wrap items-baseline gap-x-3">
                  <span dir="auto" className="min-w-0 font-semibold [overflow-wrap:anywhere]">
                    {a.arm}
                  </span>
                  <span className="text-muted">n {a.n}</span>
                  <span className="text-muted">acc {a.accepted}</span>
                  <Value v={a.costPerAccepted === null ? UNAVAILABLE : formatCost(a.costPerAccepted)} />
                  <span className="text-[12px] text-muted">{fmtInterval(a.costPerAcceptedInterval)}</span>
                </li>
              ))}
            </ul>
            {v.excluded > 0 && <p className="mt-1 text-[12px] text-muted">{v.excluded} excluded</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Usage → Lab (docs/prd/claude-usage.md §28.11): the slice economy per day or week and per role and model, and the experiments with each
 * arm's n and the primary (median cost per accepted slice) with its 90 percent interval. Read only; every figure's source is in a tip.
 */
export function LabTab() {
  const [period, setPeriod] = useState<LabPeriod>('day');
  const summary = useLoad(() => labApi.summary(period), period);
  const experiments = useLoad(() => labApi.experiments(), 'experiments');
  return (
    <>
      <PageHeader title="Lab" />
      <div className="mb-4 sm:w-[240px]">
        <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
      </div>
      {summary.forbidden ? (
        <NotAvailable />
      ) : summary.failed ? (
        <LoadError onRetry={summary.reload} />
      ) : !summary.data ? (
        <RowsSkeleton rows={3} lines={2} label="Loading the lab" />
      ) : (
        <Summary data={summary.data} loading={summary.loading} />
      )}
      <h2 className="mb-2 mt-6 flex items-center gap-1 text-[15px] font-semibold">
        Experiments
        <InfoTip label="About experiments">Each arm: slices, accepted slices, the median cost per accepted slice (its rework counted) and its 90 percent interval (bootstrap, from 20 accepted slices).</InfoTip>
      </h2>
      {experiments.forbidden ? null : experiments.failed ? (
        <LoadError onRetry={experiments.reload} />
      ) : !experiments.data ? (
        <RowsSkeleton rows={1} lines={1} label="Loading experiments" />
      ) : (
        <Experiments list={experiments.data} />
      )}
    </>
  );
}
