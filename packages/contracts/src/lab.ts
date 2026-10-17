// Efficiency lab (T-287, docs/prd/claude-usage.md §28): per-slice economy metrics from the session stream and experiments with arms.
// Counts and ids only: no prompt, command, result or other transcript text ever reaches these shapes.

import type { CursorPage } from './page.js';

/** A slice: one sub-agent thread (`agent`, keyed by the Agent call's tool_use id) or one main-thread turn (`turn`, `turn:<n>`). */
export type LabSliceKind = 'agent' | 'turn';

/** The class of a tool call. Bash commands: `inspect` is exactly the reference script's regex (slice_metrics.py), the rest by first word. */
export const LAB_TOOL_CLASSES = ['inspect', 'test', 'git_read', 'git_write', 'api', 'wait', 'edit', 'agent', 'other'] as const;
export type LabToolClass = (typeof LAB_TOOL_CLASSES)[number];

export interface LabSliceMetrics {
  sessionId: string;
  sliceId: string;
  kind: LabSliceKind;
  /** The first `T-<n>` in the Agent call's prompt (first 2,500 characters) or description; null when none. */
  ticket: string | null;
  /** The Agent call's `subagent_type` when it is a plain name; null otherwise. */
  role: string | null;
  /** The model the slice's requests reported last. */
  model: string | null;
  /** The effort the Agent call asked for (`low` to `max`) when it is a plain name; null otherwise or for a main-thread turn (slice 3). */
  effort: string | null;
  /** Assistant messages, deduplicated by message id. */
  requests: number;
  /** Context per request = cache read + cache write tokens (as the reference script): median (truncated) and the 90th percentile. */
  ctxP50: number;
  ctxP90: number;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  /** Cost in input-price units (the design's weights): cache read 0.1, write 1.25 (5 min) or 2.0 (1 h), output 5, plain input 1. */
  units: { input: number; read: number; write: number; out: number };
  /**
   * (input + cache read x the model's own read weight + write + out units) x the model's input price (lab/prices.ts); null when the model has
   * no known price ("unavailable", never a guess). The read weight is per model (Opus 5.5 0.05, Fable 5.1 0.025, else the design's 0.1); the
   * `units.read` above stays at 0.1 so it equals the reference script.
   */
  costUsd: number | null;
  /** Cache tokens written again after a miss (less than half of the previous context read although the context did not shrink). */
  rewriteTokens: number;
  results: number;
  resultChars: number;
  /**
   * Result tokens (slice 3), an ESTIMATE read from the usage the stream reports: for each request after the first, its context (input + cache
   * read + cache write) less the previous request's context and output, at least 0, laid on the results of the tool calls the previous
   * request made (split by their characters). Context growth after a request without a tool call is not counted. null when the slice has
   * results but none can be laid on a request (rows from before migration 853, or a frozen slice from before slice 3).
   */
  resultTokens: number | null;
  /** The same per class of the tool call, rounded (the classes may differ from the total by rounding); empty when unavailable. */
  resultTokensByClass: Partial<Record<LabToolClass, number>>;
  /**
   * Minutes between consecutive requests over 5 minutes (the short cache's life), summed, one decimal; and the longest gap (slice 3). null for
   * a slice frozen before slice 3.
   */
  idleMinutes: number | null;
  maxGapMinutes: number | null;
  bashCalls: number;
  rtkCalls: number;
  inspectCalls: number;
  /** Tool calls by class (every tool, not only Bash). */
  toolCalls: Partial<Record<LabToolClass, number>>;
  /** Bash calls only, by class (slice 2): the base of "share of Bash calls by class". */
  bashByClass: Partial<Record<LabToolClass, number>>;
  startMs: number | null;
  endMs: number | null;
  /** (last request - first request) in minutes, one decimal; 0 with fewer than two timed requests. */
  minutes: number;
}

export type LabExperimentDesign = 'randomized' | 'before_after';
export type LabExperimentStatus = 'running' | 'stopped' | 'decided';
export type LabDecision = 'adopt' | 'reject' | 'iterate';

/**
 * What a randomized experiment stratifies by (slice 3): the ticket's ESTIMATE size when the slice starts, the Agent call's role, its requested
 * model and its effort. A missing value is its own level (`-`).
 */
export const LAB_STRATUM_KEYS = ['size', 'role', 'model', 'effort'] as const;
export type LabStratumKey = (typeof LAB_STRATUM_KEYS)[number];

export interface LabExperiment {
  id: string;
  name: string;
  hypothesis: string;
  design: LabExperimentDesign;
  /** randomized: the arm names; before_after: always ['before', 'after'] split at `switchMs`. */
  arms: string[];
  primaryMetric: string;
  guardrails: unknown[];
  thresholds: Record<string, unknown>;
  minN: number;
  status: LabExperimentStatus;
  startMs: number;
  stopMs: number | null;
  switchMs: number | null;
  decision: LabDecision | null;
  verdict: string | null;
  createdMs: number;
  /** randomized: the stratum keys in order; null keeps slice 1's stratum (role and requested model, `role|model`). */
  strata: LabStratumKey[] | null;
  /** randomized: only a bound draw (`lab_arm_draw`, T-292) gives an arm; a slice without one is excluded. */
  drawsOnly: boolean;
}

export interface LabArmSummary {
  arm: string;
  n: number;
  /** Medians over the arm's slices (null with no slice). */
  medians: {
    requests: number | null;
    ctxP50: number | null;
    costUsd: number | null;
    resultChars: number | null;
    resultTokens: number | null;
    minutes: number | null;
  };
  /** Sum of rewrite tokens / sum of cache write tokens; null with no write. */
  rewriteShare: number | null;
  /** Inspection calls / Bash calls; null with no Bash call. */
  inspectShare: number | null;
  /** Bash calls that start with `rtk` / Bash calls (compliance for the RTK arm); null with no Bash call. */
  rtkShare: number | null;
}

