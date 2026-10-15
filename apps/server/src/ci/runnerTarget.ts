// Runner targets (T-557, docs/prd/local-git-ci.md section 23): where a heavy job runs. One small seam, so the cluster Job of
// scripts/job-run.sh and, later, a burst Codespace look the same to the caller: start, run, logs, stop, remove. Nothing here
// calls GitHub or a cluster by itself: the cluster target takes an injected `exec`, the fake keeps its state in memory.

export interface RunSpec {
  /** The command line, as `job-run.sh -- <command>` takes it (one shell string). */
  command: string;
  /** A pushed branch or commit. Absent: HEAD of the caller's folder (job-run's own default). */
  ref?: string;
  /** Extra `job-run.sh` options, passed through untouched (`--repo`, `--timeout`, `--out`, `--big` ...). */
  options?: string[];
  /** The deadline of the run, in milliseconds. Past it the run ends with reason `timeout` and the target is stopped and removed. */
  timeoutMs?: number;
  /** Secret NAMES the job needs, `pool:NAME` (never a value). The runner gets them only as a sealed lease. */
  secrets?: string[];
}

/**
 * A job's secrets, sealed for one runner (S1b makes it; here it is only the shape). Carries names and an opaque sealed blob, never a
 * value: nothing that prints a lease prints a secret.
 */
export interface SealedLease {
  readonly id: string;
  /** The runner (its enrollment key) the lease is sealed for. */
  readonly audience: string;
  readonly names: readonly string[];
  readonly sealed: string;
  readonly expiresAt: number;
}

/** Makes and revokes leases. The portal resolves the names for the program's own refs only, and writes one audit row per job and name. */
export interface LeaseIssuer {
  issue(names: string[], audience: string): Promise<SealedLease>;
  revoke(id: string): Promise<void>;
}

/** What `start` returns: an opaque id the other calls take. */
export interface RunnerHandle {
  readonly id: string;
  readonly spec: RunSpec;
  readonly lease?: SealedLease;
}

export type RunReason = 'ok' | 'step_failed' | 'timeout' | 'cancelled' | 'start_failed' | 'runner_error';
export interface RunResult {
  /** The command's exit code; null when it never ran or never finished. */
  rc: number | null;
  reason: RunReason;
}

export interface RunnerTarget {
  readonly kind: 'cluster' | 'connect' | 'codespace' | 'fake';
  /** Creates or starts the runner; resolves when it can run. A target that cannot honour a lease it is given must refuse, not ignore it. */
  start(spec: RunSpec, signal?: AbortSignal, lease?: SealedLease): Promise<RunnerHandle>;
  /** Runs the command to its end. A command that fails is a result, not a throw. */
  run(h: RunnerHandle, signal?: AbortSignal): Promise<RunResult>;
  /** The masked log so far. */
  logs(h: RunnerHandle): Promise<string>;
  /** Stops the work; safe to call twice. */
  stop(h: RunnerHandle): Promise<void>;
  /** Releases everything held or paid for; safe to call twice. */
  remove(h: RunnerHandle): Promise<void>;
}

export interface Outcome extends RunResult {
  log: string;
  /** What `stop` or `remove` threw (the run's own result is still returned). */
  cleanupErrors: string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The one lifecycle: start, run under the deadline, read the log, then stop and remove in every case, so a failed start, a failed
 * run or a timeout still releases the runner. A cleanup that fails is reported in `cleanupErrors`, never swallowed.
 */
export async function runOnTarget(
  target: RunnerTarget,
  spec: RunSpec,
  opts: { signal?: AbortSignal; leases?: LeaseIssuer; audience?: string } = {},
): Promise<Outcome> {
  const cleanupErrors: string[] = [];
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  if (spec.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, spec.timeoutMs);
  }
  let h: RunnerHandle | null = null;
  let lease: SealedLease | undefined;
  let result: RunResult;
  let log = '';
  try {
    try {
      if (spec.secrets?.length) {
        if (!opts.leases) throw new Error('the job declares secrets and no lease issuer is configured');
        lease = await opts.leases.issue(spec.secrets, opts.audience ?? target.kind);
      }
      h = await target.start(spec, ctl.signal, lease);
    } catch (e) {
      // No handle came back: a target must release what a failed `start` made itself (the codespace target deletes its own).
      return { rc: null, reason: timedOut ? 'timeout' : 'start_failed', log: msg(e), cleanupErrors };
    }
    try {
      result = await target.run(h, ctl.signal);
      if (timedOut) result = { rc: result.rc, reason: 'timeout' };
      else if (opts.signal?.aborted) result = { rc: result.rc, reason: 'cancelled' };
    } catch (e) {
      result = { rc: null, reason: timedOut ? 'timeout' : opts.signal?.aborted ? 'cancelled' : 'runner_error' };
      log = msg(e);
    }
    try {
      log = (await target.logs(h)) || log;
    } catch (e) {
      log ||= `log unavailable: ${msg(e)}`;
    }
    return { ...result, log, cleanupErrors };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (lease) {
      try {
        await opts.leases!.revoke(lease.id);
      } catch (e) {
        cleanupErrors.push(`revoke: ${msg(e)}`);
      }
    }
    if (h) {
      for (const [what, fn] of [['stop', target.stop], ['remove', target.remove]] as const) {
        try {
          await fn.call(target, h);
        } catch (e) {
          cleanupErrors.push(`${what}: ${msg(e)}`);
        }
      }
    }
  }
}

