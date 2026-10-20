import { LoadError, RowsSkeleton, Segmented } from '@isnanme/ui';
import type { LabExperimentView, LabPeriod, LabSummary, LabSummaryRow } from '@portal/contracts';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { formatCost } from '@/lib/usage/format';
import { NotAvailable } from '../usage/spend/shared';
import { useLoad } from '../usage/spend/useLoad';
import { labApi } from './api';
import { fmtInterval, groupByPeriod, rowTitle, splitFigures, UNAVAILABLE, type Figure } from './model';
import { Value } from './parts';

const PERIODS: { value: LabPeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
];

/** Where every figure comes from, and how a cell reads: one tip for the section. */
function Sources({ basis }: { basis: Record<string, string> }) {
  return (
    <InfoTip label="Sources">
      <span className="mb-1 block">Each cell: the median, the p90 under it when it differs.</span>
      {Object.entries(basis).map(([k, v]) => (
        <span key={k} className="mb-1 block">
          <b>{k}</b>: {v}
        </span>
      ))}
    </InfoTip>
  );
}

/** A cell: the median, and the p90 under it (muted) when the figure has one. */
function Stacked({ v }: { v: string }) {
  const [median, p90] = v.split(' / ');
  return (
    <>
      <Value v={median!} />
      {p90 && <span className="block text-[11.5px] font-normal text-muted tabular-nums">{p90}</span>}
    </>
  );
}

/** A small figure: label over the value (median, p90 under it); the interval under the cost per accepted slice. */
function Fig({ f, under }: { f: Figure; under?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-muted">{f.label}</dt>
      <dd className="text-[14px] font-semibold break-words [overflow-wrap:anywhere]">
        <Stacked v={f.value} />
        {under && under !== UNAVAILABLE && <span className="block text-[11px] font-normal text-muted tabular-nums">{under}</span>}
      </dd>
    </div>
  );
}

