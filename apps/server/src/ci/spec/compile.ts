// From a checked pipeline and an event to the PLAN the runner executes (PRD §11.3). Everything dynamic is decided here, in
// the portal, before the run exists: which pipelines an event starts, which jobs and steps an `if:` leaves out, every
// `${{ }}`, the environment. What the runner is left to decide is only `when`: success, failure or always.

import type { CiDiagnostic, CiInput } from '@portal/contracts';
import { shortSha } from '@portal/contracts';
import { globMatches, globToRegExp } from '../glob.js';
import { CI_LIMITS } from '../limits.js';
import type { Plan, PlanJob, PlanStep } from '../plan.js';
import { evalExpr, ExprError, renderInterp, truthy, type Interp, type Lookup, type Value } from './expr.js';
import { comboLabel, type Combo } from './matrix.js';
import type { Cond, Pipeline } from './validate.js';

/** What started a run, as the pipeline's expressions see it (`ci.*` and `inputs.*`). */
export interface EventContext {
  event: 'push' | 'merge' | 'manual' | 'schedule';
  /** A full ref: `refs/heads/main`, `refs/tags/v1`. */
  ref: string;
  sha: string;
  /** The commit the ref moved from (null for a new ref or a manual run). */
  base: string | null;
  /** `ui`, `push`, `portal-mcp:<id>`, `session:<id>`. */
  actor: string;
  /** The remote's name. */
  repo: string;
  ticket: string | null;
  inputs: Record<string, string | boolean>;
  /** `<target>/<name>`. */
  workspace: string;
  runId: string;
  runNumber: number;
}

export const branchOf = (ref: string): string | null => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null);
export const tagOf = (ref: string): string | null => (ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : null);

export { globMatches, globToRegExp };

/** Whether an event starts this pipeline (once, however many of its triggers match). `merge`: the ref is a protected branch that moved. */
export function matches(p: Pipeline, e: Pick<EventContext, 'event' | 'ref'>): boolean {
  const branch = branchOf(e.ref);
  const tag = tagOf(e.ref);
  if (e.event === 'manual') return p.on.manual !== null;
  if (e.event === 'schedule') return false;
  if (e.event === 'merge' && p.on.merge && branch && globMatches(p.on.merge.branches, branch)) return true;
  // A protected branch that moved is also a push to it.
  if (!p.on.push) return false;
  if (branch) return globMatches(p.on.push.branches, branch);
  if (tag) return globMatches(p.on.push.tags, tag);
  return false;
}

/** The values for a manual run's inputs: given ones checked, the rest defaulted. Problems come back as messages by input name. */
export function resolveInputs(inputs: readonly CiInput[], given: Record<string, unknown> | undefined): { values: Record<string, string | boolean>; problems: Record<string, string> } {
  const values: Record<string, string | boolean> = {};
  const problems: Record<string, string> = {};
  const raw = given ?? {};
  for (const name of Object.keys(raw)) if (!inputs.some((i) => i.name === name)) problems[name] = 'This pipeline has no such input.';
  for (const input of inputs) {
    const v = raw[input.name];
    if (v === undefined || v === null || v === '') {
      if (input.default !== null) values[input.name] = input.default;
      else if (input.required) problems[input.name] = 'Required.';
      else values[input.name] = input.type === 'boolean' ? false : '';
      continue;
    }
    if (input.type === 'boolean') {
      if (typeof v === 'boolean') values[input.name] = v;
      else if (v === 'true' || v === 'false') values[input.name] = v === 'true';
      else problems[input.name] = 'True or false.';
    } else if (typeof v !== 'string' && typeof v !== 'number') problems[input.name] = 'Text.';
    else if (String(v).length > 1000) problems[input.name] = 'At most 1000 characters.';
    else if (input.type === 'choice' && !input.options.includes(String(v))) problems[input.name] = `One of: ${input.options.join(', ')}.`;
    else values[input.name] = String(v);
  }
  return { values, problems };
}

