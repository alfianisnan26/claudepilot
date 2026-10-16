// Crew scorecard (T-450, docs/prd/claude-usage.md §28.14): effectiveness and cost per PROGRAM (a lead's track: the lead chain with its
// continuations and every worker under it) and per WINDOW (the last hour, 6 hours, day or week, with the window before it to compare).
// Every number names its basis (measured, estimate) and its source; a source the portal does not have is `unavailable` with a reason,
// never a guess and never 0. The targets carry the rule of the standing decision they check (D-61, D-62, D-63) and a state.

import type { Figure } from './usage.js';

export const CREW_WINDOWS =['1h', '6h', 'day', 'week'] as const;
export type CrewWindow = (typeof CREW_WINDOWS)[number];
export const CREW_WINDOW_MS: Record<CrewWindow, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, day: 24 * 3_600_000, week: 7 * 24 * 3_600_000 };

/** Why a figure is unavailable. */
export type CrewUnavailable =
  /** The table it comes from is not in this store (or could not be read). */
  | 'no_source'
  /** Nothing to divide by: no done ticket, no cost, no lead time. */
  | 'no_samples'
  /** The fact was never recorded (a worker's role, what a review waits for). */
  | 'not_recorded'
  /** T-600: the quota windows reset a moment ago (the sum of evenPct is under 10), so a pace would be noise. */
  | 'windows_just_reset'
  /** T-600: no Claude is signed in and readable (all signed out, pooled or unavailable). */
  | 'no_claude';

/** One number with its basis and source. `value` is null exactly when `basis` is `unavailable`, and then `reason` is set. */
export interface CrewFigure {
  value: number | null;
  basis: 'measured' | 'estimate' | 'unavailable';
  /** Where it comes from: a table, a function, a rule. */
  source: string;
  reason?: CrewUnavailable;
}

export type CrewTargetState = 'ok' | 'warn' | 'breach' | 'unavailable';

/** T-549 (D-65): the six efficiency targets, in the order the page shows them. */
export const CREW_D65_TARGETS = ['cost_per_done', 'lead_share', 'qa_opus_share', 'done_rate', 'quota_unused', 'wasted_tool_calls'] as const;
export type CrewD65TargetId = (typeof CREW_D65_TARGETS)[number];

/** A metric checked against a standing decision. */
export interface CrewTarget {
  id: 'live_workers' | 'lead_subagents' | 'owner_queue' | 'qa_review_model' | CrewD65TargetId;
  decision: 'D-61' | 'D-62' | 'D-63' | 'D-65';
  /** The rule, in one line. */
  rule: string;
  state: CrewTargetState;
  figure: CrewFigure;
  /** Session, ticket or Claude ids behind a warn or a breach (at most 20). */
  offenders: string[];
}

export interface CrewTypeRow {
  /** feature, bug, task, chore, ... (the ticket's type). */
  type: string;
  done: number;
  perHour: number;
  /** in_progress to done, ms; null when no done ticket of the type has a start recorded. */
  leadTimeP50Ms: number | null;
  leadTimeP90Ms: number | null;
  /** Done tickets of the type with no in_progress change recorded (not in the lead time). */
  noStart: number;
  /**
   * Usage spend's per-ticket dollars (T-449 `ticketReport`) of the type's done tickets over their LIFE: the program's requests from the
   * oldest such ticket's creation (at most 30 days back) to the window's end, own plus via lead.
   */
  costAllInUsd: number;
  /** The same, the tickets' own sessions only (no lead part). */
  costWorkersUsd: number;
  /** `costAllInUsd / done`, `costWorkersUsd / done`. */
  perTicketAllInUsd: number;
  perTicketWorkersUsd: number;
}

export interface CrewReviewItem {
  ticket: string;
  type: string;
  /** How long it has been in review at the window's end. */
  ageMs: number;
  /**
   * What it waits for (deploy, stg, qa, owner, ...): a `waits-<what>` tag first; else, for the window that ends now, read from the portal: a
   * deploy of one of its runs waiting for approval (`deploy`), a live QA, verifier, reviewer or ux-check session holding it (`qa`), or a
   * person it is assigned to (`owner`). null: neither.
   */
  waitsFor: string | null;
  /** `tag`: the ticket's own tag; `derived`: read from the deploys, sessions or assignee now; null with `waitsFor` null. */
  waitsBasis: 'tag' | 'derived' | null;
}

export interface CrewCiRow {
  pipeline: string;
  passed: number;
  failed: number;
  cancelled: number;
}

export interface CrewDeploy {
  runNumber: number;
  pipeline: string;
  environment: string;
  /** The approval (pending, approved, rejected, auto, ...). */
  approval: string;
  /** The deploy's outcome when it ran, else null. */
  outcome: string | null;
  at: string;
}

