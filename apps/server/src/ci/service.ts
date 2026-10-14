// The CI service (PRD §8, §10): follows the remotes of running workspaces, turns events into runs, queues and starts them
// under a per-workspace cap, mirrors each run's state and logs from the workspace into the portal, and answers the API.
// The workspace does the work; this only reads its files and acknowledges what it stored, so a restart loses nothing.

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  CI_REPO_NAME,
  isCiActive,
  parseTicketBranch,
  shortSha,
  CI_ENVIRONMENT_NAME,
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
} from '@portal/contracts';
import { NO_VALUES, SessionStream } from '../chat/valueRedact.js';
import { evaluateRule, needsPersonOf, WINDOW } from './autoApprove.js';
import type { Store } from '../store/store.js';
import { globMatches } from './glob.js';
import { CiUnreachable, type CiHost, type CiReply } from './host.js';
import { CI_LIMITS } from './limits.js';
import { replan, compile, matches, resolveInputs, branchOf, tagOf, type EventContext } from './spec/compile.js';
import { validateFiles, type SnapshotFile, type Validated } from './spec/validate.js';
import { CiStore, type DeploymentRow, type EnvironmentRow, type RepoRow, type RunRow } from './store.js';
import { CiLinks, type CiBumper } from './links.js';
import type { CiSessionsPort } from './sessions.js';
import type { CiTicketsPort } from './tickets.js';
import { cleanLog, oneLine, redactSecrets } from './text.js';
import type { CiEventFile, Plan } from './plan.js';

const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** The facts of a run a deployment row copies. */
const row0 = (r: RunRow) => ({ id: r.id, number: r.number, pipeline: r.pipeline, sha: r.sha, ref: r.ref, actor: r.actor, created_at: r.created_at });

