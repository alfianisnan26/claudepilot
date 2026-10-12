// cp-ci, the workspace side of CI (PRD §11): paths, name checks, a git runner with the house hygiene, and the way every
// command answers. This runs inside workspaces as the workspace user, from a root-owned script bundled from this folder,
// so it takes nothing from the repository it works on and imports nothing but Node's own modules.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EVENT_ID, RUN_ID, SHA } from '../plan.js';

/** A failure with a stable name: the command's reply is `{"ok":false,"error":<code>,...}`. */
export class Fail extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/* ---------- Where things live (all under ~/.claudepilot) ---------- */

export const rootDir = () => join(homedir(), '.claudepilot');
export const gitRoot = () => join(rootDir(), 'git');
export const ciRoot = () => join(rootDir(), 'ci');
export const eventsDir = () => join(ciRoot(), 'events');
export const runsDir = () => join(ciRoot(), 'runs');
export const runDir = (runId: string) => join(runsDir(), runId);

/* ---------- Names ---------- */

export const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const validRepoName = (n: unknown): n is string => typeof n === 'string' && REPO_NAME.test(n) && !n.endsWith('.git') && !n.includes('..');
export const validRunId = (n: unknown): n is string => typeof n === 'string' && RUN_ID.test(n);
export const validSha = (n: unknown): n is string => typeof n === 'string' && SHA.test(n);
export const validEventId = (n: unknown): n is string => typeof n === 'string' && EVENT_ID.test(n);
export const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A branch or tag name: stricter than git, so nothing odd reaches a command or a path (PRD FR6). */
export function validRefName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('/.') && !name.endsWith('.');
}

/** A full ref the runner works with: `refs/heads/<name>` or `refs/tags/<name>`. */
export function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && (ref.startsWith('refs/heads/') ? validRefName(ref.slice(11)) : ref.startsWith('refs/tags/') ? validRefName(ref.slice(10)) : false);
}

export const bareDir = (repo: string) => join(gitRoot(), `${repo}.git`);

/* ---------- Files ---------- */

/** Writes a file so a reader sees all of it or none: a temporary name in the same folder, then a rename. */
export function writeAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export const ensureDir = (path: string, mode = 0o700) => mkdirSync(path, { recursive: true, mode });

/** Whether `child` is `parent` or inside it, by path text (both already resolved). */
export const inside = (parent: string, child: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/* ---------- Git ---------- */

/** What every git call passes: nothing the repository configures runs (the hygiene cp-session's diff uses). */
const HARDEN = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.quotePath=false', '-c', 'protocol.ext.allow=never'];

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** The environment git gets: the user's, minus every GIT_* a hook might have passed on, plus what we set. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  return { ...env, HOME: homedir(), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
}

/** Runs git with an argument array (never a shell). `gitDir` makes it work on a bare repository. */
export function git(args: string[], opts: { cwd?: string; gitDir?: string; input?: string | Buffer; env?: Record<string, string>; timeoutMs?: number; maxBytes?: number; raw?: boolean } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // `raw` is for asking git what the configuration really says, which the hardening would overwrite.
    const full = [...(opts.raw ? [] : HARDEN), ...(opts.gitDir ? [`--git-dir=${opts.gitDir}`] : []), ...args];
    const child = spawn('git', full, { cwd: opts.cwd ?? homedir(), env: gitEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= max) out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 16_384) err.push(c);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Fail('git_missing', `git could not run: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input);
  });
}

/** Runs git and returns trimmed text; a failure is a {@link Fail} with git's own message. */
export async function gitText(args: string[], opts: Parameters<typeof git>[1] = {}, code = 'git_failed'): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Fail(code, r.stderr.trim().split('\n')[0]?.slice(0, 300) || `git ${args[0]} failed`);
  return r.stdout.toString('utf8').trim();
}

/* ---------- Answers ---------- */

export const PREFIX = '@cpci ';

/** The one line a command prints: the prefix and a JSON object. The portal reads the last such line, so noise in the exec's merged output is harmless. */
export function reply(obj: Record<string, unknown>): string {
  return `${PREFIX}${JSON.stringify(obj)}\n`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();