export interface CrewEffectiveness {
  done: CrewFigure;
  donePerHour: CrewFigure;
  reopened: CrewFigure;
  wontDo: CrewFigure;
  byType: CrewTypeRow[];
  reviewBacklog: CrewFigure;
  review: CrewReviewItem[];
  ciRuns: CrewFigure;
  ci: CrewCiRow[];
  deploysCount: CrewFigure;
  deploys: CrewDeploy[];
}

export interface CrewCost {
  total: CrewFigure;
  lead: CrewFigure;
  workers: CrewFigure;
  /** Percent of `total`. */
  leadShare: CrewFigure;
  /** `total / done` (all-in) and `workers / done`. */
  perDoneAllIn: CrewFigure;
  perDoneWorkers: CrewFigure;
}

/** Context size (tokens of the last turn, `chat_sessions.context_used`) of a group of sessions active in the window. */
export interface CrewContextRow {
  /** A role (the worker's agent, `lead`, or `unrecorded`), or a lead session id. */
  key: string;
  sessions: number;
  p50: number | null;
  p90: number | null;
}

export interface CrewModelRow {
  /** The worker's role (its agent), `lead`, or `unrecorded`. */
  role: string;
  model: string;
  requests: number;
  costUsd: number;
}

export interface CrewRoleRow {
  role: string;
  /** Sessions of the role with a request in the window. */
  sessions: number;
  /** Of them, started in the window (churn); the rest were reused. */
  started: number;
  requests: number;
  requestsPerSession: number;
}

export interface CrewSessionCost {
  session: string;
  role: string;
  costUsd: number;
  requests: number;
}

export interface CrewSpike {
  at: string;
  kind: 'rate' | 'burst' | 'outlier';
  /** The session behind it (for rate: the Claude's top session, when it is the program's). */
  session: string | null;
  role: string;
  claude: string;
  summary: string;
}

export interface CrewEfficiency {
  /** Percent of the window's dollars at list price by token class (lab/prices.ts weights). ESTIMATE; unavailable with no priced model. */
  costParts: { input: CrewFigure; output: CrewFigure; cacheRead: CrewFigure; cacheWrite: CrewFigure };
  requests: CrewFigure;
  requestsPerSession: CrewFigure;
  contextByRole: CrewContextRow[];
  /** Per lead session: its workers' context (the lead's own is `leadTokens`). */
  contextByLead: (CrewContextRow & { leadTokens: number | null })[];
  /** The five sessions that cost the most in the window. */
  topSessions: CrewSessionCost[];
  modelMix: CrewModelRow[];
  roles: CrewRoleRow[];
  /** Live sessions per Claude now (T-427 spread). */
  liveByClaude: { claude: string; live: number }[];
  /** Lead continuations started in the window (T-423 hand-overs), and per hour. */
  handovers: CrewFigure;
  handoversPerHour: CrewFigure;
  spikesCount: CrewFigure;
  spikes: CrewSpike[];
  /** T-490 (D-63): the QA and review workers (by role) with a request in the window, and how many of them ran on opus or fable. */
  qaReviewOpus: CrewQaReviewOpus;
}

/** T-490 (D-63): the opus share of a program's QA and review workers in a window. */
export interface CrewQaReviewOpus {
  /** QA, verifier, ux-check and review workers (their role, `chat_sessions.agent`) with a request in the window. */
  sessions: number;
  /** Of them, with a request on an opus or fable model. */
  opus: number;
  /** Of `opus`, started with a reason (`session_spawn` `why`, `chat_sessions.spawn_why`). */
  opusWithWhy: number;
  /** `opus / sessions`, percent; unavailable with no such worker (no_samples). */
  share: CrewFigure;
}

export interface CrewEnding {
  session: string;
  kind: 'integrity' | 'credential' | 'error';
  at: string;
}

export interface CrewHealth {
  /** `agent.refused` audit rows of the program's sessions in the window, by scope. */
  refusals: CrewFigure;
  refusalsByScope: { scope: string; count: number }[];
  /** Sessions ended by an integrity or credential check, or interrupted by an error, in the window. */
  badEndings: CrewFigure;
  endings: CrewEnding[];
  /** The portal does not record a workspace pod's memory or its OOM restarts: unavailable (no_source). */
  podMemory: CrewFigure;
  oomRestarts: CrewFigure;
}

export interface CrewWindowScore {
  fromMs: number;
  toMs: number;
  effectiveness: CrewEffectiveness;
  cost: CrewCost;
  efficiency: CrewEfficiency;
  health: CrewHealth;
}