/** Removes every handle idle longer than `idleMs` (a runner nobody uses is a cost). Returns the ids removed. */
export async function sweepIdle(
  target: RunnerTarget,
  held: Map<string, { handle: RunnerHandle; idleSince: number }>,
  now: number,
  idleMs: number,
): Promise<string[]> {
  const gone: string[] = [];
  for (const [id, e] of [...held]) {
    if (now - e.idleSince < idleMs) continue;
    try {
      await target.stop(e.handle);
      await target.remove(e.handle);
      held.delete(id);
      gone.push(id);
    } catch {
      // kept: the next sweep tries again
    }
  }
  return gone;
}

/* ---------- The cluster target: scripts/job-run.sh, unchanged ---------- */

export type Exec = (argv: string[], signal?: AbortSignal) => Promise<{ rc: number; out: string }>;

const JOB = /\bclaudepilot-job-[0-9a-f]{8}\b/;

/**
 * The existing path behind the seam: `scripts/job-run.sh [options] [--ref r] -- <command>`, with job-run's own caps, log and exit
 * codes (the command's, 1 not finished, 2 usage, 124 past the deadline). `exec` runs the script (the caller gives it the real one).
 * `start` makes nothing: job-run creates and deletes its Job itself, so `stop` and `remove` only ask it to stop a Job it named.
 */
export class ClusterTarget implements RunnerTarget {
  readonly kind = 'cluster' as const;
  readonly #state = new Map<string, { log: string; job: string | null }>();
  #n = 0;
  constructor(private readonly exec: Exec) {}

  async start(spec: RunSpec, _signal?: AbortSignal, lease?: SealedLease): Promise<RunnerHandle> {
    // Until the lease is built (S1b) a Job cannot receive declared secrets: refuse rather than run without them.
    if (spec.secrets?.length || lease) throw new Error('the cluster target takes no secret lease yet (T-557 S1b)');
    const id = `cluster-${++this.#n}`;
    this.#state.set(id, { log: '', job: null });
    return { id, spec };
  }

  async run(h: RunnerHandle, signal?: AbortSignal): Promise<RunResult> {
    const st = this.#state.get(h.id);
    if (!st) return { rc: null, reason: 'runner_error' };
    const { spec } = h;
    const argv = [...(spec.options ?? []), ...(spec.ref ? ['--ref', spec.ref] : []), '--', spec.command];
    const r = await this.exec(argv, signal);
    st.log = r.out;
    st.job = r.out.match(JOB)?.[0] ?? null;
    if (r.rc === 0) return { rc: 0, reason: 'ok' };
    if (r.rc === 124) return { rc: 124, reason: 'timeout' };
    if (r.rc === 1 || r.rc === 2) return { rc: r.rc, reason: 'runner_error' };
    return { rc: r.rc, reason: 'step_failed' };
  }

  async logs(h: RunnerHandle): Promise<string> {
    return this.#state.get(h.id)?.log ?? '';
  }

  async stop(h: RunnerHandle): Promise<void> {
    const job = this.#state.get(h.id)?.job;
    if (job) await this.exec(['--stop', job]);
  }

  async remove(h: RunnerHandle): Promise<void> {
    await this.stop(h);
    this.#state.delete(h.id);
  }
}

/* ---------- The fake target, for tests ---------- */

/** In memory; every call is recorded, and each step can be made to fail or hang. */
export class FakeTarget implements RunnerTarget {
  readonly kind = 'fake' as const;
  readonly calls: string[] = [];
  /** Handles that exist (started and not removed). */
  readonly live = new Set<string>();
  failOn: Partial<Record<'start' | 'run' | 'logs' | 'stop' | 'remove', Error>> = {};
  rc = 0;
  log = 'fake log\n';
  /** When true, `run` waits for the signal to abort (a hung command). */
  hang = false;
  /** The lease each started runner was given (what it received, to assert on). */
  readonly leases: (SealedLease | undefined)[] = [];
  #n = 0;

  async start(spec: RunSpec, _signal?: AbortSignal, lease?: SealedLease): Promise<RunnerHandle> {
    this.calls.push('start');
    if (this.failOn.start) throw this.failOn.start;
    const id = `fake-${++this.#n}`;
    this.live.add(id);
    this.leases.push(lease);
    return { id, spec, lease };
  }

  async run(h: RunnerHandle, signal?: AbortSignal): Promise<RunResult> {
    this.calls.push('run');
    if (this.failOn.run) throw this.failOn.run;
    if (this.hang) {
      await new Promise<void>((res) => {
        if (signal?.aborted) return res();
        signal?.addEventListener('abort', () => res(), { once: true });
      });
      return { rc: null, reason: 'cancelled' };
    }
    return { rc: this.rc, reason: this.rc === 0 ? 'ok' : 'step_failed' };
  }

  async logs(): Promise<string> {
    this.calls.push('logs');
    if (this.failOn.logs) throw this.failOn.logs;
    return this.log;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    if (this.failOn.stop) throw this.failOn.stop;
  }

  async remove(h: RunnerHandle): Promise<void> {
    this.calls.push('remove');
    if (this.failOn.remove) throw this.failOn.remove;
    this.live.delete(h.id);
  }
}
