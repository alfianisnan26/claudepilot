// The supervisor (PRD FR18 to FR25): one detached process per run. It reads the plan, makes a clean checkout per job, runs
// the steps as the workspace user in their own process groups, keeps the logs and artifacts within their caps, enforces the
// timeouts, and writes `state.json` after every change. It never talks to the portal: the portal reads its files.

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { homedir, setPriority, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CiArtifact, CiJob, CiReason, CiRunStateFile, CiStep } from '@portal/contracts';
import { artifactMatches } from '../glob.js';
import { CI_LIMITS } from '../limits.js';
import type { Plan, PlanJob, PlanStep } from '../plan.js';
import { bareDir, ensureDir, git, inside, nowIso, runDir, sleep, writeAtomic } from './common.js';
import { readJson, startTicks } from './runs.js';

/** The masked value in a log (the portal's own redactor uses the same word). */
const MASK = Buffer.from('[redacted]');

/**
 * Takes secret values out of a byte stream as it passes. A chunk that ends with what could be the start of a value waits for
 * the next one (only those bytes, so ordinary output is never delayed); at the end the rest goes out as it is.
 */
class Masker {
  readonly #needles: Buffer[];
  #held: Buffer = Buffer.alloc(0);
  constructor(values: string[]) {
    // A short value would blank ordinary text: it is not masked (the portal says so when it checks the names).
    this.#needles = values.filter((v) => v.length >= 6).map((v) => Buffer.from(v, 'utf8'));
  }

  get active(): boolean {
    return this.#needles.length > 0;
  }

  push(chunk: Buffer): Buffer {
    if (!this.#needles.length) return chunk;
    let buf = this.#held.length ? Buffer.concat([this.#held, chunk]) : chunk;
    this.#held = Buffer.alloc(0);
    const out: Buffer[] = [];
    let from = 0;
    for (;;) {
      let at = -1;
      let len = 0;
      for (const n of this.#needles) {
        const i = buf.indexOf(n, from);
        if (i >= 0 && (at < 0 || i < at || (i === at && n.length > len))) (at = i), (len = n.length);
      }
      if (at < 0) break;
      out.push(buf.subarray(from, at), MASK);
      from = at + len;
    }
    buf = buf.subarray(from);
    // What could still become a value: the longest end of the buffer that is the start of one.
    let hold = 0;
    for (const n of this.#needles) {
      for (let k = Math.min(n.length - 1, buf.length); k > hold; k--) {
        if (buf.subarray(buf.length - k).equals(n.subarray(0, k))) {
          hold = k;
          break;
        }
      }
    }
    out.push(buf.subarray(0, buf.length - hold));
    this.#held = Buffer.from(buf.subarray(buf.length - hold));
    return Buffer.concat(out);
  }

  /** The step is over: whatever was held was not a value. */
  flush(): Buffer {
    const rest = this.#held;
    this.#held = Buffer.alloc(0);
    return rest;
  }
}

/** The output of one step, capped. After the cap output is dropped and one line says so. */
class LogSink {
  bytes = 0;
  truncated = false;
  readonly #ws: WriteStream;
  readonly #mask: Masker;
  constructor(
    path: string,
    private readonly cap: number,
    private readonly budget: { left: number },
    secretValues: string[] = [],
  ) {
    this.#ws = createWriteStream(path, { flags: 'a', mode: 0o600 });
    this.#ws.on('error', () => undefined);
    this.#mask = new Masker(secretValues);
  }

  write(raw: Buffer): void {
    if (this.truncated) return;
    this.#put(this.#mask.push(raw));
  }

  #put(chunk: Buffer): void {
    if (!chunk.length) return;
    const room = Math.min(this.cap - this.bytes, this.budget.left);
    if (room <= 0) return this.#cut();
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#ws.write(part);
    this.bytes += part.length;
    this.budget.left -= part.length;
    if (part.length < chunk.length) this.#cut();
  }

  /** A line from the runner itself, outside the cap. */
  note(text: string): void {
    this.#ws.write(`${text}\n`);
  }

  #cut(): void {
    this.truncated = true;
    this.#ws.write('\n[pilot] output cap reached; the rest of this step\'s output was dropped\n');
  }

  end(): Promise<void> {
    if (!this.truncated) this.#put(this.#mask.flush());
    return new Promise((resolve) => this.#ws.end(resolve));
  }
}

const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? null;

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is gone already
  }
};

