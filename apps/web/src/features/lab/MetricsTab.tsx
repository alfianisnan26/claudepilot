import { Dialog, LoadError, RowsSkeleton, Segmented, Select } from '@isnanme/ui';
import type { MetricsProgram, MetricsWindow } from '@portal/contracts';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { NotAvailable } from '../usage/spend/shared';
import { useLoad } from '../usage/spend/useLoad';
import { metricsApi } from './api';
import { drillTitle, pickProgram, programOptions, WINDOW_OPTIONS, type DrillTarget } from './metricsModel';
import {
  AccountPaceCard,
  ClosuresCard,
  DrillList,
  InsightsCard,
  LeadsCard,
  LeadTimeCard,
  ProgramUnavailable,
  ScoresCard,
  Slot,
  StagesCard,
  TrendCard,
} from './metricsParts';

/** More programs than fit one row of segments (a `program-*` tag adds one by itself): a select instead. */
const SEGMENT_MAX = 4;

/** The tickets behind a stage or a lead, in the kit's dialog (a bottom sheet on a phone; its header is not a drag handle, lib/sheetDrag.ts). */
function DrillSheet({ program, window, target, open, onClose }: { program: string; window: MetricsWindow; target: DrillTarget; open: boolean; onClose: () => void }) {
  const load = useLoad(() => metricsApi.tickets(program, window, { stage: target.stage, groupBy: target.group ? 'lead' : null, group: target.group }), `drill|${program}|${window}|${target.stage}|${target.group}`, { live: false });
  return (
    <Dialog open={open} onClose={onClose} size="md" title={drillTitle(target)} description={`Done in the last ${window}`}>
      <div data-metric-drill="">
        <DrillList load={load} target={target} window={window} />
      </div>
    </Dialog>
  );
}

/** The body for one program and window: six reads, each with its own loading and failure, so one slow or failing read leaves the rest. */
function MetricsBody({ programId, window, programs }: { programId: string; window: MetricsWindow; programs: MetricsProgram[] }) {
  const program = programs.find((p) => p.id === programId);
  const key = `${programId}|${window}`;
  const quiet = { live: false } as const;
  const overview = useLoad(() => metricsApi.overview(programId, window), `overview|${key}`, quiet);
  const flow = useLoad(() => metricsApi.flow(programId, window, 'lead'), `flow|${key}`, quiet);
  const tickets = useLoad(() => metricsApi.tickets(programId, window), `tickets|${key}`, quiet);
  const eff = useLoad(() => metricsApi.trend(programId, 'efficiency', window), `trend-eff|${key}`, quiet);
  const eft = useLoad(() => metricsApi.trend(programId, 'effectiveness', window), `trend-eft|${key}`, quiet);
  const insights = useLoad(() => metricsApi.insights(programId, window), `insights|${key}`, quiet);
  const [drill, setDrill] = useState<{ target: DrillTarget; open: boolean } | null>(null);
  const pick = (target: DrillTarget) => setDrill({ target, open: true });
  const picked = drill?.open ? drill.target : null;

  return (
    <div className="space-y-3" data-metrics-body={programId}>
      <Slot load={overview} label="Loading the scores" rows={3}>
        {(o) => <ScoresCard overview={o} program={program} loading={overview.loading} />}
      </Slot>
      <TrendCard eff={eff} effv={eft} window={window} />
      <div className="grid gap-3 lg:grid-cols-2">
        <ClosuresCard load={tickets} window={window} />
        <LeadTimeCard load={tickets} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <StagesCard load={flow} onPick={pick} picked={picked} />
        <div className="space-y-3">
          <LeadsCard load={flow} onPick={pick} picked={picked} />
          <AccountPaceCard overview={overview} />
        </div>
      </div>
      <InsightsCard load={insights} />
      {drill && <DrillSheet key={`${drill.target.stage}|${drill.target.group}`} program={programId} window={window} target={drill.target} open={drill.open} onClose={() => setDrill((d) => (d ? { ...d, open: false } : d))} />}
    </div>
  );
}

/**
 * Usage → Metrics (T-2360, docs/prd/claude-usage.md §28.15): how fast tickets move and how well the crew works, for one program or all of
 * them, over 24 hours or 7 days. Two scores with the change since the window before, their trend, tickets closed per hour or day, the time
 * in each stage and per lead (a tap lists the tickets behind it), the spread of lead times, each Claude's quota pace and the findings.
 * Read only; every number's basis is in a tip, a missing one says "unavailable" with its reason. Each chart has a Table toggle.
 */
export function MetricsTab() {
  const [program, setProgram] = useState<string | null>(null);
  const [window, setWindow] = useState<MetricsWindow>('24h');
  const [tick, setTick] = useState(0);
  const programs = useLoad(() => metricsApi.programs(), 'programs', { live: false });
  const options = programs.data ? programOptions(programs.data) : [];
  const id = programs.data ? pickProgram(programs.data, program) : null;
  return (
    <>
      <PageHeader title="Metrics" />
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center sm:flex-1">
          <div className="min-w-0 flex-1">
            {id && options.length <= SEGMENT_MAX ? (
              <Segmented label="Program" value={id} options={options} onChange={setProgram} />
            ) : id ? (
              <Select label="Program" value={id} onChange={setProgram} options={options} />
            ) : (
              <div className="skeleton h-11 w-full rounded-full" aria-hidden="true" />
            )}
          </div>
        </div>
        <div className="flex items-center sm:w-[220px]">
          <div className="min-w-0 flex-1">
            <Segmented label="Window" value={window} options={WINDOW_OPTIONS} onChange={setWindow} />
          </div>
          <InfoTip label="About the window">Each number covers the last 24 hours or 7 days and is compared with the window before it, the same length. Scores are 0 to 100.</InfoTip>
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => setTick((t) => t + 1)}
            className="press flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {programs.forbidden ? (
        <NotAvailable />
      ) : programs.failed ? (
        <LoadError onRetry={programs.reload} />
      ) : !programs.data || !id ? (
        <RowsSkeleton rows={3} lines={3} label="Loading the metrics" />
      ) : programs.data.find((p) => p.id === id)?.unavailable ? (
        <ProgramUnavailable program={programs.data.find((p) => p.id === id)!} />
      ) : (
        <MetricsBody key={`${id}|${window}|${tick}`} programId={id} window={window} programs={programs.data} />
      )}
    </>
  );
}
