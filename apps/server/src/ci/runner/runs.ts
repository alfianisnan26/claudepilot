// Runs, from the portal's side of the exec (PRD §11): `start` takes a plan and leaves a detached supervisor behind; `poll`
// reports pending events and the state of the runs the portal follows; `cancel`, `log`, `archive` and `gc` do what they say.
// Everything a run needs is in files under ~/.claudepilot/ci/runs/<run>/, so nothing depends on this process or the portal.

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CiRunStateFile } from '@portal/contracts';
import { CI_LIMITS } from '../limits.js';
import type { Plan } from '../plan.js';
import { ackEvents, pendingEvents, pruneEvents } from './events.js';
import { ensureDir, eventsDir, Fail, gitRoot, JOB_ID, nowIso, runDir, runsDir, validRef, validRepoName, validRunId, validSha, writeAtomic } from './common.js';
import { hookState, needRepo } from './repo.js';

/* ---------- Reading a plan ---------- */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** The SHA-256 of an approval key, in hex. */
const GATE = /^[0-9a-f]{64}$/;
/** An approval key as the portal makes it: 32 random bytes in hex. */
const KEY = /^[0-9a-f]{64}$/;
const WHENS = ['success', 'failure', 'always'];
const relative = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && !s.startsWith('/') && !s.includes('\\') && !s.includes('\0') && !s.split('/').includes('..');

function envOf(x: unknown, what: string): Record<string, string> {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Fail('bad_plan', `${what} is not a map.`);
  const entries = Object.entries(x as Record<string, unknown>);
  if (entries.length > 200) throw new Fail('bad_plan', `${what} has too many variables.`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!NAME.test(k) || typeof v !== 'string' || v.length > 8192) throw new Fail('bad_plan', `${what} has a bad variable.`);
    out[k] = v;
  }
  return out;
}

