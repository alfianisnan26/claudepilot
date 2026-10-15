// The two things the portal and the runner (`cp-ci`) agree on (PRD §11.3): the PLAN the portal hands `start`, and the
// event files and replies the runner prints. Types only, so the runner bundle and the portal share them freely.

/** When a job or step runs, given how the jobs before it ended. `if:` is resolved before the plan exists; this is all that stays dynamic. */
export type PlanWhen = 'success' | 'failure' | 'always';

export interface PlanStep {
  name: string;
  /** A shell script. Values reach it as environment variables, never pasted into the text. */
  run: string;
  env: Record<string, string>;
  /** Relative to the checkout; the portal has checked it holds no `..`. */
  workingDirectory: string;
  /** Null: only the job's and the run's timeouts apply. */
  timeoutMs: number | null;
  continueOnError: boolean;
  when: PlanWhen;
  /** Set when an `if:` was false before the run: it is shown as skipped and never runs. */
  skip: 'condition' | null;
}

export interface PlanJob {
  id: string;
  name: string;
  needs: string[];
  when: PlanWhen;
  skip: 'condition' | null;
  timeoutMs: number;
  continueOnError: boolean;
  env: Record<string, string>;
  /** The matrix this job is one combination of: its siblings share the group's id. `failFast` stops the siblings that have not started when one fails; `maxParallel` caps how many run at once. */
  group: { id: string; failFast: boolean; maxParallel: number | null } | null;
  /** Secrets & env names the job's steps get as environment variables: the runner reads each from the workspace's secret files, and masks its value in the logs. */
  secrets: string[];
  steps: PlanStep[];
  artifacts: { paths: string[]; expireDays: number; when: 'success' | 'always' } | null;
  /** The environment the job deploys to (`environment:`); shown on the run, decided nothing by itself. */
  environment?: string | null;
  /**
   * Set when that environment is protected (PRD FR41): the job waits (`waiting`) until `cp-ci approve` hands over the key whose SHA-256 is
   * `gate`. Only the portal holds the key, and it gives it only when a person approves, so writing a file in the workspace approves nothing.
   */
  approval?: { environment: string; gate: string } | null;
}

export interface Plan {
  v: 1;
  runId: string;
  runNumber: number;
  /** `<target>/<name>`, for `PILOT_WORKSPACE`. */
  workspace: string;
  /** The remote's name: the bare repository `~/.claudepilot/git/<repo>.git`. */
  repo: string;
  sha: string;
  ref: string;
  pipeline: string;
  /** The `PILOT_*` variables known before the run, plus the pipeline's own `env`. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Jobs that may run at once. */
  maxParallel: number;
  jobs: PlanJob[];
  /** The pipeline's `on.notify` (FR36): states a run reports to its session besides what it always does. The portal reads it; the runner does not. */
  notify?: string[];
  /** `runs-on` labels (T-557): the portal picks the runner; the runner itself ignores this. */
  runsOn?: string[];
  /**
   * Set by the portal when a runner executes the run for another workspace (T-557): the mirror (`m-<8 hex>-<remote>`) the commit was
   * bundled into, cloned instead of `repo`; and `leased`: the run's secrets were handed over with `cp-ci lease`, so the supervisor reads
   * them from the run's lease (removed when the run ends) instead of this workspace's Secrets & env files.
   */
  mirror?: string;
  leased?: boolean;
}

/** One ref update a hook saw, as an event file (PRD FR5). */
export interface CiEventFile {
  v: 1;
  /** `<epoch ms>-<8 hex>`, unique per workspace. */
  id: string;
  at: string;
  repo: string;
  kind: 'push' | 'delete';
  /** A full ref: `refs/heads/...` or `refs/tags/...`. */
  ref: string;
  old: string;
  new: string;
  /** The user that pushed. */
  by: string;
  /** `push` for a hook; `portal` for a merge the portal made. */
  via: 'push' | 'portal';
}

export const EVENT_ID = /^\d{10,16}-[0-9a-f]{8}$/;
export const RUN_ID = /^r[a-z0-9]{6,24}$/;
export const SHA = /^[0-9a-f]{40}$/;
export const NULL_SHA = '0'.repeat(40);
