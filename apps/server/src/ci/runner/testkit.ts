// Test helpers (not used by the portal): a "workspace" that is a temporary home folder on this machine, the real cp-ci script
// built from source, and real git. The service tests build their fake runtime on it too.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDirectory } from '../../store/testTmp.js';
import type { Plan, PlanJob, PlanStep } from '../plan.js';
import { buildRunner } from './build.js';

let cachedScript: string | null = null;
/** The runner text, built once per test process. */
export const runnerText = (): string => (cachedScript ??= buildRunner());

export interface CiReply {
  ok: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export class Home {
  readonly home: string;
  readonly script: string;
  /** Extra variables in the environment cp-ci runs with (a secret the exec happens to have, say). */
  extraEnv: Record<string, string> = {};

  constructor(prefix = 'cp-ci-home-') {
    this.home = tempDirectory(prefix);
    this.script = join(this.home, 'bin', 'cp-ci');
    mkdirSync(join(this.home, 'bin'));
    writeFileSync(this.script, runnerText(), { mode: 0o755 });
    chmodSync(this.script, 0o755);
    writeFileSync(join(this.home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
    mkdirSync(join(this.home, 'work'));
  }

  env(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: this.home, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', ...this.extraEnv };
  }

  /** Runs `cp-ci <args>`; stdin is written and left open like an exec's. Resolves with the reply, or the raw output when there is none. */
  ci(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<CiReply> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.script, ...args], { env: this.env(), cwd: this.home, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`cp-ci ${args.join(' ')} timed out; output so far: ${out}`));
      }, opts.timeoutMs ?? 60_000);
      child.stdout.on('data', (d: Buffer) => (out += d));
      child.stderr.on('data', (d: Buffer) => (out += d));
      child.on('close', () => {
        clearTimeout(timer);
        const line = out.split('\n').filter((l) => l.startsWith('@cpci ')).pop();
        resolve(line ? (JSON.parse(line.slice(6)) as CiReply) : { ok: false, error: 'no_reply', message: out });
      });
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      // Left open on purpose when stdin is given: `start` reads exactly the bytes it was told to.
      else child.stdin.end();
    });
  }

  /** `start <run> --bytes n` with the plan on stdin. */
  start(plan: Plan): Promise<CiReply> {
    const text = JSON.stringify(plan);
    return this.ci(['start', plan.runId, '--bytes', String(Buffer.byteLength(text))], { stdin: text });
  }

  git(args: string[], cwd = join(this.home, 'work')): string {
    const r = spawnSync('git', args, { cwd, env: this.env(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** Runs a shell command here (not through cp-ci). */
  sh(command: string, cwd = this.home): string {
    const r = spawnSync('sh', ['-c', command], { cwd, env: this.env(), encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`;
  }

  /** A working repository `~/work/<name>` with a commit holding the given files. */
  repo(name: string, files: Record<string, string> = { 'README.md': '# app\n' }): string {
    const dir = join(this.home, 'work', name);
    mkdirSync(dir, { recursive: true });
    this.git(['init', '--quiet'], dir);
    this.commit(dir, files, 'first');
    return dir;
  }

  commit(dir: string, files: Record<string, string>, message: string): string {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    this.git(['add', '-A'], dir);
    this.git(['commit', '--quiet', '-m', message], dir);
    return this.git(['rev-parse', 'HEAD'], dir);
  }

  /** Waits until the run's state file says it is over. */
  async finished(runId: string, timeoutMs = 60_000): Promise<CiReply & { state: { status: string; reason: string | null; jobs: { id: string; status: string; reason: string | null; ignored: boolean; steps: { status: string; reason: string | null; exitCode: number | null; ignored: boolean; logBytes: number; logTruncated: boolean }[]; artifacts: { path: string; bytes: number }[] }[] } }> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.ci(['poll', '--runs', runId]);
      const run = (p.runs as Record<string, { state: { status: string } | null; alive: boolean }>)[runId];
      if (run?.state && ['passed', 'failed', 'cancelled'].includes(run.state.status)) return { ...p, state: run.state } as never;
      if (Date.now() > until) throw new Error(`run ${runId} did not finish: ${JSON.stringify(run)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

let counter = 0;
export const runId = (): string => `rtest${String(++counter).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`;

export const step = (run: string, over: Partial<PlanStep> = {}): PlanStep => ({ name: run.split('\n')[0]!.slice(0, 40), run, env: {}, workingDirectory: '.', timeoutMs: null, continueOnError: false, when: 'success', skip: null, ...over });

export const job = (id: string, steps: PlanStep[], over: Partial<PlanJob> = {}): PlanJob => ({ id, name: id, needs: [], when: 'success', skip: null, timeoutMs: 60_000, continueOnError: false, env: {}, secrets: [], group: null, steps, artifacts: null, ...over });

export const plan = (repo: string, sha: string, jobs: PlanJob[], over: Partial<Plan> = {}): Plan => ({
  v: 1,
  runId: runId(),
  runNumber: 1,
  workspace: 'docker/test',
  repo,
  sha,
  ref: 'refs/heads/main',
  pipeline: 'ci',
  env: { CI: 'true', PILOT_CI: 'true', PILOT_BRANCH: 'main' },
  timeoutMs: 120_000,
  maxParallel: 2,
  jobs,
  ...over,
});
