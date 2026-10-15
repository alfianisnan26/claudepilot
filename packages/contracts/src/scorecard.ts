// Crew scorecard (T-450, docs/prd/claude-usage.md §28.14): effectiveness and cost per PROGRAM (a lead's track: the lead chain with its
// continuations and every worker under it) and per WINDOW (the last hour, 6 hours, day or week, with the window before it to compare).
// Every number names its basis (measured, estimate) and its source; a source the portal does not have is `unavailable` with a reason,
// never a guess and never 0. The targets carry the rule of the standing decision they check (D-61, D-62, D-63) and a state.

export const CREW_WINDOWS = ['1h', '6h', 'day', 'week'] as const;
export type CrewWindow = (typeof CREW_WINDOWS)[number];
export const CREW_WINDOW_MS: Record<CrewWindow, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, day: 24 * 3_600_000, week: 7 * 24 * 3_600_000 };

/** Why a figure is unavailable. */
export type CrewUnavailable =
  /** The table it comes from is not in this store (or could not be read). */
  | 'no_source'
  /** Nothing to divide by: no done ticket, no cost, no lead time. */
  | 'no_samples'
  /** The fact was never recorded (a worker's role, what a review waits for). */
  | 'not_recorded';

/** One number with its basis and source. `value` is null exactly when `basis` is `unavailable`, and then `reason` is set. */
export interface CrewFigure {
  value: number | null;
  basis: 'measured' | 'estimate' | 'unavailable';
  /** Where it comes from: a table, a function, a rule. */
  source: string;
  reason?: CrewUnavailable;
}

export type CrewTargetState = 'ok' | 'warn' | 'breach' | 'unavailable';

/** A metric checked against a standing decision. */
export interface CrewTarget {
  id: 'live_workers' | 'lead_subagents' | 'owner_queue' | 'qa_review_model';
  decision: 'D-61' | 'D-62' | 'D-63';
  /** The rule, in one line. */
  rule: string;
  state: CrewTargetState;
  figure: CrewFigure;
  /** Session or ticket ids behind a warn or a breach (at most 20). */
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
  /** Usage spend's per-ticket dollars (T-449 `ticketReport`) of the type's done tickets, over the window's requests: own plus via lead. */
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
  /** What it waits for, from a `waits-<what>` tag (deploy, stg, qa, ...); null: not recorded. */
  waitsFor: string | null;
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

export interface CrewWindowScore {
  fromMs: number;
  toMs: number;
  effectiveness: CrewEffectiveness;
  cost: CrewCost;
}

export interface CrewProgramScore {
  /** The first row of the lead chain (its id names the program). */
  program: string;
  title: string;
  /** The lead chain: the lead and its continuations, oldest first. */
  leads: string[];
  /** Worker sessions in the program (any depth), live or ended. */
  workers: number;
  current: CrewWindowScore;
  previous: CrewWindowScore | null;
  targets: CrewTarget[];
}

export interface CrewScorecard {
  window: CrewWindow;
  nowMs: number;
  programs: CrewProgramScore[];
  /** One line per figure: where it comes from (the InfoTip). */
  basis: Record<string, string>;
}

export const SCORECARD_API = {
  /** GET `?window=1h|6h|day|week&compare=0|1&program=<id>`: `CrewScorecard`. An agent reads its own program only. */
  scorecard: '/api/lab/scorecard',
} as const;
