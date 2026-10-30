// The CI service (PRD §8, §10): follows the remotes of running workspaces, turns events into runs, queues and starts them
// under a per-workspace cap, mirrors each run's state and logs from the workspace into the portal, and answers the API.
// The workspace does the work; this only reads its files and acknowledges what it stored, so a restart loses nothing.

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  CI_REPO_NAME,
  type CiRunFlaky,
  isCiActive,
  parseTicketBranch,
  shortSha,
  CI_ENVIRONMENT_NAME,
  type CiReleaseReportResult,
  type CiReleaseReportSetting,
  type CiBranch,
  type CiDeployment,
  type CiDiagnostic,
  type CiEnvironment,
  type CiJob,
  type CiLogChunk,
  type CiPipelineInfo,
  type CiRepo,
  type CiRun,
  type CiRunFilter,
  type CiRunList,
  type CiRunPage,
  type CiRunStateFile,
  type CiRunSummary,
  type CiStatus,
  type CiTrigger,
  type CiUnitStatus,
  type ConnectCiRepoRequest,
  type CreateCiRepoRequest,
  type MergeCiRequest,
  type MergeCiResult,
  type StartCiRunRequest,
  type UpdateCiRepoRequest,
  type UpdateCiEnvironmentRequest,
  type ValidateCiRequest,
  type ValidateCiResult,
  type CiRunReport,
  type CiRunBump,
  type BumpRequest,
  type BumpTarget,
  type CiAutoApproveMode,
  type UpdateCiAutoApproveRequest,
  type CiUpstreamSyncResult,
  type CiRunner,
  type UpsertCiRunnerRequest,
} from '@portal/contracts';
import { NO_VALUES, SessionStream } from '../chat/valueRedact.js';
import { evaluateRule, needsPersonOf, ruleLine, WINDOW } from './autoApprove.js';
import { deploysOnlyToStg, LEAD_ENVIRONMENT } from './authz.js';
import type { Store } from '../store/store.js';
import { globMatches } from './glob.js';
import { CiUnreachable, type CiHost, type CiReply } from './host.js';
import { CI_LIMITS } from './limits.js';
import { replan, compile, matches, resolveInputs, branchOf, tagOf, type EventContext } from './spec/compile.js';
import { RUNNER_LABEL, validateFiles, type SnapshotFile, type Validated } from './spec/validate.js';
import { CiStore, type DeploymentRow, type EnvironmentRow, type RepoRow, type RunnerRow, type RunRow } from './store.js';
import { CiLinks, runLink, type CiBumper } from './links.js';
import type { CiSessionsPort } from './sessions.js';
import { DeployChatsWatch } from './deployChats.js';
import { parseSetting, ReleaseReporter, ReportRefused, type ReleaseNoteSink } from './releaseReporter.js';
import { validFolder } from './releaseReport.js';
import type { CiTicketsPort } from './tickets.js';
import { cleanLog, oneLine, redactSecrets } from './text.js';
import { flakyComment, flakyDescription, flakyExcerpt, flakyTitle, parseFlaky, repoTag, type FlakySighting } from './flaky.js';
import type { CiEventFile, Plan } from './plan.js';
import {
  checkUpstream,
  defaultLookup,
  EMPTY_STATE,
  nextState,
  readState,
  upstreamPin,
  upstreamView,
  withoutUserinfo,
  type Lookup,
  type SyncReply,
} from './upstream.js';

/** The flaky rows of a run, per job: the count and the distinct tickets, in order. */
function flakyOfJobs(rows: { job: string; ticket_id: string | null }[]): CiRunFlaky[] {
  const out: CiRunFlaky[] = [];
  for (const r of rows) {
    let j = out.find((x) => x.job === r.job);
    if (!j) out.push((j = { job: r.job, tests: 0, tickets: [] }));
    j.tests++;
    if (r.ticket_id && !j.tickets.includes(r.ticket_id)) j.tickets.push(r.ticket_id);
  }
  return out;
}

const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** The facts of a run a deployment row copies. */
/** Where a run executes (T-557): the runner that took it, or the repository's workspace. */
export const execOf = (r: Pick<RunRow, 'workspace_id' | 'runner_workspace_id'>): string => r.runner_workspace_id ?? r.workspace_id;
/** The `runs-on` labels a run asked for (T-557), or null for the repository's workspace. */
export function runsOnOf(r: Pick<RunRow, 'runs_on'>): string[] | null {
  if (!r.runs_on) return null;
  try {
    const v = JSON.parse(r.runs_on) as unknown;
    return Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  } catch {
    return null;
  }
}
/** The mirror a runner keeps of a workspace's remote (T-557): never the runner's own remote of the same name. */
export const mirrorOf = (workspaceId: string, repo: string) =>
  `m-${createHash('sha256').update(workspaceId).digest('hex').slice(0, 8)}-${repo}`;
/** Base64 characters per chunk of a bundle on its way to a runner: under cp-ci's 4 MiB stdin and reply caps. */
const BUNDLE_CHUNK = 1_048_576;

const row0 = (r: RunRow) => ({
  id: r.id,
  number: r.number,
  pipeline: r.pipeline,
  sha: r.sha,
  ref: r.ref,
  actor: r.actor,
  created_at: r.created_at,
});

