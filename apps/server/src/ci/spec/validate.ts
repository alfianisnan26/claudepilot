// Reading a pipeline file (PRD §9): YAML text in, a checked Pipeline and every diagnostic out. Unknown keys are errors with
// a suggestion; the formats this one is shaped after (GitHub Actions, GitLab CI) each get specific hints for the keys an
// agent is likely to carry over. Nothing here runs anything: expressions are parsed and their names checked, not evaluated.

import { CI_NOTIFY_STATES, type CiDiagnostic, type CiInput, type CiNotifyState, type CiPipelineInfo } from '@portal/contracts';
import { CI_LIMITS } from '../limits.js';
import type { PlanWhen } from '../plan.js';
import { checkExpr, checkInterp, closest, parseExpr, parseInterp, splitCondition, unwrapIf, ExprError, type Expr, type Interp, type Scope } from './expr.js';
import { expandMatrix, type Combo, type MatrixDef, type Scalar } from './matrix.js';
import { parseYaml, type ParsedYaml, type PathSeg } from './yaml.js';

/* ---------- The checked pipeline ---------- */

export interface Cond {
  when: PlanWhen;
  /** Decided before the run; null when the condition is only a status function (or there is none). */
  expr: Expr | null;
}

export interface PStep {
  name: Interp | null;
  run: string;
  env: Record<string, Interp>;
  cond: Cond;
  workingDirectory: string;
  timeoutMs: number | null;
  continueOnError: boolean;
}

export interface PJob {
  id: string;
  /** A job whose id starts with `.` is a template for `extends`: it never runs. */
  hidden: boolean;
  name: Interp | null;
  needs: string[];
  cond: Cond;
  timeoutMs: number | null;
  env: Record<string, Interp>;
  /** Secrets & env names (never values). */
  secrets: string[];
  /** The job runs once per combination (a job without a matrix is one combination with no values). */
  strategy: { matrix: MatrixDef; combos: Combo[]; failFast: boolean; maxParallel: number | null } | null;
  continueOnError: boolean;
  steps: PStep[];
  artifacts: { paths: string[]; expireDays: number; when: 'success' | 'always' } | null;
  /** The environment it deploys to (PRD FR41): the portal decides from its own record whether a person must approve it first. */
  environment: string | null;
  /** `runs-on` labels (T-557): the run goes to a runner whose labels include all of them; null runs it in the repository's workspace. */
  runsOn: string[] | null;
}

export interface Pipeline {
  file: string;
  /** The file's name without its extension: how runs and the API name it. */
  id: string;
  name: Interp | null;
  on: {
    push: { branches: string[]; tags: string[] } | null;
    merge: { branches: string[] } | null;
    manual: { inputs: CiInput[] } | null;
    /** `notify: [passed, cancelled, waiting]`: states a push or merge run reports to its session too (FR36); null when the file says nothing. */
    notify: CiNotifyState[] | null;
  };
  env: Record<string, Interp>;
  timeoutMs: number | null;
  concurrency: { group: Interp; cancelInProgress: boolean } | null;
  /** The runner labels every job shares (T-557: one runner per run for now); null: the repository's workspace. */
  runsOn: string[] | null;
  jobs: PJob[];
}

export interface Validated {
  /** Null when the file has an error: it can't be run. */
  pipeline: Pipeline | null;
  info: CiPipelineInfo;
}

/* ---------- Where things go wrong ---------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const pathText = (path: readonly PathSeg[]): string => path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${p}` : p), '');

class Diags {
  readonly list: CiDiagnostic[] = [];
  constructor(
    readonly file: string,
    readonly doc: ParsedYaml | null,
  ) {}

  add(severity: 'error' | 'warning', path: readonly PathSeg[], code: string, message: string, hint?: string, at: 'key' | 'value' = 'value'): void {
    const p = this.doc?.where(path, at) ?? { line: 0, column: 0 };
    this.list.push({ file: this.file, line: p.line, column: p.column, path: pathText(path), severity, code, message, ...(hint ? { hint } : {}) });
  }

  error(path: readonly PathSeg[], code: string, message: string, hint?: string, at: 'key' | 'value' = 'value') {
    this.add('error', path, code, message, hint, at);
  }

  get errors(): number {
    return this.list.filter((d) => d.severity === 'error').length;
  }
}

/** Keys that other CI formats have and this one doesn't, with what to write instead. */
const FOREIGN_TOP: Record<string, string> = {
  stages: 'There are no stages: order jobs with `needs`.',
  variables: 'Use `env`.',
  default: 'Put shared settings in `env`, or use `extends` with a hidden job (later).',
  workflow: 'Use `on` to say when it runs.',
  image: 'Jobs run in the workspace itself; there are no images.',
  services: 'Jobs run in the workspace itself; there are no services.',
  cache: 'Not needed: the workspace keeps its home folder between runs.',
  before_script: 'Make it the first step of the job.',
  after_script: 'Make it a last step with `if: always()`.',
  permissions: 'There are no tokens to scope here.',
  defaults: 'Set `env` or repeat `working-directory` on the steps.',
  include: 'Local `include` arrives with templates, in a later milestone.',
};
const FOREIGN_JOB: Record<string, string> = {
  script: 'Use `steps`, each with `run`.',
  before_script: 'Make it the first step.',
  after_script: 'Make it a last step with `if: always()`.',
  stage: 'There are no stages: order jobs with `needs`.',
  rules: 'Use `if`.',
  only: 'Use `if`, or filter in `on`.',
  except: 'Use `if`, or filter in `on`.',
  when: 'Use `if`.',
  image: 'Jobs run in the workspace itself; there are no images.',
  container: 'Jobs run in the workspace itself; there are no containers.',
  services: 'Jobs run in the workspace itself; there are no services.',
  allow_failure: 'Use `continue-on-error`.',
  variables: 'Use `env`.',
  cache: 'Not needed: the workspace keeps its home folder between runs.',
  retry: 'Retries are not supported.',
  tags: 'Runners are not selected by tag: a job runs in the workspace.',
  dependencies: 'Use `needs`: a job gets the artifacts of the jobs it needs.',
  outputs: 'Values do not pass between jobs; use artifacts.',
  permissions: 'There are no tokens to scope here.',
  defaults: 'Set `env` or repeat `working-directory` on the steps.',
  'continue_on_error': 'Use `continue-on-error`.',
};
const FOREIGN_STEP: Record<string, string> = {
  script: 'Use `run`.',
  shell: 'Steps run with bash.',
  id: 'Steps have no outputs.',
  with: 'Only a local step takes `with`, and local steps arrive in a later milestone.',
};
const FOREIGN_ON: Record<string, string> = {
  pull_request: 'There are no pull requests: use `merge` for a protected branch, or `push`.',
  pull_request_target: 'There are no pull requests: use `merge` for a protected branch, or `push`.',
  workflow_dispatch: 'Use `manual`.',
  workflow_call: 'Reusable workflows do not exist here.',
  release: 'Push a tag and use `push: { tags: [...] }`.',
  create: 'Use `push`.',
  delete: 'A deleted branch starts nothing.',
  issues: 'Not an event here.',
  repository_dispatch: 'Use `manual`.',
};

