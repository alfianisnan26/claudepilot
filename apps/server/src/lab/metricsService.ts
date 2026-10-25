// Pilot metrics (T-2360, docs/prd/claude-usage.md §28.15): puts the pure parts together for the routes, the snapshot timer and (later) the
// Portal MCP tools. Reads go through the loaders (bounded to the window and the one before it); the T-450 / T-600 numbers come from the
// scorecard's own functions (`loadCrewFacts`, `programScore`, `buildHeadline`, usage spend's `ticketReport` behind them), never a copy.

import {
  METRICS_WINDOW_MS,
  type CrewFigure,
  type MetricsFlow,
  type MetricsGroupBy,
  type MetricsInsights,
  type MetricsOverview,
  type MetricsProgram,
  type MetricsStage,
  type MetricsTickets,
  type MetricsTrend,
  type MetricsTrendKey,
  type MetricsTrendWindow,
  type MetricsWindow,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import { SpendStore } from '../usagespend/store.js';
import { flowProgramsRaw, flowThresholds, type FlowSettingsReader } from '../flow/settings.js';
import { parsePrograms } from '../flow/programs.js';
import { buildHeadline, type PaceClaude } from './headline.js';
import { programScore, programsOf, programTickets, type CrewFacts, type Program } from './scorecard.js';
import { loadCrewFacts } from './scorecardData.js';
import {
  DEFAULT_METRICS_PROGRAMS,
  efficiencyScore,
  effectivenessScore,
  groupFlow,
  groupKeysOf,
  inProgram,
  insights,
  openWork,
  resolvePrograms,
  snapshotValues,
  downsample,
  ticketFlow,
  ticketRows,
  type CrewNow,
  type FlowRow,
  type OpenTicketFacts,
} from './flowMetrics.js';
import { loadFlowTickets, loadOpenTickets, loadProgramTags } from './flowMetricsData.js';
import { KEEP_SNAPSHOTS_MS, readTrend, snapshotNear, SNAPSHOT_EVERY_MS, writeSnapshots } from './metricsSnapshots.js';
import { METRICS_SETTING } from './metricsSettings.js';

const HOUR = 3_600_000;
const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review']);
const LIVE = new Set(['starting', 'idle', 'working', 'waiting', 'interrupted']);
/** The trend has at most about this many points. */
export const TREND_POINTS = 200;
/** The drill-down returns at most this many rows. */
export const TICKET_ROWS = 200;

export const METRICS_BASIS: Record<string, string> = {
  stages:
    'ticket_events (status moves into in_progress, the first comment by an agent session, QA and review verdicts, self-test lines) and ticket_merge_status (merged) of the tickets closed in the window; a ticket that lacks a stage’s timestamps is left out of it (excluded), never 0',
  percentile: 'nearest rank (scorecard.ts percentile), median and 90th percentile',
  wontDo: 'closed won’t-do: counted apart, never in a stage',
  programs: 'tickets carrying one of the program’s tags (setting lab.metricsPrograms; program-* tags and flow.programs added); all: every ticket',
  lead: 'the ticket’s first area-* tag, else the lineage root of the session that held it (assignee, or who moved it into in_progress)',
  crew: 'the crews (lead tracks) holding the program’s tickets: the crew scorecard’s headline (T-600) and cost (T-450) over them',
  previous: 'the score in the snapshot nearest to one window ago (snapshots every 10 min, kept 30 days)',
};

export interface MetricsDeps {
  store: Store;
  now: () => number;
  settings: FlowSettingsReader | null;
  /** claudeusage's snapshot of the Claudes' plan windows; null or failing: quota is unavailable. */
  paces: (() => Promise<readonly PaceClaude[] | null>) | null;
  log?: (msg: string) => void;
}

/** The facts read once for one answer. */
interface Loaded {
  nowMs: number;
  rows: FlowRow[] | null;
  open: OpenTicketFacts[] | null;
}

const tryRead = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export class Metrics {
  constructor(private readonly deps: MetricsDeps) {}

  #setting(key: string): unknown {
    try {
      return this.deps.settings?.get(key);
    } catch {
      return undefined;
    }
  }

  /** Every program, `all` first. */
  programs(): MetricsProgram[] {
    const db = this.deps.store.db;
    const flow = parsePrograms(flowProgramsRaw(this.deps.settings)).map((p) => ({ name: p.name, tag: p.tag }));
    // No settings module, or a value that is not text: the setting's default (as flowProgramsRaw does for flow.programs).
    const raw = this.#setting(METRICS_SETTING.programs);
    return resolvePrograms({ setting: typeof raw === 'string' ? raw : DEFAULT_METRICS_PROGRAMS, programTags: (db && tryRead(() => loadProgramTags(db))) || [], flow });
  }

  program(id: string | undefined): MetricsProgram | null {
    return this.programs().find((p) => p.id === (id ?? 'all')) ?? null;
  }

  #load(windowMs: number): Loaded {
    const nowMs = this.deps.now();
    const db = this.deps.store.db;
    if (!db) return { nowMs, rows: null, open: null };
    const spend = new SpendStore(this.deps.store);
    // At least two days back: effectiveness reads the last 24 h whatever the window.
    const from = nowMs - Math.max(2 * windowMs, 48 * HOUR);
    const facts = tryRead(() => loadFlowTickets(db, from, nowMs + 1, (ids) => spend.sessions(ids)));
    return { nowMs, rows: facts ? facts.map(ticketFlow) : null, open: tryRead(() => loadOpenTickets(db)) };
  }

  #rowsOf(l: Loaded, p: MetricsProgram): FlowRow[] | null {
    if (p.kind === 'commits') return [];
    return l.rows ? l.rows.filter((r) => inProgram(r.tags, p)) : null;
  }

  #openOf(l: Loaded, p: MetricsProgram) {
    if (!l.open) return null;
    return openWork(
      l.open.filter((t) => inProgram(t.tags, p)),
      l.nowMs,
      flowThresholds(this.deps.settings).stallMs,
    );
  }

  async #paces(): Promise<readonly PaceClaude[] | null> {
    if (!this.deps.paces) return null;
    try {
      return await this.deps.paces();
    } catch (e) {
      this.deps.log?.(`metrics: pace source failed (${e instanceof Error ? e.name : 'error'})`);
      return null;
    }
  }

  /** The crews holding the program's tickets (for `all`, every crew), with a session live now. */
  #crews(facts: CrewFacts, p: MetricsProgram): Program[] {
    const crews = [...programsOf(facts.sessions, facts.extra).values()];
    if (p.kind === 'commits') return [];
    const tickets = (facts.tickets ?? []).filter((t) => inProgram(t.tags, p));
    return crews.filter((c) => p.kind === 'all' || programTickets(c, tickets, facts.sessions).length > 0);
  }

  #crewNow(facts: CrewFacts, crews: readonly Program[], p: MetricsProgram): CrewNow[] {
    const open = (facts.tickets ?? []).filter((t) => OPEN.has(t.status) && inProgram(t.tags, p));
    return crews
      .map((c) => {
        const leadId = c.leads.at(-1) ?? c.id;
        const lead = facts.sessions.get(leadId);
        const leads = new Set(c.leads);
        const workers = [...c.members]
          .filter((m) => !leads.has(m))
          .map((m) => ({ id: m, state: facts.sessions.get(m)?.state ?? 'ended', stateSinceMs: facts.extra.get(m)?.stateSinceMs ?? null }));
        return { lead: lead ? { id: leadId, state: lead.state ?? 'ended', claudeId: lead.claudeId || null } : null, workers, openWork: programTickets(c, open, facts.sessions).length > 0 };
      })
      .filter((c) => (c.lead && LIVE.has(c.lead.state)) || c.workers.some((w) => LIVE.has(w.state)));
  }

  #previous(program: string, nowMs: number, windowMs: number): { efficiency: number | null; effectiveness: number | null } {
    const db = this.deps.store.db;
    const s = db ? tryRead(() => snapshotNear(db, program, nowMs - windowMs, Math.max(SNAPSHOT_EVERY_MS * 3, windowMs / 24))) : null;
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    return { efficiency: n(s?.values.efficiency), effectiveness: n(s?.values.effectiveness) };
  }

  /** Both scores of one program now, with the facts behind them. */
  #scores(l: Loaded, p: MetricsProgram, facts: CrewFacts | null, paces: readonly PaceClaude[] | null, windowMs: number) {
    const prev = this.#previous(p.id, l.nowMs, windowMs);
    const crews = facts ? this.#crews(facts, p) : null;
    const exhausted = paces ? new Set(paces.filter((c) => c.windows.some((w) => typeof w.usedPct === 'number' && w.usedPct >= 100)).map((c) => c.claudeId)) : null;
    const efficiency = efficiencyScore({ nowMs: l.nowMs, crews: facts && crews ? this.#crewNow(facts, crews, p) : null, exhausted, previous: prev.efficiency });
    const rows = this.#rowsOf(l, p);
    const open = p.kind === 'commits' ? null : this.#openOf(l, p);
    const effectiveness = effectivenessScore({ nowMs: l.nowMs, rows: p.kind === 'commits' ? null : rows, open, targets: p.targets, previous: prev.effectiveness });
    return { efficiency, effectiveness, rows, open, crews };
  }

  /** The overview of one program; null when the program is not there. */
  async overview(programId: string | undefined, window: MetricsWindow): Promise<MetricsOverview | null> {
    const p = this.program(programId);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    const facts = tryRead(() => loadCrewFacts(this.deps.store, l.nowMs, l.nowMs - 2 * windowMs));
    const paces = await this.#paces();
    const s = this.#scores(l, p, facts, paces, windowMs);
    const flow = groupFlow(s.rows ?? [], l.nowMs, windowMs, null, []).total;
    let crew: MetricsOverview['crew'] = null;
    if (facts && s.crews) {
      const headline = buildHeadline({ programs: s.crews, facts, windowMs, compare: true, paces });
      const costs = s.crews.map((c) => programScore(c, facts, windowMs, false).current.cost);
      const sum = (k: 'total' | 'lead' | 'workers') => {
        const vals = costs.map((c) => c[k]).filter((f) => f.value !== null);
        return vals.length ? vals.reduce((a, f) => a + f.value!, 0) : null;
      };
      const src = 'chat_usage.cost_usd of the crews in the window (crew scorecard cost, T-450), summed';
      const fig = (v: number | null, source = src): CrewFigure => (v === null ? { value: null, basis: 'unavailable', source, reason: 'no_samples' } : { value: Math.round(v * 100) / 100, basis: 'estimate', source });
      const total = sum('total');
      const lead = sum('lead');
      const done = flow.current.done;
      crew = {
        programs: s.crews.map((c) => c.id),
        headline,
        cost: {
          total: fig(total),
          lead: fig(lead),
          workers: fig(sum('workers')),
          leadShare: fig(total && lead !== null ? (100 * lead) / total : null, 'the crews’ lead dollars / all their dollars, percent'),
          perDone: fig(total !== null && done > 0 ? total / done : null, 'the crews’ dollars / the program’s tickets done in the window'),
        },
      };
    }
    return {
      program: p,
      window,
      nowMs: l.nowMs,
      efficiency: s.efficiency,
      effectiveness: s.effectiveness,
      flow,
      open: s.open ? { open: s.open.open, inProgress: s.open.inProgress, blocked: s.open.blocked, inReview: s.open.inReview, oldestReviewMs: s.open.oldestReviewMs, stalled: s.open.stalled } : null,
      crew,
      basis: METRICS_BASIS,
    };
  }

  flow(programId: string | undefined, window: MetricsWindow, groupBy: MetricsGroupBy | null): MetricsFlow | null {
    const p = this.program(programId);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    const { total, groups } = groupFlow(this.#rowsOf(l, p) ?? [], l.nowMs, windowMs, groupBy, this.programs());
    return { program: p.id, window, nowMs: l.nowMs, groupBy, total, groups, basis: METRICS_BASIS };
  }

  tickets(programId: string | undefined, window: MetricsWindow, opts: { stage?: MetricsStage; groupBy?: MetricsGroupBy; group?: string }): MetricsTickets | null {
    const p = this.program(programId);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    const programs = this.programs();
    let rows = (this.#rowsOf(l, p) ?? []).filter((r) => !opts.stage || r.stages[opts.stage] !== null);
    if (opts.groupBy && opts.group) rows = rows.filter((r) => groupKeysOf(r, opts.groupBy!, programs).includes(opts.group!));
    const all = ticketRows(rows, l.nowMs - windowMs, l.nowMs, programs);
    return { program: p.id, window, nowMs: l.nowMs, stage: opts.stage ?? null, group: opts.group ?? null, groupBy: opts.groupBy ?? null, total: all.length, rows: all.slice(0, TICKET_ROWS) };
  }

  trend(programId: string | undefined, metric: MetricsTrendKey, window: MetricsTrendWindow): MetricsTrend | null {
    const p = this.program(programId);
    if (!p) return null;
    const nowMs = this.deps.now();
    const from = nowMs - METRICS_WINDOW_MS[window];
    const db = this.deps.store.db;
    const points = db ? (tryRead(() => readTrend(db, p.id, metric, from, nowMs)) ?? []) : [];
    return {
      program: p.id,
      metric,
      window,
      nowMs,
      points: downsample(points, from, nowMs, TREND_POINTS),
      everyMs: SNAPSHOT_EVERY_MS,
      keepMs: KEEP_SNAPSHOTS_MS,
      source: 'lab_metric_snapshots (written every 10 min, kept 30 days); the last snapshot of each of at most 200 equal slices',
    };
  }

  /** Plain-language findings for one program and window. */
  async insights(programId: string | undefined, window: MetricsWindow): Promise<MetricsInsights | null> {
    const p = this.program(programId);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    if (p.kind === 'commits') return { program: p.id, window, nowMs: l.nowMs, items: [{ kind: 'no_data', severity: 'info', text: p.unavailable!.text, tickets: [] }] };
    const facts = tryRead(() => loadCrewFacts(this.deps.store, l.nowMs, l.nowMs - HOUR));
    const s = this.#scores(l, p, facts, await this.#paces(), windowMs);
    const rows = s.rows ?? [];
    const flow = groupFlow(rows, l.nowMs, windowMs, null, []).total;
    return { program: p.id, window, nowMs: l.nowMs, items: insights({ label: p.label, windowLabel: window === '24h' ? '24 hours' : '7 days', flow, rows, efficiency: s.efficiency, open: s.open, targets: p.targets }) };
  }

  /** One snapshot per ticket program (the timer, every 10 minutes). Returns how many rows were written. */
  async snapshot(): Promise<number> {
    const db = this.deps.store.writable ? this.deps.store.db : null;
    if (!db) return 0;
    const windowMs = METRICS_WINDOW_MS['24h'];
    const l = this.#load(windowMs);
    const facts = tryRead(() => loadCrewFacts(this.deps.store, l.nowMs, l.nowMs - HOUR));
    const paces = await this.#paces();
    const rows = this.programs()
      .filter((p) => p.kind !== 'commits')
      .map((p) => {
        const s = this.#scores(l, p, facts, paces, windowMs);
        const day = groupFlow(s.rows ?? [], l.nowMs, windowMs, null, []).total.current;
        return { program: p.id, values: snapshotValues({ efficiency: s.efficiency, effectiveness: s.effectiveness, day, open: s.open }) };
      });
    return writeSnapshots(db, l.nowMs, rows);
  }
}