const newRunId = () => `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const WORKSPACE_ID = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SKIP = /\[(?:skip ci|ci skip)\]/i;
const GLOB = /^[A-Za-z0-9._/*?-]{1,200}$/;
const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** One upstream sync's own bound (the runner's fetch gives up at 600 s): it runs beside the poll, never in it. */
const UPSTREAM_SYNC_TIMEOUT_MS = 660_000;

/** A deployment as the API shows it: never its key. */
const deploymentView = (d: DeploymentRow): CiDeployment => ({
  id: d.id,
  runId: d.run_id,
  runNumber: d.run_number,
  pipeline: d.pipeline,
  job: d.job,
  environment: d.environment,
  sha: d.sha,
  ref: d.ref,
  actor: d.actor,
  approval: d.approval,
  decidedBy: d.decided_by,
  decidedAt: d.decided_at,
  outcome: (d.outcome as CiDeployment['outcome']) ?? null,
  createdAt: d.created_at,
  autoApprove:
    d.auto_verdict && d.auto_line && d.auto_at
      ? { mode: d.auto_mode === 'on' ? 'on' : 'dry', verdict: d.auto_verdict, line: d.auto_line, at: d.auto_at }
      : null,
});

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const notFound = (what: string) => new AppError('NOT_FOUND', `No such ${what}.`);

/** A refusal from the runner as the portal's own error. */
function fromReply(r: CiReply): AppError {
  const message = (r.message as string | undefined) ?? 'The workspace refused that.';
  switch (r.error) {
    case 'bad_name':
    case 'bad_path':
    case 'bad_branch':
    case 'bad_ref':
    case 'bad_strategy':
    case 'bad_sha':
    case 'no_path':
    case 'not_a_repo':
    case 'bad_flag':
      return new AppError('VALIDATION_FAILED', message);
    case 'no_repo':
    case 'no_branch':
    case 'no_ref':
    case 'no_commit':
      return new AppError('NOT_FOUND', message);
    case 'exists':
    case 'conflict':
    case 'moved':
    case 'not_ff':
    case 'same_branch':
    case 'too_many':
      return new AppError('CONFLICT', message, r.files ? { details: { files: r.files } } : undefined);
    default:
      return new AppError('SERVICE_UNAVAILABLE', message, { expose: true });
  }
}

export interface CiServiceOptions {
  maxRunsPerWorkspace?: number;
  maxJobsParallel?: number;
  pollActiveMs?: number;
  pollIdleMs?: number;
  /** Redacts text from a workspace; the value redactor for its exposed secrets plugs in here. Always on top of the pattern redactor. */
  redactFor?: (workspaceId: string) => (text: string) => string;
  /** The same for a live read, as a stream. */
  streamFor?: (workspaceId: string) => SessionStream;
  /** Tickets and sessions CI links runs to (interface I10); without them runs are not linked. */
  tickets?: CiTicketsPort;
  sessions?: CiSessionsPort;
  /** Whether a Secrets & env name reaches a workspace (names only, never a value). Without it secret names are not checked before a run. */
  secrets?: (workspaceId: string, name: string) => { kind: string; asFile: boolean; asVariable: boolean } | null;
  /**
   * The VALUE of a secret as the workspace's Secrets & env sets deliver it as a file (T-557), for the lease a runner gets when it takes that
   * workspace's run. In memory only: handed to the runner on stdin, never logged, stored or returned. Without it a run that names a secret
   * can not go to a runner.
   * T-486 S2 uses the same value to check the upstream webhook's signature (the remote's hook secret, a SECRET by name; one rule, one
   * helper: decision on T-486). Never logged, stored, returned or audited there either; null (no such secret, or Locked) refuses every delivery.
   */
  secretValue?: (workspaceId: string, name: string) => string | null;
  /** The platform audit (approvals, protection changes). Names, ids and fixed codes only. */
  audit?: (e: {
    kind: string;
    actor: string;
    userId: string | null;
    severity?: 'info' | 'medium' | 'high';
    subject?: string;
    detail?: Record<string, unknown>;
  }) => void;
  /** The clock of the auto-approve rule (its daily cap and window, FR41a) and of the stg age (T-558); tests pass a fake one. */
  now?: () => Date;
  /** Upstream sync (FR8a): how a host name resolves for the SSRF guard (default: the system's resolver); tests pass a fake one. */
  lookup?: Lookup;
  /**
   * Upstream sync: the only hosts an upstream may be on, read at each use (T-486 S2: the `ci.upstreamHosts` setting). Unset or empty: any
   * host whose every address is public. The SSRF guard holds either way.
   */
  upstreamHosts?: readonly string[] | (() => readonly string[] | undefined);
  /** T-486 S2: the least time between two webhook-kicked syncs of one remote (default UPSTREAM_HOOK_GAP_MS); tests pass a short one. */
  hookGapMs?: number;
  /**
   * T-1637: a run executing on a runner that has not answered for this many minutes ends failed as `runner_lost` (re-run in the
   * repository's workspace when its `runs-on` has `fallback: workspace`). Read at each look (the `ci.runnerLostMin` setting); 0: never.
   * Default RUNNER_LOST_MIN.
   */
  runnerLostMin?: number | (() => number);
}

/** T-1637: the default of `ci.runnerLostMin`, in minutes. */
export const RUNNER_LOST_MIN = 10;

/** T-486 S2: webhook kicks of one remote closer than this coalesce into one sync. */
export const UPSTREAM_HOOK_GAP_MS = 10_000;

/** Who decided something a person must decide (an approval, a protection change): the actor string for records and the user for the audit. */
export interface CiDecider {
  actor: string;
  userId: string | null;
}

/** What other modules hear about (tickets, sessions): called after the change is stored, never allowed to break the service. */
export interface CiHooks {
  created?(run: RunRow): void;
  changed?(run: RunRow, previous: CiStatus | null): void;
  /** A job started waiting for a person's approval (PRD FR41): once per job. Notifications plug in here. */
  waiting?(run: RunRow, job: string, environment: string): void;
  /**
   * A push to a remote's default branch whose commit has `docs/context-pack.md` (T-292): the file as the snapshot read it (text,
   * or why not). The portal keeps the repository's context pack pool in step with it (personas/contextPack.ts).
   */
  contextPack?(e: { workspaceId: string; repo: string; branch: string; sha: string; file: SnapshotFile }): void;
}

interface Polled {
  state: CiRunStateFile | null;
  alive: boolean;
}

export class CiService {
  /** Called after anything changes, for the live socket. */
  onChange?: () => void;
  hooks: CiHooks = {};
  /** Where release reports are written (T-591): the knowledge vault, as the portal. Set after both services exist; unset: no report is written. */
  releaseNotes?: ReleaseNoteSink;
  readonly #reporter: ReleaseReporter;
  readonly #cs: CiStore;
  readonly #opts: Required<
    Omit<
      CiServiceOptions,
      'redactFor' | 'streamFor' | 'tickets' | 'sessions' | 'secrets' | 'secretValue' | 'audit' | 'upstreamHosts' | 'runnerLostMin'
    >
  > &
    Pick<CiServiceOptions, 'redactFor' | 'streamFor' | 'secrets' | 'secretValue' | 'audit' | 'upstreamHosts' | 'runnerLostMin'>;
  /** Runs a runner is being handed right now (T-557), so two workspaces' dispatches can not both fill its last slot. */
  readonly #handing = new Map<string, number>();
  /** Runs whose hand-off is in flight (T-557): handed off beside the poll, never twice at once. */
  readonly #handingRuns = new Set<string>();
  /** T-1637: since when (ms, on `now`) each workspace has not answered a poll; gone once one is answered. In memory: a restart starts over. */
  readonly #unreachable = new Map<string, number>();
  /** T-1637: runs ended in the portal while their host did not answer, per host: the cancel goes to it once it answers again. */
  readonly #recall = new Map<string, Set<string>>();
  /** Upstream sync: when each remote last tried (ms), and the sync in flight per remote (one at a time). */
  readonly #upstreamAt = new Map<string, number>();
  readonly #syncing = new Map<string, Promise<SyncReply>>();
  /** T-486 S2: remotes a webhook asked for while their sync ran: one more sync after it, however many asked. */
  readonly #again = new Set<string>();
  /** T-486 S2: one wake-up timer per remote whose webhook sync is due after the gap. */
  readonly #wake = new Map<string, NodeJS.Timeout>();
  /** The auto-approve rule's evaluations in flight (dry mode), so a test or a shutdown can wait for them. */
  readonly #ruling = new Set<Promise<void>>();
  /** Runs with an approval being decided right now: one decision at a time per run. */
  readonly #deciding = new Set<string>();
  readonly #links: CiLinks;
  readonly #tickets: CiTicketsPort | undefined;
  readonly #polling = new Map<string, Promise<void>>();
  readonly #acks = new Map<string, string[]>();
  readonly #lastPoll = new Map<string, number>();
  readonly #kicked = new Set<string>();
  readonly #complained = new Map<string, string>();
  readonly #live = new Map<string, { stream: SessionStream; offset: number }>();
  #timer: NodeJS.Timeout | undefined;
  /** T-277 layer 4: says in the log which chats are attached while a deploying job runs (null without a sessions port that can tell). */
  readonly #deployChats: DeployChatsWatch | null;
  readonly #maintained = new Map<string, number>();
  #lastPrune = 0;

  constructor(
    private readonly store: Store,
    private readonly host: CiHost,
    opts: CiServiceOptions = {},
  ) {
    this.#cs = new CiStore(store);
    this.#links = new CiLinks(this.#cs, opts.tickets, opts.sessions);
    this.#tickets = opts.tickets;
    const sinkNow = (): ReleaseNoteSink | undefined => this.releaseNotes;
    this.#reporter = new ReleaseReporter({
      cs: this.#cs,
      cp: (ws, args) => this.host.cp(ws, args, { timeoutMs: 30_000 }),
      tickets: opts.tickets,
      get sink() {
        return sinkNow();
      },
      audit: opts.audit,
    });
    const sessions = opts.sessions;
    this.#deployChats = sessions?.attached ? new DeployChatsWatch(() => sessions.attached!()) : null;
    this.#opts = {
      maxRunsPerWorkspace: opts.maxRunsPerWorkspace ?? 2,
      maxJobsParallel: opts.maxJobsParallel ?? 2,
      pollActiveMs: opts.pollActiveMs ?? CI_LIMITS.pollActiveMs,
      pollIdleMs: opts.pollIdleMs ?? CI_LIMITS.pollIdleMs,
      redactFor: opts.redactFor,
      streamFor: opts.streamFor,
      secrets: opts.secrets,
      secretValue: opts.secretValue,
      audit: opts.audit,
      now: opts.now ?? (() => new Date()),
      lookup: opts.lookup ?? defaultLookup,
      upstreamHosts: opts.upstreamHosts,
      hookGapMs: opts.hookGapMs ?? UPSTREAM_HOOK_GAP_MS,
      runnerLostMin: opts.runnerLostMin,
    };
  }

  /** The upstream host allow-list as it is now (a setting may change it at any time); undefined: none. */
  #allowedHosts(): readonly string[] | undefined {
    const h = this.#opts.upstreamHosts;
    const list = typeof h === 'function' ? h() : h;
    return list?.length ? list : undefined;
  }

  /* ---------- Life ---------- */

  /** Whether the portal may act on workspaces and its tables are there; false on a frozen or read-only database. */
  #ok(): boolean {
    try {
      return this.store.deliveryAllowed && this.store.writable && this.#cs.ready;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.#timer) return;
    try {
      if (!this.#ok()) {
        console.log('[ci] not started: the database is not in a state CI can use');
        return;
      }
      this.#timer = setInterval(() => this.#tick(), 1000);
      this.#timer.unref();
      for (const id of this.#cs.workspacesWithRepos()) this.kick(id);
    } catch (e) {
      console.error(`[ci] start failed: ${(e as Error).message}`);
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Looks at a workspace soon instead of at its next turn (a merge was made, a workspace started, a run was asked for). */
  kick(workspaceId: string): void {
    this.#kicked.add(workspaceId);
    this.#lastPoll.set(workspaceId, 0);
  }

  #tick(): void {
    try {
      if (!this.#ok()) return;
      const ids = new Set([...this.#cs.workspacesWithRepos(), ...this.#cs.workspacesWithActiveRuns(), ...this.#kicked]);
      const now = Date.now();
      for (const id of ids) {
        const busy =
          this.#kicked.has(id) ||
          this.#cs.runningRuns(id).length > 0 ||
          this.#cs.queuedRuns(id).length > 0 ||
          (this.#acks.get(id)?.length ?? 0) > 0;
        const every = busy ? this.#opts.pollActiveMs : this.#opts.pollIdleMs;
        if ((this.#lastPoll.get(id) ?? 0) + every <= now) void this.poll(id);
      }
    } catch (e) {
      console.error(`[ci] tick failed: ${(e as Error).message}`);
    }
  }

  /** One look at a workspace: events in, runs followed, queued runs started. A call during one shares it. */
  poll(workspaceId: string): Promise<void> {
    const running = this.#polling.get(workspaceId);
    if (running) return running;
    this.#kicked.delete(workspaceId);
    this.#lastPoll.set(workspaceId, Date.now());
    const p = this.#poll(workspaceId)
      .then(() => void this.#complained.delete(workspaceId))
      .catch((e: unknown) => {
        const message = e instanceof CiUnreachable ? e.message : (e as Error).message;
        // One line per distinct problem, not one per poll.
        if (this.#complained.get(workspaceId) !== message) {
          this.#complained.set(workspaceId, message);
          console.error(`[ci] ${workspaceId}: ${message}`);
        }
      })
      .then(() => this.#runnerLost(workspaceId))
      .catch((e: unknown) => console.error(`[ci] ${workspaceId}: the lost-runner check failed: ${(e as Error).message}`))
      .finally(() => this.#polling.delete(workspaceId));
    this.#polling.set(workspaceId, p);
    return p;
  }

  /* ---------- Following a workspace ---------- */

  async #poll(workspaceId: string): Promise<void> {
    // T-1637: not running, or no answer to the poll: the workspace is unreachable from now (the lost-runner check counts from here).
    let state: Awaited<ReturnType<CiHost['state']>>;
    try {
      state = await this.host.state(workspaceId);
    } catch (e) {
      this.#unreached(workspaceId);
      throw e;
    }
    // Stopped: events wait on the volume and are read after the next start. Gone: its runs stay as history.
    if (state !== 'running') return this.#unreached(workspaceId);
    let following: RunRow[];
    let acks: string[];
    let reply: CiReply;
    try {
      await this.host.install(workspaceId);
      // Upstream sync (FR8a), detached: a slow or stalled upstream never holds this poll (following runs, starting queued ones, approvals).
      // A sync that moved a branch kicks the next poll, which reads the events it wrote.
      this.#upstreams(workspaceId);
      following = this.#cs.runningRuns(workspaceId);
      acks = this.#acks.get(workspaceId) ?? [];
      const args = ['poll'];
      if (acks.length) args.push('--ack', acks.join(','));
      if (following.length) args.push('--runs', following.map((r) => r.id).join(','));
      reply = await this.host.cp(workspaceId, args, { timeoutMs: 20_000 });
    } catch (e) {
      this.#unreached(workspaceId);
      throw e;
    }
    this.#unreachable.delete(workspaceId);
    await this.#recallRuns(workspaceId);
    if (!reply.ok) throw new Error(`poll: ${reply.message ?? reply.error}`);
    this.#acks.set(
      workspaceId,
      (this.#acks.get(workspaceId) ?? []).filter((id) => !acks.includes(id)),
    );

    await this.#repos(workspaceId, (reply.repos as { name: string; hook: string }[] | undefined) ?? []);
    for (const ev of (reply.events as CiEventFile[] | undefined) ?? []) {
      try {
        await this.#event(workspaceId, ev);
      } catch (e) {
        // Left unacknowledged: it comes back on the next poll. Later events wait behind it, in order.
        throw new Error(`event ${ev.id}: ${(e as Error).message}`);
      }
      this.#acks.set(workspaceId, [...(this.#acks.get(workspaceId) ?? []), ev.id]);
    }
    const polled = (reply.runs as Record<string, Polled> | undefined) ?? {};
    for (const row of following) await this.#follow(row, polled[row.id]);
    await this.#dispatch(workspaceId);
    await this.#maintenance(workspaceId);
  }

  /* ---------- Unreachable hosts and lost runners (T-1637) ---------- */

  #unreached(workspaceId: string): void {
    if (!this.#unreachable.has(workspaceId)) this.#unreachable.set(workspaceId, this.#opts.now().getTime());
  }

  /** `ci.runnerLostMin` as it is now: a whole number of minutes, 0 (or anything not a positive number): never. */
  #lostMin(): number {
    const v = this.#opts.runnerLostMin;
    const n = typeof v === 'function' ? v() : (v ?? RUNNER_LOST_MIN);
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Whether a workspace has not answered for `ci.runnerLostMin` minutes or more. */
  #isLost(workspaceId: string): boolean {
    const since = this.#unreachable.get(workspaceId);
    const min = this.#lostMin();
    return since !== undefined && min > 0 && this.#opts.now().getTime() - since >= min * 60_000;
  }

  /**
   * After each look at a workspace: when it is a runner that has not answered for `ci.runnerLostMin` minutes, every run executing on it
   * ends failed as `runner_lost`, and one whose `runs-on` has `fallback: workspace` runs again (the re-run skips the lost runner, so it
   * starts in the repository's workspace). A run executing in its own workspace (no runner) is never ended here: it is followed as before.
   */
  async #runnerLost(workspaceId: string): Promise<void> {
    if (!this.#isLost(workspaceId)) return;
    const min = this.#lostMin();
    for (const row of this.#cs.runningRuns(workspaceId)) {
      if (!row.runner_workspace_id || row.runner_workspace_id !== workspaceId) continue;
      const note: CiDiagnostic = {
        file: '',
        line: 0,
        column: 0,
        path: 'runs-on',
        severity: 'error',
        code: 'runner_lost',
        message: `The runner ${workspaceId} did not answer for ${min} minutes or more.`,
      };
      this.#cs.updateRun(row.id, { diagnostics: JSON.stringify([...json<CiDiagnostic[]>(row.diagnostics, []), note]) });
      this.#remember(workspaceId, row.id);
      console.error(`[ci] ${row.id}: the runner ${workspaceId} did not answer for ${min} minutes: failed as runner_lost`);
      await this.#lost(row, json<CiRunStateFile | null>(row.state, null));
      if (row.plan && (JSON.parse(row.plan) as Plan).runsOnFallback === 'workspace') {
        const again = await this.rerun(row.id, row.actor).catch((e: unknown) => {
          console.error(`[ci] ${row.id}: no re-run on the fallback: ${(e as Error).message}`);
          return null;
        });
        if (again) console.log(`[ci] ${row.id}: re-run as ${again.id} on the fallback (the runner was lost)`);
      }
    }
  }

  /** A run ended in the portal while its host did not answer: the host is told to cancel it once it answers again. */
  #remember(workspaceId: string, runId: string): void {
    const set = this.#recall.get(workspaceId) ?? new Set<string>();
    set.add(runId);
    this.#recall.set(workspaceId, set);
  }

  async #recallRuns(workspaceId: string): Promise<void> {
    const ids = this.#recall.get(workspaceId);
    if (!ids) return;
    this.#recall.delete(workspaceId);
    for (const id of ids) await this.host.cp(workspaceId, ['cancel', id], { timeoutMs: 20_000 }).catch(() => undefined);
  }

  /** Keeps each remote's hook state current, and repairs a hook that is missing or out of date. */
  async #repos(workspaceId: string, seen: { name: string; hook: string }[]): Promise<void> {
    for (const repo of this.#cs.repos(workspaceId)) {
      let hook = seen.find((s) => s.name === repo.name)?.hook ?? 'missing';
      if (hook !== 'ok' && seen.some((s) => s.name === repo.name)) {
        const fixed = await this.host.cp(workspaceId, ['repo', 'ensure', repo.name]).catch(() => null);
        if (fixed?.ok) hook = (fixed.hook as string) ?? 'ok';
      }
      if (hook !== repo.hook_state) {
        this.#cs.updateRepo(repo.id, { hook_state: hook });
        this.#changed();
      }
    }
  }

  /* ---------- Upstream sync (FR8a, T-486) ---------- */

  /**
   * Each remote of the workspace that follows an upstream and is due: one sync, started and not waited for (the poll goes on at once).
   * One at a time per remote (`#sync`); a remote still syncing is skipped. A failure is kept on the remote, never fails the poll.
   */
  #upstreams(workspaceId: string): void {
    const now = Date.now();
    for (const repo of this.#cs.repos(workspaceId)) {
      if (!repo.upstream_url || this.#syncing.has(repo.id)) continue;
      const every = (repo.upstream_every_s ?? 30) * 1000;
      if ((this.#upstreamAt.get(repo.id) ?? 0) + every > now) continue;
      void this.#sync(repo, null).catch(() => undefined);
    }
  }

  /** One sync of a remote, shared with a call that comes while it runs. Bounded by its own timeout (`UPSTREAM_SYNC_TIMEOUT_MS`). */
  #sync(repo: RepoRow, by: CiDecider | null): Promise<SyncReply> {
    const running = this.#syncing.get(repo.id);
    if (running) return running;
    const started = Date.now();
    this.#upstreamAt.set(repo.id, started);
    this.#again.delete(repo.id);
    const p = this.#syncOnce(repo, by).finally(() => {
      this.#syncing.delete(repo.id);
      // A webhook came while this sync ran: the push it announced may be newer than this fetch. One more, due one gap after this start.
      if (this.#again.delete(repo.id)) this.#dueAt(repo, started + this.#opts.hookGapMs);
    });
    this.#syncing.set(repo.id, p);
    return p;
  }

  /** Makes a remote's next sync due at `at` (ms) instead of after its `everyS`, and has the workspace looked at soon. */
  #dueAt(repo: RepoRow, at: number): void {
    const every = (repo.upstream_every_s ?? 30) * 1000;
    this.#upstreamAt.set(repo.id, Math.min(this.#upstreamAt.get(repo.id) ?? 0, at - every));
    this.kick(repo.workspace_id);
    // Due later than now (the gap): look again then, not at the next idle poll.
    const wait = at - Date.now();
    if (wait > 0 && !this.#wake.has(repo.id)) {
      const t = setTimeout(() => {
        this.#wake.delete(repo.id);
        this.kick(repo.workspace_id);
      }, wait);
      t.unref();
      this.#wake.set(repo.id, t);
    }
  }

  /**
   * T-486 S2: the upstream's webhook asks for a sync now. It never fetches here: it only makes the remote's detached, one-at-a-time sync due
   * (started by the next poll). Kicks coalesce: during a sync they ask for ONE more after it; otherwise a sync at most every
   * `UPSTREAM_HOOK_GAP_MS` per remote. The caller has checked the signature and the seam.
   */
  kickUpstream(id: string): void {
    const repo = this.#cs.repo(id);
    if (!repo || repo.removed_at || !repo.upstream_url) return;
    if (this.#syncing.has(id)) {
      this.#again.add(id);
      return;
    }
    this.#dueAt(repo, Math.max(Date.now(), (this.#upstreamAt.get(id) ?? 0) + this.#opts.hookGapMs));
  }

  /**
   * T-486 S2: what the webhook route needs to check a delivery for remote `id`: its workspace and the signing value, or null (no such
   * remote, it follows no upstream, no hook secret set, or the value is not available). The value is never kept beyond the check.
   */
  upstreamHookKey(id: string): { workspaceId: string; key: string } | null {
    if (!this.#ok()) return null;
    const repo = this.#cs.repo(id);
    if (!repo || repo.removed_at || !repo.upstream_url || !repo.upstream_hook_secret) return null;
    const key = this.#opts.secretValue?.(repo.workspace_id, repo.upstream_hook_secret) ?? null;
    return key ? { workspaceId: repo.workspace_id, key } : null;
  }

  async #syncOnce(repo: RepoRow, by: CiDecider | null): Promise<SyncReply> {
    const url = repo.upstream_url!;
    const prev = readState(repo.upstream_state);
    const at = new Date().toISOString();
    const fail = (message: string): never => {
      const error = oneLine(withoutUserinfo(this.#redact(repo.workspace_id, message)))?.slice(0, 300) ?? 'The sync failed.';
      // T-486 S2: the first failure of a row is when the Needs you item starts; a later, different message keeps that time.
      const errorSince = (prev.error && prev.errorSince) || at;
      if (prev.error !== error || prev.errorSince !== errorSince) {
        // Only if it still follows this upstream (it may have been changed or removed while this sync ran).
        const still = this.#cs.repo(repo.id);
        if (still && !still.removed_at && still.upstream_url === url) {
          this.#cs.updateRepo(repo.id, { upstream_state: JSON.stringify({ ...prev, at, error, errorSince }) });
          this.#changed();
        }
      }
      throw new AppError('SERVICE_UNAVAILABLE', error, { expose: true });
    };
    // The SSRF guard, before every sync: the host may resolve elsewhere now. git is pinned to the address checked here.
    let pin: string;
    try {
      pin = await upstreamPin(url, this.#opts.lookup, this.#allowedHosts());
    } catch (e) {
      return fail((e as Error).message);
    }
    const args = ['repo', 'sync', repo.name, '--url', url, '--pin', pin];
    if (repo.upstream_secret) args.push('--secret', repo.upstream_secret);
    // The upstream was changed or removed since the last sync: the runner clears the old one's staging refs first (a baseline again).
    if (prev.reset) args.push('--reset');
    let r: CiReply;
    try {
      r = await this.host.cp(repo.workspace_id, args, { timeoutMs: UPSTREAM_SYNC_TIMEOUT_MS });
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!r.ok) return fail(String(r.message ?? r.error ?? 'The sync failed.'));
    const reply: SyncReply = {
      moved: Array.isArray(r.moved) ? (r.moved as SyncReply['moved']) : [],
      diverged: Array.isArray(r.diverged) ? (r.diverged as SyncReply['diverged']) : [],
      ahead: Array.isArray(r.ahead) ? (r.ahead as string[]) : [],
      deleted: Array.isArray(r.deleted) ? (r.deleted as string[]) : [],
      onlyHere: Array.isArray(r.onlyHere) ? (r.onlyHere as string[]) : [],
    };
    // The upstream may have been changed or removed while this sync ran: its result belongs to the old one, and the reset mark stays.
    const now = this.#cs.repo(repo.id);
    if (!now || now.removed_at || now.upstream_url !== url) return reply;
    const next = nextState(prev, reply, at);
    const shown = (s: typeof prev) => JSON.stringify({ ...s, at: null });
    this.#cs.updateRepo(repo.id, { upstream_state: JSON.stringify(next) });
    if (reply.moved.length) {
      // Names, counts and shas only: the URL is the person's setting, the secret only its name; never a value.
      this.#opts.audit?.({
        kind: 'ci.upstream_synced',
        actor: by?.actor ?? 'upstream',
        userId: by?.userId ?? null,
        subject: `ci_repo:${repo.id}`,
        detail: {
          workspace: repo.workspace_id,
          repo: repo.name,
          moved: reply.moved.length,
          branches: reply.moved.slice(0, 20).map((m) => ({ branch: m.branch, old: m.old, new: m.new })),
        },
      });
      this.kick(repo.workspace_id);
    }
    if (reply.moved.length || shown(prev) !== shown(next)) this.#changed();
    return reply;
  }

  #redact(workspaceId: string, text: string): string {
    const r = this.#opts.redactFor?.(workspaceId);
    return redactSecrets(r ? r(text) : text);
  }

  /** `POST /api/ci/repos/:id/sync`: sync now (the Needs you item's action). */
  async syncUpstream(id: string, by: CiDecider | null): Promise<CiUpstreamSyncResult> {
    const repo = this.#needRepo(id);
    if (!repo.upstream_url) throw new AppError('CONFLICT', 'This remote follows no upstream.');
    await this.#running(repo.workspace_id);
    const reply = await this.#sync(repo, by);
    return { moved: reply.moved, repo: await this.repo(repo.id) };
  }

  /* ---------- Events become runs ---------- */

  async #event(workspaceId: string, ev: CiEventFile): Promise<void> {
    if (this.#cs.eventSeen(workspaceId, ev.id)) return;
    const repo = this.#cs.repoByName(workspaceId, ev.repo);
    const record = (outcome: string, note: string | null = null) =>
      this.#cs.insertEvent({
        workspace_id: workspaceId,
        id: ev.id,
        repo_id: repo?.id ?? null,
        repo: ev.repo,
        kind: ev.kind,
        ref: ev.ref,
        old_sha: ev.old,
        new_sha: ev.new,
        via: ev.via,
        at: ev.at,
        outcome,
        note,
      });
    if (!repo) return record('ignored', 'not one of the portal’s remotes');
    if (ev.kind === 'delete') return record('ignored', 'ref deleted');
    const branch = branchOf(ev.ref);
    const protectedBranch = !!branch && globMatches(json<string[]>(repo.protected, []), branch);
    const trigger: CiTrigger = protectedBranch ? 'merge' : 'push';

    const snap = (await this.host.cp(workspaceId, ['snapshot', repo.name, ev.new], { timeoutMs: 30_000 })) as CiReply & {
      message?: string;
      subject?: string;
      hasPilot?: boolean;
      files?: SnapshotFile[];
      contextPack?: SnapshotFile | null;
    };
    if (!snap.ok) {
      if (snap.error === 'no_commit') return record('ignored', 'the commit is no longer in the remote');
      throw new Error(snap.message ?? snap.error ?? 'snapshot failed');
    }
    // The context pack follows the default branch, whatever the pipelines do with the push ([skip ci] included).
    const pack = snap.contextPack;
    if (pack && branch === repo.default_branch)
      this.#hook(() => this.hooks.contextPack?.({ workspaceId, repo: repo.name, branch, sha: ev.new, file: pack }));
    if (SKIP.test(snap.message ?? '')) return record('skipped', '[skip ci] in the commit message');
    if (!snap.hasPilot) return record('no_pipeline', 'no .pilot folder');
    const { pipelines } = validateFiles(snap.files ?? []);
    if (!pipelines.length) return record('no_pipeline', 'no pipeline file in .pilot');
    if (this.#cs.queuedRuns(workspaceId).length >= CI_LIMITS.queuedPerWorkspace)
      return record('queue_full', `${CI_LIMITS.queuedPerWorkspace} runs are already waiting`);

    const made: RunRow[] = [];
    this.#cs.tx(() => {
      for (const v of pipelines) {
        const wanted = !v.pipeline || matches(v.pipeline, { event: trigger, ref: ev.ref });
        if (!wanted) continue;
        made.push(
          this.#insertRun(repo, v, {
            event: trigger,
            ref: ev.ref,
            sha: ev.new,
            base: ev.old === '0'.repeat(40) ? null : ev.old,
            actor: ev.via === 'portal' ? 'ui' : 'push',
            inputs: {},
            eventId: ev.id,
            subject: snap.subject ?? null,
            trigger,
          }),
        );
      }
      record(
        made.length ? 'runs' : 'no_match',
        made.length ? `${made.length} run${made.length === 1 ? '' : 's'}` : 'no pipeline matches this ref',
      );
    });
    if (made.length) {
      for (const run of made) this.#born(run, snap.message ?? null);
      this.#changed();
    }
  }

  /** Records one run for a pipeline: queued with its plan, or failed at once when the file is invalid. */
  #insertRun(
    repo: RepoRow,
    v: Validated,
    o: {
      event: EventContext['event'];
      ref: string;
      sha: string;
      base: string | null;
      actor: string;
      inputs: Record<string, string | boolean>;
      eventId: string | null;
      subject: string | null;
      trigger: CiTrigger;
      rerunOf?: string;
      sessionId?: string | null;
      actorLabel?: string | null;
    },
  ): RunRow {
    const number = this.#cs.nextNumber(repo.id);
    const id = newRunId();
    const now = new Date().toISOString();
    const base: RunRow = {
      id,
      number,
      workspace_id: repo.workspace_id,
      repo_id: repo.id,
      repo: repo.name,
      pipeline: v.info.file.slice(v.info.file.lastIndexOf('/') + 1).replace(/\.ya?ml$/, ''),
      trigger: o.trigger,
      event_id: o.eventId,
      ref: o.ref,
      branch: branchOf(o.ref),
      tag: tagOf(o.ref),
      sha: o.sha,
      base_sha: o.base,
      subject: oneLine(o.subject),
      status: 'queued',
      reason: null,
      actor: o.actor,
      actor_label: oneLine(o.actorLabel)?.slice(0, 60) ?? null,
      inputs: JSON.stringify(o.inputs),
      ticket_id: null,
      ticket_source: null,
      session_id: o.sessionId ?? null,
      rerun_of: o.rerunOf ?? null,
      concurrency_group: null,
      cancel_in_progress: 0,
      plan: null,
      state: null,
      diagnostics: null,
      attempts: 0,
      created_at: now,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      archived: 0,
    };
    let row: RunRow = base;
    if (!v.pipeline) {
      row = {
        ...base,
        status: 'failed',
        reason: 'invalid_pipeline',
        diagnostics: JSON.stringify(v.info.diagnostics),
        finished_at: now,
        duration_ms: 0,
        archived: 1,
      };
    } else {
      const ctx: EventContext = {
        event: o.event,
        ref: o.ref,
        sha: o.sha,
        base: o.base,
        actor: o.actor,
        repo: repo.name,
        ticket: null,
        inputs: o.inputs,
        workspace: repo.workspace_id,
        runId: id,
        runNumber: number,
      };
      const c = compile(v.pipeline, ctx, { maxParallel: this.#opts.maxJobsParallel });
      const missing = c.ok
        ? this.#missingSecrets(
            repo.workspace_id,
            c.plan.jobs.filter((j) => !j.skip),
            v.info.file,
          )
        : [];
      const gates = c.ok && !missing.length ? this.#gates(repo, c.plan, row0(base)) : null;
      row = !c.ok
        ? {
            ...base,
            status: 'failed',
            reason: 'invalid_pipeline',
            diagnostics: JSON.stringify(c.diagnostics),
            finished_at: now,
            duration_ms: 0,
            archived: 1,
          }
        : missing.length
          ? {
              ...base,
              status: 'failed',
              reason: 'invalid_pipeline',
              diagnostics: JSON.stringify(missing),
              finished_at: now,
              duration_ms: 0,
              archived: 1,
            }
          : gates && 'problem' in gates
            ? {
                ...base,
                status: 'failed',
                reason: 'invalid_pipeline',
                diagnostics: JSON.stringify([gates.problem]),
                finished_at: now,
                duration_ms: 0,
                archived: 1,
              }
            : {
                ...base,
                plan: JSON.stringify(c.plan),
                concurrency_group: c.group,
                cancel_in_progress: c.cancelInProgress ? 1 : 0,
                ...(c.plan.runsOn && this.#cs.runnersReady ? { runs_on: JSON.stringify(c.plan.runsOn) } : {}),
              };
      this.#cs.insertRun(row);
      if (gates && 'deployments' in gates && row.status === 'queued') for (const d of gates.deployments) this.#cs.insertDeployment(d);
      return row;
    }
    this.#cs.insertRun(row);
    return row;
  }

  /**
   * Environments for a plan's jobs (PRD FR41): each named environment is found or made (protected), and a job that deploys to a protected one
   * gets a gate: the SHA-256 of a fresh random key, which the portal keeps and hands to the runner only when a person approves. Changes the
   * plan in place and returns the deployment rows to store with the run. Fails closed: without the tables, a deployment can not run.
   */
  #gates(
    repo: RepoRow,
    plan: Plan,
    run: Pick<RunRow, 'id' | 'number' | 'pipeline' | 'sha' | 'ref' | 'actor' | 'created_at'>,
  ): { deployments: DeploymentRow[] } | { problem: CiDiagnostic } {
    const jobs = plan.jobs.filter((j) => j.environment && !j.skip);
    for (const j of plan.jobs) j.approval = null;
    if (!jobs.length) return { deployments: [] };
    if (!this.#cs.deploymentsReady)
      return {
        problem: {
          file: '',
          line: 0,
          column: 0,
          path: `jobs.${jobs[0]!.id}.environment`,
          severity: 'error',
          code: 'no-environments',
          message: 'This portal can not hold deployment approvals yet (its database is not up to date).',
        },
      };
    const deployments: DeploymentRow[] = [];
    for (const j of jobs) {
      const env = this.#cs.ensureEnvironment(repo.id, j.environment!, 'system', newId('e'));
      let key: string | null = null;
      if (env.protected) {
        key = randomBytes(32).toString('hex');
        j.approval = { environment: env.name, gate: createHash('sha256').update(key).digest('hex') };
      }
      deployments.push({
        id: newId('d'),
        run_id: run.id,
        run_number: run.number,
        job: j.id,
        repo_id: repo.id,
        environment: env.name,
        pipeline: run.pipeline,
        sha: run.sha,
        ref: run.ref,
        actor: run.actor,
        approval: key ? 'pending' : 'auto',
        gate_key: key,
        decided_by: null,
        decided_at: null,
        outcome: null,
        owner_id: env.owner_id,
        created_by: 'u_owner',
        created_at: run.created_at,
      });
    }
    return { deployments };
  }

  /** The secrets jobs name that this workspace can't give them (a name not assigned, or one that reaches Claude Code only as a variable). */
  #missingSecrets(
    workspaceId: string,
    jobs: { id: string; secrets: string[] }[],
    file: string,
    severity: 'error' | 'warning' = 'error',
  ): CiDiagnostic[] {
    const check = this.#opts.secrets;
    if (!check) return [];
    const out: CiDiagnostic[] = [];
    for (const job of jobs) {
      for (const name of job.secrets) {
        const found = check(workspaceId, name);
        if (found?.asFile) continue;
        out.push({
          file,
          line: 0,
          column: 0,
          path: `jobs.${job.id}.secrets`,
          severity,
          code: 'secret-missing',
          message: found
            ? `${name} reaches Claude Code as a variable only, so a job can't use it.`
            : `The secret ${name} is not available in this workspace.`,
          hint: 'Assign it in Secrets & env as a secret or a tool login, then run again.',
        });
      }
    }
    return out;
  }

  /* ---------- Starting runs ---------- */

  async #dispatch(workspaceId: string): Promise<void> {
    let free = this.#opts.maxRunsPerWorkspace - this.#cs.runningRuns(workspaceId).length;
    for (const run of this.#cs.queuedRuns(workspaceId)) {
      if (free <= 0) break;
      if (!run.plan) {
        this.#cs.updateRun(run.id, { status: 'failed', reason: 'invalid_pipeline', finished_at: new Date().toISOString(), archived: 1 });
        continue;
      }
      if (run.concurrency_group) {
        const others = this.#cs.activeInGroup(run.repo_id, run.concurrency_group, run.id).filter((o) => o.created_at <= run.created_at);
        if (others.length) {
          if (run.cancel_in_progress)
            for (const o of others)
              await this.#cancelRow(o, 'superseded', { actor: 'pipeline', note: `for #${run.number}` }).catch(() => undefined);
          // Either way this one waits for the group to be clear; the next look starts it.
          continue;
        }
      }
      // `runs-on` (T-557): a runner takes it, not this workspace's own slots.
      const labels = runsOnOf(run);
      if (labels) {
        // Beside the poll, never inside it: a slow or stalled runner (a tunnel that resets, a bundle that takes minutes) must not hold
        // this workspace's own runs, events and approvals (seen on a Docker Desktop runner, 2026-10-15).
        if (!this.#handingRuns.has(run.id)) {
          this.#handingRuns.add(run.id);
          void this.#toRunner(run, labels)
            .catch((e: unknown) => this.#retry(this.#cs.run(run.id) ?? run, `runner: ${(e as Error).message}`))
            .finally(() => this.#handingRuns.delete(run.id));
        }
        continue;
      }
      const text = run.plan;
      let reply: CiReply;
      try {
        reply = await this.host.cp(workspaceId, ['start', run.id, '--bytes', String(Buffer.byteLength(text))], {
          stdin: text,
          timeoutMs: 30_000,
        });
      } catch (e) {
        this.#retry(run, (e as Error).message);
        continue;
      }
      if (reply.ok) {
        this.#cs.updateRun(run.id, { status: 'running', started_at: new Date().toISOString(), attempts: 0 });
        this.#changed();
        this.#moved(run.id, 'queued');
        console.log(`[ci] ${run.id} started ${run.pipeline} on ${run.repo}@${shortSha(run.sha)}`);
        free--;
      } else if (reply.error === 'no_space') {
        this.#finishFailed(run, 'no_space', 'The workspace is almost out of disk space.');
      } else if (reply.error === 'bad_plan') {
        this.#finishFailed(run, 'runner_error', reply.message ?? 'The runner refused the plan.');
      } else this.#retry(run, reply.message ?? reply.error ?? 'start failed');
    }
  }

  /**
   * A run with `runs-on` (T-557): the least busy enabled runner whose labels include all of the run's, running and with a free slot, gets
   * the commit (a bundle into its mirror of this remote, only what it lacks), the run's secrets (a lease on stdin, from the repository
   * workspace's Secrets & env), and the plan. No runner carries the labels at all: the run fails at once as `no_runner`. Runners exist but
   * none is free or online: it waits, up to `runnerWaitMs` from when it was queued. A failure on the way is retried like a start (3 tries).
   * With `fallback: workspace` (owner, 2026-10-15) none of that waits or fails: no runner, none ready, or a hand-off that fails starts the run
   * in the repository's workspace at once, and the run says why.
   */
  async #toRunner(run: RunRow, labels: string[]): Promise<void> {
    // Read again: the run may have been cancelled or started since the poll listed it.
    const live = this.#cs.run(run.id);
    if (!live || live.status !== 'queued') return;
    run = live;
    const fallback = (JSON.parse(run.plan!) as Plan).runsOnFallback === 'workspace';
    const fits = this.#cs.runners().filter((r) => {
      const has = new Set(JSON.parse(r.labels) as string[]);
      return r.enabled && labels.every((l) => has.has(l));
    });
    if (!fits.length) {
      if (fallback) return this.#startHere(run, `no runner has the labels ${labels.join(', ')}`);
      return this.#finishFailed(
        run,
        'no_runner',
        `No runner has the labels ${labels.join(', ')}. Add one in CI > Runners, or change runs-on.`,
      );
    }
    const ready: { id: string; load: number }[] = [];
    for (const r of fits) {
      if (r.drained || this.#isLost(r.workspace_id)) continue;
      const state = await this.host.state(r.workspace_id).catch(() => 'gone' as const);
      if (state !== 'running') continue;
      const load = this.#cs.runningRuns(r.workspace_id).length + (this.#handing.get(r.workspace_id) ?? 0);
      if (load < r.max_runs) ready.push({ id: r.workspace_id, load });
    }
    if (!ready.length) {
      if (fallback) return this.#startHere(run, `no runner with the labels ${labels.join(', ')} is online and free`);
      if (Date.now() - Date.parse(run.created_at) > CI_LIMITS.runnerWaitMs)
        this.#finishFailed(
          run,
          'no_runner',
          `No runner with the labels ${labels.join(', ')} was online and free for ${Math.round(CI_LIMITS.runnerWaitMs / 60_000)} minutes.`,
        );
      return;
    }
    const runner = ready.sort((a, b) => a.load - b.load || a.id.localeCompare(b.id))[0]!.id;
    this.#handing.set(runner, (this.#handing.get(runner) ?? 0) + 1);
    const local = runner === run.workspace_id;
    let leased = false;
    try {
      const plan = JSON.parse(run.plan!) as Plan;
      const names = [...new Set(plan.jobs.filter((j) => !j.skip).flatMap((j) => j.secrets))];
      if (!local) {
        await this.host.install(runner);
        plan.mirror = mirrorOf(run.workspace_id, run.repo);
        // A step can tell where it runs: on a runner (its workspace id), or, without this, in the repository's own workspace.
        plan.env = { ...plan.env, PILOT_RUNNER: runner };
        await this.#sendCommit(run, runner, plan.mirror);
        if (names.length) {
          const values: Record<string, string> = {};
          for (const name of names) {
            const v = this.#opts.secretValue?.(run.workspace_id, name) ?? null;
            if (v === null)
              return this.#finishFailed(
                run,
                'invalid_pipeline',
                `The secret ${name} is not available in the repository's workspace, so it can not be handed to a runner.`,
              );
            values[name] = v;
          }
          const text = JSON.stringify(values);
          const lease = await this.host.cp(runner, ['lease', run.id, '--bytes', String(Buffer.byteLength(text))], {
            stdin: text,
            timeoutMs: 30_000,
          });
          if (!lease.ok) throw new Error(lease.message ?? lease.error ?? 'the lease was refused');
          plan.leased = true;
          leased = true;
        }
      }
      const text = JSON.stringify(plan);
      const reply = await this.host.cp(runner, ['start', run.id, '--bytes', String(Buffer.byteLength(text))], {
        stdin: text,
        timeoutMs: 30_000,
      });
      if (!reply.ok) {
        if (reply.error === 'no_space') return this.#finishFailed(run, 'no_space', 'The runner is almost out of disk space.');
        if (reply.error === 'bad_plan') return this.#finishFailed(run, 'runner_error', reply.message ?? 'The runner refused the plan.');
        throw new Error(reply.message ?? reply.error ?? 'start failed');
      }
      leased = false;
      this.#cs.updateRun(run.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        attempts: 0,
        runner_workspace_id: local ? null : runner,
      });
      this.#changed();
      this.#moved(run.id, 'queued');
      this.kick(runner);
      console.log(`[ci] ${run.id} started ${run.pipeline} on ${run.repo}@${shortSha(run.sha)} on the runner ${runner}`);
      this.#opts.audit?.({
        kind: 'ci.run_on_runner',
        actor: run.actor,
        userId: null,
        subject: `ci_run:${run.id}`,
        detail: { workspace: run.workspace_id, runner, labels, secrets: names, repo: run.repo, run: run.number, sha: shortSha(run.sha) },
      });
    } catch (e) {
      if (fallback) await this.#startHere(run, `the hand-off to the runner ${runner} failed: ${(e as Error).message}`);
      else this.#retry(run, `runner ${runner}: ${(e as Error).message}`);
    } finally {
      // A lease handed over for a start that did not happen goes again (the runner's gc removes it after a day otherwise).
      if (leased) await this.host.cp(runner, ['lease', run.id, '--drop']).catch(() => undefined);
      const n = (this.#handing.get(runner) ?? 1) - 1;
      if (n > 0) this.#handing.set(runner, n);
      else this.#handing.delete(runner);
    }
  }

  /**
   * `fallback: workspace`: the run starts in the repository's workspace like a run without `runs-on` (its plan as compiled: no mirror, no
   * lease, no PILOT_RUNNER), within the workspace's own run slots (full: it stays queued and the next look tries the runners again), and
   * says why as a warning on the run.
   */
  async #startHere(run: RunRow, why: string): Promise<void> {
    const live = this.#cs.run(run.id);
    if (!live || live.status !== 'queued') return;
    if (this.#cs.runningRuns(live.workspace_id).length >= this.#opts.maxRunsPerWorkspace) return;
    const text = live.plan!;
    let reply: CiReply;
    try {
      reply = await this.host.cp(live.workspace_id, ['start', live.id, '--bytes', String(Buffer.byteLength(text))], {
        stdin: text,
        timeoutMs: 30_000,
      });
    } catch (e) {
      return this.#retry(live, (e as Error).message);
    }
    if (!reply.ok) {
      if (reply.error === 'no_space') return this.#finishFailed(live, 'no_space', 'The workspace is almost out of disk space.');
      if (reply.error === 'bad_plan') return this.#finishFailed(live, 'runner_error', reply.message ?? 'The runner refused the plan.');
      return this.#retry(live, reply.message ?? reply.error ?? 'start failed');
    }
    const note: CiDiagnostic = {
      file: '',
      line: 0,
      column: 0,
      path: 'runs-on',
      severity: 'warning',
      code: 'runner-fallback',
      message: `Ran in the repository's workspace: ${why}.`,
    };
    this.#cs.updateRun(live.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      attempts: 0,
      runner_workspace_id: null,
      diagnostics: JSON.stringify([note]),
    });
    this.#changed();
    this.#moved(live.id, 'queued');
    this.kick(live.workspace_id);
    console.log(`[ci] ${live.id} started ${live.pipeline} on ${live.repo}@${shortSha(live.sha)} in its workspace (fallback: ${why})`);
    this.#opts.audit?.({
      kind: 'ci.run_fallback',
      actor: live.actor,
      userId: null,
      subject: `ci_run:${live.id}`,
      detail: { workspace: live.workspace_id, why, repo: live.repo, run: live.number },
    });
  }

  /** The commit into the runner's mirror (T-557): what the mirror already has is left out; nothing travels when it has the commit. */
  async #sendCommit(run: RunRow, runner: string, mirror: string): Promise<void> {
    const heads = await this.host.cp(runner, ['mirror', 'heads', mirror, '--sha', run.sha], { timeoutMs: 30_000 });
    if (!heads.ok) throw new Error(heads.message ?? heads.error ?? 'the runner did not say what it has');
    if (heads.has === true) return;
    const haves = ((heads.heads as string[] | undefined) ?? []).slice(0, 50);
    const made = await this.host.cp(
      run.workspace_id,
      ['repo', 'bundle', run.repo, run.sha, '--id', run.id, ...(haves.length ? ['--haves', haves.join(',')] : [])],
      { timeoutMs: 600_000 },
    );
    if (!made.ok) throw new Error(made.message ?? made.error ?? 'the bundle failed');
    if (made.empty === true) return;
    try {
      let offset = 0;
      for (let part = 0; ; part++) {
        const chunk = await this.host.cp(
          run.workspace_id,
          ['repo', 'outbox', run.id, '--offset', String(offset), '--max', String(BUNDLE_CHUNK)],
          { timeoutMs: 60_000 },
        );
        if (!chunk.ok || typeof chunk.data !== 'string') throw new Error(chunk.message ?? chunk.error ?? 'the bundle could not be read');
        const last = chunk.done === true;
        const put = await this.host.cp(
          runner,
          [
            'mirror',
            'put',
            mirror,
            run.id,
            run.sha,
            '--part',
            String(part),
            ...(last ? ['--last'] : []),
            '--bytes',
            String(Buffer.byteLength(chunk.data)),
          ],
          { stdin: chunk.data, timeoutMs: last ? 600_000 : 120_000 },
        );
        if (!put.ok) throw new Error(put.message ?? put.error ?? 'the runner refused the bundle');
        if (last) return;
        offset = Number(chunk.next);
      }
    } finally {
      await this.host.cp(run.workspace_id, ['repo', 'outbox', run.id, '--drop']).catch(() => undefined);
    }
  }

  /* ---------- Runners (T-557) ---------- */

  /** Every runner with its workspace's state and the runs executing on it now. */
  async runners(): Promise<CiRunner[]> {
    const states = await this.host.states();
    return this.#cs.runners().map((r) => this.#runnerView(r, states));
  }

  #runnerView(r: RunnerRow, states: Map<string, 'running' | 'stopped'>): CiRunner {
    const s = states.get(r.workspace_id);
    return {
      workspaceId: r.workspace_id,
      labels: json<string[]>(r.labels, []),
      maxRuns: r.max_runs,
      enabled: r.enabled === 1,
      drained: r.drained === 1,
      note: r.note,
      state: s === 'running' ? 'online' : s === 'stopped' ? 'offline' : 'gone',
      running: this.#cs.runningRuns(r.workspace_id).length,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Makes a workspace a runner, or changes one (a person's act, audited). Labels: lowercase, at most `runnerLabelsPerRunner`. */
  async upsertRunner(workspaceId: string, req: Partial<UpsertCiRunnerRequest>, by: CiDecider): Promise<CiRunner> {
    if (!this.#cs.runnersReady)
      throw new AppError('SERVICE_UNAVAILABLE', 'This portal can not hold runners yet (its database is not up to date).');
    if (!/^[^/]+\/[^/]+$/.test(workspaceId)) throw invalid('workspaceId', 'A workspace id is <target>/<name>.');
    if ((await this.host.state(workspaceId)) === 'gone') throw notFound('workspace');
    const was = this.#cs.runner(workspaceId);
    if (!Array.isArray(req.labels) && !was) throw invalid('labels', 'Give the runner at least one label.');
    const raw: unknown[] = Array.isArray(req.labels) ? req.labels : json<string[]>(was!.labels, []);
    const labels = [...new Set(raw.map((l) => (typeof l === 'string' ? l.trim().toLowerCase() : '')))].sort();
    if (!labels.length) throw invalid('labels', 'Give the runner at least one label.');
    if (labels.length > CI_LIMITS.runnerLabelsPerRunner)
      throw invalid('labels', `A runner has at most ${CI_LIMITS.runnerLabelsPerRunner} labels.`);
    const bad: string | undefined = labels.find((l) => !RUNNER_LABEL.test(l) || l === 'self-hosted' || l === 'workspace');
    if (bad !== undefined)
      throw invalid(
        'labels',
        `"${bad.slice(0, 40)}" is not a runner label: lowercase letters, digits, ".", "-" and "_" (self-hosted and workspace are reserved).`,
      );
    const maxRuns = req.maxRuns ?? was?.max_runs ?? 1;
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > CI_LIMITS.runnerMaxRuns)
      throw invalid('maxRuns', `A runner takes 1 to ${CI_LIMITS.runnerMaxRuns} runs at once.`);
    const note = req.note === undefined ? (was?.note ?? null) : req.note === null ? null : String(req.note).slice(0, 200);
    const row = this.#cs.upsertRunner(
      {
        workspace_id: workspaceId,
        labels: JSON.stringify(labels),
        max_runs: maxRuns,
        enabled: (req.enabled ?? (was ? was.enabled === 1 : true)) ? 1 : 0,
        drained: (req.drained ?? (was ? was.drained === 1 : false)) ? 1 : 0,
        note,
      },
      by.actor,
    );
    this.#opts.audit?.({
      kind: 'ci.runner_changed',
      actor: by.actor,
      userId: by.userId,
      severity: 'medium',
      subject: `workspace:${workspaceId}`,
      detail: { workspace: workspaceId, labels, maxRuns, enabled: row.enabled === 1, drained: row.drained === 1, created: !was },
    });
    this.#changed();
    return this.#runnerView(row, await this.host.states());
  }

  /** A runner no more. Its running runs finish; queued runs that need its labels wait for another, or fail as `no_runner` later. */
  async removeRunner(workspaceId: string, by: CiDecider): Promise<void> {
    if (!this.#cs.removeRunner(workspaceId)) throw notFound('runner');
    this.#opts.audit?.({
      kind: 'ci.runner_changed',
      actor: by.actor,
      userId: by.userId,
      severity: 'medium',
      subject: `workspace:${workspaceId}`,
      detail: { workspace: workspaceId, removed: true },
    });
    this.#changed();
  }

  #retry(run: RunRow, why: string): void {
    const attempts = run.attempts + 1;
    if (attempts >= 3) return this.#finishFailed(run, 'runner_error', why);
    this.#cs.updateRun(run.id, { attempts });
    console.error(`[ci] ${run.id}: could not start (${attempts}/3): ${why}`);
  }

  #finishFailed(run: RunRow, reason: string, note: string): void {
    const now = new Date().toISOString();
    this.#cs.updateRun(run.id, {
      status: 'failed',
      reason,
      finished_at: now,
      duration_ms: 0,
      archived: 1,
      diagnostics: JSON.stringify([{ file: '', line: 0, column: 0, path: '', severity: 'error', code: reason, message: note }]),
    });
    this.#settleDeployments(run.id, null);
    this.#changed();
    this.#moved(run.id, run.status);
  }

  /* ---------- Following runs ---------- */

  async #follow(row: RunRow, polled: Polled | undefined): Promise<void> {
    if (!polled) return;
    // Read again (T-1637): the run may have ended in the portal while this poll was out (cancelled while its host did not answer, or
    // lost). What the host reports late never reopens it or changes how it ended.
    const live = this.#cs.run(row.id);
    if (!live || live.status !== 'running') return;
    const s = polled.state;
    if (!s) {
      // No state file: the workspace was reset, or the start never took.
      if (!polled.alive && Date.now() - Date.parse(row.started_at ?? row.created_at) > 30_000) await this.#lost(row, null);
      return;
    }
    if (s.status === 'passed' || s.status === 'failed' || s.status === 'cancelled') return this.#complete(row, s);
    if (!polled.alive) return this.#lost(row, s);
    // Every poll, changed or not: the open control requests of attached chats change while the release step waits on them.
    if (this.#deployChats) this.#deployChats.observe(row.id, this.#cs.deploymentsOfRun(row.id), s.jobs);
    const text = JSON.stringify(s);
    if (text !== row.state) {
      this.#cs.updateRun(row.id, { state: text, started_at: s.startedAt ?? row.started_at });
      this.#waiting(row, s);
      this.#changed();
    }
  }

  /** A held job the runner now reports as `waiting`: its deployment says so, and the hook hears it once. */
  #waiting(row: RunRow, s: CiRunStateFile): void {
    for (const d of this.#cs.deploymentsOfRun(row.id)) {
      if (d.approval !== 'pending' || s.jobs.find((j) => j.id === d.job)?.status !== 'waiting') continue;
      if (!this.#cs.updateDeployment(d.id, { approval: 'waiting' }, ['pending'])) continue;
      console.log(`[ci] ${row.id} ${d.job} waits for an approval to deploy to ${d.environment}`);
      this.#hook(() => this.hooks.waiting?.(row, d.job, d.environment));
      // The session hears it too, once per run (its own run, or the pipeline asked for it): it should not wait on a deploy nobody approved.
      void this.#links
        .waiting(row, d.environment)
        .catch((e: unknown) => console.error(`[ci] ${row.id}: reporting the wait failed: ${(e as Error).message}`));
      this.#rule(row.id, d.id);
    }
  }

  /**
   * The auto-approve rule (FR41a). When a held deployment starts waiting and its environment's mode is `dry` or `on`, the rule is evaluated
   * once (it only reads). Then, the environment read again AFTER the evaluation:
   *  - mode `on` and protection on (both still, now): the verdict is claimed once on the deployment, and when every condition held the job is
   *    approved through the same path a person's approval takes (`#settle`: the key to the runner, one decision per run, the deployment still
   *    `waiting`), as `rule:<environment>` with no user. If that approval does not go through, the line says so and a person decides.
   *  - otherwise (`dry`, or `on` switched off or protection switched off meanwhile): the dry WOULD line only; nothing is approved.
   * Every decision is one audit row `ci.deploy_auto_approve` (mode, verdict: would / would_not / approved / refused / failed, and the fixed
   * condition code; ids only, no free text). Mode `off` writes nothing. Never breaks the poll.
   */
  #rule(runId: string, deploymentId: string): void {
    if (!this.#cs.autoApproveReady) return;
    const p = (async () => {
      const run = this.#cs.run(runId);
      const dep = this.#cs.deploymentsOfRun(runId).find((d) => d.id === deploymentId);
      if (!run || !dep || dep.approval !== 'waiting' || dep.auto_verdict) return;
      const env = this.#cs.environment(dep.repo_id, dep.environment);
      if (!env || (env.auto_approve ?? 'off') === 'off') return;
      const deps = { cs: this.#cs, now: this.#opts.now, cp: (ws: string, args: string[]) => this.host.cp(ws, args, { timeoutMs: 30_000 }) };
      const v = await evaluateRule(deps, run, dep, env);
      // The facts took time to read: the mode and the protection that count are the ones in force now.
      const now = this.#cs.environment(dep.repo_id, dep.environment);
      const real = env.auto_approve === 'on' && now?.auto_approve === 'on' && now.protected === 1;
      const mode = real ? 'on' : 'dry';
      const at = this.#opts.now().toISOString();
      // Claimed once: a second look at this deployment (another poll, another portal process) writes and approves nothing.
      if (!this.#cs.setAutoVerdict(dep.id, v.verdict, ruleLine(mode, v), at, mode)) return;
      const actor = `rule:${dep.environment}`;
      const audit = (outcome: 'would' | 'would_not' | 'approved' | 'refused' | 'failed', code: string) =>
        this.#opts.audit?.({
          kind: 'ci.deploy_auto_approve',
          severity: outcome === 'approved' ? 'medium' : 'info',
          actor,
          userId: null,
          subject: `ci_run:${run.id}`,
          detail: {
            workspace: run.workspace_id,
            repo: run.repo,
            pipeline: run.pipeline,
            run: run.number,
            job: dep.job,
            environment: dep.environment,
            sha: shortSha(run.sha),
            mode,
            verdict: outcome,
            condition: code,
          },
        });
      if (mode === 'dry' || v.verdict === 'would_not') {
        audit(mode === 'dry' ? v.verdict : 'refused', v.code);
        console.log(`[ci] ${run.id} ${dep.job}: ${ruleLine(mode, v)}`);
        this.#changed();
        return;
      }
      try {
        await this.#settle(run, dep, 'approve', { actor, userId: null }, { startedBy: run.actor, by: 'rule', condition: v.code });
        audit('approved', v.code);
      } catch (e) {
        // Not approved after all (a person decided first, the run ended, the runner refused): say so; the job waits for a person as before.
        const why =
          e instanceof AppError && e.code === 'CONFLICT' ? 'it was decided or ended meanwhile' : 'the runner did not take the approval';
        this.#cs.settleAutoVerdict(
          dep.id,
          'would_not',
          ruleLine('on', { verdict: 'would_not', why: `every condition held, but the approval did not go through (${why})`, line: '' }),
        );
        audit('failed', 'approve');
        console.error(`[ci] ${run.id} ${dep.job}: the rule's approval did not go through: ${(e as Error).message}`);
      }
      this.#changed();
    })()
      .catch((e: unknown) => console.error(`[ci] ${runId}: the auto-approve rule failed: ${(e as Error).message}`))
      .finally(() => this.#ruling.delete(p));
    this.#ruling.add(p);
  }

  /** Waits for the auto-approve evaluations in flight (tests). */
  async settled(): Promise<void> {
    while (this.#ruling.size) await Promise.all([...this.#ruling]);
  }

  /** Waits for the upstream syncs in flight (tests). A failed sync counts as settled. */
  async syncsSettled(): Promise<void> {
    while (this.#syncing.size) await Promise.all([...this.#syncing.values()].map((p) => p.catch(() => undefined)));
  }

  /** The run is over: each deployment gets how its job ended, an undecided approval expires, and every key is dropped. */
  #settleDeployments(runId: string, s: CiRunStateFile | null): void {
    for (const d of this.#cs.deploymentsOfRun(runId)) {
      const job = s?.jobs.find((j) => j.id === d.job);
      const undecided = d.approval === 'pending' || d.approval === 'waiting';
      const approval: DeploymentRow['approval'] = !undecided
        ? d.approval
        : job?.reason === 'rejected'
          ? 'rejected'
          : job?.status === 'skipped'
            ? 'skipped'
            : 'expired';
      this.#cs.updateDeployment(d.id, { approval, gate_key: null, outcome: job?.status ?? 'cancelled' });
    }
  }

  /** The supervisor is gone with the run still open (the workspace stopped, or it was killed): the run failed and can be run again. */
  async #lost(row: RunRow, last: CiRunStateFile | null): Promise<void> {
    await this.#complete(row, this.#ended(row, last, 'failed', 'runner_lost'));
  }

  /** The run's last state with every open job and step closed: a running one `running` (failed or cancelled), the rest cancelled. */
  #ended(
    row: RunRow,
    last: CiRunStateFile | null,
    running: 'failed' | 'cancelled',
    reason: 'runner_lost' | 'cancelled' | 'superseded',
  ): CiRunStateFile {
    // With no state file the jobs come from the plan, all still waiting.
    const s: CiRunStateFile = last ?? {
      v: 1,
      runId: row.id,
      status: 'running',
      reason: null,
      startedAt: row.started_at,
      finishedAt: null,
      durationMs: null,
      jobs: this.get(row.id).detail,
    };
    for (const j of s.jobs) {
      if (j.status === 'running') ((j.status = running), (j.reason = reason));
      else if (j.status === 'pending' || j.status === 'waiting') ((j.status = 'cancelled'), (j.reason = reason));
      for (const st of j.steps) {
        if (st.status === 'running') ((st.status = running), (st.reason = reason));
        else if (st.status === 'pending') ((st.status = 'cancelled'), (st.reason = reason));
      }
    }
    s.status = running;
    s.reason = reason;
    s.finishedAt = new Date().toISOString();
    return s;
  }

  async #complete(row: RunRow, s: CiRunStateFile): Promise<void> {
    // Ended in the portal meanwhile (T-1637): a late report never changes how it ended.
    if (this.#cs.run(row.id)?.status !== 'running') return;
    const finished = s.finishedAt ?? new Date().toISOString();
    const started = Date.parse(row.started_at ?? row.created_at);
    this.#cs.updateRun(row.id, {
      status: s.status as CiStatus,
      reason: s.reason,
      state: JSON.stringify(s),
      started_at: s.startedAt ?? row.started_at,
      finished_at: finished,
      duration_ms: s.durationMs ?? Math.max(0, Date.parse(finished) - started),
    });
    console.log(`[ci] ${row.id} ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
    this.#deployChats?.forget(row.id);
    this.#settleDeployments(row.id, s);
    await this.#archive(row.id).catch((e: unknown) => console.error(`[ci] ${row.id}: logs not kept yet: ${(e as Error).message}`));
    this.#changed();
    this.#moved(row.id, row.status);
  }

  /** Keeps a finished run's logs in the portal, cleaned and redacted (PRD FR30, FR31). */
  async #archive(runId: string): Promise<void> {
    const row = this.#cs.run(runId);
    if (!row || row.archived) return;
    const reply = await this.host.cp(
      execOf(row),
      [
        'archive',
        runId,
        '--head',
        String(CI_LIMITS.archiveHeadBytes),
        '--tail',
        String(CI_LIMITS.archiveTailBytes),
        '--total',
        String(CI_LIMITS.archiveRunBytes),
      ],
      { timeoutMs: 30_000 },
    );
    if (!reply.ok) throw new Error(reply.message ?? reply.error ?? 'archive failed');
    const redact = this.#redactor(row.workspace_id);
    const steps =
      (reply.steps as { job: string; step: number; size: number; head: string; tail: string | null; omitted: number }[] | undefined) ?? [];
    this.#cs.saveLogs(
      runId,
      steps.map((s) => ({
        job: s.job,
        step: s.step,
        bytes: s.size,
        omitted: s.omitted,
        text: redact(
          cleanLog(s.tail === null ? s.head : `${s.head}${s.head.endsWith('\n') ? '' : '\n'}[… ${s.omitted} bytes omitted …]\n${s.tail}`),
        ),
      })),
    );
    this.#flaky(runId);
  }

  /**
   * T-95 item 4: the tests a passed step's log names as `flaky, passed on rerun: <file>;<test>` (the gate's verdict), one ticket per test
   * across runs. Read from the kept logs (cleaned and redacted already), once per run and test. Never breaks the archive.
   */
  #flaky(runId: string): void {
    const tickets = this.#tickets;
    const row = this.#cs.run(runId);
    if (!tickets || !row || !this.#cs.flakyReady) return;
    const state = json<CiRunStateFile | null>(row.state, null);
    const redact = this.#redactor(row.workspace_id);
    const sighting = (job: string): FlakySighting => ({ runNumber: row.number, link: runLink(row.id), sha: row.sha, repo: row.repo, job });
    for (const j of state?.jobs ?? []) {
      for (const st of j.steps) {
        if (st.status !== 'passed') continue;
        const log = this.#cs.log(runId, j.id, st.idx)?.text ?? '';
        for (const f of parseFlaky(log)) {
          try {
            const at = new Date().toISOString();
            const before = this.#cs.flakyOf(row.repo, f.file, f.test);
            if (!this.#cs.insertFlaky({ run_id: row.id, repo: row.repo, job: j.id, file: f.file, test: f.test, ticket_id: null, at }))
              continue;
            const s = sighting(j.id);
            let ticketId = before.ticketId;
            const closed = ticketId ? tickets.closed(ticketId) : null;
            if (ticketId && closed !== null) {
              if (closed) tickets.reopen(ticketId);
              tickets.note(ticketId, flakyComment(s, before.runs + 1, closed), { actor: `ci:${row.id}`, label: 'CI' });
            } else {
              const tags = ['flaky', 'area-qa', ...[repoTag(row.repo)].filter((t): t is string => !!t && t !== 'flaky' && t !== 'area-qa')];
              ticketId = tickets.open({
                summary: flakyTitle(f),
                description: flakyDescription(f, s, flakyExcerpt(log, f.test, redact)),
                tags,
                workspaceId: row.workspace_id,
              });
            }
            this.#cs.setFlakyTicket(row.id, row.repo, f.file, f.test, ticketId);
            console.log(`[ci] ${row.id} ${j.id}: flaky ${f.file} (${ticketId})`);
          } catch (e) {
            console.error(`[ci] ${row.id}: the ticket of a flaky test could not be written: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  #redactor(workspaceId: string): (text: string) => string {
    const extra = this.#opts.redactFor?.(workspaceId);
    return (text) => redactSecrets(extra ? extra(text) : text);
  }

  /** Housekeeping on a quiet poll: logs that could not be kept earlier, old runs, and the workspace's own cleanup. */
  async #maintenance(workspaceId: string): Promise<void> {
    for (const row of this.#cs.unarchived(5).filter((r) => execOf(r) === workspaceId)) await this.#archive(row.id).catch(() => undefined);
    const now = Date.now();
    if (now - this.#lastPrune >= 60 * 60_000) {
      this.#lastPrune = now;
      this.#cs.prune({
        runDays: CI_LIMITS.runRecordDays,
        eventDays: CI_LIMITS.eventRecordDays,
        keepPerWorkspace: CI_LIMITS.runRecordsPerWorkspace,
      });
    }
    // The workspace's own cleanup: once an hour per workspace, and right after the portal first sees it.
    if (now - (this.#maintained.get(workspaceId) ?? 0) < 60 * 60_000) return;
    this.#maintained.set(workspaceId, now);
    await this.host.cp(workspaceId, ['gc', '--days', String(CI_LIMITS.runDirDays)]).catch(() => undefined);
  }

  /* ---------- Cancelling and running again ---------- */

  /** Cancels a run, recording who (`by`: an actor string as runs store it, and a token's label) and, optionally, why (T-95). */
  async cancel(id: string, by: { actor?: string; label?: string | null; note?: string | null } = {}): Promise<CiRun> {
    const row = this.#need(id);
    await this.#cancelRow(row, 'cancelled', { actor: by.actor ?? 'ui', label: by.label ?? null, note: by.note ?? null });
    return this.get(id);
  }

  async #cancelRow(
    row: RunRow,
    reason: 'cancelled' | 'superseded',
    by: { actor: string; label?: string | null; note?: string | null },
  ): Promise<void> {
    const now = new Date().toISOString();
    const who = {
      cancelled_by: by.actor,
      cancelled_by_label: oneLine(by.label)?.slice(0, 60) ?? null,
      cancel_note: oneLine(by.note)?.slice(0, 120) ?? null,
    };
    if (row.status === 'queued') {
      this.#cs.updateRun(row.id, { status: 'cancelled', reason, finished_at: now, duration_ms: 0, archived: 1, ...who });
      this.#settleDeployments(row.id, null);
      this.#changed();
      this.#moved(row.id, 'queued');
      return;
    }
    if (row.status !== 'running') throw new AppError('CONFLICT', 'That run is already over.');
    let reply: CiReply;
    try {
      reply = await this.host.cp(execOf(row), ['cancel', row.id], { timeoutMs: 20_000 });
    } catch (e) {
      // T-1637: the host does not answer (a runner that went away): the run is cancelled here, and the host hears it when it answers again.
      return this.#cancelHere(row, reason, who, (e as Error).message);
    }
    if (!reply.ok) throw fromReply(reply);
    this.#cs.updateRun(row.id, { ...who, ...(reason === 'superseded' ? { reason: 'superseded' as const } : {}) });
    this.kick(execOf(row));
  }

  /** A running run cancelled in the portal because its host did not answer: ended as cancelled, its deployments settled like a queued one. */
  #cancelHere(
    row: RunRow,
    reason: 'cancelled' | 'superseded',
    who: { cancelled_by: string; cancelled_by_label: string | null; cancel_note: string | null },
    why: string,
  ): void {
    const live = this.#cs.run(row.id);
    if (!live || live.status !== 'running') throw new AppError('CONFLICT', 'That run is already over.');
    const s = this.#ended(live, json<CiRunStateFile | null>(live.state, null), 'cancelled', reason);
    const note: CiDiagnostic = {
      file: '',
      line: 0,
      column: 0,
      path: '',
      severity: 'warning',
      code: 'runner-unreachable',
      message: 'runner unreachable: cancelled in the portal',
    };
    const finished = s.finishedAt!;
    this.#cs.updateRun(live.id, {
      status: 'cancelled',
      reason,
      state: JSON.stringify(s),
      finished_at: finished,
      duration_ms: Math.max(0, Date.parse(finished) - Date.parse(live.started_at ?? live.created_at)),
      diagnostics: JSON.stringify([...json<CiDiagnostic[]>(live.diagnostics, []), note]),
      ...who,
    });
    this.#remember(execOf(live), live.id);
    console.log(`[ci] ${live.id} cancelled in the portal: ${execOf(live)} did not answer (${why})`);
    this.#deployChats?.forget(live.id);
    this.#settleDeployments(live.id, null);
    this.#changed();
    this.#moved(live.id, 'running');
  }

  async rerun(id: string, actor = 'ui'): Promise<CiRun> {
    const row = this.#need(id);
    if (isCiActive(row.status)) throw new AppError('CONFLICT', 'Wait for that run to finish, or cancel it.');
    const repo = this.#cs.repo(row.repo_id);
    if (!repo || repo.removed_at) throw new AppError('CONFLICT', 'That remote has been removed.');
    const created = this.#cs.tx(() => {
      const number = this.#cs.nextNumber(repo.id);
      const newId2 = newRunId();
      const plan = row.plan ? replan(JSON.parse(row.plan) as Plan, newId2, number) : null;
      const now = new Date().toISOString();
      const copy: RunRow = {
        ...row,
        id: newId2,
        number,
        trigger: 'rerun',
        event_id: null,
        status: plan ? 'queued' : 'failed',
        reason: plan ? null : row.reason,
        actor,
        actor_label: null,
        cancelled_by: null,
        cancelled_by_label: null,
        cancel_note: null,
        plan: plan ? JSON.stringify(plan) : null,
        state: null,
        attempts: 0,
        created_at: now,
        started_at: null,
        finished_at: plan ? null : now,
        duration_ms: plan ? null : 0,
        archived: plan ? 0 : 1,
        rerun_of: row.id,
      };
      // A rerun deploys again: fresh gates and its own approvals, never the old run's.
      const gates = plan ? this.#gates(repo, plan, row0(copy)) : null;
      if (gates && 'problem' in gates) throw new AppError('CONFLICT', gates.problem.message);
      if (plan) copy.plan = JSON.stringify(plan);
      this.#cs.insertRun(copy);
      if (gates) for (const d of gates.deployments) this.#cs.insertDeployment(d);
      return copy;
    });
    this.#born(created, null);
    this.#changed();
    this.kick(created.workspace_id);
    return this.get(created.id);
  }

  /* ---------- Approvals and environments (PRD FR41) ---------- */

  /**
   * A person lets a held job run, or refuses it. The caller has made sure it is a person (never a token or an agent: the routes, and no tool,
   * reach this). The one other caller of `#settle` is the environment's own rule (`#rule`), which never comes through here: an actor that
   * says `rule:` is refused, so no route can pass a person's click off as the rule's.
   */
  async decide(id: string, job: unknown, decision: 'approve' | 'reject', by: CiDecider): Promise<CiRun> {
    const row = this.#need(id);
    if (typeof job !== 'string' || !JOB_ID.test(job)) throw invalid('job', 'Pick the job that waits.');
    if (by.actor.startsWith('rule:') || !by.userId) throw new AppError('FORBIDDEN', 'Only a person signed in to the portal can do this.');
    const dep = this.#cs.deploymentsReady ? this.#cs.deployment(row.id, job) : undefined;
    if (!dep) throw notFound('deployment');
    await this.#settle(row, dep, decision, by, { startedBy: row.actor });
    this.#changed();
    this.kick(row.workspace_id);
    return this.get(row.id);
  }

  /**
   * Decides a held job (FR41): approving hands the runner the job's key through `cp-ci approve`; the decision is recorded only after the runner
   * took it, and one decision per run is made at a time, so two deciders (two people, or a person and the rule) can not approve and reject the
   * same job into a split state, nor approve it twice. Audited as `ci.deploy_approved` / `ci.deploy_rejected` with the decider as the actor.
   */
  async #settle(
    row: RunRow,
    dep: DeploymentRow,
    decision: 'approve' | 'reject',
    by: CiDecider,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const job = dep.job;
    if (row.status !== 'running' || dep.approval !== 'waiting' || !dep.gate_key)
      throw new AppError(
        'CONFLICT',
        dep.approval === 'pending' ? 'That job is not waiting yet.' : 'That job is not waiting for an approval.',
      );
    if (this.#deciding.has(row.id)) throw new AppError('CONFLICT', 'Someone is deciding this right now.');
    this.#deciding.add(row.id);
    try {
      await this.#running(execOf(row));
      // Read again inside the lock: what the caller saw may have been decided meanwhile.
      const live = this.#cs.deployment(row.id, job);
      if (!live || live.approval !== 'waiting' || !live.gate_key)
        throw new AppError('CONFLICT', 'That job is not waiting for an approval.');
      const key = live.gate_key;
      const reply =
        decision === 'approve'
          ? await this.#cp(execOf(row), ['approve', row.id, job, '--bytes', String(Buffer.byteLength(key))], { stdin: key })
          : await this.#cp(execOf(row), ['approve', row.id, job, '--reject']);
      if (!reply.ok) {
        if (reply.error === 'over' || reply.error === 'not_waiting') throw new AppError('CONFLICT', 'That job is not waiting any more.');
        throw fromReply(reply);
      }
      const at = new Date().toISOString();
      const state = decision === 'approve' ? 'approved' : 'rejected';
      if (!this.#cs.updateDeployment(live.id, { approval: state, decided_by: by.actor, decided_at: at, gate_key: null }, ['waiting']))
        throw new AppError('CONFLICT', 'That was decided already.');
      this.#opts.audit?.({
        kind: decision === 'approve' ? 'ci.deploy_approved' : 'ci.deploy_rejected',
        severity: 'medium',
        actor: by.actor,
        userId: by.userId,
        subject: `ci_run:${row.id}`,
        detail: {
          workspace: row.workspace_id,
          repo: row.repo,
          pipeline: row.pipeline,
          run: row.number,
          job,
          environment: live.environment,
          sha: shortSha(row.sha),
          ...extra,
        },
      });
      console.log(`[ci] ${row.id} ${job}: deployment to ${live.environment} ${state} by ${by.actor}`);
    } finally {
      this.#deciding.delete(row.id);
    }
  }

  #envView(e: EnvironmentRow): CiEnvironment {
    const mode: CiAutoApproveMode = e.auto_approve === 'on' ? 'on' : e.auto_approve === 'dry' ? 'dry' : 'off';
    return {
      id: e.id,
      repoId: e.repo_id,
      name: e.name,
      protected: e.protected === 1,
      updatedAt: e.updated_at,
      updatedBy: e.updated_by,
      autoApprove: mode,
      autoApproveWindow: e.auto_window ?? null,
      needsPerson: needsPersonOf(e),
      deployments: this.#cs.deploymentsOf(e.repo_id, e.name).map(deploymentView),
    };
  }

  environments(repoId: string): CiEnvironment[] {
    const repo = this.#needRepo(repoId);
    if (!this.#cs.deploymentsReady) return [];
    return this.#cs.environments(repo.id).map((e) => this.#envView(e));
  }

  /**
   * Turns an environment's protection on or off (a person, `manage`), making it when it does not exist yet. A run started before the change
   * keeps the gates it was planned with: switching protection off never lets a job already waiting go on by itself.
   */
  setEnvironment(repoId: string, name: unknown, req: Partial<UpdateCiEnvironmentRequest>, by: CiDecider): CiEnvironment {
    const repo = this.#needRepo(repoId);
    if (typeof name !== 'string' || !CI_ENVIRONMENT_NAME.test(name)) throw invalid('name', 'Lowercase letters, digits, . _ and -.');
    if (typeof req.protected !== 'boolean') throw invalid('protected', 'true or false.');
    if (!this.#cs.deploymentsReady)
      throw new AppError('SERVICE_UNAVAILABLE', 'This portal’s database is not up to date.', { expose: true });
    const env = this.#cs.ensureEnvironment(repo.id, name, by.actor, newId('e'));
    if ((env.protected === 1) !== req.protected) {
      this.#cs.setProtected(env.id, req.protected, by.actor);
      this.#opts.audit?.({
        kind: 'ci.environment_protection',
        severity: req.protected ? 'info' : 'high',
        actor: by.actor,
        userId: by.userId,
        subject: `ci_repo:${repo.id}`,
        detail: { workspace: repo.workspace_id, repo: repo.name, environment: name, protected: req.protected },
      });
      this.#changed();
    }
    return this.#envView(this.#cs.environment(repo.id, name)!);
  }

  /**
   * Sets an environment's auto-approve rule (FR41a): a person with manage (the route refuses tokens and agents; no Portal MCP tool reaches
   * this), audited as `ci.environment_auto_approve`. `on` only for a protected environment (an unprotected one holds nothing to approve);
   * turning protection off later leaves the mode as it is, and the rule then approves nothing (nothing waits, and `#rule` checks again).
   */
  setAutoApprove(repoId: string, name: unknown, req: Partial<UpdateCiAutoApproveRequest>, by: CiDecider): CiEnvironment {
    const repo = this.#needRepo(repoId);
    if (typeof name !== 'string' || !CI_ENVIRONMENT_NAME.test(name)) throw invalid('name', 'Lowercase letters, digits, . _ and -.');
    if (req.mode !== 'off' && req.mode !== 'dry' && req.mode !== 'on') throw invalid('mode', 'off, dry or on.');
    if (req.window !== undefined && req.window !== null && (typeof req.window !== 'string' || !WINDOW.test(req.window)))
      throw invalid('window', 'HH:MM-HH:MM in UTC, or null for always.');
    if (
      req.needsPerson !== undefined &&
      req.needsPerson !== null &&
      (!Array.isArray(req.needsPerson) ||
        req.needsPerson.length > 50 ||
        req.needsPerson.some((g) => typeof g !== 'string' || !GLOB.test(g)))
    )
      throw invalid('needsPerson', 'Up to 50 path patterns, or null for the defaults.');
    if (!this.#cs.deploymentsReady || !this.#cs.autoApproveReady)
      throw new AppError('SERVICE_UNAVAILABLE', 'This portal’s database is not up to date.', { expose: true });
    const env = this.#cs.environment(repo.id, name);
    if (!env) throw notFound('environment');
    if (req.mode === 'on' && env.protected !== 1)
      throw invalid('mode', 'Turn the approval on first: the rule approves only what waits for one.');
    const next = {
      mode: req.mode,
      window: req.window === undefined ? (env.auto_window ?? null) : req.window,
      paths:
        req.needsPerson === undefined
          ? (env.auto_paths ?? null)
          : req.needsPerson === null
            ? null
            : JSON.stringify([...new Set(req.needsPerson)]),
    };
    const was = { mode: env.auto_approve ?? 'off', window: env.auto_window ?? null, paths: env.auto_paths ?? null };
    if (was.mode !== next.mode || was.window !== next.window || was.paths !== next.paths) {
      this.#cs.setAutoApprove(env.id, next, by.actor);
      this.#opts.audit?.({
        kind: 'ci.environment_auto_approve',
        severity: next.mode === 'on' ? 'high' : next.mode === 'off' ? 'info' : 'medium',
        actor: by.actor,
        userId: by.userId,
        subject: `ci_repo:${repo.id}`,
        detail: {
          workspace: repo.workspace_id,
          repo: repo.name,
          environment: name,
          mode: next.mode,
          was: was.mode,
          window: next.window,
          needsPerson: next.paths === null ? 'defaults' : 'own list',
        },
      });
      this.#changed();
    }
    return this.#envView(this.#cs.environment(repo.id, name)!);
  }

  /** The workspace of a run or remote, for the authorization resolvers (null when there is none). */
  workspaceOfRun(id: string): string | null {
    return this.#cs.run(id)?.workspace_id ?? null;
  }

  workspaceOfRepo(id: string): string | null {
    const r = this.#cs.repo(id);
    return r && !r.removed_at ? r.workspace_id : null;
  }

  /* ---------- Manual runs ---------- */

  /**
   * Starts a pipeline by hand (FR13). `sessionId` links the run to the session that asked (an agent's own run: it may read and cancel it).
   * `deploymentOnly` refuses a pipeline in which no job names an environment: what an agent may start on a branch that is not its own (PRD §14);
   * a text is refused as FORBIDDEN, an error is thrown as it is (T-476: another program's remote reads as a missing one). `rule` names why an
   * agent may start it (T-476); every start is one platform audit row `ci.run_started`: who, which pipeline, on which branch, by which rule.
   * `stgOnly` (T-558) refuses, with that error, a pipeline that is invalid or does not deploy to exactly `stg` (ci/authz.ts, deploysOnlyToStg):
   * the environments come from the file at the resolved commit, never from the inputs.
   */
  async startRun(
    req: Partial<StartCiRunRequest>,
    actor = 'ui',
    opts: {
      sessionId?: string | null;
      deploymentOnly?: string | AppError;
      stgOnly?: AppError;
      actorLabel?: string | null;
      rule?: string;
    } = {},
  ): Promise<CiRun> {
    if (typeof req.repoId !== 'string') throw invalid('repoId', 'Pick a remote.');
    const repo = this.#needRepo(req.repoId);
    if (typeof req.pipeline !== 'string' || !req.pipeline) throw invalid('pipeline', 'Pick a pipeline.');
    if (typeof req.ref !== 'string' || !req.ref.trim()) throw invalid('ref', 'Pick a branch or tag.');
    await this.#running(repo.workspace_id);
    const ref = await this.#resolveRef(repo, req.ref.trim());
    const snap = await this.#snapshot(repo, ref.sha);
    const found = validateFiles(snap.files ?? []).pipelines.find(
      (p) => p.info.file.replace(/^\.pilot\//, '').replace(/\.ya?ml$/, '') === req.pipeline,
    );
    if (!found) throw notFound('pipeline');
    if (opts.stgOnly && !(found.pipeline && deploysOnlyToStg(found.pipeline.jobs))) throw opts.stgOnly;
    if (!found.pipeline)
      throw new AppError('CONFLICT', 'That pipeline has errors. Fix them and push first.', {
        details: { diagnostics: found.info.diagnostics },
      });
    if (!found.pipeline.on.manual) throw new AppError('CONFLICT', 'That pipeline can not be started by hand: it has no manual trigger.');
    if (opts.deploymentOnly && !found.pipeline.jobs.some((j) => !j.hidden && j.environment))
      throw typeof opts.deploymentOnly === 'string' ? new AppError('FORBIDDEN', opts.deploymentOnly) : opts.deploymentOnly;
    const { values, problems } = resolveInputs(found.pipeline.on.manual.inputs, req.inputs);
    if (Object.keys(problems).length) throw new AppError('VALIDATION_FAILED', 'Check the inputs.', { details: problems });
    const row = this.#cs.tx(() =>
      this.#insertRun(repo, found, {
        event: 'manual',
        ref: ref.ref,
        sha: ref.sha,
        base: null,
        actor,
        inputs: values,
        eventId: null,
        subject: snap.subject ?? null,
        trigger: 'manual',
        sessionId: opts.sessionId ?? null,
        actorLabel: opts.actorLabel ?? null,
      }),
    );
    this.#born(row, snap.message ?? null);
    this.#changed();
    this.kick(repo.workspace_id);
    this.#opts.audit?.({
      kind: 'ci.run_started',
      actor,
      userId: null,
      subject: `ci_run:${row.id}`,
      detail: {
        workspace: repo.workspace_id,
        repo: repo.name,
        run: row.number,
        pipeline: req.pipeline,
        ref: ref.ref,
        sessionId: opts.sessionId ?? null,
        rule: opts.rule ?? null,
      },
    });
    return this.get(row.id);
  }

  /**
   * T-558: whole minutes since the last stg deploy of a remote that went through: a run that passed whose `stg` deploying job passed, timed at
   * the run's end, on the service's clock. Null when there is none (or the deployments table is not there): the caller says "unavailable".
   */
  stgAgeMinutes(repoId: string): number | null {
    const at = this.#cs.deploymentsReady ? this.#cs.lastDeployFinished(repoId, LEAD_ENVIRONMENT) : null;
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? Math.max(0, Math.floor((this.#opts.now().getTime() - t) / 60_000)) : null;
  }

  async #resolveRef(repo: RepoRow, input: string): Promise<{ ref: string; sha: string }> {
    const candidates = input.startsWith('refs/') ? [input] : [`refs/heads/${input}`, `refs/tags/${input}`];
    for (const ref of candidates) {
      const r = await this.#cp(repo.workspace_id, ['repo', 'rev', repo.name, ref]);
      if (r.ok) return { ref, sha: r.sha as string };
      if (r.error !== 'no_ref' && r.error !== 'bad_ref') throw fromReply(r);
    }
    throw notFound('branch or tag');
  }

  async #snapshot(repo: RepoRow, sha: string) {
    const r = (await this.#cp(repo.workspace_id, ['snapshot', repo.name, sha], { timeoutMs: 30_000 })) as CiReply & {
      subject?: string;
      files?: SnapshotFile[];
      message?: string;
      hasPilot?: boolean;
    };
    if (!r.ok) throw fromReply(r);
    return r;
  }

  /* ---------- Reading ---------- */

  #need(id: string): RunRow {
    const row = this.#cs.run(id);
    if (!row) throw notFound('run');
    return row;
  }

  #needRepo(id: string): RepoRow {
    const repo = this.#cs.repo(id);
    if (!repo || repo.removed_at) throw notFound('remote');
    return repo;
  }

  #summary(row: RunRow): CiRunSummary {
    const state = json<CiRunStateFile | null>(row.state, null);
    const plan = json<{ jobs?: { id: string; skip: string | null }[] }>(row.plan, {});
    const jobs = state
      ? state.jobs.map((j) => ({ id: j.id, status: j.status }))
      : (plan.jobs ?? []).map((j) => ({ id: j.id, status: (j.skip ? 'skipped' : 'pending') as CiUnitStatus }));
    return {
      id: row.id,
      number: row.number,
      workspaceId: row.workspace_id,
      repoId: row.repo_id,
      repo: row.repo,
      pipeline: row.pipeline,
      trigger: row.trigger as CiTrigger,
      ref: row.ref,
      branch: row.branch,
      tag: row.tag,
      sha: row.sha,
      subject: row.subject,
      status: row.status,
      reason: row.reason as CiRunSummary['reason'],
      actor: row.actor,
      actorLabel: row.actor_label ?? null,
      cancelledBy: row.cancelled_by ?? null,
      cancelledByLabel: row.cancelled_by_label ?? null,
      cancelNote: row.cancel_note ?? null,
      ticketId: row.ticket_id,
      sessionId: row.session_id,
      rerunOf: row.rerun_of,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      jobs,
      runsOn: runsOnOf(row),
      runnerWorkspaceId: row.runner_workspace_id ?? null,
    };
  }

  /** T-1098: a run filter's ticket in either form (`KONF-3`) as the stable id runs store; unknown: as given (no match). */
  #ticketRef(t: string | undefined): string | undefined {
    return t ? (this.#tickets?.resolve?.(t) ?? t) : undefined;
  }

  list(f: CiRunFilter = {}): CiRunList {
    const { rows, total, active } = this.#cs.listRuns({
      workspace: f.workspace,
      repoId: f.repo,
      pipeline: f.pipeline,
      branch: f.branch,
      statuses: f.status,
      ticket: this.#ticketRef(f.ticket),
      session: f.session,
      limit: f.limit,
    });
    return { items: rows.map((r) => this.#summary(r)), total, active };
  }

  /**
   * D-58: one page of runs for `GET /api/ci/runs` (`{ items, next }`, plus `total` and `active` on the first page). `scope` names the caller;
   * the cursor is bound to it and to every filter value. `keep` is the caller's authz check (`view`), run on every run before it is shown.
   */
  listPage(
    f: CiRunFilter,
    args: { caller: string; cursor?: string | undefined; limit?: unknown; keep?: (r: { id: string }) => boolean },
  ): CiRunPage {
    const scope = `ci.runs|${JSON.stringify([args.caller, f.workspace ?? '', f.repo ?? '', f.pipeline ?? '', f.branch ?? '', f.ticket ?? '', f.session ?? '', f.status ?? []])}`;
    const { rows, next, total, active } = this.#cs.listRunsPage(
      {
        workspace: f.workspace,
        repoId: f.repo,
        pipeline: f.pipeline,
        branch: f.branch,
        statuses: f.status,
        ticket: this.#ticketRef(f.ticket),
        session: f.session,
      },
      { scope, cursor: args.cursor, limit: args.limit, keep: args.keep },
    );
    return { items: rows.map((r) => this.#summary(r)), next, ...(total !== undefined ? { total, active } : {}) };
  }

  async runs(f: CiRunFilter = {}): Promise<CiRunList> {
    return this.list(f);
  }

  get(id: string): CiRun {
    const row = this.#need(id);
    const state = json<CiRunStateFile | null>(row.state, null);
    const plan = json<{
      jobs?: {
        id: string;
        name: string;
        needs: string[];
        skip: string | null;
        environment?: string | null;
        steps: { name: string; skip: string | null }[];
      }[];
    }>(row.plan, {});
    // A run that has not started has no state file yet: show its jobs and steps as the plan has them.
    const detail: CiJob[] = state
      ? state.jobs
      : (plan.jobs ?? []).map((j) => ({
          id: j.id,
          name: j.name,
          status: (j.skip ? 'skipped' : 'pending') as CiUnitStatus,
          needs: j.needs,
          startedAt: null,
          durationMs: null,
          ignored: false,
          reason: j.skip ? ('condition' as const) : null,
          steps: j.steps.map((s, idx) => ({
            idx,
            name: s.name,
            status: (s.skip || j.skip ? 'skipped' : 'pending') as CiUnitStatus,
            startedAt: null,
            durationMs: null,
            exitCode: null,
            logBytes: 0,
            logTruncated: false,
            ignored: false,
            reason: s.skip || j.skip ? ('condition' as const) : null,
          })),
          artifacts: [],
          artifactsSkipped: 0,
          environment: j.environment ?? null,
        }));
    return {
      ...this.#summary(row),
      baseSha: row.base_sha,
      inputs: json(row.inputs, {}),
      ticketSource: row.ticket_source as CiRun['ticketSource'],
      detail,
      diagnostics: json<CiDiagnostic[]>(row.diagnostics, []),
      workspaceState: 'running',
      archived: row.archived === 1,
      deployments: this.#cs.deploymentsOfRun(row.id).map(deploymentView),
      ...this.#messages(row.id),
      flaky: flakyOfJobs(this.#cs.flakyOfRun(row.id)),
    };
  }

  /** What CI told the run's session (one per state), and the bumps (`bump:<mode>` rows), apart. */
  #messages(runId: string): Pick<CiRun, 'reports' | 'bumps'> {
    const reports: CiRunReport[] = [];
    const bumps: CiRunBump[] = [];
    for (const m of this.#cs.messagesOfRun(runId)) {
      if (m.state?.startsWith('bump:'))
        bumps.push({
          sessionId: m.session_id,
          mode: m.state === 'bump:prioritise' ? 'prioritise' : 'ask',
          outcome: m.outcome === 'bumped' ? 'sent' : 'refused',
          at: m.at,
          note: m.note,
        });
      else
        reports.push({
          state: (m.state ?? 'failed') as CiRunReport['state'],
          outcome: m.outcome as CiRunReport['outcome'],
          sessionId: m.session_id,
          at: m.at,
          note: m.note,
        });
    }
    return { reports, bumps };
  }

  /* ---------- Bump (FR37a) ---------- */

  /** The sessions a run can be bumped into: its own session first, then its workspace's, then its ticket's. */
  bumpTargets(id: string): BumpTarget[] {
    return this.#links.targets(this.#need(id));
  }

  /**
   * Bumps a run into a session ("Fix" or "Ask", with a note), records it on the run and its ticket, and writes it to the platform audit.
   * The caller checked the seam (operate on the run and on the session).
   */
  async bump(id: string, req: Partial<BumpRequest>, by: CiBumper): Promise<CiRun> {
    const row = this.#need(id);
    const waiting = this.#cs.deploymentsOfRun(row.id).find((d) => d.approval === 'waiting');
    const to = await this.#links.bump(row, req, by, waiting?.environment ?? null);
    this.#opts.audit?.({
      kind: 'ci.run_bumped',
      actor: by.actor,
      userId: by.userId,
      subject: `ci_run:${row.id}`,
      detail: {
        workspace: row.workspace_id,
        run: row.number,
        pipeline: row.pipeline,
        sessionId: to.sessionId,
        mode: req.mode ?? null,
        ticketId: row.ticket_id,
        note: typeof req.note === 'string' && req.note.trim().length > 0,
      },
    });
    this.#changed();
    return this.get(id);
  }

  /** The run with the workspace's state filled in (one listing for however many runs). */
  async show(id: string): Promise<CiRun> {
    const run = this.get(id);
    const states = await this.host.states();
    // A runner's run (T-557): its logs live where it executes.
    return { ...run, workspaceState: states.get(run.runnerWorkspaceId ?? run.workspaceId) ?? 'gone' };
  }

  /* ---------- Logs ---------- */

  async log(id: string, job: unknown, step: unknown, offset: unknown): Promise<CiLogChunk> {
    const row = this.#need(id);
    if (typeof job !== 'string' || !JOB_ID.test(job)) throw invalid('job', 'Pick a job.');
    const n = Number(step);
    if (!Number.isInteger(n) || n < 0 || n >= CI_LIMITS.stepsPerJob) throw invalid('step', 'Pick a step.');
    const from = Number(offset ?? 0);
    if (!Number.isInteger(from) || from < 0) throw invalid('offset', 'An offset is a number of bytes.');
    if (row.archived) {
      const kept = this.#cs.log(id, job, n);
      const text = from === 0 ? (kept?.text ?? '') : '';
      return { text, next: text.length, done: true, truncated: (kept?.omitted ?? 0) > 0, source: 'archive' };
    }
    if (row.status === 'queued') return { text: '', next: 0, done: false, truncated: false, source: 'workspace' };
    const key = `${id}/${job}/${n}`;
    const live = this.#live.get(key);
    const stream =
      live && live.offset === from
        ? live
        : { stream: this.#opts.streamFor?.(row.workspace_id) ?? new SessionStream(NO_VALUES), offset: from };
    let reply: CiReply;
    try {
      reply = await this.host.cp(execOf(row), ['log', id, job, String(n), String(from)], { timeoutMs: 15_000 });
    } catch {
      return { text: '', next: from, done: false, truncated: false, source: 'workspace' };
    }
    if (!reply.ok) return { text: '', next: from, done: false, truncated: false, source: 'workspace' };
    const next = Number(reply.next);
    const done = reply.done === true;
    // Redacted as a stream, so a credential split across two reads is held back until it can be judged, and a key block is dropped whole.
    let text = stream.stream.push(cleanLog(String(reply.text ?? '')));
    if (done) text += stream.stream.flush();
    const redact = this.#redactor(row.workspace_id);
    text = redact(text);
    stream.offset = next;
    this.#live.set(key, stream);
    if (this.#live.size > 200) this.#live.delete(this.#live.keys().next().value as string);
    return { text, next, done, truncated: reply.truncated === true, source: 'workspace' };
  }

  /* ---------- Remotes ---------- */

  async #running(workspaceId: string): Promise<void> {
    const state = await this.host.state(workspaceId);
    if (state === 'gone') throw new AppError('CONFLICT', 'That workspace no longer exists.');
    if (state === 'unsupported') throw new AppError('CONFLICT', 'CI runs on Docker workspaces and This machine for now.');
    if (state !== 'running') throw new AppError('CONFLICT', 'Start the workspace first.');
    await this.host.install(workspaceId);
  }

  /** `cp-ci` in a workspace, failing as the portal's own error when the workspace can't be reached. */
  async #cp(workspaceId: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<CiReply> {
    try {
      return await this.host.cp(workspaceId, args, opts);
    } catch (e) {
      throw new AppError('SERVICE_UNAVAILABLE', (e as Error).message, { expose: true });
    }
  }

  async #repoView(row: RepoRow, states?: Map<string, 'running' | 'stopped'>): Promise<CiRepo> {
    const map = states ?? (await this.host.states());
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      path: row.path,
      defaultBranch: row.default_branch,
      protected: json<string[]>(row.protected, []),
      sourcePath: row.source_path,
      connected: json<string[]>(row.connected, []),
      hooks: (['ok', 'outdated', 'missing'] as const).find((h) => h === row.hook_state) ?? 'unknown',
      workspaceState: map.get(row.workspace_id) ?? 'gone',
      createdAt: row.created_at,
      upstream: upstreamView(row),
    };
  }

  async repos(workspaceId?: string): Promise<CiRepo[]> {
    const states = await this.host.states();
    return Promise.all(this.#cs.repos(workspaceId).map((r) => this.#repoView(r, states)));
  }

  async repo(id: string): Promise<CiRepo> {
    return this.#repoView(this.#needRepo(id));
  }

  async createRepo(req: Partial<CreateCiRepoRequest>): Promise<CiRepo> {
    if (typeof req.workspaceId !== 'string' || !WORKSPACE_ID.test(req.workspaceId)) throw invalid('workspaceId', 'Pick a workspace.');
    const name = typeof req.name === 'string' ? req.name.trim() : '';
    if (!CI_REPO_NAME.test(name) || name.endsWith('.git') || name.includes('..'))
      throw invalid('name', 'Lowercase letters, digits, . _ and -.');
    if (req.source !== undefined && (typeof req.source !== 'string' || !req.source.startsWith('/') || req.source.length > 500))
      throw invalid('source', 'An absolute folder.');
    if (
      req.defaultBranch !== undefined &&
      (typeof req.defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(req.defaultBranch))
    )
      throw invalid('defaultBranch', 'A branch name.');
    if (this.#cs.repoByName(req.workspaceId, name))
      throw new AppError('CONFLICT', `There is already a remote named ${name} here.`, { details: { name: 'Taken.' } });
    if (this.#cs.repos(req.workspaceId).length >= CI_LIMITS.reposPerWorkspace)
      throw new AppError('CONFLICT', `A workspace has at most ${CI_LIMITS.reposPerWorkspace} remotes.`);
    await this.#running(req.workspaceId);
    const args = ['repo', 'create', name];
    if (req.source) args.push('--from', req.source);
    if (req.defaultBranch) args.push('--branch', req.defaultBranch);
    if (req.source && req.connect) args.push('--connect');
    const r = await this.#cp(req.workspaceId, args, { timeoutMs: 300_000 });
    if (!r.ok) throw fromReply(r);
    const defaultBranch = String(r.defaultBranch ?? req.defaultBranch ?? 'main');
    const row: Omit<RepoRow, 'removed_at'> = {
      id: newId('p'),
      workspace_id: req.workspaceId,
      name,
      path: String(r.path ?? ''),
      default_branch: defaultBranch,
      protected: JSON.stringify([defaultBranch]),
      required_checks: '[]',
      merge_only: 0,
      source_path: req.source ?? null,
      connected: JSON.stringify(typeof r.connected === 'string' ? [r.connected] : []),
      hook_state: String(r.hook ?? 'ok'),
      created_at: new Date().toISOString(),
    };
    this.#cs.insertRepo(row);
    this.#changed();
    this.kick(req.workspaceId);
    return this.repo(row.id);
  }

  /** `by`: the person changing it; the upstream (FR8a) is a person's setting only, and is audited. */
  async updateRepo(id: string, req: Partial<UpdateCiRepoRequest>, by?: CiDecider): Promise<CiRepo> {
    const repo = this.#needRepo(id);
    const patch: Parameters<CiStore['updateRepo']>[1] = {};
    let audit: { kind: string; detail: Record<string, unknown> } | null = null;
    if (req.upstream !== undefined) {
      if (!by) throw new AppError('FORBIDDEN', 'Only a person signed in to the portal can do this.');
      if (req.upstream === null) {
        // The old upstream's staging refs stay in the remote until the next sync clears them: remember that, even after the removal.
        const stale = repo.upstream_url || readState(repo.upstream_state).reset;
        Object.assign(patch, {
          upstream_url: null,
          upstream_secret: null,
          upstream_every_s: null,
          upstream_hook_secret: null,
          upstream_state: stale ? JSON.stringify({ ...EMPTY_STATE, reset: true }) : null,
        });
        if (repo.upstream_url) audit = { kind: 'ci.upstream_cleared', detail: { repo: repo.name, url: repo.upstream_url } };
      } else {
        const u = checkUpstream(req.upstream);
        // The SSRF guard on set too, so a refused host is said at once, not by the first sync.
        await upstreamPin(u.url, this.#opts.lookup, this.#allowedHosts());
        if (u.secret && this.#opts.secrets) {
          const info = this.#opts.secrets(repo.workspace_id, u.secret);
          if (!info?.asFile)
            throw invalid(
              'upstream.secret',
              `${u.secret} does not reach this workspace as a file. Assign it in Secrets & env as a secret or a tool login.`,
            );
        }
        // T-486 S2: the webhook's signing secret is checked by the portal itself, so it must be a secret the workspace's sets deliver.
        if (u.hookSecret && this.#opts.secrets) {
          const info = this.#opts.secrets(repo.workspace_id, u.hookSecret);
          if (info?.kind !== 'secret')
            throw invalid(
              'upstream.hookSecret',
              `${u.hookSecret} is not a secret assigned to this workspace. Add it in Secrets & env as a secret.`,
            );
        }
        // A new URL is a new upstream (the same URL again is not): its sync starts from a clean staging area, so it is a baseline.
        const changed = u.url !== repo.upstream_url;
        const staged = changed && (repo.upstream_url || readState(repo.upstream_state).reset);
        Object.assign(patch, {
          upstream_url: u.url,
          upstream_secret: u.secret,
          upstream_every_s: u.everyS,
          upstream_hook_secret: u.hookSecret,
          ...(changed ? { upstream_state: staged ? JSON.stringify({ ...EMPTY_STATE, reset: true }) : null } : {}),
        });
        audit = {
          kind: 'ci.upstream_set',
          detail: { repo: repo.name, url: u.url, secret: u.secret, everyS: u.everyS, hookSecret: u.hookSecret },
        };
      }
      this.#upstreamAt.delete(repo.id);
    }
    if (req.defaultBranch !== undefined) {
      if (typeof req.defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(req.defaultBranch))
        throw invalid('defaultBranch', 'A branch name.');
      patch.default_branch = req.defaultBranch;
    }
    if (req.protected !== undefined) {
      if (!Array.isArray(req.protected) || req.protected.length > 20 || req.protected.some((g) => typeof g !== 'string' || !GLOB.test(g)))
        throw invalid('protected', 'Up to 20 branch names or patterns.');
      patch.protected = JSON.stringify([...new Set(req.protected)]);
    }
    this.#cs.updateRepo(repo.id, patch);
    if (audit && by)
      this.#opts.audit?.({
        kind: audit.kind,
        actor: by.actor,
        userId: by.userId,
        severity: 'medium',
        subject: `ci_repo:${repo.id}`,
        detail: { workspace: repo.workspace_id, ...audit.detail },
      });
    this.#changed();
    if (req.upstream) this.kick(repo.workspace_id);
    return this.repo(repo.id);
  }

  async connectRepo(id: string, req: Partial<ConnectCiRepoRequest>): Promise<CiRepo> {
    const repo = this.#needRepo(id);
    if (typeof req.path !== 'string' || !req.path.startsWith('/') || req.path.length > 500) throw invalid('path', 'An absolute folder.');
    await this.#running(repo.workspace_id);
    const r = await this.#cp(repo.workspace_id, ['repo', 'connect', repo.name, req.path], { timeoutMs: 60_000 });
    if (!r.ok) throw fromReply(r);
    const connected = [...new Set([...json<string[]>(repo.connected, []), String(r.path)])];
    this.#cs.updateRepo(repo.id, { connected: JSON.stringify(connected) });
    this.#changed();
    return this.repo(repo.id);
  }

  async deleteRepo(id: string): Promise<void> {
    const repo = this.#needRepo(id);
    if (this.#cs.activeCount(repo.id)) throw new AppError('CONFLICT', 'Cancel its runs first.');
    const state = await this.host.state(repo.workspace_id);
    if (state === 'running') {
      const r = await this.#cp(repo.workspace_id, ['repo', 'delete', repo.name]);
      if (!r.ok && r.error !== 'no_repo') throw fromReply(r);
    } else if (state !== 'gone') throw new AppError('CONFLICT', 'Start the workspace first, so its folder can be removed.');
    this.#cs.updateRepo(repo.id, { removed_at: new Date().toISOString() });
    this.#changed();
  }

  async branches(id: string): Promise<CiBranch[]> {
    const repo = this.#needRepo(id);
    await this.#running(repo.workspace_id);
    const r = await this.#cp(repo.workspace_id, ['repo', 'branches', repo.name, '--limit', '200']);
    if (!r.ok) throw fromReply(r);
    const protectedGlobs = json<string[]>(repo.protected, []);
    const latest = this.#cs.latestByBranch(repo.id);
    return ((r.branches as { name: string; sha: string; subject: string; at: string }[]) ?? []).map((b) => ({
      name: b.name,
      sha: b.sha,
      subject: oneLine(b.subject) ?? '',
      at: b.at,
      protected: globMatches(protectedGlobs, b.name),
      runs: latest.filter((l) => l.branch === b.name).map((l) => ({ runId: l.id, pipeline: l.pipeline, status: l.status, sha: l.sha })),
    }));
  }

  async pipelines(id: string, ref?: string): Promise<CiPipelineInfo[]> {
    const repo = this.#needRepo(id);
    await this.#running(repo.workspace_id);
    const target = await this.#resolveRef(repo, ref?.trim() || repo.default_branch);
    const snap = await this.#snapshot(repo, target.sha);
    // What the workspace itself can't give a pipeline is shown as a warning here; a run would fail on it.
    return validateFiles(snap.files ?? []).pipelines.map((p) =>
      p.pipeline
        ? {
            ...p.info,
            diagnostics: [
              ...p.info.diagnostics,
              ...this.#missingSecrets(
                repo.workspace_id,
                p.pipeline.jobs.filter((j) => !j.hidden),
                p.info.file,
                'warning',
              ),
            ],
          }
        : p.info,
    );
  }

  async merge(id: string, req: Partial<MergeCiRequest>, actor = 'ui'): Promise<MergeCiResult> {
    const repo = this.#needRepo(id);
    if (typeof req.source !== 'string' || !req.source) throw invalid('source', 'Pick a branch to merge.');
    if (typeof req.target !== 'string' || !req.target) throw invalid('target', 'Pick the branch to merge into.');
    if (req.strategy !== undefined && req.strategy !== 'ff' && req.strategy !== 'merge') throw invalid('strategy', 'ff or merge.');
    await this.#running(repo.workspace_id);
    const strategy = req.strategy ?? 'merge';
    const ticket = parseTicketBranch(req.source);
    const message = `Merge branch '${req.source}' into ${req.target}${ticket ? `\n\nTicket: ${ticket}` : ''}`;
    const record = (outcome: string, sha: string | null, note: string | null) =>
      this.#cs.insertMerge({
        id: newId('m'),
        repo_id: repo.id,
        source: req.source!,
        target: req.target!,
        strategy,
        result_sha: sha,
        actor,
        at: new Date().toISOString(),
        outcome,
        note,
      });
    const r = await this.#cp(
      repo.workspace_id,
      ['merge', repo.name, req.source, req.target, '--strategy', strategy, '--message', message, '--author', 'Claudepilot'],
      { timeoutMs: 60_000 },
    );
    if (!r.ok) {
      record(r.error ?? 'failed', null, oneLine(r.message as string | undefined));
      throw fromReply(r);
    }
    record(r.alreadyMerged ? 'already_merged' : 'merged', r.sha as string, null);
    this.#changed();
    // The merge wrote an event; look now instead of at the next turn.
    this.kick(repo.workspace_id);
    return { sha: r.sha as string, strategy: r.strategy as 'ff' | 'merge', alreadyMerged: r.alreadyMerged === true };
  }

  /** Reads pipeline files given as text (nothing is read from a workspace): the checker the API and the MCP tool share. */
  validate(req: Partial<ValidateCiRequest>): ValidateCiResult {
    const files = req.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw invalid('files', 'Send { files: { ".pilot/ci.yml": "text" } }.');
    const entries = Object.entries(files);
    if (entries.length > 40) throw invalid('files', 'At most 40 files.');
    const list: SnapshotFile[] = [];
    for (const [path, text] of entries) {
      if (typeof text !== 'string' || path.length > 200) throw invalid('files', 'Each file is a path and its text.');
      list.push({ path, text });
    }
    const { pipelines, diagnostics } = validateFiles(list);
    return { pipelines: pipelines.map((p) => p.info), diagnostics };
  }

  /* ---------- Plumbing ---------- */

  #changed(): void {
    try {
      this.onChange?.();
    } catch (e) {
      console.error(`[ci] change listener failed: ${(e as Error).message}`);
    }
  }

  /** A run was just recorded: link it to its ticket and session, tell the others, and report one that is already over (an invalid pipeline). */
  #born(run: RunRow, message: string | null): void {
    const linked = this.#links.link(run, message);
    this.#hook(() => this.hooks.created?.(linked));
    if (linked.status !== 'queued') this.#moved(linked.id, null);
  }

  /** A run's status changed: the ticket's check and the session's message follow (never allowed to break the poll). */
  #moved(id: string, previous: CiStatus | null): void {
    const row = this.#cs.run(id);
    if (!row) return;
    this.#hook(() => this.hooks.changed?.(row, previous));
    void this.#links.changed(row, previous).catch((e: unknown) => console.error(`[ci] ${id}: linking failed: ${(e as Error).message}`));
    // T-591: a release pipeline that ended writes its report (only when the remote has the setting and its release job passed).
    if (row.status === 'passed' || row.status === 'failed' || row.status === 'cancelled')
      void this.#reporter
        .report(id)
        .catch((e: unknown) =>
          console.error(
            `[ci] ${id}: release report failed: ${oneLine(this.#redact(row.workspace_id, (e as Error).message)) ?? 'unknown error'}`,
          ),
        );
  }

  /* ---------- Release reports (T-591) ---------- */

  /** The remote's release report setting; null: off. */
  releaseReportSetting(repoId: string): CiReleaseReportSetting | null {
    const repo = this.#cs.repo(repoId);
    if (!repo || repo.removed_at) throw notFound('remote');
    return parseSetting(repo.release_report);
  }

  /** Whether the vault a setting names exists (false without a sink: fail closed). The route asks it, with the person's right to write there (ci/authz.ts). */
  vaultExists(vaultId: string): boolean {
    return this.releaseNotes?.exists?.(vaultId) ?? false;
  }

  /** Sets or clears it. A person only (the route refuses tokens and agents); audited. The vault must exist: it is checked when a note is written, so a wrong id fails loudly then. */
  setReleaseReport(repoId: string, setting: CiReleaseReportSetting | null, by: CiDecider): CiReleaseReportSetting | null {
    const repo = this.#cs.repo(repoId);
    if (!repo || repo.removed_at) throw notFound('remote');
    if (setting !== null) {
      const pipeline = typeof setting.pipeline === 'string' ? setting.pipeline.trim() : '';
      const vaultId = typeof setting.vaultId === 'string' ? setting.vaultId.trim() : '';
      const folder = typeof setting.folder === 'string' ? setting.folder.trim().replace(/^\/+|\/+$/g, '') : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pipeline))
        throw new AppError('VALIDATION_FAILED', 'Check the pipeline.', {
          details: { pipeline: 'A pipeline file name without .yml, e.g. deploy.' },
        });
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(vaultId))
        throw new AppError('VALIDATION_FAILED', 'Check the vault.', { details: { vaultId: 'A vault id.' } });
      if (!validFolder(folder))
        throw new AppError('VALIDATION_FAILED', 'Check the folder.', {
          details: { folder: 'A folder in the vault, e.g. Releases (no .., at most four levels).' },
        });
      setting = { pipeline, vaultId, folder };
    }
    this.#cs.updateRepo(repoId, { release_report: setting ? JSON.stringify(setting) : null });
    this.#opts.audit?.({
      kind: 'ci.release_report_setting',
      actor: by.actor,
      userId: by.userId,
      severity: 'medium',
      subject: `ci_repo:${repoId}`,
      detail: { repo: repo.name, vault: setting?.vaultId ?? null, folder: setting?.folder ?? null, pipeline: setting?.pipeline ?? null },
    });
    this.#changed();
    return setting;
  }

  /** The backfill: the report of a past run, into the vault the remote's own setting names. Refuses a run that does not qualify (409 with why). */
  async reportRelease(runId: string): Promise<CiReleaseReportResult> {
    try {
      const r = await this.#reporter.report(runId, true);
      if (!r) throw new AppError('CONFLICT', 'This run has no release report.');
      return r;
    } catch (e) {
      if (e instanceof ReportRefused) throw new AppError('CONFLICT', e.message);
      throw e;
    }
  }

  #hook(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`[ci] hook failed: ${(e as Error).message}`);
    }
  }
}