function checkKeys(d: Diags, o: Obj, path: readonly PathSeg[], allowed: readonly string[], foreign: Record<string, string> = {}) {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    const near = closest(k, allowed);
    d.error([...path, k], foreign[k] ? 'unsupported-key' : 'unknown-key', `Unknown key "${k}".`, foreign[k] ?? (near ? `Did you mean "${near}"?` : `Allowed here: ${allowed.join(', ')}.`), 'key');
  }
}

/* ---------- Small readers ---------- */

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** `90s`, `15m`, `2h`, `1h30m` in milliseconds; null when it isn't one. */
export function parseDuration(s: string): number | null {
  const m = DURATION.exec(s.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function timeoutOf(d: Diags, o: Obj, path: readonly PathSeg[]): number | null {
  const has = own(o, 'timeout');
  const hasMinutes = own(o, 'timeout-minutes');
  if (has && hasMinutes) d.error([...path, 'timeout-minutes'], 'duplicate-timeout', 'Both timeout and timeout-minutes are set.', 'Keep one.', 'key');
  let ms: number | null = null;
  if (has) {
    const v = o.timeout;
    ms = typeof v === 'string' ? parseDuration(v) : null;
    if (ms === null) d.error([...path, 'timeout'], 'bad-duration', `${JSON.stringify(v)} is not a duration.`, typeof v === 'number' ? `Write ${v}m, or use timeout-minutes: ${v}.` : 'Write 90s, 15m or 2h.');
  } else if (hasMinutes) {
    const v = o['timeout-minutes'];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) ms = Math.round(v * 60_000);
    else d.error([...path, 'timeout-minutes'], 'bad-duration', `${JSON.stringify(v)} is not a number of minutes.`, 'Write timeout-minutes: 15.');
  }
  if (ms !== null && ms < 1000) {
    d.error([...path, has ? 'timeout' : 'timeout-minutes'], 'bad-duration', 'A timeout is at least one second.');
    ms = null;
  }
  if (ms !== null && ms > CI_LIMITS.maxTimeoutMs) {
    d.error([...path, has ? 'timeout' : 'timeout-minutes'], 'timeout-too-long', `A timeout is at most ${CI_LIMITS.maxTimeoutMs / 3_600_000} hours.`);
    ms = null;
  }
  return ms;
}

/** `${{ }}` in text that may have it: parsed, and its names checked. */
function interp(d: Diags, v: unknown, path: readonly PathSeg[], scope: Scope): Interp | null {
  if (typeof v !== 'string') return null;
  const { parts, errors } = parseInterp(v);
  for (const e of errors) d.error(path, 'bad-expression', e.error.message, e.error.hint);
  for (const e of checkInterp(parts, scope)) d.error(path, 'unknown-name', e.message, e.hint);
  return errors.length ? null : parts;
}

function envOf(d: Diags, v: unknown, path: readonly PathSeg[], scope: Scope): Record<string, Interp> {
  const out: Record<string, Interp> = {};
  if (v === undefined) return out;
  if (!isObj(v)) {
    d.error(path, 'bad-type', 'env is a map of NAME: value.', 'For example: env: { NODE_ENV: test }');
    return out;
  }
  const names = Object.keys(v);
  if (names.length > 100) d.error(path, 'too-many', 'At most 100 variables per env.');
  for (const name of names.slice(0, 100)) {
    const p = [...path, name];
    if (!NAME.test(name)) {
      d.error(p, 'bad-name', `"${name}" is not a variable name.`, 'Letters, digits and _, not starting with a digit.', 'key');
      continue;
    }
    if (name.startsWith('PILOT_')) {
      d.error(p, 'reserved-name', 'Names starting with PILOT_ are set by the runner.', undefined, 'key');
      continue;
    }
    const val = v[name];
    if (typeof val === 'string') {
      const parts = interp(d, val, p, scope);
      if (parts) out[name] = parts;
    } else if (typeof val === 'number' || typeof val === 'boolean') out[name] = [String(val)];
    else d.error(p, 'bad-type', 'A variable is text, a number or true or false.', val === null ? 'Quote an empty value: NAME: "".' : undefined);
  }
  return out;
}

function condOf(d: Diags, v: unknown, path: readonly PathSeg[], scope: Scope): Cond {
  const fallback: Cond = { when: 'success', expr: null };
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return { when: 'success', expr: { t: 'lit', v, at: 0 } };
  if (typeof v !== 'string') {
    d.error(path, 'bad-type', 'A condition is an expression in text.', "For example: if: ci.branch == 'main'");
    return fallback;
  }
  const src = unwrapIf(v);
  if (src === null) {
    d.error(path, 'bad-expression', 'Put the whole condition in one ${{ }}, or none.');
    return fallback;
  }
  try {
    const e = parseExpr(src);
    const problems = checkExpr(e, scope);
    for (const p of problems) d.error(path, 'unknown-name', p.message, p.hint);
    const { when, rest } = splitCondition(e);
    return problems.length ? fallback : { when, expr: rest };
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    d.error(path, 'bad-expression', `${e.message} (character ${e.at + 1} of the condition)`, e.hint);
    return fallback;
  }
}

function boolOf(d: Diags, o: Obj, key: string, path: readonly PathSeg[]): boolean {
  if (!own(o, key)) return false;
  if (typeof o[key] === 'boolean') return o[key];
  d.error([...path, key], 'bad-type', `${key} is true or false.`);
  return false;
}

/** A relative path that stays inside where it is applied: no `..`, not absolute, no backslash. */
function relativePath(s: string): boolean {
  if (!s || s.length > 200 || s.startsWith('/') || s.includes('\\') || s.includes('\0')) return false;
  return !s.split('/').some((seg) => seg === '..');
}

const GLOB = /^[A-Za-z0-9._/*?-]{1,200}$/;

/** Globs of a trigger or an artifact: a string or a list of them. */
function globsOf(d: Diags, v: unknown, path: readonly PathSeg[]): string[] {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (!list) {
    d.error(path, 'bad-type', 'Write a name or a list of names.', "For example: branches: ['main', 'release/*']");
    return [];
  }
  const out: string[] = [];
  list.forEach((g, i) => {
    const p = typeof v === 'string' ? path : [...path, i];
    if (typeof g !== 'string' || !GLOB.test(g)) d.error(p, 'bad-glob', `${JSON.stringify(g)} is not a name or a pattern.`, 'Letters, digits, . _ - / and the wildcards * and ?. ** crosses folders.');
    else out.push(g);
  });
  return out;
}

/* ---------- Triggers ---------- */

const ON_KEYS = ['push', 'merge', 'manual', 'schedule'] as const;
const INPUT_TYPES = ['string', 'boolean', 'choice'] as const;

function readOn(d: Diags, v: unknown): { on: Pipeline['on']; inputs: CiInput[] } {
  const on: Pipeline['on'] = { push: null, merge: null, manual: null, notify: null };
  const inputs: CiInput[] = [];
  const path = ['on'];
  let map: Obj;
  if (typeof v === 'string') map = { [v]: null };
  else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) map = Object.fromEntries((v as string[]).map((x) => [x, null]));
  else if (isObj(v)) map = v;
  else {
    d.error(path, 'bad-type', 'on says when the pipeline runs.', 'For example: on: { push: { branches: [main] } }');
    return { on, inputs };
  }
  if (!Object.keys(map).length) d.error(path, 'empty', 'on needs at least one trigger.', `Choose from ${ON_KEYS.join(', ')}.`);
  for (const key of Object.keys(map)) {
    const p = [...path, key];
    const body = map[key];
    if (key === 'notify') {
      on.notify = notifyOf(d, body, p);
      continue;
    }
    if (!(ON_KEYS as readonly string[]).includes(key)) {
      const near = closest(key, ON_KEYS);
      d.error(p, FOREIGN_ON[key] ? 'unsupported-trigger' : 'unknown-key', `Unknown trigger "${key}".`, FOREIGN_ON[key] ?? (near ? `Did you mean "${near}"?` : `Choose from ${ON_KEYS.join(', ')}.`), 'key');
      continue;
    }
    if (body !== null && !isObj(body)) {
      d.error(p, 'bad-type', `${key} takes settings in a map (or nothing).`);
      continue;
    }
    const o: Obj = body ?? {};
    if (key === 'push') {
      checkKeys(d, o, p, ['branches', 'tags']);
      const hasB = own(o, 'branches');
      const hasT = own(o, 'tags');
      const branches = hasB ? globsOf(d, o.branches, [...p, 'branches']) : hasT ? [] : ['**'];
      const tags = hasT ? globsOf(d, o.tags, [...p, 'tags']) : [];
      on.push = { branches, tags };
    } else if (key === 'merge') {
      checkKeys(d, o, p, ['branches']);
      on.merge = { branches: own(o, 'branches') ? globsOf(d, o.branches, [...p, 'branches']) : ['**'] };
    } else if (key === 'manual') {
      checkKeys(d, o, p, ['inputs']);
      on.manual = { inputs: [] };
      if (own(o, 'inputs')) {
        const raw = o.inputs;
        if (!isObj(raw)) d.error([...p, 'inputs'], 'bad-type', 'inputs is a map of name: { type, default, ... }.');
        else {
          for (const name of Object.keys(raw)) {
            const ip = [...p, 'inputs', name];
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name)) {
              d.error(ip, 'bad-name', `"${name}" is not an input name.`, 'Letters, digits and _.', 'key');
              continue;
            }
            const spec = raw[name] === null ? {} : raw[name];
            if (!isObj(spec)) {
              d.error(ip, 'bad-type', 'An input is a map: { type, default, options, required }.');
              continue;
            }
            checkKeys(d, spec, ip, ['type', 'default', 'options', 'required', 'description']);
            const type = own(spec, 'type') ? spec.type : 'string';
            if (typeof type !== 'string' || !(INPUT_TYPES as readonly string[]).includes(type)) {
              d.error([...ip, 'type'], 'bad-type', `Input type "${String(type)}" is unknown.`, `Use ${INPUT_TYPES.join(', ')}.`);
              continue;
            }
            const options = Array.isArray(spec.options) ? spec.options.filter((x): x is string => typeof x === 'string') : [];
            if (type === 'choice' && (!Array.isArray(spec.options) || options.length === 0 || options.length !== (spec.options as unknown[]).length)) d.error([...ip, 'options'], 'bad-type', 'A choice input needs options: a list of text.');
            let def: string | boolean | null = null;
            if (own(spec, 'default') && spec.default !== null) {
              if (type === 'boolean' && typeof spec.default === 'boolean') def = spec.default;
              else if (type !== 'boolean' && (typeof spec.default === 'string' || typeof spec.default === 'number')) def = String(spec.default);
              else d.error([...ip, 'default'], 'bad-type', `The default of a ${type} input is ${type === 'boolean' ? 'true or false' : 'text'}.`);
              if (type === 'choice' && typeof def === 'string' && !options.includes(def)) d.error([...ip, 'default'], 'bad-default', `"${def}" is not one of the options.`);
            }
            const input: CiInput = { name, type: type as CiInput['type'], default: def, options: type === 'choice' ? options : [], required: spec.required === true, description: typeof spec.description === 'string' ? spec.description.slice(0, 200) : null };
            inputs.push(input);
            on.manual.inputs.push(input);
          }
        }
      }
    }
  }
  if (own(map, 'schedule')) d.error([...path, 'schedule'], 'not-yet', 'Schedules are not available yet.', 'Start the pipeline by hand with manual, or from a script.', 'key');
  return { on, inputs };
}