export interface LabExperimentReport {
  experiment: LabExperiment;
  arms: LabArmSummary[];
  /** Slices taken out with a reason (an outage); never in an arm. */
  excluded: number;
}

/* ---------- Slice 2: outcomes, the summary and the read API (docs/prd/claude-usage.md §28.7 to §28.10) ---------- */

/**
 * A slice's outcome, from its ticket's status timeline after the slice ended (a rule of thumb, §28.7): `accepted` when the ticket next went
 * to done, `rework` when it next went from in review back to work, `defect` when an accepted ticket was reopened within 7 days of being
 * done, `unknown` with no ticket, no decision yet, or a ticket the lab can not read.
 */
export const LAB_OUTCOMES = ['accepted', 'rework', 'defect', 'unknown'] as const;
export type LabOutcome = (typeof LAB_OUTCOMES)[number];

/** A slice with what the lab derives for it: its outcome, its ticket's ESTIMATE size, and the experiment arms it is in. */
export interface LabSliceView extends LabSliceMetrics {
  outcome: LabOutcome;
  /** The size in the ticket's last ESTIMATE comment (S, M, L, XL), or null. */
  estimateSize: string | null;
  /** Experiment id to arm. */
  arms: Record<string, string>;
}

/** `GET LAB_API.slices` (D-58): one page of slices. `total` (every slice the filters leave in) rides on the first page only. */
export interface LabSlicePage extends CursorPage<LabSliceView> {
  total?: number;
}

/** The median and the 90th percentile (index floor(0.9 n) of the sorted values) of a group; null with no value. */
export interface LabStat {
  median: number | null;
  p90: number | null;
}

/** A bootstrap 90 percent interval (5th and 95th percentile of 2,000 resamples, a fixed seed); `n too small` under 20 values. */
export type LabInterval = { low: number; high: number } | 'n too small';

export interface LabSummaryRow {
  /** The period's first day, UTC (`2026-10-14`; a week starts on Monday). */
  period: string;
  /** The Agent call's role; `main` for a main-thread turn; `unknown` for a sub-agent without one. */
  role: string;
  model: string | null;
  n: number;
  requests: LabStat;
  /** Over the slices' own context p50 (tokens per request). */
  ctxP50: LabStat;
  /** Tool result size in characters. */
  resultChars: LabStat;
  /** Result tokens per slice (an estimate from the stream's usage, see LabSliceMetrics), over the slices that have the figure. */
  resultTokens: LabStat;
  minutes: LabStat;
  /** Over the slices with a price; null when none has one. */
  costUsd: LabStat | null;
  /** Bash calls by class over all Bash calls of the group (0 to 1); empty with no Bash call. */
  bashShare: Partial<Record<LabToolClass, number>>;
  bashCalls: number;
  /** Re-written cache tokens after a miss, summed, and their share of all cache writes (null with no write). */
  rewriteTokens: number;
  rewriteShare: number | null;
  outcomes: Record<LabOutcome, number>;
  /** accepted / (accepted + rework + defect); null with none decided. */
  firstPassYield: number | null;
  /**
   * Median loaded cost of an accepted slice: its own cost plus the cost of the rework and defect slices on the same ticket that ended
   * before it (rejected work counts against it). null with no accepted slice that has a price.
   */
  costPerAccepted: number | null;
  costPerAcceptedN: number;
  costPerAcceptedInterval: LabInterval;
}

export type LabPeriod = 'day' | 'week';

/** A ticket's dollars in the window as usage spend reads them (T-449; the same function as Usage -> Attribution by ticket): own, via leads, total. */
export interface LabTicketCost {
  ticket: string;
  type: string | null;
  status: string | null;
  doneAt: string | null;
  ownUsd: number;
  viaLeadUsd: number;
  totalUsd: number;
}

export interface LabSummary {
  period: LabPeriod;
  sinceMs: number;
  rows: LabSummaryRow[];
  /** Tickets with their cost since `sinceMs`, most dollars first (at most 25); the basis of `viaLeadUsd` is `ATTRIBUTION_LEAD_BASIS`. */
  tickets?: LabTicketCost[];
  /** One line per figure: where it comes from (the source an InfoTip shows). */
  basis: Record<string, string>;
  nowMs: number;
}

export interface LabArmView {
  arm: string;
  n: number;
  accepted: number;
  costPerAccepted: number | null;
  costPerAcceptedInterval: LabInterval;
}

/** An experiment with its arms' counts and the primary (median loaded cost per accepted slice) with its interval. */
export interface LabExperimentView {
  experiment: LabExperiment;
  arms: LabArmView[];
  excluded: number;
}

export interface LabSliceFilter {
  session?: string;
  ticket?: string;
  role?: string;
  model?: string;
  experiment?: string;
  arm?: string;
  /** Slices that started at or after (ms since the epoch or an ISO time). */
  since?: string;
  limit?: string;
}

export const LAB_API = {
  /** GET `?session=&ticket=&role=&model=&experiment=&arm=&since=&limit=&cursor=`: one `LabSlicePage` (D-58: 25 by default, 100 at most), newest first. */
  slices: '/api/lab/slices',
  /** GET: `LabExperimentView[]`. */
  experiments: '/api/lab/experiments',
  /** GET `?period=day|week&since=`: `LabSummary`. */
  summary: '/api/lab/summary',
} as const;