/** Reads and checks a plan: the runner trusts nothing it is handed, whoever wrote it. */
export function parsePlan(raw: Buffer): Plan {
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Fail('bad_plan', 'The plan is not JSON.');
  }
  const bad = (m: string) => new Fail('bad_plan', m);
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!x || x.v !== 1) throw bad('Unknown plan version.');
  if (!validRunId(x.runId) || !validRepoName(x.repo) || !validSha(x.sha) || !validRef(x.ref)) throw bad('The plan names a run, remote, commit or ref that is not valid.');
  if (typeof x.pipeline !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(x.pipeline) || typeof x.workspace !== 'string' || x.workspace.length > 200 || !int(x.runNumber, 0, 1e9)) throw bad('The plan has a bad name.');
  if (!int(x.timeoutMs, 1000, CI_LIMITS.maxTimeoutMs) || !int(x.maxParallel, 1, 8)) throw bad('The plan has a bad limit.');
  const env = envOf(x.env, 'The plan');
  if (!Array.isArray(x.jobs) || x.jobs.length < 1 || x.jobs.length > CI_LIMITS.jobs) throw bad('The plan has no jobs, or too many.');
  const ids = new Set<string>();
  const jobs = x.jobs as Record<string, unknown>[];
  for (const j of jobs) {
    if (!j || typeof j.id !== 'string' || !JOB_ID.test(j.id) || ids.has(j.id)) throw bad('A job id is not valid or is used twice.');
    ids.add(j.id);
  }
  for (const j of jobs) {
    const id = j.id as string;
    if (typeof j.name !== 'string' || j.name.length > 200) throw bad(`Job ${id} has a bad name.`);
    if (!Array.isArray(j.needs) || j.needs.some((n) => typeof n !== 'string' || !ids.has(n) || n === id)) throw bad(`Job ${id} needs a job that does not exist.`);
    if (!WHENS.includes(j.when as string) || (j.skip !== null && j.skip !== 'condition') || !int(j.timeoutMs, 1000, CI_LIMITS.maxTimeoutMs) || typeof j.continueOnError !== 'boolean') throw bad(`Job ${id} has a bad setting.`);
    envOf(j.env, `Job ${id}`);
    const g = j.group as { id?: unknown; failFast?: unknown; maxParallel?: unknown } | null | undefined;
    if (g !== null && (typeof g !== 'object' || typeof g.id !== 'string' || !JOB_ID.test(g.id) || typeof g.failFast !== 'boolean' || (g.maxParallel !== null && !int(g.maxParallel, 1, 8)))) throw bad(`Job ${id} has a bad matrix group.`);
    if (!Array.isArray(j.secrets) || j.secrets.length > 20 || j.secrets.some((n) => typeof n !== 'string' || !NAME.test(n) || n.startsWith('PILOT_'))) throw bad(`Job ${id} lists a secret that is not a name.`);
    if (!Array.isArray(j.steps) || j.steps.length > CI_LIMITS.stepsPerJob) throw bad(`Job ${id} has too many steps.`);
    for (const s of j.steps as Record<string, unknown>[]) {
      if (!s || typeof s.name !== 'string' || s.name.length > 200 || typeof s.run !== 'string' || s.run.length > 100_000 || !relative(s.workingDirectory === '.' ? 'x' : s.workingDirectory)) throw bad(`A step of ${id} is not valid.`);
      if (!WHENS.includes(s.when as string) || (s.skip !== null && s.skip !== 'condition') || typeof s.continueOnError !== 'boolean' || (s.timeoutMs !== null && !int(s.timeoutMs, 1000, CI_LIMITS.maxTimeoutMs))) throw bad(`A step of ${id} has a bad setting.`);
      envOf(s.env, `A step of ${id}`);
    }
    const a = j.artifacts as Record<string, unknown> | null;
    if (a !== null && (typeof a !== 'object' || !Array.isArray(a.paths) || a.paths.length < 1 || a.paths.length > 50 || !a.paths.every(relative) || !int(a.expireDays, 1, 365) || (a.when !== 'success' && a.when !== 'always'))) throw bad(`Job ${id} has bad artifacts.`);
    // An environment and its approval gate (PRD FR41): both optional, so a plan from before them still reads.
    if (j.environment !== undefined && j.environment !== null && (typeof j.environment !== 'string' || !ENV_NAME.test(j.environment))) throw bad(`Job ${id} names a bad environment.`);
    const g2 = j.approval as { environment?: unknown; gate?: unknown } | null | undefined;
    if (g2 !== undefined && g2 !== null && (typeof g2 !== 'object' || typeof g2.environment !== 'string' || !ENV_NAME.test(g2.environment) || typeof g2.gate !== 'string' || !GATE.test(g2.gate))) throw bad(`Job ${id} has a bad approval gate.`);
  }
  // A cycle would leave jobs waiting forever.
  const by = new Map(jobs.map((j) => [j.id as string, j.needs as string[]]));
  const seen = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (seen.has(id)) throw bad('The jobs wait for each other.');
    seen.add(id);
    for (const n of by.get(id) ?? []) visit(n);
    done.add(id);
  };
  for (const id of by.keys()) visit(id);
  return { ...(x as unknown as Plan), env };
}

/* ---------- Files and liveness ---------- */

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat: when the process started, so a reused pid isn't taken for the supervisor. */
export function startTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export function supervisorAlive(runId: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(runDir(runId), 'supervisor.pid'), 'utf8');
  } catch {
    return false;
  }
  const [pidText, ticks] = raw.trim().split(' ');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (ticks) {
    const now = startTicks(pid);
    if (now !== null && now !== ticks) return false;
  }
  return true;
}

export const isTerminal = (s: string | undefined): boolean => s === 'passed' || s === 'failed' || s === 'cancelled';

/* ---------- start ---------- */

/** Reads exactly `n` bytes from stdin (the exec keeps it open, so waiting for the end would hang). */
export function readExactly(n: number, timeoutMs = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    const timer = setTimeout(() => reject(new Fail('stdin_timeout', 'The plan did not arrive.')), timeoutMs);
    process.stdin.on('data', (c: Buffer) => {
      chunks.push(c);
      got += c.length;
      if (got >= n) {
        clearTimeout(timer);
        process.stdin.pause();
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    });
    process.stdin.on('end', () => {
      if (got < n) {
        clearTimeout(timer);
        reject(new Fail('stdin_short', 'The plan was cut short.'));
      }
    });
    process.stdin.on('error', (e) => reject(e));
  });
}

export function initialState(plan: Plan): CiRunStateFile {
  return {
    v: 1,
    runId: plan.runId,
    status: 'queued',
    reason: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    jobs: plan.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.skip ? 'skipped' : 'pending',
      needs: j.needs,
      startedAt: null,
      durationMs: null,
      ignored: false,
      reason: j.skip ? 'condition' : null,
      steps: j.steps.map((s, idx) => ({ idx, name: s.name, status: s.skip || j.skip ? 'skipped' : 'pending', startedAt: null, durationMs: null, exitCode: null, logBytes: 0, logTruncated: false, ignored: false, reason: s.skip || j.skip ? 'condition' : null })),
      artifacts: [],
      artifactsSkipped: 0,
      environment: j.environment ?? null,
    })),
  };
}