/** `notify`: a list of the states a run reports to its session besides a failure (`failed` may be listed; it always reports). */
function notifyOf(d: Diags, v: unknown, path: PathSeg[]): CiNotifyState[] {
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list)) {
    d.error(path, 'bad-type', 'notify is a list of states.', `For example: notify: [passed, cancelled, waiting]. Choose from ${CI_NOTIFY_STATES.join(', ')}.`);
    return [];
  }
  const out: CiNotifyState[] = [];
  list.forEach((x, i) => {
    if (typeof x === 'string' && (CI_NOTIFY_STATES as readonly string[]).includes(x)) {
      if (!out.includes(x as CiNotifyState)) out.push(x as CiNotifyState);
      return;
    }
    const near = typeof x === 'string' ? closest(x, CI_NOTIFY_STATES) : null;
    d.error([...path, i], 'bad-value', `"${String(x)}" is not a state a run reports.`, near ? `Did you mean "${near}"?` : `Choose from ${CI_NOTIFY_STATES.join(', ')}.`);
  });
  return out;
}

/* ---------- Jobs and steps ---------- */

const JOB_KEYS = ['name', 'needs', 'if', 'timeout', 'timeout-minutes', 'env', 'secrets', 'continue-on-error', 'strategy', 'steps', 'artifacts', 'environment', 'extends', 'runs-on'] as const;
const STEP_KEYS = ['name', 'run', 'env', 'if', 'working-directory', 'timeout', 'timeout-minutes', 'continue-on-error', 'uses'] as const;
const NOT_YET: Record<string, string> = {
  extends: 'extends arrives in a later milestone.',
};
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** `environment: production` or `environment: { name: production }` (GitHub's shapes; `url` is accepted and not used yet). */
function environmentOf(d: Diags, raw: unknown, path: readonly PathSeg[]): string | null {
  if (raw === undefined) return null;
  let name: unknown = raw;
  if (isObj(raw)) {
    checkKeys(d, raw, path, ['name', 'url']);
    name = raw.name;
  }
  if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) {
    d.error(isObj(raw) ? [...path, 'name'] : path, 'bad-environment', 'An environment is a name such as production.', 'Lowercase letters, digits, . _ and -, at most 40.');
    return null;
  }
  return name;
}

