// Local git and CI/CD (docs/prd/local-git-ci.md): a git remote on a workspace and a runner in it. A push, or a
// merge into a protected branch, runs the pipelines in the repository's `.pilot/` folder inside the workspace.
// Everything that came out of a workspace (logs, commit messages, diagnostics) is untrusted text.

/** A run's status. Jobs and steps add `pending` and `skipped`; a job held for a person's approval (FR41) is `waiting` (its run stays `running`). */
export const CI_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];
export type CiUnitStatus = CiStatus | 'pending' | 'skipped' | 'waiting';

/** Not finished: it still has work to do or is doing it. */
export const isCiActive = (s: CiUnitStatus): boolean => s === 'queued' || s === 'running' || s === 'pending' || s === 'waiting';

/** Why a run or a unit failed, when it isn't just "a step exited non-zero". */
export const CI_REASONS = ['step_failed', 'timeout', 'invalid_pipeline', 'runner_lost', 'no_space', 'runner_error', 'cancelled', 'superseded', 'needs', 'condition', 'signal', 'fail_fast', 'rejected'] as const;
export type CiReason = (typeof CI_REASONS)[number];

/** What started a run. A rerun keeps the trigger it repeats in `rerunOf`. */
export type CiTrigger = 'push' | 'merge' | 'manual' | 'schedule' | 'rerun';

/** How a run was linked to a ticket (PRD FR33). */
export type CiTicketSource = 'session' | 'trailer' | 'branch';

export const CI_STATUS_LABEL: Record<CiUnitStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Pending',
  skipped: 'Skipped',
  waiting: 'Waiting',
};

/** One command of a job, as the runner records it in `state.json` and the portal shows it. */
export interface CiStep {
  idx: number;
  name: string;
  status: CiUnitStatus;
  startedAt: string | null;
  durationMs: number | null;
  /** The shell's exit code; null while it runs, when it was killed (see `reason`) or never ran. */
  exitCode: number | null;
  /** Bytes of its log in the workspace. */
  logBytes: number;
  /** Its output went past the cap and the rest was dropped. */
  logTruncated: boolean;
  /** It failed under `continue-on-error`: the job went on. */
  ignored: boolean;
  reason: CiReason | null;
}

export interface CiArtifact {
  path: string;
  bytes: number;
}

export interface CiJob {
  id: string;
  name: string;
  status: CiUnitStatus;
  needs: string[];
  startedAt: string | null;
  durationMs: number | null;
  /** A failed job under `continue-on-error`: the run went on. */
  ignored: boolean;
  reason: CiReason | null;
  steps: CiStep[];
  artifacts: CiArtifact[];
  /** Artifact files left out (over a cap, a link, outside the checkout). */
  artifactsSkipped: number;
  /** The environment the job deploys to (`environment:`), when it names one. */
  environment?: string | null;
}

/** What `cp-ci` writes to `runs/<run>/state.json`: the record of a run while it runs. */
export interface CiRunStateFile {
  v: 1;
  runId: string;
  status: CiStatus;
  reason: CiReason | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  jobs: CiJob[];
}

/** One problem in a pipeline file; `line` and `column` start at 1 (0 when the problem has no place in the text). */
export interface CiDiagnostic {
  file: string;
  line: number;
  column: number;
  /** Where in the document: `jobs.test.steps[1].run`. */
  path: string;
  severity: 'error' | 'warning';
  /** A stable name for the kind of problem: `unknown-key`, `bad-duration`, ... */
  code: string;
  message: string;
  hint?: string;
}

export type CiInputType = 'string' | 'boolean' | 'choice';

export interface CiInput {
  name: string;
  type: CiInputType;
  default: string | boolean | null;
  options: string[];
  required: boolean;
  description: string | null;
}

/** A pipeline file as the portal reads it at a commit. */
export interface CiPipelineInfo {
  /** `.pilot/ci.yml` */
  file: string;
  /** The name it is run under. */
  name: string;
  valid: boolean;
  triggers: ('push' | 'merge' | 'manual' | 'schedule')[];
  inputs: CiInput[];
  jobs: string[];
  diagnostics: CiDiagnostic[];
}

/** A run as lists show it. */
export interface CiRunSummary {
  id: string;
  /** Counts up per remote: `#14`. */
  number: number;
  workspaceId: string;
  repoId: string;
  /** The remote's name. */
  repo: string;
  pipeline: string;
  trigger: CiTrigger;
  ref: string;
  /** Null for a tag. */
  branch: string | null;
  tag: string | null;
  sha: string;
  /** The tip commit's first line, when known (untrusted text). */
  subject: string | null;
  status: CiStatus;
  reason: CiReason | null;
  /** `ui`, `push`, `portal-mcp:<id>`, `session:<id>`. */
  actor: string;
  /** The Portal MCP token's label when `actor` is a token, as it was when the run started (a later rename changes nothing); else null. */
  actorLabel: string | null;
  /** A cancelled run: who cancelled it (an actor like `actor`; `pipeline` when a newer run of the same group superseded it), a token's label as it was, and a short note (`for #12`). Null otherwise. */
  cancelledBy: string | null;
  cancelledByLabel: string | null;
  cancelNote: string | null;
  ticketId: string | null;
  sessionId: string | null;
  rerunOf: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Each job's id and status, for the strip a list row shows. */
  jobs: { id: string; status: CiUnitStatus }[];
}

