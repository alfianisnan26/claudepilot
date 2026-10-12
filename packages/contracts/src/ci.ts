// Local git and CI/CD (docs/prd/local-git-ci.md): a git remote on a workspace and a runner in it. A push, or a
// merge into a protected branch, runs the pipelines in the repository's `.pilot/` folder inside the workspace.
// Everything that came out of a workspace (logs, commit messages, diagnostics) is untrusted text.

/** A run's status. Jobs and steps add `pending` and `skipped`. */
export const CI_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];
export type CiUnitStatus = CiStatus | 'pending' | 'skipped';

/** Not finished: it still has work to do or is doing it. */
export const isCiActive = (s: CiUnitStatus): boolean => s === 'queued' || s === 'running' || s === 'pending';

/** Why a run or a unit failed, when it isn't just "a step exited non-zero". */
export const CI_REASONS = ['step_failed', 'timeout', 'invalid_pipeline', 'runner_lost', 'no_space', 'runner_error', 'cancelled', 'superseded', 'needs', 'condition', 'signal', 'fail_fast'] as const;
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
} as const;

/** The first 7 characters of a commit. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The remote name pattern (PRD FR1). */
export const CI_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