export interface CrewProgramScore {
  /** The first row of the lead chain (its id names the program). */
  program: string;
  title: string;
  /** T-490: the workspace the program's lead runs in (`kubernetes/<name>`), or null when its row is gone. */
  workspaceId: string | null;
  /** The lead chain: the lead and its continuations, oldest first. */
  leads: string[];
  /** Worker sessions in the program (any depth), live or ended. */
  workers: number;
  current: CrewWindowScore;
  previous: CrewWindowScore | null;
  targets: CrewTarget[];
}

/** T-547 (D-65): how much of a Claude's plan window went unused at its reset, from the last reading just before it. */
export interface QuotaUnusedRow {
  claudeId: string;
  /** The window key (`session`, `week`, ...). */
  window: string;
  /** When the period ended (ISO). */
  resetAt: string;
  /** Percent of the window left at the last reading before the reset; unavailable when no reading came within 30 minutes of it. */
  unusedPct: Figure<number>;
  /** When that reading was taken (ISO), null when there was none. */
  readingAt: string | null;
}

/** T-600: one Claude's own pace in its 5-hour `session` window (contracts/usage.ts WindowPace: usedPct, evenPct, projectedPct). */
export interface CrewPaceClaude {
  claude: string;
  label: string;
  usedPct: number;
  evenPct: number;
  /** `usedPct / evenPct`; unavailable when evenPct is 0. */
  ratio: CrewFigure;
  /** Where the window ends if the rate holds, percent of the quota; null when the Claude does not say. */
  projectedPct: number | null;
}

/**
 * T-600 effectiveness (quota), global: sum of usedPct / sum of evenPct over the 5-hour `session` window of every Claude that is signed in and
 * readable. A snapshot of now, so it does not depend on the scorecard's window. `ratio.value` 1 means the quota is spent exactly by its reset.
 */
export interface CrewPace {
  ratio: CrewFigure;
  /** Under 0.9: percent of the quota left unused at reset (from projectedPct); null otherwise or when no Claude says. */
  unusedAtResetPct: number | null;
  /** The weekly window the same way, when a Claude reports one. */
  weekly: CrewFigure;
  claudes: CrewPaceClaude[];
}

export interface CrewProgramCount {
  program: string;
  title: string;
  /** `done` for resolved; created or closed for created-per-closed (see the field that holds it). */
  count: number;
}

export interface CrewCreatedClosedRow {
  program: string;
  title: string;
  created: number;
  /** done + won't-do. */
  closed: number;
  /** `created / closed`; unavailable with none closed (no_samples), never a division by zero. */
  ratio: CrewFigure;
}

/** T-600 one window's efficiency figures. */
export interface CrewSummaryWindow {
  fromMs: number;
  toMs: number;
  /** Requests per hour and estimated dollars per hour, all crews (chat_usage). */
  requestsPerHour: CrewFigure;
  usdPerHour: CrewFigure;
  /** Tickets closed `done` in the window, global; won't-do apart. */
  resolved: CrewFigure;
  wontDo: CrewFigure;
  resolvedByProgram: CrewProgramCount[];
  /** Estimated dollars of the window / resolved. Unavailable with none resolved. */
  perResolvedUsd: CrewFigure;
  /** Tickets created / tickets closed (done + won't-do), global and per program. Under 1 the backlog shrinks. */
  createdPerClosed: CrewFigure;
  createdPerClosedByProgram: CrewCreatedClosedRow[];
}

/** T-600: the summary block at the top of the Crew page and the Glance widget. The same programs and attribution as `programs`. */
export interface CrewSummary {
  pace: CrewPace;
  current: CrewSummaryWindow;
  /** The window before, the same length; null unless compare=1. */
  previous: CrewSummaryWindow | null;
}

export interface CrewScorecard {
  window: CrewWindow;
  nowMs: number;
  programs: CrewProgramScore[];
  /** T-547: "quota left unused at reset", per Claude per window, for the resets inside the scorecard window. Whole-portal read only (an agent's own-program read omits it). */
  quotaUnused?: QuotaUnusedRow[];
  /**
   * T-600. Optional until the server fills it: the page says "unavailable" for the block when it is absent. Named `headline`, not `summary`:
   * the `crew_scorecard` portal tool already puts a text `summary` beside the scorecard it spreads.
   */
  headline?: CrewSummary;
  /** One line per figure: where it comes from (the InfoTip). */
  basis: Record<string, string>;
}

export const SCORECARD_API = {
  /** GET `?window=1h|6h|day|week&compare=0|1&program=<id>`: `CrewScorecard`. An agent reads its own program only. */
  scorecard: '/api/lab/scorecard',
} as const;
