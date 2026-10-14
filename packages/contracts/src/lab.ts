// Efficiency lab (T-287, docs/prd/claude-usage.md §28): per-slice economy metrics from the session stream and experiments with arms.
// Counts and ids only: no prompt, command, result or other transcript text ever reaches these shapes.

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
  /** units x the model's input price (lab/prices.ts); null when the model has no known price ("unavailable", never a guess). */
  costUsd: number | null;
  /** Cache tokens written again after a miss (less than half of the previous context read although the context did not shrink). */
  rewriteTokens: number;
  results: number;
  resultChars: number;
  bashCalls: number;
  rtkCalls: number;
  inspectCalls: number;
  /** Tool calls by class (every tool, not only Bash). */
  toolCalls: Partial<Record<LabToolClass, number>>;
  startMs: number | null;
  endMs: number | null;
  /** (last request - first request) in minutes, one decimal; 0 with fewer than two timed requests. */
  minutes: number;
}

export type LabExperimentDesign = 'randomized' | 'before_after';
export type LabExperimentStatus = 'running' | 'stopped' | 'decided';
export type LabDecision = 'adopt' | 'reject' | 'iterate';

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
}

export interface LabArmSummary {
  arm: string;
  n: number;
  /** Medians over the arm's slices (null with no slice). */
  medians: { requests: number | null; ctxP50: number | null; costUsd: number | null; resultChars: number | null; minutes: number | null };
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