const USES_HINT: [RegExp, string][] = [
  [/^actions\/setup-/, 'Node, git and the usual tools are in the workspace. Install anything else with `run`.'],
  [/^actions\/cache/, 'Not needed: the workspace keeps its home folder (~/.npm and similar) between runs.'],
  [/^actions\/upload-artifact/, "Use the job's `artifacts: { paths: [...] }`."],
  [/^actions\/download-artifact/, 'A job that `needs` another gets its artifacts.'],
  [/^docker\//, 'There are no containers here: run commands directly with `run`.'],
];

function readStep(d: Diags, raw: unknown, path: readonly PathSeg[], jobScope: Scope): PStep | null {
  if (!isObj(raw)) {
    d.error(path, 'bad-type', 'A step is a map with `run`.', 'For example: - run: npm test');
    return null;
  }
  checkKeys(d, raw, path, STEP_KEYS, FOREIGN_STEP);
  if (own(raw, 'uses')) {
    const uses = raw.uses;
    if (typeof uses !== 'string') d.error([...path, 'uses'], 'bad-type', 'uses names a local step.');
    else if (/^actions\/checkout(@|$)/.test(uses)) d.add('warning', [...path, 'uses'], 'ignored-checkout', 'The checkout is implicit; this step is ignored.', 'Remove it. Every job starts in a clean checkout of the commit.');
    else if (uses.startsWith('./')) d.error([...path, 'uses'], 'not-yet', 'Local steps arrive in a later milestone.');
    else d.error([...path, 'uses'], 'no-remote-actions', `"${uses}" is not available.`, USES_HINT.find(([re]) => re.test(uses))?.[1] ?? 'Steps run in the workspace; only local steps (`uses: ./steps/<name>`) can be used, and they arrive later. Use `run`.');
    return null;
  }
  if (!own(raw, 'run')) {
    // A step written with `script` has already been told to use `run`.
    if (!own(raw, 'script')) d.error(path, 'missing-key', 'A step needs `run`.', own(raw, 'name') ? `Add "run:" under the step named ${JSON.stringify(raw.name)}.` : undefined);
    return null;
  }
  const run = raw.run;
  if (typeof run !== 'string' || !run.trim()) {
    d.error([...path, 'run'], 'bad-type', '`run` is a shell script in text.', typeof run === 'string' ? 'It is empty.' : undefined);
    return null;
  }
  if (run.includes('${{')) d.error([...path, 'run'], 'no-interpolation-in-run', '${{ }} cannot be used inside `run`.', 'Values reach scripts as environment variables: use $PILOT_BRANCH, $PILOT_SHA or a name from env. This keeps a branch or an input from becoming shell.');
  if (run.length > 100_000) d.error([...path, 'run'], 'too-long', 'A script is at most 100,000 characters.', 'Put it in a file under .pilot/scripts/ and run that.');
  // A step's own env is for its script and its condition; its env values see only the pipeline's and the job's.
  const stepEnv = envOf(d, raw.env, [...path, 'env'], jobScope);
  const scope: Scope = { ...jobScope, env: new Set([...jobScope.env, ...Object.keys(stepEnv)]) };
  const name = own(raw, 'name') ? (typeof raw.name === 'string' ? interp(d, raw.name, [...path, 'name'], scope) : (d.error([...path, 'name'], 'bad-type', 'A step name is text.'), null)) : null;
  let workingDirectory = '.';
  if (own(raw, 'working-directory')) {
    const wd = raw['working-directory'];
    if (typeof wd === 'string' && relativePath(wd)) workingDirectory = wd.replace(/\/+$/, '') || '.';
    else d.error([...path, 'working-directory'], 'bad-path', `${JSON.stringify(wd)} is not a folder inside the checkout.`, 'A relative path with no `..`.');
  }
  return {
    name,
    run,
    env: stepEnv,
    cond: condOf(d, raw.if, [...path, 'if'], scope),
    workingDirectory,
    timeoutMs: timeoutOf(d, raw, path),
    continueOnError: boolOf(d, raw, 'continue-on-error', path),
  };
}

/** `secrets: [NAME]`: Secrets & env names a job relies on. The file only names them; values come from the workspace at run time. */
function secretsOf(d: Diags, v: unknown, path: readonly PathSeg[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    d.error(path, 'bad-type', 'secrets is a list of Secrets & env names.', 'For example: secrets: [NPM_TOKEN]');
    return [];
  }
  if (v.length > 20) d.error(path, 'too-many', 'At most 20 secrets per job.');
  const out: string[] = [];
  v.slice(0, 20).forEach((n, i) => {
    if (typeof n !== 'string' || !NAME.test(n) || n.startsWith('PILOT_')) d.error([...path, i], 'bad-name', `${JSON.stringify(n)} is not a secret name.`, 'Use the name as it is in Secrets & env: letters, digits and _, not starting with PILOT_.');
    else if (out.includes(n)) d.error([...path, i], 'duplicate', `${n} is listed twice.`);
    else out.push(n);
  });
  return out;
}

const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** `strategy: { matrix: { os: [a, b], include: [...], exclude: [...] }, fail-fast, max-parallel }`. */
function strategyOf(d: Diags, v: unknown, path: readonly PathSeg[]): PJob['strategy'] {
  if (v === undefined) return null;
  if (!isObj(v)) {
    d.error(path, 'bad-type', 'strategy is a map with a matrix.', 'For example: strategy: { matrix: { node: [20, 22] } }');
    return null;
  }
  checkKeys(d, v, path, ['matrix', 'fail-fast', 'max-parallel'], { parallel: 'Use max-parallel.' });
  if (!own(v, 'matrix')) {
    d.error(path, 'missing-key', 'A strategy needs a matrix.', 'For example: strategy: { matrix: { node: [20, 22] } }');
    return null;
  }
  const m = v.matrix;
  const mp = [...path, 'matrix'];
  if (!isObj(m)) {
    d.error(mp, 'bad-type', 'matrix is a map of key to a list of values.', 'For example: matrix: { node: [20, 22] }');
    return null;
  }
  const axes: Record<string, Scalar[]> = {};
  for (const key of Object.keys(m)) {
    if (key === 'include' || key === 'exclude') continue;
    const kp = [...mp, key];
    if (!NAME.test(key)) {
      d.error(kp, 'bad-name', `"${key}" is not a matrix key.`, 'Letters, digits and _.', 'key');
      continue;
    }
    const list = m[key];
    if (!Array.isArray(list) || list.length === 0 || !list.every(isScalar)) {
      d.error(kp, 'bad-type', `${key} is a list of text, numbers or true and false.`, `For example: ${key}: [a, b]`);
      continue;
    }
    axes[key] = list as Scalar[];
  }
  const entries = (name: 'include' | 'exclude'): Combo[] => {
    if (!own(m, name)) return [];
    const list = m[name];
    if (!Array.isArray(list)) {
      d.error([...mp, name], 'bad-type', `${name} is a list of maps.`);
      return [];
    }
    const out: Combo[] = [];
    list.forEach((e, i) => {
      if (!isObj(e) || !Object.keys(e).length || !Object.keys(e).every((k) => NAME.test(k)) || !Object.values(e).every(isScalar)) d.error([...mp, name, i], 'bad-type', `Each ${name} entry is a map of key to one value.`);
      else out.push(e as Combo);
    });
    return out;
  };
  const def: MatrixDef = { axes, include: entries('include'), exclude: entries('exclude') };
  const combos = expandMatrix(def);
  if (combos.length === 0) d.error(mp, 'empty-matrix', 'This matrix has no combinations.', 'Give it at least one key with values, or an include.');
  if (combos.length > CI_LIMITS.matrixCombinations) d.error(mp, 'too-many', `This matrix makes ${combos.length} combinations; the most is ${CI_LIMITS.matrixCombinations}.`, 'Cut the lists, or exclude some.');
  let failFast = true;
  if (own(v, 'fail-fast')) {
    if (typeof v['fail-fast'] === 'boolean') failFast = v['fail-fast'];
    else d.error([...path, 'fail-fast'], 'bad-type', 'fail-fast is true or false.');
  }
  let maxParallel: number | null = null;
  if (own(v, 'max-parallel')) {
    const n = v['max-parallel'];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8) maxParallel = n;
    else d.error([...path, 'max-parallel'], 'bad-type', 'max-parallel is a whole number from 1 to 8.');
  }
  return combos.length && combos.length <= CI_LIMITS.matrixCombinations ? { matrix: def, combos, failFast, maxParallel } : null;
}

