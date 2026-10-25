import { LoadError, RowsSkeleton } from '@isnanme/ui';
import type {
  MetricsFlow,
  MetricsInsights,
  MetricsOverview,
  MetricsProgram,
  MetricsStage,
  MetricsTickets,
  MetricsTrend,
  MetricsWindow,
} from '@portal/contracts';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BarList, ColumnChart, Histogram, LineChart, ScoreTile, StageBars, type BarRow } from '@/components/charts';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { NotAvailable } from '../usage/spend/shared';
import {
  STAGE_INFO,
  STEP_STAGES,
  TOTAL_STAGES,
  UNAVAILABLE,
  closureColumns,
  drillRows,
  drillTitle,
  fmtRatio,
  formatSpan,
  insightRows,
  leadRows,
  leadTimeSpread,
  paceView,
  scoreView,
  stageRows,
  summaryStats,
  ticketHref,
  trendView,
  type DrillTarget,
  type ScoreView,
} from './metricsModel';

/** What `useLoad` hands a card. */
export interface Load<T> {
  data: T | null;
  failed: boolean;
  forbidden: boolean;
  loading: boolean;
  reload: () => Promise<void> | void;
}

/** A card: a one or two word title, an InfoTip for the explanation, the body. */
export function MetricCard({
  title,
  tip,
  tipLabel,
  children,
  id,
}: {
  title: string;
  tip?: ReactNode;
  tipLabel?: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <Card>
      <section aria-label={title} data-metric-card={id} className="px-4 pt-3 pb-2">
        <h3 className="flex items-center gap-1 text-[14px] font-semibold">
          {title}
          {tip && <InfoTip label={tipLabel ?? `About ${title.toLowerCase()}`}>{tip}</InfoTip>}
        </h3>
        <div className="mt-1">{children}</div>
      </section>
    </Card>
  );
}

/** A read that came back without figures because the closed tickets could not be read: the reason in words, never 0 or "no ticket". */
export function UnavailableNote({ text }: { text: string }) {
  return (
    <p className="py-2 text-[13px] break-words text-muted [overflow-wrap:anywhere]" data-metric-unavailable="">
      {UNAVAILABLE}: {text}
    </p>
  );
}

