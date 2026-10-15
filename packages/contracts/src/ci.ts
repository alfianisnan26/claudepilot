// Local git and CI/CD (docs/prd/local-git-ci.md): a git remote on a workspace and a runner in it. A push, or a
// merge into a protected branch, runs the pipelines in the repository's `.pilot/` folder inside the workspace.
// Everything that came out of a workspace (logs, commit messages, diagnostics) is untrusted text.

import type { BumpMode } from './bump.js';

/** A run's status. Jobs and steps add `pending` and `skipped`; a job held for a person's approval (FR41) is `waiting` (its run stays `running`). */
export const CI_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];
export type CiUnitStatus = CiStatus | 'pending' | 'skipped' | 'waiting';

/** Not finished: it still has work to do or is doing it. */
export const isCiActive = (s: CiUnitStatus): boolean => s === 'queued' || s === 'running' || s === 'pending' || s === 'waiting';

/** Why a run or a unit failed, when it isn't just "a step exited non-zero". */
export const CI_REASONS = ['step_failed', 'timeout', 'invalid_pipeline', 'runner_lost', 'no_space', 'runner_error', 'cancelled', 'superseded', 'needs', 'condition', 'signal', 'fail_fast', 'rejected', 'no_runner'] as const;
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
  /** The `runs-on` labels the pipeline asked for (T-557); null: it runs in the repository's workspace. */
  runsOn: string[] | null;
  /** The runner that executes it when that is another workspace (T-557); null: `workspaceId`. */
  runnerWorkspaceId: string | null;
}

/**
 * A runner (T-557, PRD §23): a workspace (in the cluster, or a machine enrolled through Connect) that takes the runs of other workspaces whose
 * pipeline says `runs-on: [labels]`. It gets each run's commit (into a mirror) and secrets (a lease removed with the run) from the portal.
 */
export interface CiRunner {
  workspaceId: string;
  /** Lowercase labels; a run goes to a runner whose labels include all of its `runs-on`. */
  labels: string[];
  /** Runs it executes at once (its own included). */
  maxRuns: number;
  enabled: boolean;
  /** Its running runs finish; it gets no new one. */
  drained: boolean;
  note: string | null;
  /** online: its workspace runs; offline: stopped; gone: the workspace no longer exists. */
  state: 'online' | 'offline' | 'gone';
  /** Runs executing on it now. */
  running: number;
  createdAt: string;
  updatedAt: string;
}

/** `PUT CI_API.runners`: make a workspace a runner, or change one. */
export interface UpsertCiRunnerRequest {
  workspaceId: string;
  labels: string[];
  maxRuns?: number;
  enabled?: boolean;
  drained?: boolean;
  note?: string | null;
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
  /** The times a person (or a script) bumped the run into a session (FR37a), oldest first. */
  bumps: CiRunBump[];
  /** Per job, the tests its log named as flaky (passed on rerun) and their tickets (T-95 item 4); empty until the run's logs are kept. */
  flaky: CiRunFlaky[];
}

/** A job's flaky tests: how many, and the ticket of each (one ticket per test across runs). */
export interface CiRunFlaky {
  job: string;
  tests: number;
  tickets: string[];
}

/**
 * A bump of a run into a session (FR37a): `prioritise` is shown as "Fix" (the report goes in as `next`, the session acts on it), `ask` is a
 * question (`later`). `refused`: the session would not take the message (`note` says why); otherwise `note` is the person's one line.
 */
export interface CiRunBump {
  sessionId: string;
  mode: BumpMode;
  outcome: 'sent' | 'refused';
  at: string;
  note: string | null;
}

/** What the run's two bump modes are called (the shared Bump dialog's labels). */
export const CI_BUMP_MODE_LABEL: Record<BumpMode, string> = { prioritise: 'Fix', ask: 'Ask' };

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
 * Where a deployment's approval stands. `pending`: its job has not been reached; `waiting`: held for a person (or the environment's rule);
 * `approved` / `rejected` by a person, or `approved` by the environment's rule (`decidedBy` is then `rule:<environment>`, FR41a); `auto`: the
 * environment is not protected; `expired`: the run ended before anyone decided; `skipped`: its job did not run.
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
  /** Who approved or rejected it: a person (`user:<id>`) or the environment's rule (`rule:<environment>`, FR41a). */
  decidedBy: string | null;
  decidedAt: string | null;
  /** How the job ended, once it did. */
  outcome: CiUnitStatus | null;
  createdAt: string;
  /** The auto-approve rule's verdict (T-110, PRD FR41a), or null when the rule did not look (mode off, or before the job waited). */
  autoApprove: CiAutoApproveVerdict | null;
}