export interface CiRun extends CiRunSummary {
  baseSha: string | null;
  inputs: Record<string, string | boolean>;
  ticketSource: CiTicketSource | null;
  /** The jobs with their steps (`jobs` is the short strip a list row shows). */
  detail: CiJob[];
  /** For a run that failed as `invalid_pipeline`: what is wrong with the file. */
  diagnostics: CiDiagnostic[];
  /** The workspace is gone or stopped: logs of a run that did not finish can't be read. */
  workspaceState: 'running' | 'stopped' | 'gone';
  /** The logs are kept in the portal (the run is over). */
  archived: boolean;
  /** Its jobs that deploy to an environment (FR41), with where each approval stands. */
  deployments: CiDeployment[];
  /** What CI told the run's session, or why it did not (FR36, FR37), oldest first: at most one per state. */
  reports: CiRunReport[];
}

/**
 * The states a run reports to its session (FR36). `failed` always does (but never for a run a person started by hand); the others do for
 * a run the session started itself, and for any run when the pipeline lists them in `on.notify`. `waiting`: a deployment is held for a person.
 */
export const CI_NOTIFY_STATES = ['failed', 'passed', 'cancelled', 'waiting'] as const;
export type CiNotifyState = (typeof CI_NOTIFY_STATES)[number];

/** Where a report went: `sent`; or why not: the session `ended`, it `refused`, a cap was reached (`capped`), repeated failures (`paused`). */
export type CiReportOutcome = 'sent' | 'refused' | 'capped' | 'paused' | 'ended';

export interface CiRunReport {
  state: CiNotifyState;
  outcome: CiReportOutcome;
  /** The chat it went to, as it is now (a moved chat's current id). */
  sessionId: string;
  at: string;
  note: string | null;
}

/**
 * Where a deployment's approval stands. `pending`: its job has not been reached; `waiting`: held for a person; `approved` / `rejected` by a
 * person; `auto`: the environment is not protected; `expired`: the run ended before anyone decided; `skipped`: its job did not run.
 */
export const CI_APPROVAL_STATES = ['pending', 'waiting', 'approved', 'rejected', 'auto', 'expired', 'skipped'] as const;
export type CiApprovalState = (typeof CI_APPROVAL_STATES)[number];

/** A run's job tied to an environment (PRD FR41). */
export interface CiDeployment {
  id: string;
  runId: string;
  runNumber: number;
  pipeline: string;
  job: string;
  environment: string;
  sha: string;
  ref: string;
  /** Who started the run: `ui`, `push`, `portal-mcp:<id>`, `session:<id>`. */
  actor: string;
  approval: CiApprovalState;
  /** The person who approved or rejected it (an actor string). */
  decidedBy: string | null;
  decidedAt: string | null;
  /** How the job ended, once it did. */
  outcome: CiUnitStatus | null;
  createdAt: string;
}

/** An environment of a remote (PRD FR41): created protected the first time a pipeline names it. */
export interface CiEnvironment {
  id: string;
  repoId: string;
  name: string;
  /** A job that deploys here waits for a person's approval. */
  protected: boolean;
  updatedAt: string;
  updatedBy: string;
  /** The latest deployments, newest first (at most 20). */
  deployments: CiDeployment[];
}

export interface UpdateCiEnvironmentRequest {
  protected: boolean;
}

/** Approve or reject the job a run is holding for a person. */
export interface CiApprovalRequest {
  job: string;
}

export interface CiRunList {
  items: CiRunSummary[];
  /** Matching the filters. */
  total: number;
  /** Runs not finished, over everything the filters left in. */
  active: number;
}

export interface CiRunFilter {
  workspace?: string;
  repo?: string;
  pipeline?: string;
  branch?: string;
  status?: CiStatus[];
  ticket?: string;
  session?: string;
  limit?: number;
  /** A run id: only runs before it. */
  before?: string;
}

/** A piece of a step's log, redacted, with the offset to ask for next. */
export interface CiLogChunk {
  text: string;
  /** The byte offset the next request starts at. */
  next: number;
  /** The step is over and nothing is left after `next`. */
  done: boolean;
  /** The log went past its cap; what is shown is the part kept. */
  truncated: boolean;
  /** Where it was read from: the workspace while the run is going, the portal's copy after. */
  source: 'workspace' | 'archive';
}