const newRunId = () => `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const WORKSPACE_ID = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SKIP = /\[(?:skip ci|ci skip)\]/i;
const GLOB = /^[A-Za-z0-9._/*?-]{1,200}$/;
const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
  autoApprove: d.auto_verdict && d.auto_line && d.auto_at ? { mode: 'dry', verdict: d.auto_verdict, line: d.auto_line, at: d.auto_at } : null,
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
  /** The platform audit (approvals, protection changes). Names, ids and fixed codes only. */
  audit?: (e: { kind: string; actor: string; userId: string | null; severity?: 'info' | 'medium' | 'high'; subject?: string; detail?: Record<string, unknown> }) => void;
  /** The clock of the auto-approve rule (its daily cap and window, FR41a); tests pass a fake one. */
  now?: () => Date;
}

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
}

interface Polled {
  state: CiRunStateFile | null;
  alive: boolean;
}

export class CiService {
  /** Called after anything changes, for the live socket. */
  onChange?: () => void;
  hooks: CiHooks = {};
  readonly #cs: CiStore;
  readonly #opts: Required<Omit<CiServiceOptions, 'redactFor' | 'streamFor' | 'tickets' | 'sessions' | 'secrets' | 'audit'>> & Pick<CiServiceOptions, 'redactFor' | 'streamFor' | 'secrets' | 'audit'>;
  /** The auto-approve rule's evaluations in flight (dry mode), so a test or a shutdown can wait for them. */
  readonly #ruling = new Set<Promise<void>>();
  /** Runs with an approval being decided right now: one decision at a time per run. */
  readonly #deciding = new Set<string>();
  readonly #links: CiLinks;
  readonly #polling = new Map<string, Promise<void>>();
  readonly #acks = new Map<string, string[]>();
  readonly #lastPoll = new Map<string, number>();
  readonly #kicked = new Set<string>();
  readonly #complained = new Map<string, string>();
  readonly #live = new Map<string, { stream: SessionStream; offset: number }>();
  #timer: NodeJS.Timeout | undefined;
  readonly #maintained = new Map<string, number>();
  #lastPrune = 0;

  constructor(
    private readonly store: Store,
    private readonly host: CiHost,
    opts: CiServiceOptions = {},
  ) {
    this.#cs = new CiStore(store);
    this.#links = new CiLinks(this.#cs, opts.tickets, opts.sessions);
    this.#opts = {
      maxRunsPerWorkspace: opts.maxRunsPerWorkspace ?? 2,
      maxJobsParallel: opts.maxJobsParallel ?? 2,
      pollActiveMs: opts.pollActiveMs ?? CI_LIMITS.pollActiveMs,
      pollIdleMs: opts.pollIdleMs ?? CI_LIMITS.pollIdleMs,
      redactFor: opts.redactFor,
      streamFor: opts.streamFor,
      secrets: opts.secrets,
      audit: opts.audit,
      now: opts.now ?? (() => new Date()),
    };
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
        const busy = this.#kicked.has(id) || this.#cs.runningRuns(id).length > 0 || this.#cs.queuedRuns(id).length > 0 || (this.#acks.get(id)?.length ?? 0) > 0;
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
      .finally(() => this.#polling.delete(workspaceId));
    this.#polling.set(workspaceId, p);
    return p;
  }

  /* ---------- Following a workspace ---------- */

  async #poll(workspaceId: string): Promise<void> {
    const state = await this.host.state(workspaceId);
    // Stopped: events wait on the volume and are read after the next start. Gone: its runs stay as history.
    if (state !== 'running') return;
    await this.host.install(workspaceId);
    const following = this.#cs.runningRuns(workspaceId);
    const acks = this.#acks.get(workspaceId) ?? [];
    const args = ['poll'];
    if (acks.length) args.push('--ack', acks.join(','));
    if (following.length) args.push('--runs', following.map((r) => r.id).join(','));
    const reply = await this.host.cp(workspaceId, args, { timeoutMs: 20_000 });
    if (!reply.ok) throw new Error(`poll: ${reply.message ?? reply.error}`);
    this.#acks.set(workspaceId, (this.#acks.get(workspaceId) ?? []).filter((id) => !acks.includes(id)));

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

  /* ---------- Events become runs ---------- */

  async #event(workspaceId: string, ev: CiEventFile): Promise<void> {
    if (this.#cs.eventSeen(workspaceId, ev.id)) return;
    const repo = this.#cs.repoByName(workspaceId, ev.repo);
    const record = (outcome: string, note: string | null = null) =>
      this.#cs.insertEvent({ workspace_id: workspaceId, id: ev.id, repo_id: repo?.id ?? null, repo: ev.repo, kind: ev.kind, ref: ev.ref, old_sha: ev.old, new_sha: ev.new, via: ev.via, at: ev.at, outcome, note });
    if (!repo) return record('ignored', 'not one of the portal’s remotes');
    if (ev.kind === 'delete') return record('ignored', 'ref deleted');
    const branch = branchOf(ev.ref);
    const protectedBranch = !!branch && globMatches(json<string[]>(repo.protected, []), branch);
    const trigger: CiTrigger = protectedBranch ? 'merge' : 'push';

    const snap = (await this.host.cp(workspaceId, ['snapshot', repo.name, ev.new], { timeoutMs: 30_000 })) as CiReply & { message?: string; subject?: string; hasPilot?: boolean; files?: SnapshotFile[] };
    if (!snap.ok) {
      if (snap.error === 'no_commit') return record('ignored', 'the commit is no longer in the remote');
      throw new Error(snap.message ?? snap.error ?? 'snapshot failed');
    }
    if (SKIP.test(snap.message ?? '')) return record('skipped', '[skip ci] in the commit message');
    if (!snap.hasPilot) return record('no_pipeline', 'no .pilot folder');
    const { pipelines } = validateFiles(snap.files ?? []);
    if (!pipelines.length) return record('no_pipeline', 'no pipeline file in .pilot');
    if (this.#cs.queuedRuns(workspaceId).length >= CI_LIMITS.queuedPerWorkspace) return record('queue_full', `${CI_LIMITS.queuedPerWorkspace} runs are already waiting`);

    const made: RunRow[] = [];
    this.#cs.tx(() => {
      for (const v of pipelines) {
        const wanted = !v.pipeline || matches(v.pipeline, { event: trigger, ref: ev.ref });
        if (!wanted) continue;
        made.push(this.#insertRun(repo, v, { event: trigger, ref: ev.ref, sha: ev.new, base: ev.old === '0'.repeat(40) ? null : ev.old, actor: ev.via === 'portal' ? 'ui' : 'push', inputs: {}, eventId: ev.id, subject: snap.subject ?? null, trigger }));
      }
      record(made.length ? 'runs' : 'no_match', made.length ? `${made.length} run${made.length === 1 ? '' : 's'}` : 'no pipeline matches this ref');
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
    o: { event: EventContext['event']; ref: string; sha: string; base: string | null; actor: string; inputs: Record<string, string | boolean>; eventId: string | null; subject: string | null; trigger: CiTrigger; rerunOf?: string; sessionId?: string | null; actorLabel?: string | null },
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
      row = { ...base, status: 'failed', reason: 'invalid_pipeline', diagnostics: JSON.stringify(v.info.diagnostics), finished_at: now, duration_ms: 0, archived: 1 };
    } else {
      const ctx: EventContext = { event: o.event, ref: o.ref, sha: o.sha, base: o.base, actor: o.actor, repo: repo.name, ticket: null, inputs: o.inputs, workspace: repo.workspace_id, runId: id, runNumber: number };
      const c = compile(v.pipeline, ctx, { maxParallel: this.#opts.maxJobsParallel });
      const missing = c.ok ? this.#missingSecrets(repo.workspace_id, c.plan.jobs.filter((j) => !j.skip), v.info.file) : [];
      const gates = c.ok && !missing.length ? this.#gates(repo, c.plan, row0(base)) : null;
      row = !c.ok
        ? { ...base, status: 'failed', reason: 'invalid_pipeline', diagnostics: JSON.stringify(c.diagnostics), finished_at: now, duration_ms: 0, archived: 1 }
        : missing.length
          ? { ...base, status: 'failed', reason: 'invalid_pipeline', diagnostics: JSON.stringify(missing), finished_at: now, duration_ms: 0, archived: 1 }
          : gates && 'problem' in gates
            ? { ...base, status: 'failed', reason: 'invalid_pipeline', diagnostics: JSON.stringify([gates.problem]), finished_at: now, duration_ms: 0, archived: 1 }
            : { ...base, plan: JSON.stringify(c.plan), concurrency_group: c.group, cancel_in_progress: c.cancelInProgress ? 1 : 0 };
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
  #gates(repo: RepoRow, plan: Plan, run: Pick<RunRow, 'id' | 'number' | 'pipeline' | 'sha' | 'ref' | 'actor' | 'created_at'>): { deployments: DeploymentRow[] } | { problem: CiDiagnostic } {
    const jobs = plan.jobs.filter((j) => j.environment && !j.skip);
    for (const j of plan.jobs) j.approval = null;
    if (!jobs.length) return { deployments: [] };
    if (!this.#cs.deploymentsReady)
      return { problem: { file: '', line: 0, column: 0, path: `jobs.${jobs[0]!.id}.environment`, severity: 'error', code: 'no-environments', message: 'This portal can not hold deployment approvals yet (its database is not up to date).' } };
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
  #missingSecrets(workspaceId: string, jobs: { id: string; secrets: string[] }[], file: string, severity: 'error' | 'warning' = 'error'): CiDiagnostic[] {
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
          message: found ? `${name} reaches Claude Code as a variable only, so a job can't use it.` : `The secret ${name} is not available in this workspace.`,
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
          if (run.cancel_in_progress) for (const o of others) await this.#cancelRow(o, 'superseded', { actor: 'pipeline', note: `for #${run.number}` }).catch(() => undefined);
          // Either way this one waits for the group to be clear; the next look starts it.
          continue;
        }
      }
      const text = run.plan;
      let reply: CiReply;
      try {
        reply = await this.host.cp(workspaceId, ['start', run.id, '--bytes', String(Buffer.byteLength(text))], { stdin: text, timeoutMs: 30_000 });
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

  #retry(run: RunRow, why: string): void {
    const attempts = run.attempts + 1;
    if (attempts >= 3) return this.#finishFailed(run, 'runner_error', why);
    this.#cs.updateRun(run.id, { attempts });
    console.error(`[ci] ${run.id}: could not start (${attempts}/3): ${why}`);
  }

  #finishFailed(run: RunRow, reason: string, note: string): void {
    const now = new Date().toISOString();
    this.#cs.updateRun(run.id, { status: 'failed', reason, finished_at: now, duration_ms: 0, archived: 1, diagnostics: JSON.stringify([{ file: '', line: 0, column: 0, path: '', severity: 'error', code: reason, message: note }]) });
    this.#settleDeployments(run.id, null);
    this.#changed();
    this.#moved(run.id, run.status);
  }

  /* ---------- Following runs ---------- */

  async #follow(row: RunRow, polled: Polled | undefined): Promise<void> {
    if (!polled) return;
    const s = polled.state;
    if (!s) {
      // No state file: the workspace was reset, or the start never took.
      if (!polled.alive && Date.now() - Date.parse(row.started_at ?? row.created_at) > 30_000) await this.#lost(row, null);
      return;
    }
    if (s.status === 'passed' || s.status === 'failed' || s.status === 'cancelled') return this.#complete(row, s);
    if (!polled.alive) return this.#lost(row, s);
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
      void this.#links.waiting(row, d.environment).catch((e: unknown) => console.error(`[ci] ${row.id}: reporting the wait failed: ${(e as Error).message}`));
      this.#rule(row.id, d.id);
    }
  }

  /**
   * The auto-approve rule (FR41a), slice 1: when the environment's mode is `dry` (or `on`, which is `dry` until slice 2), says once on the
   * deployment and in the audit what the rule WOULD do. It reads facts and writes that line, nothing else: no key, no `cp-ci approve`, no
   * `decide`. Mode `off` writes nothing. Never breaks the poll.
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
      const at = this.#opts.now().toISOString();
      if (!this.#cs.setAutoVerdict(dep.id, v.verdict, v.line, at)) return;
      this.#opts.audit?.({
        kind: 'ci.deploy_auto_approve',
        severity: 'info',
        actor: `rule:${dep.environment}`,
        userId: null,
        subject: `ci_run:${run.id}`,
        detail: { workspace: run.workspace_id, repo: run.repo, pipeline: run.pipeline, run: run.number, job: dep.job, environment: dep.environment, sha: shortSha(run.sha), mode: 'dry', verdict: v.verdict, line: v.line },
      });
      console.log(`[ci] ${run.id} ${dep.job}: ${v.line}`);
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

  /** The run is over: each deployment gets how its job ended, an undecided approval expires, and every key is dropped. */
  #settleDeployments(runId: string, s: CiRunStateFile | null): void {
    for (const d of this.#cs.deploymentsOfRun(runId)) {
      const job = s?.jobs.find((j) => j.id === d.job);
      const undecided = d.approval === 'pending' || d.approval === 'waiting';
      const approval: DeploymentRow['approval'] = !undecided ? d.approval : job?.reason === 'rejected' ? 'rejected' : job?.status === 'skipped' ? 'skipped' : 'expired';
      this.#cs.updateDeployment(d.id, { approval, gate_key: null, outcome: job?.status ?? 'cancelled' });
    }
  }

  /** The supervisor is gone with the run still open (the workspace stopped, or it was killed): the run failed and can be run again. */
  async #lost(row: RunRow, last: CiRunStateFile | null): Promise<void> {
    // With no state file the jobs come from the plan, all still waiting.
    const s: CiRunStateFile = last ?? { v: 1, runId: row.id, status: 'running', reason: null, startedAt: row.started_at, finishedAt: null, durationMs: null, jobs: this.get(row.id).detail };
    for (const j of s.jobs) {
      if (j.status === 'running') (j.status = 'failed'), (j.reason = 'runner_lost');
      else if (j.status === 'pending' || j.status === 'waiting') (j.status = 'cancelled'), (j.reason = 'runner_lost');
      for (const st of j.steps) {
        if (st.status === 'running') (st.status = 'failed'), (st.reason = 'runner_lost');
        else if (st.status === 'pending') (st.status = 'cancelled'), (st.reason = 'runner_lost');
      }
    }
    s.status = 'failed';
    s.reason = 'runner_lost';
    s.finishedAt = new Date().toISOString();
    await this.#complete(row, s);
  }

  async #complete(row: RunRow, s: CiRunStateFile): Promise<void> {
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
    this.#settleDeployments(row.id, s);
    await this.#archive(row.id).catch((e: unknown) => console.error(`[ci] ${row.id}: logs not kept yet: ${(e as Error).message}`));
    this.#changed();
    this.#moved(row.id, row.status);
  }

  /** Keeps a finished run's logs in the portal, cleaned and redacted (PRD FR30, FR31). */
  async #archive(runId: string): Promise<void> {
    const row = this.#cs.run(runId);
    if (!row || row.archived) return;
    const reply = await this.host.cp(row.workspace_id, ['archive', runId, '--head', String(CI_LIMITS.archiveHeadBytes), '--tail', String(CI_LIMITS.archiveTailBytes), '--total', String(CI_LIMITS.archiveRunBytes)], { timeoutMs: 30_000 });
    if (!reply.ok) throw new Error(reply.message ?? reply.error ?? 'archive failed');
    const redact = this.#redactor(row.workspace_id);
    const steps = (reply.steps as { job: string; step: number; size: number; head: string; tail: string | null; omitted: number }[] | undefined) ?? [];
    this.#cs.saveLogs(
      runId,
      steps.map((s) => ({
        job: s.job,
        step: s.step,
        bytes: s.size,
        omitted: s.omitted,
        text: redact(cleanLog(s.tail === null ? s.head : `${s.head}${s.head.endsWith('\n') ? '' : '\n'}[… ${s.omitted} bytes omitted …]\n${s.tail}`)),
      })),
    );
  }

  #redactor(workspaceId: string): (text: string) => string {
    const extra = this.#opts.redactFor?.(workspaceId);
    return (text) => redactSecrets(extra ? extra(text) : text);
  }

  /** Housekeeping on a quiet poll: logs that could not be kept earlier, old runs, and the workspace's own cleanup. */
  async #maintenance(workspaceId: string): Promise<void> {
    for (const row of this.#cs.unarchived(5).filter((r) => r.workspace_id === workspaceId)) await this.#archive(row.id).catch(() => undefined);
    const now = Date.now();
    if (now - this.#lastPrune >= 60 * 60_000) {
      this.#lastPrune = now;
      this.#cs.prune({ runDays: CI_LIMITS.runRecordDays, eventDays: CI_LIMITS.eventRecordDays, keepPerWorkspace: CI_LIMITS.runRecordsPerWorkspace });
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

  async #cancelRow(row: RunRow, reason: 'cancelled' | 'superseded', by: { actor: string; label?: string | null; note?: string | null }): Promise<void> {
    const now = new Date().toISOString();
    const who = { cancelled_by: by.actor, cancelled_by_label: oneLine(by.label)?.slice(0, 60) ?? null, cancel_note: oneLine(by.note)?.slice(0, 120) ?? null };
    if (row.status === 'queued') {
      this.#cs.updateRun(row.id, { status: 'cancelled', reason, finished_at: now, duration_ms: 0, archived: 1, ...who });
      this.#settleDeployments(row.id, null);
      this.#changed();
      this.#moved(row.id, 'queued');
      return;
    }
    if (row.status !== 'running') throw new AppError('CONFLICT', 'That run is already over.');
    const reply = await this.host.cp(row.workspace_id, ['cancel', row.id]).catch((e: unknown) => {
      throw new AppError('SERVICE_UNAVAILABLE', (e as Error).message, { expose: true });
    });
    if (!reply.ok) throw fromReply(reply);
    this.#cs.updateRun(row.id, { ...who, ...(reason === 'superseded' ? { reason: 'superseded' as const } : {}) });
    this.kick(row.workspace_id);
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
      const copy: RunRow = { ...row, id: newId2, number, trigger: 'rerun', event_id: null, status: plan ? 'queued' : 'failed', reason: plan ? null : row.reason, actor, actor_label: null, cancelled_by: null, cancelled_by_label: null, cancel_note: null, plan: plan ? JSON.stringify(plan) : null, state: null, attempts: 0, created_at: now, started_at: null, finished_at: plan ? null : now, duration_ms: plan ? null : 0, archived: plan ? 0 : 1, rerun_of: row.id };
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
   * reach this). Approving hands the runner the job's key through `cp-ci approve`; the decision is recorded only after the runner took it,
   * and one decision per run is made at a time, so two people can not approve and reject the same job into a split state.
   */
  async decide(id: string, job: unknown, decision: 'approve' | 'reject', by: CiDecider): Promise<CiRun> {
    const row = this.#need(id);
    if (typeof job !== 'string' || !JOB_ID.test(job)) throw invalid('job', 'Pick the job that waits.');
    const dep = this.#cs.deploymentsReady ? this.#cs.deployment(row.id, job) : undefined;
    if (!dep) throw notFound('deployment');
    if (row.status !== 'running' || dep.approval !== 'waiting' || !dep.gate_key) throw new AppError('CONFLICT', dep.approval === 'pending' ? 'That job is not waiting yet.' : 'That job is not waiting for an approval.');
    if (this.#deciding.has(row.id)) throw new AppError('CONFLICT', 'Someone is deciding this right now.');
    this.#deciding.add(row.id);
    try {
      await this.#running(row.workspace_id);
      const key = dep.gate_key;
      const reply = decision === 'approve' ? await this.#cp(row.workspace_id, ['approve', row.id, job, '--bytes', String(Buffer.byteLength(key))], { stdin: key }) : await this.#cp(row.workspace_id, ['approve', row.id, job, '--reject']);
      if (!reply.ok) {
        if (reply.error === 'over' || reply.error === 'not_waiting') throw new AppError('CONFLICT', 'That job is not waiting any more.');
        throw fromReply(reply);
      }
      const at = new Date().toISOString();
      const state = decision === 'approve' ? 'approved' : 'rejected';
      if (!this.#cs.updateDeployment(dep.id, { approval: state, decided_by: by.actor, decided_at: at, gate_key: null }, ['waiting'])) throw new AppError('CONFLICT', 'That was decided already.');
      this.#opts.audit?.({
        kind: decision === 'approve' ? 'ci.deploy_approved' : 'ci.deploy_rejected',
        severity: 'medium',
        actor: by.actor,
        userId: by.userId,
        subject: `ci_run:${row.id}`,
        detail: { workspace: row.workspace_id, repo: row.repo, pipeline: row.pipeline, run: row.number, job, environment: dep.environment, sha: shortSha(row.sha), startedBy: row.actor },
      });
      console.log(`[ci] ${row.id} ${job}: deployment to ${dep.environment} ${state}`);
    } finally {
      this.#deciding.delete(row.id);
    }
    this.#changed();
    this.kick(row.workspace_id);
    return this.get(row.id);
  }

  #envView(e: EnvironmentRow): CiEnvironment {
    // `on` is reserved for slice 2 (T-110) and behaves as `dry` until then, so it shows as `dry`.
    const mode: CiAutoApproveMode = (e.auto_approve ?? 'off') === 'off' ? 'off' : 'dry';
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
    if (!this.#cs.deploymentsReady) throw new AppError('SERVICE_UNAVAILABLE', 'This portal’s database is not up to date.', { expose: true });
    const env = this.#cs.ensureEnvironment(repo.id, name, by.actor, newId('e'));
    if ((env.protected === 1) !== req.protected) {
      this.#cs.setProtected(env.id, req.protected, by.actor);
      this.#opts.audit?.({ kind: 'ci.environment_protection', severity: req.protected ? 'info' : 'high', actor: by.actor, userId: by.userId, subject: `ci_repo:${repo.id}`, detail: { workspace: repo.workspace_id, repo: repo.name, environment: name, protected: req.protected } });
      this.#changed();
    }
    return this.#envView(this.#cs.environment(repo.id, name)!);
  }

  /**
   * Sets an environment's auto-approve rule (FR41a): a person with manage (the route refuses tokens and agents; no Portal MCP tool reaches
   * this), audited as `ci.environment_auto_approve`. Slice 1 knows `off` and `dry`; `on` is refused until the real approval exists.
   */
  setAutoApprove(repoId: string, name: unknown, req: Partial<UpdateCiAutoApproveRequest>, by: CiDecider): CiEnvironment {
    const repo = this.#needRepo(repoId);
    if (typeof name !== 'string' || !CI_ENVIRONMENT_NAME.test(name)) throw invalid('name', 'Lowercase letters, digits, . _ and -.');
    if ((req.mode as string) === 'on') throw invalid('mode', 'The real auto-approval comes later (T-110 slice 2): use dry to see what it would do.');
    if (req.mode !== 'off' && req.mode !== 'dry') throw invalid('mode', 'off or dry.');
    if (req.window !== undefined && req.window !== null && (typeof req.window !== 'string' || !WINDOW.test(req.window))) throw invalid('window', 'HH:MM-HH:MM in UTC, or null for always.');
    if (req.needsPerson !== undefined && req.needsPerson !== null && (!Array.isArray(req.needsPerson) || req.needsPerson.length > 50 || req.needsPerson.some((g) => typeof g !== 'string' || !GLOB.test(g))))
      throw invalid('needsPerson', 'Up to 50 path patterns, or null for the defaults.');
    if (!this.#cs.deploymentsReady || !this.#cs.autoApproveReady) throw new AppError('SERVICE_UNAVAILABLE', 'This portal’s database is not up to date.', { expose: true });
    const env = this.#cs.environment(repo.id, name);
    if (!env) throw notFound('environment');
    const next = {
      mode: req.mode,
      window: req.window === undefined ? (env.auto_window ?? null) : req.window,
      paths: req.needsPerson === undefined ? (env.auto_paths ?? null) : req.needsPerson === null ? null : JSON.stringify([...new Set(req.needsPerson)]),
    };
    const was = { mode: env.auto_approve ?? 'off', window: env.auto_window ?? null, paths: env.auto_paths ?? null };
    if (was.mode !== next.mode || was.window !== next.window || was.paths !== next.paths) {
      this.#cs.setAutoApprove(env.id, next, by.actor);
      this.#opts.audit?.({
        kind: 'ci.environment_auto_approve',
        severity: next.mode === 'off' ? 'info' : 'medium',
        actor: by.actor,
        userId: by.userId,
        subject: `ci_repo:${repo.id}`,
        detail: { workspace: repo.workspace_id, repo: repo.name, environment: name, mode: next.mode, was: was.mode, window: next.window, needsPerson: next.paths === null ? 'defaults' : 'own list' },
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
   * `deploymentOnly` refuses a pipeline in which no job names an environment: what an agent may start on a branch that is not its own (PRD §14).
   */
  async startRun(req: Partial<StartCiRunRequest>, actor = 'ui', opts: { sessionId?: string | null; deploymentOnly?: string; actorLabel?: string | null } = {}): Promise<CiRun> {
    if (typeof req.repoId !== 'string') throw invalid('repoId', 'Pick a remote.');
    const repo = this.#needRepo(req.repoId);
    if (typeof req.pipeline !== 'string' || !req.pipeline) throw invalid('pipeline', 'Pick a pipeline.');
    if (typeof req.ref !== 'string' || !req.ref.trim()) throw invalid('ref', 'Pick a branch or tag.');
    await this.#running(repo.workspace_id);
    const ref = await this.#resolveRef(repo, req.ref.trim());
    const snap = await this.#snapshot(repo, ref.sha);
    const found = validateFiles(snap.files ?? []).pipelines.find((p) => p.info.file.replace(/^\.pilot\//, '').replace(/\.ya?ml$/, '') === req.pipeline);
    if (!found) throw notFound('pipeline');
    if (!found.pipeline) throw new AppError('CONFLICT', 'That pipeline has errors. Fix them and push first.', { details: { diagnostics: found.info.diagnostics } });
    if (!found.pipeline.on.manual) throw new AppError('CONFLICT', 'That pipeline can not be started by hand: it has no manual trigger.');
    if (opts.deploymentOnly && !found.pipeline.jobs.some((j) => !j.hidden && j.environment)) throw new AppError('FORBIDDEN', opts.deploymentOnly);
    const { values, problems } = resolveInputs(found.pipeline.on.manual.inputs, req.inputs);
    if (Object.keys(problems).length) throw new AppError('VALIDATION_FAILED', 'Check the inputs.', { details: problems });
    const row = this.#cs.tx(() => this.#insertRun(repo, found, { event: 'manual', ref: ref.ref, sha: ref.sha, base: null, actor, inputs: values, eventId: null, subject: snap.subject ?? null, trigger: 'manual', sessionId: opts.sessionId ?? null, actorLabel: opts.actorLabel ?? null }));
    this.#born(row, snap.message ?? null);
    this.#changed();
    this.kick(repo.workspace_id);
    return this.get(row.id);
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
    const r = (await this.#cp(repo.workspace_id, ['snapshot', repo.name, sha], { timeoutMs: 30_000 })) as CiReply & { subject?: string; files?: SnapshotFile[]; message?: string; hasPilot?: boolean };
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
    const jobs = state ? state.jobs.map((j) => ({ id: j.id, status: j.status })) : (plan.jobs ?? []).map((j) => ({ id: j.id, status: (j.skip ? 'skipped' : 'pending') as CiUnitStatus }));
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
    };
  }

  list(f: CiRunFilter = {}): CiRunList {
    const { rows, total, active } = this.#cs.listRuns({ workspace: f.workspace, repoId: f.repo, pipeline: f.pipeline, branch: f.branch, statuses: f.status, ticket: f.ticket, session: f.session, before: f.before, limit: f.limit });
    return { items: rows.map((r) => this.#summary(r)), total, active };
  }

  async runs(f: CiRunFilter = {}): Promise<CiRunList> {
    return this.list(f);
  }

  get(id: string): CiRun {
    const row = this.#need(id);
    const state = json<CiRunStateFile | null>(row.state, null);
    const plan = json<{ jobs?: { id: string; name: string; needs: string[]; skip: string | null; environment?: string | null; steps: { name: string; skip: string | null }[] }[] }>(row.plan, {});
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
          steps: j.steps.map((s, idx) => ({ idx, name: s.name, status: (s.skip || j.skip ? 'skipped' : 'pending') as CiUnitStatus, startedAt: null, durationMs: null, exitCode: null, logBytes: 0, logTruncated: false, ignored: false, reason: s.skip || j.skip ? ('condition' as const) : null })),
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
    };
  }

  /** What CI told the run's session (one per state), and the bumps (`bump:<mode>` rows), apart. */
  #messages(runId: string): Pick<CiRun, 'reports' | 'bumps'> {
    const reports: CiRunReport[] = [];
    const bumps: CiRunBump[] = [];
    for (const m of this.#cs.messagesOfRun(runId)) {
      if (m.state?.startsWith('bump:')) bumps.push({ sessionId: m.session_id, mode: m.state === 'bump:prioritise' ? 'prioritise' : 'ask', outcome: m.outcome === 'bumped' ? 'sent' : 'refused', at: m.at, note: m.note });
      else reports.push({ state: (m.state ?? 'failed') as CiRunReport['state'], outcome: m.outcome as CiRunReport['outcome'], sessionId: m.session_id, at: m.at, note: m.note });
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
    this.#opts.audit?.({ kind: 'ci.run_bumped', actor: by.actor, userId: by.userId, subject: `ci_run:${row.id}`, detail: { workspace: row.workspace_id, run: row.number, pipeline: row.pipeline, sessionId: to.sessionId, mode: req.mode ?? null, ticketId: row.ticket_id, note: typeof req.note === 'string' && req.note.trim().length > 0 } });
    this.#changed();
    return this.get(id);
  }

  /** The run with the workspace's state filled in (one listing for however many runs). */
  async show(id: string): Promise<CiRun> {
    const run = this.get(id);
    const states = await this.host.states();
    return { ...run, workspaceState: states.get(run.workspaceId) ?? 'gone' };
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
    const stream = live && live.offset === from ? live : { stream: this.#opts.streamFor?.(row.workspace_id) ?? new SessionStream(NO_VALUES), offset: from };
    let reply: CiReply;
    try {
      reply = await this.host.cp(row.workspace_id, ['log', id, job, String(n), String(from)], { timeoutMs: 15_000 });
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
    if (!CI_REPO_NAME.test(name) || name.endsWith('.git') || name.includes('..')) throw invalid('name', 'Lowercase letters, digits, . _ and -.');
    if (req.source !== undefined && (typeof req.source !== 'string' || !req.source.startsWith('/') || req.source.length > 500)) throw invalid('source', 'An absolute folder.');
    if (req.defaultBranch !== undefined && (typeof req.defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(req.defaultBranch))) throw invalid('defaultBranch', 'A branch name.');
    if (this.#cs.repoByName(req.workspaceId, name)) throw new AppError('CONFLICT', `There is already a remote named ${name} here.`, { details: { name: 'Taken.' } });
    if (this.#cs.repos(req.workspaceId).length >= CI_LIMITS.reposPerWorkspace) throw new AppError('CONFLICT', `A workspace has at most ${CI_LIMITS.reposPerWorkspace} remotes.`);
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

  async updateRepo(id: string, req: Partial<UpdateCiRepoRequest>): Promise<CiRepo> {
    const repo = this.#needRepo(id);
    const patch: Parameters<CiStore['updateRepo']>[1] = {};
    if (req.defaultBranch !== undefined) {
      if (typeof req.defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(req.defaultBranch)) throw invalid('defaultBranch', 'A branch name.');
      patch.default_branch = req.defaultBranch;
    }
    if (req.protected !== undefined) {
      if (!Array.isArray(req.protected) || req.protected.length > 20 || req.protected.some((g) => typeof g !== 'string' || !GLOB.test(g))) throw invalid('protected', 'Up to 20 branch names or patterns.');
      patch.protected = JSON.stringify([...new Set(req.protected)]);
    }
    this.#cs.updateRepo(repo.id, patch);
    this.#changed();
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
    return validateFiles(snap.files ?? []).pipelines.map((p) => (p.pipeline ? { ...p.info, diagnostics: [...p.info.diagnostics, ...this.#missingSecrets(repo.workspace_id, p.pipeline.jobs.filter((j) => !j.hidden), p.info.file, 'warning')] } : p.info));
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
      this.#cs.insertMerge({ id: newId('m'), repo_id: repo.id, source: req.source!, target: req.target!, strategy, result_sha: sha, actor, at: new Date().toISOString(), outcome, note });
    const r = await this.#cp(repo.workspace_id, ['merge', repo.name, req.source, req.target, '--strategy', strategy, '--message', message, '--author', 'Claudepilot'], { timeoutMs: 60_000 });
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
  }

  #hook(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`[ci] hook failed: ${(e as Error).message}`);
    }
  }
}
