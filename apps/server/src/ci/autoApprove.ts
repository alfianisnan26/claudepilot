// The auto-approve rule of an environment (T-110, PRD FR41a), slice 1: DRY MODE ONLY. When a deployment of a protected environment whose
// rule is `dry` starts waiting, the rule reads the facts of the run, the pipeline and the diff since the last release, and writes ONE line on
// the deployment (the run page shows it) and one audit row: what it WOULD do. It approves nothing: it never reads the gate key, never calls
// `cp-ci approve` and never calls the service's decide path. Every fact it can not read reliably is a WOULD NOT with that reason: an
// unreadable fact is a state, never a guess.

import { CI_AUTO_APPROVE_DAILY_CAP, CI_AUTO_APPROVE_DEFAULT_PATHS, shortSha, type CiRunStateFile } from '@portal/contracts';
import { globMatches } from './glob.js';
import type { CiReply } from './host.js';
import type { Plan } from './plan.js';
import type { CiStore, DeploymentRow, EnvironmentRow, RunRow } from './store.js';

/** The file the migrations live in: a change there is read migration by migration, never refused or allowed as a whole. */
export const MIGRATIONS_FILE = 'apps/server/src/store/migrations.ts';
/** The jobs the rule reads by name. */
export const RULE_JOBS = { gate: 'gate', build: 'build', verify: 'verify', rollback: 'rollback' } as const;
const DAY_MS = 86_400_000;
/** How much of the end of the gate job's log the rule reads for the verdict line. */
const GATE_TAIL_BYTES = 64 * 1024;

export const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether `now` falls inside `HH:MM-HH:MM` (UTC; a window may cross midnight; null is always). */
export function inWindow(window: string | null | undefined, now: Date): boolean {
  if (!window) return true;
  const m = WINDOW.exec(window);
  if (!m) return false;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/**
 * The gate job's own verdict from the end of its log: the last line that starts `gate: ` must be `gate: green at <sha>`, and that sha must
 * be this run's commit (a prefix of at least 7). `gate: skipped (input gate=false)`, a dry run's `[dry-run] would run`, a red verdict or no
 * verdict line at all are not green. Returns null when green, else why not.
 */
export function gateVerdict(logTail: string, sha: string): string | null {
  const lines = logTail.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('gate: '));
  const last = lines.at(-1);
  if (!last) return 'the gate job left no verdict line';
  const m = /^gate: green at ([0-9a-f]{7,40})$/.exec(last);
  if (!m) return `the gate job did not say green (“${last.slice(0, 80)}”)`;
  if (!sha.startsWith(m[1]!)) return `the gate was green at ${m[1]!.slice(0, 7)}, not at ${shortSha(sha)}`;
  return null;
}

/**
 * The migrations of a migrations file by version: each block from `{ version: N,` up to the next block or the end of the list. Null when the
 * text does not look like the file (then the change can not be judged).
 */