export type CiHookState = 'ok' | 'outdated' | 'missing' | 'unknown';

export interface CiRepo {
  id: string;
  workspaceId: string;
  name: string;
  /** The bare repository's folder in the workspace. */
  path: string;
  defaultBranch: string;
  /** Branch globs whose updates count as a merge. */
  protected: string[];
  /** The repository it was cloned from, if any. */
  sourcePath: string | null;
  /** Working repositories that have a `pilot` remote pointing here. */
  connected: string[];
  hooks: CiHookState;
  workspaceState: 'running' | 'stopped' | 'gone';
  createdAt: string;
}

/** A branch of a remote with where the checks stand. */
export interface CiBranch {
  name: string;
  sha: string;
  subject: string;
  at: string;
  protected: boolean;
  /** The latest run of each pipeline at this commit or the branch's latest run. */
  runs: { runId: string; pipeline: string; status: CiStatus; sha: string }[];
}

export interface CreateCiRepoRequest {
  workspaceId: string;
  name: string;
  /** An absolute path of a repository in the workspace to clone from. */
  source?: string;
  /** Give `source` a remote named `pilot` pointing at the new one. */
  connect?: boolean;
  /** The default branch of an empty remote (default `main`). */
  defaultBranch?: string;
}

export interface UpdateCiRepoRequest {
  defaultBranch?: string;
  protected?: string[];
}

export interface ConnectCiRepoRequest {
  /** An absolute path of a working repository in the workspace. */
  path: string;
}

export interface StartCiRunRequest {
  repoId: string;
  pipeline: string;
  /** A branch or tag name, or a full ref. */
  ref: string;
  inputs?: Record<string, string | boolean>;
}

export interface MergeCiRequest {
  source: string;
  target: string;
  strategy?: 'ff' | 'merge';
}

export interface MergeCiResult {
  /** The target's commit after the merge. */
  sha: string;
  strategy: 'ff' | 'merge';
  /** The source was already part of the target. */
  alreadyMerged: boolean;
}

export interface ValidateCiRequest {
  /** Path (as in the repository, `.pilot/ci.yml`) to the file's text. */
  files: Record<string, string>;
}

export interface ValidateCiResult {
  pipelines: CiPipelineInfo[];
  /** Problems that belong to no pipeline (a file in the wrong place, too many files). */
  diagnostics: CiDiagnostic[];
}

export const CI_API = {
  /** GET `CiRunFilter` as a query string: `CiRunList`. POST `StartCiRunRequest`: the new `CiRun`. */
  runs: '/api/ci/runs',
  /** GET: `CiRun`. */
  run: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}`,
  /** GET `?job=&step=&offset=`: `CiLogChunk`. */
  log: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}/log`,
  /** POST: cancel it. */
  cancel: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}/cancel`,
  /** POST: run it again; returns the new `CiRun`. */
  rerun: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}/rerun`,
  /** GET `?workspace=`: `CiRepo[]`. POST `CreateCiRepoRequest`: `CiRepo`. */
  repos: '/api/ci/repos',
  /** PATCH `UpdateCiRepoRequest`: `CiRepo`. DELETE: remove it and its folder. */
  repo: (id: string) => `/api/ci/repos/${encodeURIComponent(id)}`,
  /** POST `ConnectCiRepoRequest`: `CiRepo`. */
  connect: (id: string) => `/api/ci/repos/${encodeURIComponent(id)}/connect`,
  /** GET: `CiBranch[]`. */
  branches: (id: string) => `/api/ci/repos/${encodeURIComponent(id)}/branches`,
  /** GET `?ref=`: `CiPipelineInfo[]`. */
  pipelines: (id: string) => `/api/ci/repos/${encodeURIComponent(id)}/pipelines`,
  /** POST `MergeCiRequest`: `MergeCiResult`. */
  merge: (id: string) => `/api/ci/repos/${encodeURIComponent(id)}/merge`,
  /** POST `ValidateCiRequest`: `ValidateCiResult`. */
  validate: '/api/ci/validate',
  /** POST `CiApprovalRequest`: let the waiting job run (a person only); returns the `CiRun`. */
  approve: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}/approve`,
  /** POST `CiApprovalRequest`: refuse it; the run ends as cancelled (`rejected`). */
  reject: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}/reject`,
  /** GET: `CiEnvironment[]` of a remote. */
  environments: (repoId: string) => `/api/ci/repos/${encodeURIComponent(repoId)}/environments`,
  /** PUT `UpdateCiEnvironmentRequest`: `CiEnvironment` (made when it does not exist yet). */
  environment: (repoId: string, name: string) => `/api/ci/repos/${encodeURIComponent(repoId)}/environments/${encodeURIComponent(name)}`,
} as const;

/** The first 7 characters of a commit. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** An environment's name (PRD FR41). */
export const CI_ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** The remote name pattern (PRD FR1). */
export const CI_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