function readArtifacts(d: Diags, v: unknown, path: readonly PathSeg[]): PJob['artifacts'] {
  if (v === undefined) return null;
  if (!isObj(v)) {
    d.error(path, 'bad-type', 'artifacts is a map: { paths: [...] }.');
    return null;
  }
  checkKeys(d, v, path, ['paths', 'expire', 'when']);
  if (!own(v, 'paths')) {
    d.error(path, 'missing-key', 'artifacts needs `paths`.', 'For example: artifacts: { paths: [dist/**] }');
    return null;
  }
  const paths = globsOf(d, v.paths, [...path, 'paths']).filter((g, i) => {
    if (!relativePath(g)) {
      d.error([...path, 'paths', i], 'bad-path', `${JSON.stringify(g)} leaves the checkout.`, 'Paths are relative to the checkout, with no `..`.');
      return false;
    }
    return true;
  });
  if (paths.length === 0 || paths.length > 50) d.error([...path, 'paths'], 'bad-type', 'List one to 50 paths.');
  let expireDays: number = CI_LIMITS.artifactExpireDays;
  if (own(v, 'expire')) {
    const m = typeof v.expire === 'string' ? /^(\d{1,3})d$/.exec(v.expire) : null;
    if (m && Number(m[1]) >= 1) expireDays = Number(m[1]);
    else d.error([...path, 'expire'], 'bad-duration', `${JSON.stringify(v.expire)} is not a number of days.`, 'Write 7d.');
  }
  let when: 'success' | 'always' = 'success';
  if (own(v, 'when')) {
    if (v.when === 'success' || v.when === 'always') when = v.when;
    else d.error([...path, 'when'], 'bad-type', '`when` is success or always.');
  }
  return { paths, expireDays, when };
}