class Supervisor {
  readonly dir: string;
  cancelled = false;
  timedOut = false;
  readonly #children = new Map<string, Set<ChildProcess>>();
  readonly #jobTimedOut = new Set<string>();
  readonly #logBudget = { left: CI_LIMITS.runLogBytes };
  readonly #artifactBudget = { left: CI_LIMITS.artifactRunBytes };
  #timer: NodeJS.Timeout | null = null;

  constructor(
    readonly plan: Plan,
    readonly state: CiRunStateFile,
  ) {
    this.dir = runDir(plan.runId);
  }

  /* ---------- State ---------- */

  touch(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      writeAtomic(join(this.dir, 'state.json'), JSON.stringify(this.state));
    } catch {
      // a full disk: the next flush tries again
    }
  }

  /* ---------- Killing ---------- */

  #group(jobId: string): Set<ChildProcess> {
    let set = this.#children.get(jobId);
    if (!set) this.#children.set(jobId, (set = new Set()));
    return set;
  }

  /** SIGTERM now, SIGKILL after the grace period, to every step of a job (or of the run). */
  #terminate(children: Iterable<ChildProcess>): void {
    const list = [...children];
    for (const c of list) signalGroup(c, 'SIGTERM');
    setTimeout(() => {
      for (const c of list) signalGroup(c, 'SIGKILL');
    }, CI_LIMITS.killGraceMs).unref();
  }

  killAll(): void {
    for (const set of this.#children.values()) this.#terminate(set);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.killAll();
  }

  /* ---------- The run ---------- */

  async run(): Promise<void> {
    const t0 = performance.now();
    const { plan, state } = this;
    state.status = 'running';
    state.startedAt = nowIso();
    const ticks = startTicks(process.pid);
    writeFileSync(join(this.dir, 'supervisor.pid'), `${process.pid}${ticks ? ` ${ticks}` : ''}\n`, { mode: 0o600 });
    this.flush();

    const watch = setInterval(() => {
      if (existsSync(join(this.dir, 'cancel'))) this.cancel();
    }, 500);
    const runTimer = setTimeout(() => {
      this.timedOut = true;
      this.killAll();
    }, plan.timeoutMs);
    process.on('SIGTERM', () => this.cancel());
    process.on('SIGINT', () => this.cancel());

    const byId = new Map(state.jobs.map((j) => [j.id, j]));
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (this.cancelled || this.timedOut) {
        for (const js of state.jobs) if (js.status === 'pending') this.#close(js, 'cancelled', this.cancelled ? 'cancelled' : 'timeout');
      } else {
        let started = false;
        for (const job of plan.jobs) {
          const js = byId.get(job.id)!;
          if (js.status !== 'pending' || running.size >= plan.maxParallel) continue;
          if (job.group?.maxParallel && plan.jobs.filter((o) => o.group?.id === job.group!.id && byId.get(o.id)!.status === 'running').length >= job.group.maxParallel) continue;
          const deps = job.needs.map((n) => byId.get(n)!);
          if (deps.some((d) => d.status === 'pending' || d.status === 'running')) continue;
          const ok = deps.every((d) => d.status === 'passed' || (d.status === 'failed' && d.ignored));
          const brokenDep = deps.some((d) => (d.status === 'failed' && !d.ignored) || d.status === 'cancelled');
          if (!(job.when === 'always' || (job.when === 'failure' ? brokenDep : ok))) {
            this.#close(js, 'skipped', 'needs');
            this.touch();
            continue;
          }
          started = true;
          running.set(
            job.id,
            this.#job(job, js)
              .catch((e: unknown) => {
                // The job's own code failed, not a step: record it and go on.
                js.status = 'failed';
                js.reason = 'runner_error';
                this.#failFirst(job, js, `[pilot] ${(e as Error).message}`);
              })
              .finally(() => {
                running.delete(job.id);
                // fail-fast: when one combination of a matrix fails, the ones that have not started do not.
                if (job.group?.failFast && js.status === 'failed' && !js.ignored) {
                  for (const o of plan.jobs) {
                    const os = byId.get(o.id)!;
                    if (o.group?.id === job.group.id && os.status === 'pending') this.#close(os, 'skipped', 'fail_fast');
                  }
                }
                this.flush();
              }),
          );
        }
        if (!started && !running.size && state.jobs.some((j) => j.status === 'pending')) {
          // Nothing can start and nothing is running: whatever waits has nothing left to wait for.
          for (const js of state.jobs) if (js.status === 'pending') this.#close(js, 'skipped', 'needs');
        }
      }
      if (!running.size && !state.jobs.some((j) => j.status === 'pending')) break;
      await Promise.race([...running.values(), sleep(250)]);
    }

    clearInterval(watch);
    clearTimeout(runTimer);
    const failed = state.jobs.filter((j) => j.status === 'failed' && !j.ignored);
    state.status = this.cancelled ? 'cancelled' : this.timedOut || failed.length ? 'failed' : 'passed';
    state.reason = this.cancelled ? 'cancelled' : this.timedOut ? 'timeout' : failed.length ? (failed.find((j) => j.reason === 'timeout' || j.reason === 'runner_error')?.reason ?? 'step_failed') : null;
    state.finishedAt = nowIso();
    state.durationMs = Math.round(performance.now() - t0);
    rmSync(join(this.dir, 'work'), { recursive: true, force: true });
    this.flush();
  }

  /** Settles a job that will not run (or is cut off): every unfinished step gets the same status. */
  #close(js: CiJob, status: 'cancelled' | 'skipped', reason: CiReason): void {
    js.status = status;
    js.reason = reason;
    for (const s of js.steps) if (s.status === 'pending') (s.status = status), (s.reason = reason);
    this.touch();
  }

  /** Puts a message where the person will look: the first step that has not run, as its log. */
  #failFirst(job: PlanJob, js: CiJob, message: string): void {
    const s = js.steps.find((x) => x.status === 'pending' || x.status === 'running');
    if (!s) return;
    try {
      ensureDir(join(this.dir, 'logs', job.id));
      writeFileSync(join(this.dir, 'logs', job.id, `${s.idx}.log`), `${message}\n`, { flag: 'a', mode: 0o600 });
    } catch {
      // nowhere to write it
    }
    s.status = 'failed';
    s.reason = 'runner_error';
    s.logBytes += message.length + 1;
    for (const rest of js.steps) if (rest.status === 'pending') (rest.status = 'skipped'), (rest.reason = null);
  }

  /* ---------- A job ---------- */

  async #job(job: PlanJob, js: CiJob): Promise<void> {
    const t0 = performance.now();
    js.status = 'running';
    js.startedAt = nowIso();
    this.flush();
    const work = join(this.dir, 'work', job.id);
    let failed = false;
    let secrets: Record<string, string> = {};
    const timer = setTimeout(() => {
      this.#jobTimedOut.add(job.id);
      this.#terminate(this.#group(job.id));
    }, job.timeoutMs);
    try {
      secrets = this.#secrets(job);
      await this.#checkout(work);
      this.#restore(job, work);
      for (let i = 0; i < job.steps.length; i++) {
        const step = job.steps[i]!;
        const st = js.steps[i]!;
        if (st.status === 'skipped') continue;
        if (this.cancelled || this.timedOut || this.#jobTimedOut.has(job.id)) {
          st.status = 'cancelled';
          st.reason = this.cancelled ? 'cancelled' : 'timeout';
          continue;
        }
        const runs = step.when === 'always' || (step.when === 'failure' ? failed : !failed);
        if (!runs) {
          st.status = 'skipped';
          continue;
        }
        await this.#step(job, step, st, work, secrets);
        if (st.status === 'failed') {
          if (step.continueOnError) st.ignored = true;
          else failed = true;
        }
      }
    } catch (e) {
      failed = true;
      js.reason = 'runner_error';
      this.#failFirst(job, js, `[pilot] ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const timedOut = this.#jobTimedOut.has(job.id) || this.timedOut;
    js.status = this.cancelled ? 'cancelled' : timedOut || failed ? 'failed' : 'passed';
    // A job that failed because a step ran out of time says so, not just "a step failed".
    const stepTimedOut = js.steps.some((s) => s.status === 'failed' && !s.ignored && s.reason === 'timeout');
    js.reason = this.cancelled ? 'cancelled' : timedOut || (failed && stepTimedOut) ? 'timeout' : failed ? (js.reason ?? 'step_failed') : null;
    js.ignored = js.status === 'failed' && job.continueOnError;
    if (job.artifacts && (js.status === 'passed' || (job.artifacts.when === 'always' && js.status !== 'cancelled'))) {
      try {
        const r = this.#collect(job, work);
        js.artifacts = r.artifacts;
        js.artifactsSkipped = r.skipped;
      } catch {
        js.artifactsSkipped += 1;
      }
    }
    rmSync(work, { recursive: true, force: true });
    js.durationMs = Math.round(performance.now() - t0);
    this.flush();
  }

  /** A clean checkout of the commit from the bare repository, with hooks off. */
  async #checkout(work: string): Promise<void> {
    ensureDir(dirname(work));
    const clone = await git(['clone', '--local', '--no-checkout', '--quiet', bareDir(this.plan.repo), work], { timeoutMs: 600_000 });
    if (clone.code !== 0) throw new Error(`Checkout failed: ${clone.stderr.trim().split('\n')[0] ?? 'git clone failed'}`);
    const out = await git(['checkout', '--quiet', '--detach', this.plan.sha], { cwd: work, timeoutMs: 600_000 });
    if (out.code !== 0) throw new Error(`Checkout failed: ${out.stderr.trim().split('\n')[0] ?? 'git checkout failed'}`);
  }

  /**
   * The values of the secrets a job names, read from the files Secrets & env delivered (`<etc>/secrets/files/<NAME>`, readable
   * by the workspace user), where `<etc>` is the folder this script is installed in. Nothing is written anywhere: the values live in
   * this process and the steps' environments, and are masked in their logs.
   */
  #secrets(job: PlanJob): Record<string, string> {
    const out: Record<string, string> = {};
    const etc = dirname(dirname(realpathSync(process.argv[1]!)));
    for (const name of job.secrets) {
      const path = join(etc, 'secrets', 'files', name);
      let text: string;
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.size > 65_536) throw new Error('not a file the size of a secret');
        text = readFileSync(path, 'utf8');
      } catch {
        throw new Error(`The secret ${name} is not available in this workspace. Assign it in Secrets & env as a secret or a tool login.`);
      }
      out[name] = text.endsWith('\n') ? text.slice(0, -1) : text;
    }
    return out;
  }

  /** What the jobs this one needs kept is copied in before its steps. */
  #restore(job: PlanJob, work: string): void {
    for (const need of job.needs) {
      const src = join(this.dir, 'artifacts', need);
      if (existsSync(src)) cpSync(src, work, { recursive: true, force: true });
    }
  }

  /* ---------- A step ---------- */

  async #step(job: PlanJob, step: PlanStep, st: CiStep, work: string, secrets: Record<string, string>): Promise<void> {
    const t0 = performance.now();
    st.status = 'running';
    st.startedAt = nowIso();
    this.flush();
    ensureDir(join(this.dir, 'logs', job.id));
    const sink = new LogSink(join(this.dir, 'logs', job.id, `${st.idx}.log`), CI_LIMITS.stepLogBytes, this.#logBudget, Object.values(secrets));
    const finish = async (status: CiStep['status'], reason: CiReason | null, exitCode: number | null) => {
      await sink.end();
      st.status = status;
      st.reason = reason;
      st.exitCode = exitCode;
      st.logBytes = sink.bytes;
      st.logTruncated = sink.truncated;
      st.durationMs = Math.round(performance.now() - t0);
      this.flush();
    };

    // The working folder must still be inside the checkout once links are followed.
    const cwd = join(work, step.workingDirectory === '.' ? '' : step.workingDirectory);
    let real: string;
    try {
      real = realpathSync(cwd);
    } catch {
      sink.note(`[pilot] working-directory ${step.workingDirectory} does not exist in this commit`);
      return finish('failed', 'step_failed', null);
    }
    if (!inside(realpathSync(work), real)) {
      sink.note('[pilot] working-directory leaves the checkout');
      return finish('failed', 'step_failed', null);
    }

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: homedir(),
      USER: userInfo().username,
      LOGNAME: userInfo().username,
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: 'dumb',
      ...this.plan.env,
      ...job.env,
      ...step.env,
      ...secrets,
      PILOT_JOB: job.id,
      PILOT_WORKDIR: work,
    };
    // A login shell: the same tools and Secrets & env variables a terminal in this workspace has. errexit is set by the
    // script text, not the option, so the profile files that run first can't end it.
    const [file, args] = BASH ? [BASH, ['-l', '-c', `set -eo pipefail; ${step.run}`]] : ['/bin/sh', ['-c', `set -e; ${step.run}`]];
    const child = spawn(file, args, { cwd: real, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.#group(job.id).add(child);
    if (child.pid) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // a platform that won't lower it
      }
    }
    const onData = (c: Buffer) => {
      sink.write(c);
      st.logBytes = sink.bytes;
      this.touch();
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));

    let stepTimedOut = false;
    const timer =
      step.timeoutMs === null
        ? null
        : setTimeout(() => {
            stepTimedOut = true;
            sink.note(`[pilot] step timed out after ${Math.round(step.timeoutMs! / 1000)} s; stopping it`);
            this.#terminate([child]);
          }, step.timeoutMs);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('error', (e) => {
        sink.note(`[pilot] could not start the shell: ${e.message}`);
        resolve({ code: 127, signal: null });
      });
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    if (timer) clearTimeout(timer);
    // A grandchild holding the pipes open would keep them from closing: give them a moment, then let go.
    await Promise.race([closed, sleep(2000)]);
    child.stdout!.destroy();
    child.stderr!.destroy();
    // Whatever the step left running in its group goes with it.
    signalGroup(child, 'SIGKILL');
    this.#group(job.id).delete(child);

    const jobTimedOut = this.#jobTimedOut.has(job.id) || this.timedOut;
    if (this.cancelled) return finish('cancelled', 'cancelled', exit.code);
    if (stepTimedOut || jobTimedOut) {
      if (jobTimedOut && !stepTimedOut) sink.note('[pilot] the job ran out of time; stopped');
      return finish('failed', 'timeout', exit.code);
    }
    if (exit.code === 0) return finish('passed', null, 0);
    return finish('failed', exit.signal ? 'signal' : 'step_failed', exit.code);
  }

  /* ---------- Artifacts ---------- */

  #collect(job: PlanJob, work: string): { artifacts: CiArtifact[]; skipped: number } {
    const spec = job.artifacts!;
    const out = join(this.dir, 'artifacts', job.id);
    const artifacts: CiArtifact[] = [];
    let skipped = 0;
    const root = realpathSync(work);
    // Walk only from the folders the patterns name (up to their first wildcard), never `.git`.
    const startOf = (p: string): string => {
      const out: string[] = [];
      for (const seg of p.replace(/\/+$/, '').split('/')) {
        if (/[*?]/.test(seg)) break;
        out.push(seg);
      }
      return out.join('/');
    };
    const starts = new Set(spec.paths.map(startOf));
    let visited = 0;
    const walk = (rel: string) => {
      if (visited > 200_000) return;
      const abs = join(root, rel);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        return;
      }
      visited++;
      if (st.isSymbolicLink()) {
        if (artifactMatches(spec.paths, rel)) skipped++;
        return;
      }
      if (st.isDirectory()) {
        if (rel === '.git') return;
        for (const name of readdirSync(abs)) walk(rel ? `${rel}/${name}` : name);
        return;
      }
      if (!st.isFile() || !artifactMatches(spec.paths, rel)) return;
      if (artifacts.length >= CI_LIMITS.artifactFiles || st.size > CI_LIMITS.artifactFileBytes || st.size > this.#artifactBudget.left) {
        skipped++;
        return;
      }
      const dest = join(out, rel);
      if (!inside(out, dest)) return;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      this.#artifactBudget.left -= st.size;
      artifacts.push({ path: rel, bytes: st.size });
    };
    for (const start of starts) {
      const abs = join(root, start);
      if (!existsSync(abs) || !inside(root, realpathSync(abs))) continue;
      walk(start);
    }
    return { artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)), skipped };
  }
}

/** `exec <run>`: the supervisor's whole life. Never returns an error to a caller: the portal reads the state file. */
export async function supervise(runId: string): Promise<void> {
  const dir = runDir(runId);
  const plan = readJson<Plan>(join(dir, 'plan.json'));
  const state = readJson<CiRunStateFile>(join(dir, 'state.json'));
  if (!plan || !state) return;
  const sv = new Supervisor(plan, state);
  try {
    await sv.run();
  } catch (e) {
    // A bug here must still leave a finished record, or the run would hang as "running" until the supervisor is found dead.
    state.status = 'failed';
    state.reason = 'runner_error';
    state.finishedAt = nowIso();
    for (const j of state.jobs) {
      if (j.status === 'running' || j.status === 'pending') (j.status = 'failed'), (j.reason = 'runner_error');
      for (const s of j.steps) if (s.status === 'running' || s.status === 'pending') (s.status = 'failed'), (s.reason = 'runner_error');
    }
    sv.flush();
    writeFileSync(join(dir, 'supervisor.error'), `${(e as Error).stack ?? String(e)}\n`, { mode: 0o600 });
  }
}