/**
 * An environment's auto-approve mode (T-110, PRD FR41a), set only by a person with manage on the remote. `off`: a person approves, as
 * always. `dry`: when a deploy waits, the portal says on the run and in the audit whether the rule WOULD approve it, and approves nothing.
 * `on`: when a deploy of a PROTECTED environment waits and every condition holds, the portal approves it as `rule:<environment>`; when one
 * fails it approves nothing, says which, and a person decides as before.
 */
export const CI_AUTO_APPROVE_MODES = ['off', 'dry', 'on'] as const;
export type CiAutoApproveMode = (typeof CI_AUTO_APPROVE_MODES)[number];

/**
 * What the rule said about one waiting deployment: one line. `dry`: `auto-approve (dry): WOULD approve: ...` or `... WOULD NOT: ...`. `on`:
 * `auto-approve: approved: ...` (verdict `would`, the deployment `approved` by `rule:<environment>`) or `auto-approve: not approved: ...`
 * (verdict `would_not`; a person decides).
 */
export interface CiAutoApproveVerdict {
  mode: 'dry' | 'on';
  verdict: 'would' | 'would_not';
  line: string;
  at: string;
}

/** The paths a deploy may not change without a person (globs, `**` crosses folders), unless an environment lists its own. */
export const CI_AUTO_APPROVE_DEFAULT_PATHS = [
  'apps/server/src/authz/**',
  'apps/server/src/**/authz.ts',
  'apps/server/src/secrets/**',
  'apps/server/src/chat/bypass*.ts',
  'apps/web/src/features/chat/Bypass*',
  '.claude/settings.json',
  '.pilot/**',
  'scripts/gate*.sh',
  'apps/server/src/ci/autoApprove*.ts',
] as const;

/** Auto approvals (or, dry, would-be approvals) per environment in 24 hours. */
export const CI_AUTO_APPROVE_DAILY_CAP = 6;

/** An environment of a remote (PRD FR41): created protected the first time a pipeline names it. */
export interface CiEnvironment {
  id: string;
  repoId: string;
  name: string;
  /** A job that deploys here waits for a person's approval. */
  protected: boolean;
  updatedAt: string;
  updatedBy: string;
  /** The auto-approve mode (FR41a); `off` unless a person set it. */
  autoApprove: CiAutoApproveMode;
  /** When the rule may approve, `HH:MM-HH:MM` in UTC; null: always. */
  autoApproveWindow: string | null;
  /** The paths a deploy may not change without a person, as in force (the defaults unless the environment lists its own). */
  needsPerson: string[];
  /** The latest deployments, newest first (at most 20). */
  deployments: CiDeployment[];
}

export interface UpdateCiEnvironmentRequest {
  protected: boolean;
}

/**
 * PUT an environment's auto-approve rule (a person with manage only; audited as `ci.environment_auto_approve`). Fields left out keep their
 * value; `window: null` means always, `needsPerson: null` the defaults.
 */
export interface UpdateCiAutoApproveRequest {
  mode: CiAutoApproveMode;
  window?: string | null;
  needsPerson?: string[] | null;
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
  /** T-486: the upstream this remote follows by itself (fast-forward only), or null. */
  upstream: CiUpstream | null;
}

/** T-486 (local-git-ci PRD FR8a): a remote that keeps itself in step with an upstream on GitHub or Gitea. Names only, never a secret value. */
export interface CiUpstream {
  /** The https URL fetched (no credentials in it). */
  url: string;
  /** The Secrets & env NAME whose value is the token for the fetch; null for a public repository. */
  secret: string | null;
  /** Seconds between two syncs. */
  everyS: number;
  /**
   * T-486 S2: the Secrets & env NAME whose value signs the upstream's push webhook (`POST /hooks/ci/<remote id>`, GitHub's
   * `X-Hub-Signature-256` or Gitea's `X-Gitea-Signature`); null: no webhook, the timer only.
   */
  hookSecret: string | null;
  /** The last sync: when, and its error (null when it worked). */
  lastAt: string | null;
  error: string | null;
  /** Branches left as they are because pilot and the upstream each have commits the other lacks (a Needs you item each). */
  diverged: CiUpstreamDiverged[];
  /** Branches where pilot has commits the upstream lacks (left as they are; not an item). */
  ahead: string[];
  /** Branches deleted upstream that pilot keeps. */
  gone: string[];
}