export function migrationBlocks(text: string): Map<number, string> | null {
  const start = /^ {2}\{\s*\n\s+version: (\d+),/gm;
  const found = [...text.matchAll(start)];
  if (!found.length) return null;
  const end = text.indexOf('\n];', found[0]!.index);
  if (end < 0) return null;
  const blocks = new Map<number, string>();
  for (let i = 0; i < found.length; i++) {
    const at = found[i]!.index;
    if (at > end) break;
    const next = Math.min(found[i + 1]?.index ?? end, end);
    const version = Number(found[i]![1]);
    if (blocks.has(version)) return null;
    blocks.set(version, text.slice(at, next).trimEnd().replace(/,$/, ''));
  }
  return blocks;
}

/** The versions present at the last release (released) that the new text changes or removes. Null when either text can not be read. */
export function releasedMigrationChanges(base: string | null, head: string | null): number[] | null {
  if (base === null) return [];
  if (head === null) return null;
  const was = migrationBlocks(base);
  const now = migrationBlocks(head);
  if (!was || !now) return null;
  return [...was].filter(([v, text]) => now.get(v) !== text).map(([v]) => v);
}

/** The 'needs a person' globs in force for an environment. */
export function needsPersonOf(env: Pick<EnvironmentRow, 'auto_paths'>): string[] {
  if (!env.auto_paths) return [...CI_AUTO_APPROVE_DEFAULT_PATHS];
  try {
    const list = JSON.parse(env.auto_paths) as unknown;
    return Array.isArray(list) && list.every((g) => typeof g === 'string') ? (list as string[]) : [...CI_AUTO_APPROVE_DEFAULT_PATHS];
  } catch {
    return [...CI_AUTO_APPROVE_DEFAULT_PATHS];
  }
}

export interface RuleDeps {
  cs: CiStore;
  /** `cp-ci` in the run's workspace (reads only: `log`, `changes`). */
  cp(workspaceId: string, args: string[]): Promise<CiReply>;
  now(): Date;
}

export interface RuleVerdict {
  verdict: 'would' | 'would_not';
  line: string;
}

const PREFIX = 'auto-approve (dry): ';
const would = (sha: string, n: number): RuleVerdict => ({
  verdict: 'would',
  line: `${PREFIX}WOULD approve: gate green at ${shortSha(sha)}, build ok, verify and rollback present, no authz/secrets/Bypass/deny-rule/released-migration change in the diff, ${n} of ${CI_AUTO_APPROVE_DAILY_CAP} today`,
});
const wouldNot = (why: string): RuleVerdict => ({ verdict: 'would_not', line: `${PREFIX}WOULD NOT: ${why}` });

const json = <T>(text: string | null | undefined): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/**
 * Evaluates the rule for one waiting deployment, the conditions in the PRD's order, stopping at the first that fails. Reads only; the
 * caller records the verdict. Throws nothing: a failure to read becomes a WOULD NOT.
 */
export async function evaluateRule(deps: RuleDeps, run: RunRow, dep: DeploymentRow, env: EnvironmentRow): Promise<RuleVerdict> {
  try {
    return await evaluate(deps, run, dep, env);
  } catch {
    return wouldNot('a fact could not be read (the rule failed while reading)');
  }
}

async function evaluate(deps: RuleDeps, run: RunRow, dep: DeploymentRow, env: EnvironmentRow): Promise<RuleVerdict> {
  const state = json<CiRunStateFile>(run.state);
  const plan = json<Plan>(run.plan);
  if (!state || !plan) return wouldNot('the run’s state can not be read');
  const jobState = (id: string) => state.jobs.find((j) => j.id === id);
  const planJob = (id: string) => plan.jobs.find((j) => j.id === id);

  // 1. The full gate is green on this exact commit: the gate job's verdict in this run.
  const gate = jobState(RULE_JOBS.gate);
  if (!gate || !planJob(RULE_JOBS.gate)) return wouldNot('the pipeline has no gate job');
  if (gate.status !== 'passed' || gate.ignored) return wouldNot(`the gate job is ${gate.status}, not passed`);
  const gateWhy = await gateFromLog(deps, run, gate);
  if (gateWhy) return wouldNot(gateWhy);

  // 2. The build for this commit succeeded.
  const build = jobState(RULE_JOBS.build);
  if (!build || !planJob(RULE_JOBS.build)) return wouldNot('the pipeline has no build job');
  if (build.status !== 'passed' || build.ignored) return wouldNot(`the build job is ${build.status}, not passed`);

  // 3. verify and rollback exist and follow the deploying job; the rollback's previous release is known.
  for (const id of [RULE_JOBS.verify, RULE_JOBS.rollback]) {
    const j = planJob(id);
    if (!j) return wouldNot(`the pipeline has no ${id} job`);
    if (j.skip) return wouldNot(`the ${id} job is left out of this run`);
    if (!j.needs.includes(dep.job)) return wouldNot(`the ${id} job does not follow ${dep.job}`);
  }
  const released = deps.cs.lastReleased(dep.repo_id, dep.environment, run.id);
  if (!released) return wouldNot(`no earlier release of ${dep.environment} is recorded, so the rollback’s previous tag is not known`);

  // 4. The diff since the last released commit: nothing that needs a person, no released migration changed.
  const diffWhy = await diffProblem(deps, run, released, needsPersonOf(env));
  if (diffWhy) return wouldNot(diffWhy);

  // 5. At most N a day, one at a time.
  const now = deps.now();
  const others = deps.cs.ruleDeployments(dep.repo_id, dep.environment).filter((d) => d.id !== dep.id);
  const busy = others.find((d) => d.run_status === 'queued' || d.run_status === 'running');
  if (busy) return wouldNot(`#${busy.run_number}, approved by the rule, is still running (one at a time)`);
  const today = others.filter((d) => {
    const at = Date.parse(d.auto_at ?? d.decided_at ?? '');
    return Number.isFinite(at) && now.getTime() - at < DAY_MS && at <= now.getTime();
  }).length;
  if (today >= CI_AUTO_APPROVE_DAILY_CAP) return wouldNot(`${today} of ${CI_AUTO_APPROVE_DAILY_CAP} today already`);

  // 6. Inside the allowed window.
  if (!inWindow(env.auto_window, now)) return wouldNot(env.auto_window && WINDOW.test(env.auto_window) ? `outside the allowed window ${env.auto_window} UTC` : 'the allowed window can not be read');

  // 7. The previous auto-approved deploy is not failing or rolled back.
  const prevWhy = previousProblem(deps, others);
  if (prevWhy) return wouldNot(prevWhy);

  return would(run.sha, today + 1);
}

async function gateFromLog(deps: RuleDeps, run: RunRow, gate: CiRunStateFile['jobs'][number]): Promise<string | null> {
  const steps = gate.steps.filter((s) => s.status !== 'skipped');
  const last = steps.at(-1);
  if (!last) return 'the gate job ran no step';
  // The size first, then the end of the log, where the verdict is.
  const head = await deps.cp(run.workspace_id, ['log', run.id, RULE_JOBS.gate, String(last.idx), '0', '--max', '1024']);
  if (!head.ok || typeof head.size !== 'number') return 'the gate job’s log can not be read';
  const from = Math.max(0, head.size - GATE_TAIL_BYTES);
  const tail = from === 0 && head.next === head.size ? head : await deps.cp(run.workspace_id, ['log', run.id, RULE_JOBS.gate, String(last.idx), String(from), '--max', String(GATE_TAIL_BYTES)]);
  if (!tail.ok || typeof tail.text !== 'string') return 'the gate job’s log can not be read';
  return gateVerdict(tail.text, run.sha);
}

async function diffProblem(deps: RuleDeps, run: RunRow, released: DeploymentRow, globs: string[]): Promise<string | null> {
  const base = released.sha;
  if (base === run.sha) return null;
  const r = await deps.cp(run.workspace_id, ['changes', run.repo, base, run.sha, '--show', MIGRATIONS_FILE]);
  if (!r.ok) return `the diff since the last release ${shortSha(base)} can not be read (${r.error === 'no_commit' ? 'a commit is missing in the remote' : r.error === 'bad_command' ? 'the workspace’s runner is too old' : 'the runner refused'})`;
  if (r.truncated === true || !Array.isArray(r.paths)) return `the diff since the last release ${shortSha(base)} is too large to read`;
  if (r.ancestor !== true) return `${shortSha(run.sha)} does not descend from the last release ${shortSha(base)}`;
  const paths = r.paths as string[];
  const hit = paths.find((p) => globMatches(globs, p));
  if (hit) return `the diff since ${shortSha(base)} changes ${hit}, which needs a person`;
  if (paths.includes(MIGRATIONS_FILE)) {
    const show = r.show as { base: string | null; head: string | null; tooLarge: boolean } | undefined;
    if (!show || show.tooLarge) return 'the migrations file can not be read';
    const changed = releasedMigrationChanges(show.base, show.head);
    if (changed === null) return 'the migrations file can not be read';
    if (changed.length) return `the diff changes released migration ${changed.slice(0, 3).join(', ')}`;
  }
  return null;
}

function previousProblem(deps: RuleDeps, others: (DeploymentRow & { run_status: string | null })[]): string | null {
  // The newest earlier deployment the rule approved (dry: would have) that actually went out.
  const prev = others.find((d) => d.approval === 'approved' || d.approval === 'auto');
  if (!prev) return null;
  if (prev.run_status === null) return `the record of the previous auto-approved deploy #${prev.run_number} is gone`;
  const row = deps.cs.run(prev.run_id);
  const state = json<CiRunStateFile>(row?.state);
  if (!state) return `the previous auto-approved deploy #${prev.run_number} can not be read`;
  const rollback = state.jobs.find((j) => j.id === RULE_JOBS.rollback);
  if (rollback && rollback.status !== 'skipped' && rollback.status !== 'pending' && rollback.status !== 'cancelled') return `the previous auto-approved deploy #${prev.run_number} was rolled back`;
  if (prev.outcome !== 'passed' || prev.run_status !== 'passed') return `the previous auto-approved deploy #${prev.run_number} is ${prev.run_status === 'passed' ? (prev.outcome ?? 'unfinished') : prev.run_status}`;
  return null;
}