const lookupFor = (e: EventContext, env: Record<string, string>, pipeline: string, matrix: Combo | null = null): Lookup => {
  const ci: Record<string, Value> = {
    event: e.event,
    ref: e.ref,
    branch: branchOf(e.ref) ?? '',
    tag: tagOf(e.ref) ?? '',
    sha: e.sha,
    base: e.base ?? '',
    actor: e.actor,
    repo: e.repo,
    pipeline,
    ticket: e.ticket ?? '',
  };
  return (path) => {
    const [head, name] = path;
    if (path.length !== 2 || !name) return undefined;
    if (head === 'ci') return ci[name];
    if (head === 'inputs') return Object.prototype.hasOwnProperty.call(e.inputs, name) ? e.inputs[name] : null;
    if (head === 'env') return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    if (head === 'matrix') return matrix && Object.prototype.hasOwnProperty.call(matrix, name) ? matrix[name] : undefined;
    return undefined;
  };
};

export type Compiled = { ok: true; plan: Plan; group: string | null; cancelInProgress: boolean } | { ok: false; diagnostics: CiDiagnostic[] };

/** The first non-empty line of a script, as a name for a step that has none. */
function nameFromScript(run: string): string {
  const line = run.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? 'step';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Compiles a pipeline for an event. Total apart from expressions that fail when evaluated (which the checker prevents);
 * those come back as diagnostics, so the run can still be recorded as failed with the reason.
 */
export function compile(p: Pipeline, e: EventContext, opts: { maxParallel: number }): Compiled {
  const problems: CiDiagnostic[] = [];
  const fail = (path: string, err: unknown) =>
    problems.push({ file: p.file, line: 0, column: 0, path, severity: 'error', code: 'eval-error', message: err instanceof ExprError ? err.message : `Could not evaluate: ${String(err)}` });

  const render = (parts: Interp | null, env: Record<string, string>, path: string, fallback: string, matrix: Combo | null = null): string => {
    if (!parts) return fallback;
    try {
      return renderInterp(parts, lookupFor(e, env, p.id, matrix));
    } catch (err) {
      fail(path, err);
      return fallback;
    }
  };
  const evalEnv = (vars: Record<string, Interp>, base: Record<string, string>, path: string, matrix: Combo | null = null): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, parts] of Object.entries(vars)) out[k] = render(parts, base, `${path}.${k}`, '', matrix);
    return out;
  };
  const passes = (cond: Cond, env: Record<string, string>, path: string, matrix: Combo | null = null): boolean => {
    if (!cond.expr) return true;
    try {
      return truthy(evalExpr(cond.expr, lookupFor(e, env, p.id, matrix)));
    } catch (err) {
      fail(path, err);
      return false;
    }
  };

  const branch = branchOf(e.ref);
  const tag = tagOf(e.ref);
  const pipelineEnv = evalEnv(p.env, {}, 'env');
  const contract: Record<string, string> = {
    CI: 'true',
    PILOT_CI: 'true',
    PILOT_RUN_ID: e.runId,
    PILOT_RUN_NUMBER: String(e.runNumber),
    PILOT_PIPELINE: p.id,
    PILOT_EVENT: e.event,
    PILOT_REPO: e.repo,
    PILOT_REF: e.ref,
    PILOT_BRANCH: branch ?? '',
    PILOT_TAG: tag ?? '',
    PILOT_SHA: e.sha,
    PILOT_SHA_SHORT: shortSha(e.sha),
    PILOT_BASE_SHA: e.base ?? '',
    PILOT_ACTOR: e.actor,
    PILOT_TICKET: e.ticket ?? '',
    PILOT_WORKSPACE: e.workspace,
  };
  for (const [name, v] of Object.entries(e.inputs)) contract[`PILOT_INPUT_${name.toUpperCase()}`] = String(v);

  const jobs: PlanJob[] = [];
  // A matrix job becomes one job per combination (`test-m1`, `test-m2`, ...); a job that `needs` it waits for all of them.
  const ids = new Map<string, string[]>();
  for (const job of p.jobs) if (!job.hidden) ids.set(job.id, job.strategy ? job.strategy.combos.map((_, i) => `${job.id}-m${i + 1}`) : [job.id]);
  for (const job of p.jobs) {
    if (job.hidden) continue;
    const jobPath = `jobs.${job.id}`;
    (job.strategy?.combos ?? [null]).forEach((combo, n) => {
      const id = ids.get(job.id)![n]!;
      const jobEnv = evalEnv(job.env, pipelineEnv, `${jobPath}.env`, combo);
      const envHere = { ...pipelineEnv, ...jobEnv };
      const skip = passes(job.cond, envHere, `${jobPath}.if`, combo) ? null : ('condition' as const);
      const steps: PlanStep[] = job.steps.map((s, i) => {
        const stepPath = `${jobPath}.steps[${i}]`;
        const stepEnv = evalEnv(s.env, envHere, `${stepPath}.env`, combo);
        return {
          name: render(s.name, { ...envHere, ...stepEnv }, `${stepPath}.name`, '', combo) || nameFromScript(s.run),
          run: s.run,
          env: stepEnv,
          workingDirectory: s.workingDirectory,
          timeoutMs: s.timeoutMs,
          continueOnError: s.continueOnError,
          when: s.cond.when,
          skip: passes(s.cond, { ...envHere, ...stepEnv }, `${stepPath}.if`, combo) ? null : ('condition' as const),
        };
      });
      const base = render(job.name, envHere, `${jobPath}.name`, job.id, combo);
      jobs.push({
        id,
        name: combo ? `${base} (${comboLabel(combo)})` : base,
        needs: job.needs.flatMap((need) => ids.get(need) ?? []),
        when: job.cond.when,
        skip,
        timeoutMs: job.timeoutMs ?? CI_LIMITS.jobTimeoutMs,
        continueOnError: job.continueOnError,
        env: jobEnv,
        group: job.strategy ? { id: job.id, failFast: job.strategy.failFast, maxParallel: job.strategy.maxParallel } : null,
        secrets: job.secrets,
        steps,
        artifacts: job.artifacts,
        environment: job.environment,
        // Set by the service from the environment's record (protected or not), never from the file.
        approval: null,
      });
    });
  }

  let group: string | null = null;
  if (p.concurrency) group = render(p.concurrency.group, pipelineEnv, 'concurrency.group', '') || null;
  if (group !== null && group.length > 200) group = group.slice(0, 200);

  if (problems.length) return { ok: false, diagnostics: problems };
  return {
    ok: true,
    group,
    cancelInProgress: p.concurrency?.cancelInProgress ?? false,
    plan: {
      v: 1,
      runId: e.runId,
      runNumber: e.runNumber,
      workspace: e.workspace,
      repo: e.repo,
      sha: e.sha,
      ref: e.ref,
      pipeline: p.id,
      env: { ...contract, ...pipelineEnv },
      timeoutMs: p.timeoutMs ?? CI_LIMITS.runTimeoutMs,
      maxParallel: opts.maxParallel,
      jobs,
      ...(p.on.notify?.length ? { notify: p.on.notify } : {}),
      ...(p.runsOn ? { runsOn: p.runsOn, ...(p.runsOnFallback ? { runsOnFallback: p.runsOnFallback } : {}) } : {}),
    },
  };
}

/** A plan for another run of the same commit: the run's own id and number replace the old ones. */
export function replan(plan: Plan, runId: string, runNumber: number): Plan {
  return { ...plan, runId, runNumber, env: { ...plan.env, PILOT_RUN_ID: runId, PILOT_RUN_NUMBER: String(runNumber) } };
}
