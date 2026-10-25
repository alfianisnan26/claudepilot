// Pilot metrics (T-2360, docs/prd/claude-usage.md §28.16): flow times per ticket stage, the efficiency and effectiveness scores per
// program, their trend from snapshots, and plain-language findings. Read by the Metrics page (web) and the Portal MCP tools (later slices).
// Every number names its basis and source; an input the portal does not have is `unavailable` with a reason, never 0 (CrewFigure rule).

import type { CrewCost, CrewFigure, CrewSummary, CrewUnavailable } from './scorecard.js';

/** The flow windows: the last 24 hours or 7 days, each compared with the window before it (the same length). */
export const METRICS_WINDOWS = ['24h', '7d'] as const;
export type MetricsWindow = (typeof METRICS_WINDOWS)[number];
/** The trend reads snapshots (kept 30 days), so it also has a month. */
export const METRICS_TREND_WINDOWS = ['24h', '7d', '30d'] as const;
export type MetricsTrendWindow = (typeof METRICS_TREND_WINDOWS)[number];
export const METRICS_WINDOW_MS: Record<MetricsTrendWindow, number> = { '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000, '30d': 30 * 24 * 3_600_000 };

/**
 * The stages of a done ticket, each a duration in ms (see §28.16 for the exact start and end of each):
 * start (created to first in progress), report (created to the first comment by an agent session), implement (first in progress to the
 * first verdict, else the first merge), test (first verdict to the last passing one), deliver (the last merge to closed done), resolve
 * (created to done), work (first in progress to done).
 */
export const METRICS_STAGES = ['start', 'report', 'implement', 'test', 'deliver', 'resolve', 'work'] as const;
export type MetricsStage = (typeof METRICS_STAGES)[number];

export const METRICS_GROUP_BY = ['program', 'lead', 'type', 'priority'] as const;
export type MetricsGroupBy = (typeof METRICS_GROUP_BY)[number];

/** The values a snapshot keeps per program (the trend's `metric`). `<stage>P50`: the stage's median over the last 24 h, ms. */
export const METRICS_TREND_KEYS = [
  'efficiency',
  'effectiveness',
  'done24h',
  'wontDo24h',
  'openWork',
  'blocked',
  'inReview',
  ...METRICS_STAGES.map((s) => `${s}P50` as const),
] as const;
export type MetricsTrendKey = (typeof METRICS_TREND_KEYS)[number];

/** A program: a set of ticket tags (`tickets`), every ticket (`all`), or a program without tickets (`commits`, unavailable today). */
export interface MetricsProgram {
  id: string;
  label: string;
  kind: 'all' | 'tickets' | 'commits';
  /** The tags whose tickets are the program's (empty for `all` and `commits`). */
  tags: string[];
  /** Where the program came from: the setting `lab.metricsPrograms`, a `program-*` tag, the flow watchdog's `flow.programs`, or built in. */
  source: 'setting' | 'program-tag' | 'flow' | 'builtin';
  /** The targets the effectiveness score measures against. */
  targets: MetricsTargets;
  /** Set when the program's figures are unavailable (a `commits` program: the portal keeps no commit history). */
  unavailable?: { reason: CrewUnavailable; text: string };
}

export interface MetricsTargets {
  /** Done tickets per hour over the last 6 hours. */
  closuresPerHour: number;
  /** Median created-to-done over the last 24 hours, hours. */
  resolveHours: number;
  /** The oldest ticket in review, hours. */
  reviewHours: number;
}

/** One stage over a set of done tickets: `n` had both ends recorded, `excluded` did not (left out, never counted as 0). */
export interface MetricsStageStat {
  stage: MetricsStage;
  n: number;
  excluded: number;
  /** Nearest-rank median and 90th percentile, ms; null with n 0. */
  medianMs: number | null;
  p90Ms: number | null;
}

/** Verdict rounds of the done tickets that had a test stage. */
export interface MetricsTestRounds {
  /** Tickets with a test stage. */
  n: number;
  /** Median verdicts (QA or review verdicts and self-test lines) in the test stage. */
  medianRounds: number | null;
  /** Tickets with at least one failing verdict before the pass (rework), and the fails in all. */
  reworked: number;
  fails: number;
}

export interface MetricsFlowWindow {
  fromMs: number;
  toMs: number;
  /** Tickets closed done in the window (the stages are over these). */
  done: number;
  /** Closed won't-do in the window: counted apart, never in a stage. */
  wontDo: number;
  /** Created to won't-do, median, ms (how long a dropped ticket lived). */
  wontDoMedianMs: number | null;
  stages: MetricsStageStat[];
  rounds: MetricsTestRounds;
}

export interface MetricsFlowGroup {
  /** The group's key: a program id, a lead (`area-*` tag or `lead:<session>`), a ticket type or a priority; `unrecorded` when not known. */
  key: string;
  current: MetricsFlowWindow;
  previous: MetricsFlowWindow;
}

/** `GET METRICS_API.flow`. */
export interface MetricsFlow {
  program: string;
  window: MetricsWindow;
  nowMs: number;
  groupBy: MetricsGroupBy | null;
  /** The whole program. */
  total: MetricsFlowGroup;
  /** Per group, biggest first (empty without groupBy). */
  groups: MetricsFlowGroup[];
  basis: Record<string, string>;
}

/** One component of a score. `value` 0-100 or null when unavailable (then `reason` is set and its weight is shared by the others). */
export interface MetricsComponent {
  id: string;
  label: string;
  /** The weight as specified, percent. */
  weight: number;
  /** The weight it carried in this score after unavailable components were left out, percent (0 when unavailable). */
  appliedWeight: number;
  value: number | null;
  basis: 'measured' | 'estimate' | 'unavailable';
  source: string;
  reason?: CrewUnavailable;
  /** The raw figure behind the value (a ratio, a count, hours), for the InfoTip. */
  raw: string;
}

export interface MetricsScore {
  /** 0-100, the weighted mean of the available components; null when none is. */
  value: number | null;
  /** The same score in the snapshot nearest to one window ago; null when there is none. */
  previous: number | null;
  components: MetricsComponent[];
  /** One line: the weights, what was left out, where the spec comes from. */
  basis: string;
}

export interface MetricsOpenWork {
  open: number;
  inProgress: number;
  blocked: number;
  inReview: number;
  /** The oldest ticket in review now, ms; null with none. */
  oldestReviewMs: number | null;
  /** In progress with no change for `flow.stallHours`. */
  stalled: number;
}

/** `GET METRICS_API.overview`. */
export interface MetricsOverview {
  program: MetricsProgram;
  window: MetricsWindow;
  nowMs: number;
  efficiency: MetricsScore;
  effectiveness: MetricsScore;
  /** The stage medians of the window and the one before. */
  flow: MetricsFlowGroup;
  open: MetricsOpenWork | null;
  /**
   * T-600 / T-450 figures over the crews that work on this program's tickets (the scorecard's own functions): the headline (pace, resolved,
   * $/resolved, created per closed) and the cost summed over those crews. null: the store could not be read.
   */
  crew: { programs: string[]; headline: CrewSummary; cost: Pick<CrewCost, 'total' | 'lead' | 'workers' | 'leadShare'> & { perDone: CrewFigure } } | null;
  basis: Record<string, string>;
}

export interface MetricsTrendPoint {
  atMs: number;
  value: number | null;
}

/** `GET METRICS_API.trend`: one metric of one program from the snapshots, oldest first, at most about 200 points. */
export interface MetricsTrend {
  program: string;
  metric: MetricsTrendKey;
  window: MetricsTrendWindow;
  nowMs: number;
  points: MetricsTrendPoint[];
  /** How often a snapshot is written (ms) and how long they are kept. */
  everyMs: number;
  keepMs: number;
  source: string;
}

/** One done (or won't-do) ticket with its stage durations: the drill-down. */
export interface MetricsTicketRow {
  ticket: string;
  type: string;
  priority: string;
  status: 'done' | 'wont_do';
  closedAtMs: number;
  lead: string;
  programs: string[];
  /** ms per stage; null: left out (a timestamp it needs was never recorded). */
  stages: Record<MetricsStage, number | null>;
  rounds: number | null;
  fails: number | null;
}

/** `GET METRICS_API.tickets`: the rows of the window (newest close first, at most 200), filtered by stage (only tickets with it) and group. */
export interface MetricsTickets {
  program: string;
  window: MetricsWindow;
  nowMs: number;
  stage: MetricsStage | null;
  group: string | null;
  groupBy: MetricsGroupBy | null;
  total: number;
  rows: MetricsTicketRow[];
}

export interface MetricsInsight {
  kind: 'slowest_stage' | 'regression' | 'idle_capacity' | 'blocked_share' | 'outlier' | 'review_wait' | 'no_data';
  /** info, warn (worth a look), act (worth acting on). */
  severity: 'info' | 'warn' | 'act';
  text: string;
  /** Ticket ids behind it (at most 10). */
  tickets: string[];
}

/** `GET METRICS_API.insights`. */
export interface MetricsInsights {
  program: string;
  window: MetricsWindow;
  nowMs: number;
  items: MetricsInsight[];
}

export const METRICS_API = {
  /** GET: `MetricsProgram[]`, `all` first. */
  programs: '/api/lab/metrics/programs',
  /** GET `?program=&window=24h|7d`: `MetricsOverview`. */
  overview: '/api/lab/metrics/overview',
  /** GET `?program=&window=&groupBy=lead|type|priority|program`: `MetricsFlow`. */
  flow: '/api/lab/metrics/flow',
  /** GET `?metric=&program=&window=24h|7d|30d`: `MetricsTrend`. */
  trend: '/api/lab/metrics/trend',
  /** GET `?program=&window=&stage=&groupBy=&group=`: `MetricsTickets`. */
  tickets: '/api/lab/metrics/tickets',
  /** GET `?program=&window=`: `MetricsInsights`. */
  insights: '/api/lab/metrics/insights',
} as const;