function readJob(d: Diags, id: string, raw: unknown, scopeBase: { inputs: Set<string>; env: Set<string> }): PJob | null {
  const path = ['jobs', id];
  if (!isObj(raw)) {
    d.error(path, 'bad-type', 'A job is a map with `steps`.', 'For example: test: { steps: [{ run: npm test }] }');
    return null;
  }
  checkKeys(d, raw, path, JOB_KEYS, FOREIGN_JOB);
  for (const key of Object.keys(NOT_YET)) if (own(raw, key)) d.error([...path, key], 'not-yet', NOT_YET[key]!, undefined, 'key');
  const runsOn = own(raw, 'runs-on') ? runsOnOf(d, raw['runs-on'], [...path, 'runs-on']) : null;
  const hidden = id.startsWith('.');
  const secrets = secretsOf(d, raw.secrets, [...path, 'secrets']);
  const strategy = strategyOf(d, raw.strategy, [...path, 'strategy']);
  const matrixKeys = new Set(strategy ? strategy.combos.flatMap((c) => Object.keys(c)) : []);
  const jobEnv = envOf(d, raw.env, [...path, 'env'], { inputs: scopeBase.inputs, env: scopeBase.env, matrix: matrixKeys });
  const scope: Scope = { inputs: scopeBase.inputs, env: new Set([...scopeBase.env, ...Object.keys(jobEnv)]), matrix: matrixKeys };
  const steps: PStep[] = [];
  if (!own(raw, 'steps')) {
    if (!hidden) d.error(path, 'missing-key', 'A job needs `steps`.', 'For example: steps: [{ run: npm test }]');
  } else if (!Array.isArray(raw.steps)) d.error([...path, 'steps'], 'bad-type', 'steps is a list.', 'Each item starts with "- run:".');
  else {
    if (raw.steps.length === 0 && !hidden) d.error([...path, 'steps'], 'empty', 'A job needs at least one step.');
    if (raw.steps.length > CI_LIMITS.stepsPerJob) d.error([...path, 'steps'], 'too-many', `A job has at most ${CI_LIMITS.stepsPerJob} steps.`);
    raw.steps.slice(0, CI_LIMITS.stepsPerJob).forEach((s, i) => {
      const step = readStep(d, s, [...path, 'steps', i], scope);
      if (step) steps.push(step);
    });
  }
  for (const name of secrets) if (name in jobEnv || scopeBase.env.has(name)) d.error([...path, 'secrets'], 'secret-env-clash', `${name} is also set in env.`, 'A secret\'s value comes from the workspace; remove it from env.');
  let needs: string[] = [];
  if (own(raw, 'needs')) {
    const n = raw.needs;
    if (typeof n === 'string') needs = [n];
    else if (Array.isArray(n) && n.every((x) => typeof x === 'string')) needs = n as string[];
    else d.error([...path, 'needs'], 'bad-type', 'needs is a job id or a list of job ids.');
  }
  return {
    id,
    hidden,
    name: own(raw, 'name') ? (typeof raw.name === 'string' ? interp(d, raw.name, [...path, 'name'], scope) : (d.error([...path, 'name'], 'bad-type', 'A job name is text.'), null)) : null,
    needs,
    cond: condOf(d, raw.if, [...path, 'if'], scope),
    timeoutMs: timeoutOf(d, raw, path),
    env: jobEnv,
    secrets,
    strategy,
    continueOnError: boolOf(d, raw, 'continue-on-error', path),
    steps,
    artifacts: readArtifacts(d, raw.artifacts, [...path, 'artifacts']),
    environment: environmentOf(d, raw.environment, [...path, 'environment']),
    runsOn,
  };
}

/** A runner label (T-557): lowercase, like a GitHub Actions self-hosted label. */
export const RUNNER_LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** Names GitHub uses for its own machines: a job that names only these runs in the workspace, as it always did. */
const HOSTED = /^(ubuntu|linux|workspace)(-[a-z0-9.]+)?$/;

/**
 * `runs-on` (T-557): a label or a list of labels. `self-hosted` is accepted and dropped (every runner is); GitHub's hosted names alone
 * (`ubuntu-latest`, `linux`) keep the old meaning: the repository's workspace, with a warning. Anything else picks a runner by labels.
 */