/** `start <run> --bytes <n>`: the plan arrives on stdin; the supervisor is left running detached and the answer comes at once. Starting a run twice is harmless. */
export async function startRun(runId: unknown, bytes: number): Promise<Record<string, unknown>> {
  if (!validRunId(runId)) throw new Fail('bad_run', 'That is not a run id.');
  if (!Number.isInteger(bytes) || bytes < 2 || bytes > 1_048_576) throw new Fail('bad_plan', 'The plan is empty or too large.');
  const plan = parsePlan(await readExactly(bytes));
  if (plan.runId !== runId) throw new Fail('bad_plan', 'The plan is for another run.');
  needRepo(plan.repo);

  ensureDir(runsDir(), 0o700);
  const dir = runDir(runId);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: true, already: true, status: readJson<CiRunStateFile>(join(dir, 'state.json'))?.status ?? 'queued' };
    throw e;
  }
  try {
    const fs = statfsSync(homedir());
    if (fs.bavail * fs.bsize < CI_LIMITS.freeDiskBytes) throw new Fail('no_space', 'The workspace is almost out of disk space.');
    writeAtomic(join(dir, 'plan.json'), JSON.stringify(plan));
    writeAtomic(join(dir, 'state.json'), JSON.stringify(initialState(plan)));
    const log = openSync(join(dir, 'supervisor.log'), 'a', 0o600);
    // Detached: its own session, no handle on this exec's pipes, so it outlives this process and the portal.
    const child = spawn(process.execPath, [realpathSync(process.argv[1]!), 'exec', runId], { detached: true, stdio: ['ignore', log, log], cwd: homedir(), env: process.env });
    child.unref();
    closeSync(log);
    if (child.pid) writeFileSync(join(dir, 'supervisor.pid'), `${child.pid}\n`, { mode: 0o600 });
    return { ok: true, pid: child.pid ?? null };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/* ---------- poll ---------- */

/** `poll [--ack ids] [--runs ids]`: everything the portal needs in one exec (PRD FR9). */
export function poll(opts: { ack: string[]; runs: string[]; max: number }, self: string): Record<string, unknown> {
  const acked = ackEvents(opts.ack);
  const events = pendingEvents(Math.min(opts.max, CI_LIMITS.eventsPerPoll));
  const runs: Record<string, { state: CiRunStateFile | null; alive: boolean }> = {};
  for (const id of opts.runs.slice(0, 200)) {
    if (!validRunId(id)) continue;
    runs[id] = { state: readJson<CiRunStateFile>(join(runDir(id), 'state.json')), alive: supervisorAlive(id) };
  }
  const repos: { name: string; hook: string }[] = [];
  if (existsSync(gitRoot())) {
    for (const entry of readdirSync(gitRoot())) {
      const name = entry.slice(0, -4);
      if (entry.endsWith('.git') && validRepoName(name) && existsSync(join(gitRoot(), entry, 'HEAD'))) repos.push({ name, hook: hookState(name, self) });
    }
  }
  let freeBytes: number | null = null;
  try {
    const fs = statfsSync(homedir());
    freeBytes = fs.bavail * fs.bsize;
  } catch {
    // a filesystem that can't say
  }
  return { ok: true, now: nowIso(), acked, events, runs, repos, freeBytes };
}

/* ---------- cancel ---------- */

export function cancelRun(runId: unknown): Record<string, unknown> {
  if (!validRunId(runId)) throw new Fail('bad_run', 'That is not a run id.');
  const dir = runDir(runId);
  const path = join(dir, 'state.json');
  const state = readJson<CiRunStateFile>(path);
  if (!state) throw new Fail('no_run', 'There is no such run here.');
  if (isTerminal(state.status)) return { ok: true, status: state.status, alreadyOver: true };
  writeAtomic(join(dir, 'cancel'), nowIso());
  if (supervisorAlive(runId)) {
    try {
      const pid = Number(readFileSync(join(dir, 'supervisor.pid'), 'utf8').trim().split(' ')[0]);
      process.kill(pid, 'SIGTERM');
    } catch {
      // it ended between the check and the signal
    }
    return { ok: true, status: state.status, signalled: true };
  }
  // Nobody is running it: settle the record so it doesn't stay open.
  const now = nowIso();
  for (const j of state.jobs) {
    if (j.status === 'pending' || j.status === 'running' || j.status === 'waiting') {
      j.status = 'cancelled';
      j.reason = 'cancelled';
    }
    for (const s of j.steps) if (s.status === 'pending' || s.status === 'running') (s.status = 'cancelled'), (s.reason = 'cancelled');
  }
  state.status = 'cancelled';
  state.reason = 'cancelled';
  state.finishedAt = now;
  writeAtomic(path, JSON.stringify(state));
  return { ok: true, status: 'cancelled', signalled: false };
}

/* ---------- approve ---------- */

export const approvalPath = (runId: string, job: string) => join(runDir(runId), 'approvals', job);

/**
 * `approve <run> <job> --bytes <n>` (the key on stdin) or `approve <run> <job> --reject` (PRD FR41): leaves the decision where the run's
 * supervisor looks for it. The supervisor checks the key against the gate in the plan, so this command decides nothing by itself; it only
 * refuses what can not be meant (no such run or job, a job that is not waiting, a run that is over), so the portal can say why.
 */
export async function approveRun(runId: unknown, job: unknown, decision: 'approve' | 'reject', bytes: number): Promise<Record<string, unknown>> {
  if (!validRunId(runId)) throw new Fail('bad_run', 'That is not a run id.');
  if (typeof job !== 'string' || !JOB_ID.test(job)) throw new Fail('bad_job', 'That is not a job id.');
  const dir = runDir(runId);
  const plan = readJson<Plan>(join(dir, 'plan.json'));
  const state = readJson<CiRunStateFile>(join(dir, 'state.json'));
  if (!plan || !state) throw new Fail('no_run', 'There is no such run here.');
  const pj = plan.jobs.find((j) => j.id === job);
  const js = state.jobs.find((j) => j.id === job);
  if (!pj || !js) throw new Fail('no_job', 'That run has no such job.');
  if (!pj.approval) throw new Fail('no_gate', 'That job does not wait for an approval.');
  if (isTerminal(state.status)) throw new Fail('over', 'That run is already over.');
  if (js.status !== 'waiting' && js.status !== 'pending') throw new Fail('not_waiting', 'That job is not waiting for an approval.');
  let key = '';
  if (decision === 'approve') {
    if (!Number.isInteger(bytes) || bytes !== 64) throw new Fail('bad_key', 'The approval key is missing.');
    key = (await readExactly(bytes)).toString('utf8');
    if (!KEY.test(key)) throw new Fail('bad_key', 'The approval key is not valid.');
  }
  ensureDir(join(dir, 'approvals'), 0o700);
  writeAtomic(approvalPath(runId, job), JSON.stringify({ decision, key, at: nowIso() }));
  return { ok: true, decision, status: js.status };
}

/* ---------- logs ---------- */

/** The longest prefix of `buf` that ends on a whole UTF-8 character. */
function wholeChars(buf: Buffer): Buffer {
  // Walk back over at most three continuation bytes to the lead byte; a sequence cut short there is dropped.
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && (buf[i]! & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need > back + 1 ? buf.subarray(0, i) : buf;
}

/** From the first character boundary: drops the continuation bytes a cut left at the front. */
function fromBoundary(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i]! & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

function readRange(path: string, from: number, length: number): { bytes: Buffer; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const len = Math.max(0, Math.min(length, size - from));
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return { bytes: buf.subarray(0, got), size };
  } finally {
    closeSync(fd);
  }
}

const logPath = (runId: string, job: string, n: number) => join(runDir(runId), 'logs', job, `${n}.log`);

/**
 * `log <run> <job> <step> <offset> [--max n]`: a piece of a step's log. Whole lines only while the step is still going (a
 * line that isn't finished waits for the next read), so the portal can redact line by line; and whole characters always.
 */
export function readLog(runId: unknown, job: unknown, step: unknown, offset: number, max: number): Record<string, unknown> {
  if (!validRunId(runId) || typeof job !== 'string' || !JOB_ID.test(job) || !Number.isInteger(step) || (step as number) < 0 || (step as number) > CI_LIMITS.stepsPerJob) throw new Fail('bad_log', 'That is not a log.');
  const path = logPath(runId, job, step as number);
  const state = readJson<CiRunStateFile>(join(runDir(runId), 'state.json'));
  const unit = state?.jobs.find((j) => j.id === job)?.steps[step as number];
  const over = !unit || (unit.status !== 'running' && unit.status !== 'pending');
  if (!existsSync(path)) return { ok: true, text: '', next: offset, size: 0, done: over };
  const want = Math.max(1024, Math.min(max, CI_LIMITS.logChunkBytes));
  const { bytes, size } = readRange(path, Math.max(0, offset), want);
  let chunk = wholeChars(bytes);
  const reachedEnd = offset + bytes.length >= size;
  if (!reachedEnd || !over) {
    // Cut at the last newline, unless there is none (one enormous line: take what there is).
    const nl = chunk.lastIndexOf(10);
    if (nl >= 0 && (!reachedEnd || nl + 1 < chunk.length)) chunk = chunk.subarray(0, nl + 1);
  }
  const next = offset + chunk.length;
  return { ok: true, text: chunk.toString('utf8'), next, size, done: over && next >= size, truncated: !!unit?.logTruncated };
}

/** `archive <run>`: for every step the head and the tail of its log, within a total, so the portal can keep the run (PRD FR30). */
export function archiveLogs(runId: unknown, head: number, tail: number, total: number): Record<string, unknown> {
  if (!validRunId(runId)) throw new Fail('bad_run', 'That is not a run id.');
  const state = readJson<CiRunStateFile>(join(runDir(runId), 'state.json'));
  if (!state) throw new Fail('no_run', 'There is no such run here.');
  let budget = total;
  const steps: { job: string; step: number; size: number; head: string; tail: string | null; omitted: number }[] = [];
  for (const j of state.jobs) {
    for (const s of j.steps) {
      const path = logPath(runId, j.id, s.idx);
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      if (size === 0) continue;
      if (budget <= 0) {
        steps.push({ job: j.id, step: s.idx, size, head: '', tail: null, omitted: size });
        continue;
      }
      if (size <= head + tail) {
        const whole = readRange(path, 0, Math.min(size, budget)).bytes;
        steps.push({ job: j.id, step: s.idx, size, head: wholeChars(whole).toString('utf8'), tail: null, omitted: size - whole.length > 0 ? size - whole.length : 0 });
        budget -= whole.length;
      } else {
        const h = wholeChars(readRange(path, 0, Math.min(head, budget)).bytes);
        const t = fromBoundary(readRange(path, size - tail, tail).bytes);
        steps.push({ job: j.id, step: s.idx, size, head: h.toString('utf8'), tail: t.toString('utf8'), omitted: size - h.length - t.length });
        budget -= h.length + t.length;
      }
    }
  }
  return { ok: true, steps };
}

/* ---------- gc ---------- */

/** `gc [--days n]`: deletes finished runs' folders older than the retention, work folders nobody is using, and old events. */
export function gc(days: number): Record<string, unknown> {
  let runs = 0;
  let work = 0;
  const cutoff = Date.now() - days * 86_400_000;
  if (existsSync(runsDir())) {
    for (const id of readdirSync(runsDir())) {
      if (!validRunId(id)) continue;
      const dir = runDir(id);
      const state = readJson<CiRunStateFile>(join(dir, 'state.json'));
      const alive = supervisorAlive(id);
      if (!alive && existsSync(join(dir, 'work'))) {
        rmSync(join(dir, 'work'), { recursive: true, force: true });
        work++;
      }
      try {
        const old = statSync(join(dir, 'state.json')).mtimeMs < cutoff;
        if (!alive && (old || !state)) {
          // A run with no state never started; one with a finished state and no one running it is over.
          if (!state || isTerminal(state.status)) {
            rmSync(dir, { recursive: true, force: true });
            runs++;
          }
        }
      } catch {
        if (!alive && !state) {
          rmSync(dir, { recursive: true, force: true });
          runs++;
        }
      }
    }
  }
  let events = pruneEvents(CI_LIMITS.eventDays);
  // Events nobody acknowledged for a week are dropped too.
  const dir = eventsDir();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        if (statSync(join(dir, name)).mtimeMs < Date.now() - CI_LIMITS.eventDays * 86_400_000) {
          rmSync(join(dir, name), { force: true });
          events++;
        }
      } catch {
        // gone already
      }
    }
  }
  return { ok: true, runs, work, events };
}