/** Phone: a row shows four key figures; its chevron opens the other five. */
function RowCard({ r }: { r: LabSummaryRow }) {
  const [open, setOpen] = useState(false);
  const { key, rest, interval } = splitFigures(r);
  const title = rowTitle(r);
  return (
    <li className="px-4 py-1.5" data-lab-row="">
      <div className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold">
        <span dir="auto" className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
          {title}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Fewer figures, ${title}` : `More figures, ${title}`}
          onClick={() => setOpen((o) => !o)}
          className="press -mr-2.5 flex size-11 shrink-0 items-center justify-center rounded-full text-muted"
        >
          {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
      </div>
      <dl className="grid grid-cols-4 gap-x-2 pb-1.5">
        {key.map((f) => (
          <Fig key={f.key} f={f} under={f.key === 'cpa' ? interval.value : undefined} />
        ))}
      </dl>
      {open && (
        <dl className="grid grid-cols-3 gap-x-2 gap-y-2 border-t border-line pt-2 pb-2" data-lab-more="">
          {rest.map((f) => (
            <Fig key={f.key} f={f} />
          ))}
        </dl>
      )}
    </li>
  );
}

/** Desktop: one table, the period said once above its rows; the interval under the cost per accepted slice. */
function RowsTable({ groups }: { groups: ReturnType<typeof groupByPeriod> }) {
  const first = splitFigures(groups[0]!.rows[0]!);
  const head = [...first.key, ...first.rest].map((f) => f.label);
  const order = (r: LabSummaryRow) => {
    const s = splitFigures(r);
    return { all: [...s.key, ...s.rest], interval: s.interval };
  };
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-line text-left text-[11.5px] text-muted">
          <th className="px-4 py-2 font-normal">Role</th>
          {head.map((h) => (
            <th key={h} className="px-2 py-2 text-right font-normal">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.period} className="divide-y divide-line">
          <tr>
            <th colSpan={head.length + 1} className="bg-surface-2/60 px-4 py-1 text-left text-[11.5px] font-normal text-muted tabular-nums">
              {g.period}
            </th>
          </tr>
          {g.rows.map((r) => {
            const { all, interval } = order(r);
            return (
              <tr key={`${r.period}|${r.role}|${r.model ?? ''}`} data-lab-row="">
                <td className="min-w-[9.5rem] px-4 py-2">
                  <span dir="auto" className="block font-semibold [overflow-wrap:anywhere]">
                    {rowTitle(r)}
                  </span>
                </td>
                {all.map((f) => (
                  <td key={f.key} className="whitespace-nowrap px-2 py-2 text-right">
                    <Stacked v={f.value} />
                    {f.key === 'cpa' && interval.value !== UNAVAILABLE && <span className="block text-[11px] text-muted tabular-nums">{interval.value}</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

function Summary({ data, loading }: { data: LabSummary; loading: boolean }) {
  const groups = groupByPeriod(data.rows);
  return (
    <Card className={`transition-opacity motion-reduce:transition-none ${loading ? 'opacity-70' : ''}`}>
      {groups.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted">No slices</p>
      ) : (
        <>
          <div className="lg:hidden [&>section:first-child>h3]:rounded-t-[23px]">
            {groups.map((g) => (
              <section key={g.period}>
                <h3 className="border-b border-line bg-surface-2/60 px-4 py-1 text-[11.5px] font-normal text-muted tabular-nums">{g.period}</h3>
                <ul className="divide-y divide-line">
                  {g.rows.map((r) => (
                    <RowCard key={`${r.period}|${r.role}|${r.model ?? ''}`} r={r} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="hidden lg:block">
            <RowsTable groups={groups} />
          </div>
        </>
      )}
    </Card>
  );
}

function Experiments({ list }: { list: LabExperimentView[] }) {
  if (list.length === 0) return <p className="py-3 text-[13px] text-muted">None</p>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {list.map((v) => (
          <li key={v.experiment.id} className="px-4 py-3" data-lab-experiment="">
            <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
              <span dir="auto" className="min-w-0 break-words [overflow-wrap:anywhere]">
                {v.experiment.name}
              </span>
              <span className="ml-auto shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-normal text-muted">{v.experiment.status}</span>
            </p>
            <table className="mt-1.5 w-full text-[13px]">
              <thead>
                <tr className="text-[11px] text-muted">
                  <th className="py-0.5 text-left font-normal">Arm</th>
                  <th className="w-10 py-0.5 text-right font-normal">n</th>
                  <th className="w-12 py-0.5 text-right font-normal">acc</th>
                  <th className="w-[38%] py-0.5 text-right font-normal">$ / acc</th>
                </tr>
              </thead>
              <tbody>
                {v.arms.map((a) => (
                  <tr key={a.arm} className="align-top">
                    <td dir="auto" className="py-1 font-semibold break-words [overflow-wrap:anywhere]">
                      {a.arm}
                    </td>
                    <td className="py-1 text-right tabular-nums">{a.n}</td>
                    <td className="py-1 text-right tabular-nums">{a.accepted}</td>
                    <td className="py-1 text-right">
                      <Value v={a.costPerAccepted === null ? UNAVAILABLE : formatCost(a.costPerAccepted)} />
                      <span className="block text-[11px] text-muted tabular-nums">{fmtInterval(a.costPerAcceptedInterval)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {v.excluded > 0 && <p className="mt-1 text-[11.5px] text-muted">{v.excluded} excluded</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Usage → Lab (docs/prd/claude-usage.md §28.11): the slice economy per day or week and per role and model, and the experiments with each
 * arm's n and the primary (median cost per accepted slice) with its 90 percent interval. Read only; every figure's source is in a tip.
 * T-1852 text diet: the period said once per group, four key figures per phone row (the rest behind the row), the interval under its cost.
 */
export function LabTab() {
  const [period, setPeriod] = useState<LabPeriod>('day');
  const summary = useLoad(() => labApi.summary(period), period);
  const experiments = useLoad(() => labApi.experiments(), 'experiments');
  return (
    <>
      <PageHeader title="Lab" />
      <div className="mb-4 flex items-center sm:w-[260px]">
        <div className="min-w-0 flex-1">
          <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
        </div>
        {summary.data && <Sources basis={summary.data.basis} />}
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
        <InfoTip label="About experiments">Each arm: n slices, acc accepted slices, $ / acc the median cost per accepted slice (its rework counted) with its 90 percent interval under it (bootstrap, from 20 accepted slices).</InfoTip>
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