function runsOnOf(d: Diags, on: unknown, path: (string | number)[]): string[] | null {
  const list = typeof on === 'string' ? [on] : Array.isArray(on) && on.every((x) => typeof x === 'string') ? (on as string[]) : null;
  if (!list || !list.length) {
    d.error(path, 'bad-type', 'runs-on is a runner label or a list of labels.', 'For example: runs-on: [python, 8gb]');
    return null;
  }
  const labels = [...new Set(list.map((l) => l.trim().toLowerCase()).filter((l) => l && l !== 'self-hosted'))];
  if (!labels.length || labels.every((l) => HOSTED.test(l))) {
    if (!labels.includes('workspace')) d.add('warning', path, 'ignored-runs-on', 'runs-on has no effect: the job runs in the workspace.', 'Remove it, or name the labels of a runner.', 'key');
    return null;
  }
  const bad = labels.find((l) => !RUNNER_LABEL.test(l));
  if (bad) {
    d.error(path, 'bad-name', `"${bad}" is not a runner label.`, 'Lowercase letters, digits, ".", "-" and "_", at most 40 characters.');
    return null;
  }
  if (labels.length > CI_LIMITS.runnerLabels) {
    d.error(path, 'too-many', `runs-on names at most ${CI_LIMITS.runnerLabels} labels.`);
    return null;
  }
  return labels.sort();
}