/** One read's states: refused, failed (with another try), on its way (rows in the shape of the card), or its content. */
export function Slot<T>({
  load,
  label,
  rows = 2,
  children,
}: {
  load: Load<T>;
  label: string;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (load.forbidden) return <NotAvailable />;
  if (load.failed) return <LoadError onRetry={() => void load.reload()} />;
  if (!load.data) return <RowsSkeleton rows={rows} lines={2} label={label} />;
  return <>{children(load.data)}</>;
}

const SEVERITY_ICON = { act: OctagonAlert, warn: AlertTriangle, info: Info } as const;
const SEVERITY_TONE = { act: 'text-red-600 dark:text-red-400', warn: 'text-amber-600 dark:text-amber-400', info: 'text-muted' } as const;

const round = (v: number) => String(Math.round(v));

function ScoreCell({ view, tipLabel }: { view: ScoreView; tipLabel: string }) {
  return (
    <div className="relative min-w-0" data-metric-score={view.label.toLowerCase()}>
      <ScoreTile label={view.label} score={view.value} previous={view.previous} reason={view.reason} format={round} />
      {view.components.length > 0 && (
        <span className="absolute top-0 right-0 -mt-1.5 -mr-1.5">
          <InfoTip label={tipLabel}>
            <span className="mb-1 block">{view.basis}</span>
            {view.components.map((c) => (
              <span key={c.id} className="mb-1.5 block" data-metric-component={c.id}>
                <b>{c.label}</b>: {c.value}. Weight {c.weight}. {c.basis}. {c.raw}. Source: {c.source}.
              </span>
            ))}
          </InfoTip>
        </span>
      )}
    </div>
  );
}

/** Efficiency and effectiveness as gauges with the change since the window before; under them the counts of the window. */
export function ScoresCard({
  overview,
  program,
  loading,
}: {
  overview: MetricsOverview;
  program: MetricsProgram | undefined;
  loading: boolean;
}) {
  const eff = scoreView('Efficiency', overview.efficiency, program);
  const eft = scoreView('Effectiveness', overview.effectiveness, program);
  const stats = summaryStats(overview);
  return (
    <Card
      className={
        loading ? 'opacity-70 transition-opacity motion-reduce:transition-none' : 'transition-opacity motion-reduce:transition-none'
      }
    >
      <section aria-label="Scores" data-metric-card="scores" className="px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          <ScoreCell view={eff} tipLabel="About efficiency" />
          <ScoreCell view={eft} tipLabel="About effectiveness" />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-x-2 gap-y-2 border-t border-line pt-3" data-metric-stats="">
          {stats.map((s) => (
            <div key={s.key} className="min-w-0" data-metric-stat={s.key}>
              <dt className="truncate text-[11px] text-muted">{s.label}</dt>
              <dd className="text-[16px] font-semibold tabular-nums">{s.value}</dd>
              {s.sub && <dd className="truncate text-[11px] text-muted tabular-nums">{s.sub}</dd>}
            </div>
          ))}
        </dl>
        {overview.flowUnavailable && <UnavailableNote text={overview.flowUnavailable.text} />}
      </section>
    </Card>
  );
}

/** Unavailable program (memor.id: no tickets in the portal): one card that says so and why. */
export function ProgramUnavailable({ program }: { program: MetricsProgram }) {
  return (
    <Card>
      <section aria-label={`${program.label} unavailable`} data-metric-card="unavailable" className="px-4 py-4">
        <p className="text-[14px] font-semibold">
          {program.label}: {UNAVAILABLE}
        </p>
        <p className="mt-1 text-[13px] break-words text-muted [overflow-wrap:anywhere]">
          {program.unavailable?.text ?? 'The portal has no figures for this program.'}
        </p>
      </section>
    </Card>
  );
}

export function TrendCard({ eff, effv, window }: { eff: Load<MetricsTrend>; effv: Load<MetricsTrend>; window: MetricsWindow }) {
  const failed = eff.failed && effv.failed;
  const forbidden = eff.forbidden || effv.forbidden;
  const t = eff.data ?? effv.data;
  const view = trendView(eff.data, effv.data);
  return (
    <MetricCard
      id="trend"
      title="Scores over time"
      tip={
        t
          ? `${t.source} A snapshot every ${formatSpan(t.everyMs)}, kept ${formatSpan(t.keepMs)}; each point scores the 24 hours before it, so in the 7d view the tiles (7 days) differ from the line. A gap is a time with no reading, never a zero.`
          : 'Read from the portal’s snapshots.'
      }
    >
      {forbidden ? (
        <NotAvailable />
      ) : failed ? (
        <LoadError onRetry={() => void Promise.all([eff.reload(), effv.reload()])} />
      ) : !t ? (
        <RowsSkeleton rows={2} lines={2} label="Loading the trend" />
      ) : (
        <LineChart
          series={view.series}
          format={round}
          ariaLabel={`Efficiency and effectiveness over the last ${window}`}
          empty="No snapshot yet"
          dim={eff.loading || effv.loading}
        />
      )}
    </MetricCard>
  );
}

export function ClosuresCard({ load, window }: { load: Load<MetricsTickets>; window: MetricsWindow }) {
  const per = window === '24h' ? 'hour' : 'day';
  return (
    <MetricCard
      id="closed"
      title="Closed"
      tip={`Tickets closed done per ${per} over the last ${window}, the last column the newest. Won't do is not counted.`}
    >
      <Slot load={load} label="Loading closures">
        {(d) => {
          if (d.unavailable) return <UnavailableNote text={d.unavailable.text} />;
          const c = closureColumns(d, window);
          return (
            <>
              <ColumnChart
                columns={c.columns}
                format={round}
                ariaLabel={`Tickets done per ${c.per}`}
                empty="Nothing closed"
                dim={load.loading}
              />
              <p className="px-1 pt-1 text-[11.5px] text-muted tabular-nums">
                {c.done} done in {window}, a column per {c.per}
                {c.missing > 0 && ` · newest ${d.rows.length} of ${d.total} closed read, older columns may be short`}
              </p>
            </>
          );
        }}
      </Slot>
    </MetricCard>
  );
}

export function StagesCard({
  load,
  onPick,
  picked,
}: {
  load: Load<MetricsFlow>;
  onPick: (t: DrillTarget) => void;
  picked: DrillTarget | null;
}) {
  const sel = (stages: MetricsStage[]) => (picked && !picked.group && picked.stage && stages.includes(picked.stage) ? picked.stage : null);
  return (
    <MetricCard
      id="stages"
      title="Flow time"
      tip={
        <>
          {[...STEP_STAGES, ...TOTAL_STAGES].map((s) => (
            <span key={s} className="mb-1 block">
              <b>{STAGE_INFO[s].label}</b>: {STAGE_INFO[s].tip}
            </span>
          ))}
          <span className="block">
            Bar: median. Whisker: p90. n tickets had both ends recorded; excluded did not and are left out, never counted as 0. Tap a row
            for its tickets.
          </span>
        </>
      }
    >
      <Slot load={load} label="Loading the stages" rows={4}>
        {(f) =>
          f.total === null ? (
            <UnavailableNote text={f.unavailable?.text ?? 'The flow figures could not be read.'} />
          ) : (
          <div
            className={
              load.loading
                ? 'opacity-70 transition-opacity motion-reduce:transition-none'
                : 'transition-opacity motion-reduce:transition-none'
            }
          >
            <StageBars
              rows={stageRows(f.total, STEP_STAGES)}
              format={formatSpan}
              ariaLabel="Time in each stage"
              onSelect={(k) => onPick({ stage: k as MetricsStage, group: null })}
              selected={sel(STEP_STAGES)}
            />
            <div className="mt-2 border-t border-line pt-1">
              <StageBars
                rows={stageRows(f.total, TOTAL_STAGES)}
                format={formatSpan}
                ariaLabel="Total time"
                onSelect={(k) => onPick({ stage: k as MetricsStage, group: null })}
                selected={sel(TOTAL_STAGES)}
              />
            </div>
          </div>
          )
        }
      </Slot>
    </MetricCard>
  );
}

export function LeadTimeCard({ load }: { load: Load<MetricsTickets> }) {
  return (
    <MetricCard
      id="leadtime"
      title="Lead time"
      tip="How long the done tickets of the window took from created to done, in ten equal bins from 0. The dashed line is the median. The axis stops at 3 times the p90 so one outlier does not flatten the rest."
    >
      <Slot load={load} label="Loading lead times">
        {(d) => {
          if (d.unavailable) return <UnavailableNote text={d.unavailable.text} />;
          const s = leadTimeSpread(d);
          return (
            <>
              <Histogram
                edges={s.edges}
                counts={s.counts}
                median={s.median}
                format={formatSpan}
                ariaLabel="Created to done"
                empty="No ticket was done"
                dim={load.loading}
              />
              <p className="px-1 pt-1 text-[11.5px] break-words text-muted tabular-nums [overflow-wrap:anywhere]">
                n {s.n}
                {s.beyond > 0 && ` · ${s.beyond} longer than the last bin`}
                {s.missing > 0 && ` · newest ${d.rows.length} of ${d.total} closed read`}
              </p>
            </>
          );
        }}
      </Slot>
    </MetricCard>
  );
}

export function LeadsCard({
  load,
  onPick,
  picked,
}: {
  load: Load<MetricsFlow>;
  onPick: (t: DrillTarget) => void;
  picked: DrillTarget | null;
}) {
  return (
    <MetricCard
      id="leads"
      title="Leads"
      tip="Created to done per lead (the ticket’s first area tag, else the session that held it), median and p90 over the tickets done in the window. Tap a lead for its tickets."
    >
      <Slot load={load} label="Loading the leads" rows={3}>
        {(f) => {
          if (f.total === null) return <UnavailableNote text={f.unavailable?.text ?? 'The flow figures could not be read.'} />;
          const { rows, hidden } = leadRows(f);
          return (
            <>
              <StageBars
                rows={rows}
                format={formatSpan}
                ariaLabel="Created to done per lead"
                onSelect={(k) => onPick({ stage: 'resolve', group: k })}
                selected={picked?.group ?? null}
                empty="No lead closed a ticket in this window"
              />
              {hidden > 0 && <p className="px-1 text-[11.5px] text-muted">+{hidden} more leads</p>}
            </>
          );
        }}
      </Slot>
    </MetricCard>
  );
}

export function AccountPaceCard({ overview }: { overview: Load<MetricsOverview> }) {
  return (
    <MetricCard
      id="pace"
      title="Account pace"
      tip="Each Claude’s use of its 5-hour quota window against an even spend: 1 : 1 spends it exactly by the reset. Under 0.9 leaves quota unused, over 1.1 runs out early. Right now, so it does not follow the window."
    >
      <Slot load={overview} label="Loading the pace">
        {(o) => {
          const v = paceView(o);
          const rows: BarRow[] = v.rows.map((r) => ({ key: r.key, label: r.label, sub: `${r.sub} · ${r.state}`, value: r.ratio }));
          return v.note ? (
            <p className="py-2 text-[13px] break-words text-muted [overflow-wrap:anywhere]">{v.note}</p>
          ) : (
            <BarList rows={rows} format={fmtRatio} />
          );
        }}
      </Slot>
    </MetricCard>
  );
}

export function InsightsCard({ load }: { load: Load<MetricsInsights> }) {
  return (
    <MetricCard
      id="insights"
      title="Findings"
      tip="Plain-language reads of the window: the slowest stage, regressions against the window before, idle capacity, blocked share, review wait, outliers. Act first, then look, then note."
    >
      <Slot load={load} label="Loading findings">
        {(i) => {
          const rows = insightRows(i);
          if (!rows.length) return <p className="py-2 text-[13px] text-muted">No findings</p>;
          return (
            <ul className="divide-y divide-line">
              {rows.map((r) => {
                const Icon = SEVERITY_ICON[r.severity];
                return (
                  <li key={r.key} className="flex gap-3 py-2.5" data-metric-insight={r.severity}>
                    <span className={`mt-0.5 flex shrink-0 items-center ${SEVERITY_TONE[r.severity]}`}>
                      <Icon size={16} aria-hidden="true" />
                      <span className="sr-only">{r.word}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] break-words [overflow-wrap:anywhere]">{r.text}</p>
                      {r.tickets.length > 0 && (
                        <p className="mt-0.5 flex flex-wrap gap-x-1">
                          {r.tickets.map((t) => (
                            <Link
                              key={t}
                              to={ticketHref(t)}
                              className="press inline-flex min-h-11 items-center px-1 text-[12.5px] font-medium text-accent hover:underline"
                            >
                              {t}
                            </Link>
                          ))}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </Slot>
    </MetricCard>
  );
}

/** The tickets behind a number: a link each to its page with the duration of the stage, the slowest first. */
export function DrillList({ load, target, window }: { load: Load<MetricsTickets>; target: DrillTarget; window: MetricsWindow }) {
  return (
    <Slot load={load} label="Loading tickets" rows={4}>
      {(d) => {
        if (d.unavailable || d.total === null) return <UnavailableNote text={d.unavailable?.text ?? 'The tickets could not be read.'} />;
        const rows = drillRows(d, target.stage);
        const which = target.stage ? STAGE_INFO[target.stage].label : STAGE_INFO.resolve.label;
        if (!rows.length) return <p className="py-3 text-[13px] text-muted">No ticket was done in the last {window}</p>;
        return (
          <>
            <p className="pb-1 text-[11.5px] text-muted tabular-nums">
              {rows.length}
              {d.total > rows.length ? ` of ${d.total}` : ''} tickets, {which.toLowerCase()} time, slowest first
            </p>
            <ul aria-label={drillTitle(target)} className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.ticket}>
                  <Link
                    to={r.href}
                    className="press -mx-2 flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold">{r.ticket}</span>
                      <span dir="auto" className="block truncate text-[11.5px] text-muted">
                        {r.meta}
                      </span>
                    </span>
                    <span className={`shrink-0 text-[13.5px] tabular-nums ${r.durationMs === null ? 'text-muted' : 'text-ink-soft'}`}>
                      {r.duration}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        );
      }}
    </Slot>
  );
}