export interface CiUpstreamDiverged {
  branch: string;
  /** pilot's commit, and the upstream's. */
  local: string;
  upstream: string;
  since: string;
}

/** Every 30 s unless a remote says otherwise; the bounds of `everyS`. */
export const CI_UPSTREAM_EVERY_S = { default: 30, min: 15, max: 3600 } as const;

/** What `PATCH /api/ci/repos/:id` takes for the upstream: null removes it. A person only (manage). */
export interface UpdateCiUpstream {
  url: string;
  secret?: string | null;
  everyS?: number;
  /** T-486 S2: the Secrets & env name that signs the push webhook (null or absent: none). */
  hookSecret?: string | null;
}

/** T-486 S2: the portal-wide list of hosts an upstream may be on (Settings, CI); empty: any public host. The SSRF guard holds either way. */
export const CI_UPSTREAM_HOSTS_SETTING = 'ci.upstreamHosts';

/** T-486 S2: the public path of a remote's upstream webhook; the id is the remote's. */
export const CI_UPSTREAM_HOOK_PATH = '/hooks/ci/:id';

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
  /** T-486: follow an upstream (null: stop following). */
  upstream?: UpdateCiUpstream | null;
}

/** `POST /api/ci/repos/:id/sync`: what one upstream sync did. */
export interface CiUpstreamSyncResult {
  moved: { branch: string; old: string; new: string }[];
  repo: CiRepo;
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
  /** GET: `CiRunner[]`. PUT `UpsertCiRunnerRequest`: the `CiRunner`. DELETE `?workspaceId=`: it is a runner no more (T-557). */
  runners: '/api/ci/runners',
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
  /** GET: the sessions it can be bumped into (`BumpTarget[]`). POST `BumpRequest`: bump it; returns the `CiRun` (FR37a). */
  bump: (id: string) => `/api/ci/runs/${encodeURIComponent(id)}/bump`,
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
  /** POST: sync from the upstream now (T-486): `CiUpstreamSyncResult`. */
  sync: (id: string) => `/api/ci/repos/${encodeURIComponent(id)}/sync`,
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
  /** PUT `UpdateCiAutoApproveRequest`: `CiEnvironment` (FR41a; a person with manage only). */
  environmentAutoApprove: (repoId: string, name: string) => `/api/ci/repos/${encodeURIComponent(repoId)}/environments/${encodeURIComponent(name)}/auto-approve`,
  /** GET: the `CiReleaseReportSetting` of a remote or null. PUT `{ setting: CiReleaseReportSetting | null }`: set or clear it (a person with manage only; T-591). */
  releaseReport: (repoId: string) => `/api/ci/repos/${encodeURIComponent(repoId)}/release-report`,
  /** POST: write the release report of a past run (backfill) into the vault its remote's setting names; `CiReleaseReportResult` (a person with manage only; T-591). */
  runReleaseReport: (runId: string) => `/api/ci/runs/${encodeURIComponent(runId)}/release-report`,
} as const;

/** T-591 (D-69): where a remote's release reports go. Null on a remote: no reports. The vault and folder are never taken from a run or a tool call. */
export interface CiReleaseReportSetting {
  /** The pipeline whose passed `release` job writes a note (for claudepilot: `Deploy`'s file name stem, e.g. `deploy`). */
  pipeline: string;
  /** A knowledge vault id. */
  vaultId: string;
  /** A folder in it, without leading or trailing slash (e.g. `Releases`). */
  folder: string;
}

export interface CiReleaseReportResult {
  /** The note in the vault. */
  path: string;
  /** False when the note was already there and is now replaced, or unchanged. */
  created: boolean;
  unchanged: boolean;
}

/** The first 7 characters of a commit. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** An environment's name (PRD FR41). */
export const CI_ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** The remote name pattern (PRD FR1). */
export const CI_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