/** The first cycle among the jobs' `needs`, as a path of ids; null when there is none. */
function findCycle(jobs: PJob[]): string[] | null {
  const by = new Map(jobs.map((j) => [j.id, j]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const n of by.get(id)?.needs ?? []) {
      if (!by.has(n)) continue;
      const c = visit(n);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const j of jobs) {
    const c = visit(j.id);
    if (c) return c;
  }
  return null;
}

/* ---------- The file ---------- */

const TOP_KEYS = ['name', 'on', 'env', 'timeout', 'timeout-minutes', 'concurrency', 'jobs'] as const;
const JOB_ID = /^\.?[a-z0-9][a-z0-9_-]{0,63}$/;

/** `.pilot/ci.yml` to `ci`. */
export const pipelineIdOf = (file: string): string => file.slice(file.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');

/** Whether a repository path is a pipeline file: directly in `.pilot/`, `.yml` or `.yaml`. */
export const isPipelineFile = (file: string): boolean => /^\.pilot\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.ya?ml$/.test(file);

/** What to try for the YAML mistakes agents make most: a command with `: ` or ` #` in it, tabs, a key twice. */
function yamlHint(message: string): { hint?: string } {
  if (/mapping (entry|values)|bad indentation/i.test(message)) return { hint: 'If this line is a shell command, text with ": " or " #" in it must be quoted, or written as a block: "run: |" and the command on the next lines.' };
  if (/duplicated/i.test(message)) return { hint: 'Each key can appear once in a map.' };
  if (/\\t|tab/i.test(message)) return { hint: 'Indent with spaces, not tabs.' };
  return {};
}

/** Reads one pipeline file. Never throws. */
export function validatePipeline(file: string, text: string): Validated {
  const id = pipelineIdOf(file);
  const info = (valid: boolean, diagnostics: CiDiagnostic[], extra: Partial<CiPipelineInfo> = {}): CiPipelineInfo => ({ file, name: id, valid, triggers: [], inputs: [], jobs: [], diagnostics, ...extra });
  if (text.length > CI_LIMITS.pipelineFileBytes) {
    const diagnostics: CiDiagnostic[] = [{ file, line: 0, column: 0, path: '', severity: 'error', code: 'too-large', message: `A pipeline file is at most ${CI_LIMITS.pipelineFileBytes / 1024} KiB.` }];
    return { pipeline: null, info: info(false, diagnostics) };
  }
  const parsed = parseYaml(text);
  if (!parsed.ok) {
    const diagnostics: CiDiagnostic[] = [{ file, line: parsed.place.line, column: parsed.place.column, path: '', severity: 'error', code: 'yaml-syntax', message: parsed.message, ...yamlHint(parsed.message) }];
    return { pipeline: null, info: info(false, diagnostics) };
  }
  const d = new Diags(file, parsed.doc);
  const root = parsed.doc.value;
  if (!isObj(root)) {
    d.error([], 'bad-type', 'A pipeline file is a map with `on` and `jobs`.', 'See docs/prd/local-git-ci.md section 9.');
    return { pipeline: null, info: info(false, d.list) };
  }
  checkKeys(d, root, [], TOP_KEYS, FOREIGN_TOP);

  const { on, inputs } = own(root, 'on') ? readOn(d, root.on) : (d.error([], 'missing-key', 'A pipeline needs `on`.', 'For example: on: { push: {} }'), { on: { push: null, merge: null, manual: null, notify: null }, inputs: [] as CiInput[] });
  const inputNames = new Set(inputs.map((i) => i.name));
  const env = envOf(d, root.env, ['env'], { inputs: inputNames, env: new Set(), matrix: new Set() });
  const envNames = new Set(Object.keys(env));
  const name = own(root, 'name') ? (typeof root.name === 'string' ? interp(d, root.name, ['name'], { inputs: inputNames, env: envNames, matrix: new Set() }) : (d.error(['name'], 'bad-type', 'A name is text.'), null)) : null;

  let concurrency: Pipeline['concurrency'] = null;
  if (own(root, 'concurrency')) {
    const c = root.concurrency;
    if (typeof c === 'string' || (isObj(c) && typeof c.group === 'string')) {
      if (isObj(c)) checkKeys(d, c, ['concurrency'], ['group', 'cancel-in-progress']);
      const group = interp(d, typeof c === 'string' ? c : (c as Obj).group, isObj(c) ? ['concurrency', 'group'] : ['concurrency'], { inputs: inputNames, env: envNames, matrix: new Set() });
      if (group) concurrency = { group, cancelInProgress: isObj(c) ? boolOf(d, c, 'cancel-in-progress', ['concurrency']) : false };
    } else d.error(['concurrency'], 'bad-type', 'concurrency is a group name, or { group, cancel-in-progress }.');
  }

  const jobs: PJob[] = [];
  if (!own(root, 'jobs')) d.error([], 'missing-key', 'A pipeline needs `jobs`.', 'For example: jobs: { test: { steps: [{ run: npm test }] } }');
  else if (!isObj(root.jobs) || !Object.keys(root.jobs).length) d.error(['jobs'], 'bad-type', 'jobs is a map of job id to job, with at least one job.');
  else {
    const ids = Object.keys(root.jobs);
    if (ids.length > CI_LIMITS.jobs) d.error(['jobs'], 'too-many', `A pipeline has at most ${CI_LIMITS.jobs} jobs.`);
    for (const jobId of ids.slice(0, CI_LIMITS.jobs)) {
      if (!JOB_ID.test(jobId)) {
        d.error(['jobs', jobId], 'bad-name', `"${jobId}" is not a job id.`, `Lowercase letters, digits, - and _${/[A-Z]/.test(jobId) ? `; try "${jobId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}"` : ''}.`, 'key');
        continue;
      }
      const job = readJob(d, jobId, (root.jobs as Obj)[jobId], { inputs: inputNames, env: envNames });
      if (job) jobs.push(job);
    }
    const known = new Set(jobs.filter((j) => !j.hidden).map((j) => j.id));
    for (const job of jobs) {
      job.needs.forEach((n, i) => {
        const raw = (root.jobs as Obj)[job.id] as Obj;
        const p = Array.isArray(raw.needs) ? ['jobs', job.id, 'needs', i] : ['jobs', job.id, 'needs'];
        if (n === job.id) d.error(p, 'needs-self', `${job.id} needs itself.`);
        else if (!known.has(n)) d.error(p, 'unknown-job', `There is no job "${n}".`, closest(n, [...known]) ? `Did you mean "${closest(n, [...known])}"?` : `Jobs: ${[...known].join(', ') || 'none'}.`);
      });
    }
    const cycle = findCycle(jobs.filter((j) => !j.hidden));
    if (cycle) d.error(['jobs', cycle[0]!, 'needs'], 'needs-cycle', `The jobs wait for each other: ${cycle.join(' > ')}.`);
    if (jobs.length && jobs.every((j) => j.hidden)) d.error(['jobs'], 'empty', 'Every job is hidden (starts with "."), so nothing would run.');
  }

  // One runner per run for now (T-557): every job that runs names the same labels, or none.
  const runnable = jobs.filter((j) => !j.hidden);
  const key = (j: PJob) => (j.runsOn ? j.runsOn.join(',') : '');
  const odd = runnable.find((j) => key(j) !== key(runnable[0]!));
  if (odd) d.error(['jobs', odd.id, 'runs-on'], 'runs-on-mixed', 'Every job of a pipeline runs on the same runner for now.', `Give every job the same runs-on (${runnable[0]!.runsOn ? `[${runnable[0]!.runsOn.join(', ')}]` : 'none'}), or split the pipeline.`, 'key');
  const runsOn = runnable[0]?.runsOn ?? null;

  const pipeline: Pipeline = { file, id, name, on, env, timeoutMs: timeoutOf(d, root, []), concurrency, runsOn, jobs };
  if (!(on.push || on.merge || on.manual) && !d.list.some((x) => x.path === 'on')) d.error(['on'], 'empty', 'on needs at least one trigger.', 'Choose from push, merge, manual.');
  const triggers = ON_KEYS.filter((k) => (k === 'schedule' ? false : on[k] !== null));
  const valid = d.errors === 0;
  return {
    pipeline: valid ? pipeline : null,
    info: info(valid, d.list, {
      name: typeof root.name === 'string' && !root.name.includes('${{') ? root.name.slice(0, 80) : id,
      triggers: triggers as CiPipelineInfo['triggers'],
      inputs,
      jobs: jobs.filter((j) => !j.hidden).map((j) => j.id),
    }),
  };
}

/* ---------- A commit's files ---------- */

export interface SnapshotFile {
  path: string;
  /** Null when the runner didn't read it. */
  text: string | null;
  skipped?: 'too_large' | 'symlink' | 'binary';
}

/** Reads every pipeline file of a commit. Problems that belong to no file (too many, name clashes) come back apart. */
export function validateFiles(files: readonly SnapshotFile[]): { pipelines: Validated[]; diagnostics: CiDiagnostic[] } {
  const diagnostics: CiDiagnostic[] = [];
  const candidates = files.filter((f) => isPipelineFile(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (candidates.length > CI_LIMITS.pipelineFiles) diagnostics.push({ file: '.pilot', line: 0, column: 0, path: '', severity: 'error', code: 'too-many', message: `At most ${CI_LIMITS.pipelineFiles} pipeline files are read; the rest are ignored.` });
  const pipelines: Validated[] = [];
  const seen = new Map<string, string>();
  for (const f of candidates.slice(0, CI_LIMITS.pipelineFiles)) {
    const id = pipelineIdOf(f.path);
    const clash = seen.get(id);
    if (clash) {
      const diag: CiDiagnostic = { file: f.path, line: 0, column: 0, path: '', severity: 'error', code: 'duplicate-pipeline', message: `${f.path} and ${clash} are both the pipeline "${id}".`, hint: 'Keep one.' };
      pipelines.push({ pipeline: null, info: { file: f.path, name: id, valid: false, triggers: [], inputs: [], jobs: [], diagnostics: [diag] } });
      continue;
    }
    seen.set(id, f.path);
    if (f.text === null) {
      const diag: CiDiagnostic = { file: f.path, line: 0, column: 0, path: '', severity: 'error', code: f.skipped ?? 'unreadable', message: f.skipped === 'too_large' ? `A pipeline file is at most ${CI_LIMITS.pipelineFileBytes / 1024} KiB.` : f.skipped === 'symlink' ? 'A pipeline file can\'t be a link.' : 'This file could not be read.' };
      pipelines.push({ pipeline: null, info: { file: f.path, name: id, valid: false, triggers: [], inputs: [], jobs: [], diagnostics: [diag] } });
      continue;
    }
    pipelines.push(validatePipeline(f.path, f.text));
  }
  return { pipelines, diagnostics };
}
