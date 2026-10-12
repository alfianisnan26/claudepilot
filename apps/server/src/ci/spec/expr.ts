// The expression language of pipeline files (PRD §9.5): `if:` conditions and `${{ }}` substitutions. It is closed on
// purpose: literals, a handful of operators, a handful of pure functions, and values the portal already holds. It runs in
// the portal before a run starts; nothing in it can reach a file, the network or the environment.

import type { PlanWhen } from '../plan.js';

export type Value = string | number | boolean | null;

export type Expr =
  | { t: 'lit'; v: Value; at: number }
  | { t: 'ref'; path: string[]; at: number }
  | { t: 'call'; name: string; args: Expr[]; at: number }
  | { t: 'not'; x: Expr; at: number }
  | { t: 'bin'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'; l: Expr; r: Expr; at: number };

/** A problem in an expression; `at` is an offset into the expression's own text. */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly at: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const MAX_LENGTH = 1000;
const MAX_DEPTH = 20;

/** `ci.<name>`: what the portal knows about the event (PRD §9.5). */
export const CI_CONTEXT = ['event', 'ref', 'branch', 'tag', 'sha', 'base', 'actor', 'repo', 'pipeline', 'ticket'] as const;
export const STATUS_FUNCTIONS = ['always', 'failure', 'success'] as const;
const FUNCTIONS: Record<string, [min: number, max: number]> = {
  contains: [2, 2],
  startsWith: [2, 2],
  endsWith: [2, 2],
  toLower: [1, 1],
  toUpper: [1, 1],
  format: [1, 20],
  always: [0, 0],
  failure: [0, 0],
  success: [0, 0],
};

/* ---------- Tokens ---------- */

type Tok = { t: 'num'; v: number; at: number } | { t: 'str'; v: string; at: number } | { t: 'id'; v: string; at: number } | { t: 'op'; v: string; at: number } | { t: 'end'; at: number };

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LENGTH) throw new ExprError(`An expression is at most ${MAX_LENGTH} characters.`, MAX_LENGTH);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === "'") {
      let v = '';
      const at = i++;
      for (;;) {
        if (i >= src.length) throw new ExprError('This string is never closed.', at, "End it with a '.");
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v, at });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(?:\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      out.push({ t: 'op', v: two, at: i });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>' || c === '!' || c === '(' || c === ')' || c === ',') {
      out.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    if (c === '=') throw new ExprError('A single = does nothing here.', i, 'Compare with ==.');
    if (c === '&' || c === '|') throw new ExprError(`A single ${c} does nothing here.`, i, `Use ${c}${c}.`);
    if (c === '"') throw new ExprError('Strings use single quotes.', i, "Write 'text'.");
    throw new ExprError(`Unexpected "${c}".`, i);
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

/* ---------- Parser ---------- */

class Parser {
  #i = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): Expr {
    const e = this.#or(0);
    const t = this.toks[this.#i]!;
    if (t.t !== 'end') throw new ExprError(`Unexpected ${describe(t)}.`, t.at, 'Join conditions with && or ||.');
    return e;
  }

  #peek(): Tok {
    return this.toks[this.#i]!;
  }

  #isOp(v: string): boolean {
    const t = this.#peek();
    return t.t === 'op' && t.v === v;
  }

  #or(depth: number): Expr {
    this.#depth(depth);
    let l = this.#and(depth);
    while (this.#isOp('||')) {
      const at = this.toks[this.#i++]!.at;
      l = { t: 'bin', op: '||', l, r: this.#and(depth), at };
    }
    return l;
  }

  #and(depth: number): Expr {
    let l = this.#eq(depth);
    while (this.#isOp('&&')) {
      const at = this.toks[this.#i++]!.at;
      l = { t: 'bin', op: '&&', l, r: this.#eq(depth), at };
    }
    return l;
  }

  #eq(depth: number): Expr {
    let l = this.#cmp(depth);
    while (this.#isOp('==') || this.#isOp('!=')) {
      const t = this.toks[this.#i++] as Tok & { t: 'op' };
      l = { t: 'bin', op: t.v as '==' | '!=', l, r: this.#cmp(depth), at: t.at };
    }
    return l;
  }

  #cmp(depth: number): Expr {
    let l = this.#unary(depth);
    while (this.#isOp('<') || this.#isOp('<=') || this.#isOp('>') || this.#isOp('>=')) {
      const t = this.toks[this.#i++] as Tok & { t: 'op' };
      l = { t: 'bin', op: t.v as '<' | '<=' | '>' | '>=', l, r: this.#unary(depth), at: t.at };
    }
    return l;
  }

  #unary(depth: number): Expr {
    this.#depth(depth);
    if (this.#isOp('!')) {
      const at = this.toks[this.#i++]!.at;
      return { t: 'not', x: this.#unary(depth + 1), at };
    }
    return this.#primary(depth);
  }

  #primary(depth: number): Expr {
    const t = this.toks[this.#i++]!;
    switch (t.t) {
      case 'num':
        return { t: 'lit', v: t.v, at: t.at };
      case 'str':
        return { t: 'lit', v: t.v, at: t.at };
      case 'id': {
        if (this.#isOp('(')) {
          if (t.v.includes('.')) throw new ExprError(`"${t.v}" is not a function.`, t.at);
          this.#i++;
          const args: Expr[] = [];
          if (!this.#isOp(')')) {
            for (;;) {
              args.push(this.#or(depth + 1));
              if (this.#isOp(',')) {
                this.#i++;
                continue;
              }
              break;
            }
          }
          if (!this.#isOp(')')) throw new ExprError('A ) is missing.', this.#peek().at);
          this.#i++;
          return { t: 'call', name: t.v, args, at: t.at };
        }
        if (t.v === 'true') return { t: 'lit', v: true, at: t.at };
        if (t.v === 'false') return { t: 'lit', v: false, at: t.at };
        if (t.v === 'null') return { t: 'lit', v: null, at: t.at };
        return { t: 'ref', path: t.v.split('.'), at: t.at };
      }
      case 'op':
        if (t.v === '(') {
          const e = this.#or(depth + 1);
          if (!this.#isOp(')')) throw new ExprError('A ) is missing.', this.#peek().at);
          this.#i++;
          return e;
        }
        throw new ExprError(`Unexpected "${t.v}".`, t.at);
      case 'end':
        throw new ExprError('The expression ends too soon.', t.at);
    }
  }

  #depth(depth: number) {
    if (depth > MAX_DEPTH) throw new ExprError('This expression is nested too deeply.', this.#peek().at);
  }
}

function describe(t: Tok): string {
  if (t.t === 'end') return 'end';
  if (t.t === 'str') return `string '${t.v}'`;
  return `"${t.v}"`;
}

/** Parses an expression. Throws {@link ExprError} with the offset of the problem. */
export function parseExpr(src: string): Expr {
  return new Parser(tokenize(src)).parse();
}

/* ---------- Checking ---------- */

/** What names an expression may use where it stands. */
export interface Scope {
  inputs: ReadonlySet<string>;
  env: ReadonlySet<string>;
  matrix: ReadonlySet<string>;
}

const closest = (name: string, options: readonly string[]): string | null => {
  let best: string | null = null;
  let bestDistance = 3;
  for (const o of options) {
    const d = distance(name.toLowerCase(), o.toLowerCase());
    if (d < bestDistance) {
      best = o;
      bestDistance = d;
    }
  }
  return best;
};

/** Levenshtein distance, for "did you mean". */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

export { closest };

/** Every problem with the names an expression uses (it is not evaluated). */
export function checkExpr(e: Expr, scope: Scope): ExprError[] {
  const out: ExprError[] = [];
  const walk = (x: Expr) => {
    switch (x.t) {
      case 'lit':
        return;
      case 'ref': {
        const [head, name, ...rest] = x.path;
        if (head === 'ci') {
          if (!name || !(CI_CONTEXT as readonly string[]).includes(name) || rest.length)
            out.push(new ExprError(`"${x.path.join('.')}" is not a value of ci.`, x.at, hintFor(name ?? '', CI_CONTEXT, 'ci')));
        } else if (head === 'inputs') {
          if (!name || rest.length || !scope.inputs.has(name))
            out.push(new ExprError(`"${x.path.join('.')}" is not an input of this pipeline.`, x.at, scope.inputs.size ? hintFor(name ?? '', [...scope.inputs], 'inputs') : 'Declare it under on.manual.inputs.'));
        } else if (head === 'env') {
          if (!name || rest.length || !scope.env.has(name)) out.push(new ExprError(`"${x.path.join('.')}" is not set in env here.`, x.at, 'Only variables the pipeline, the job or the step declares in env are known.'));
        } else if (head === 'matrix') {
          if (!name || rest.length || !scope.matrix.has(name)) out.push(new ExprError(`"${x.path.join('.')}" is not a matrix key of this job.`, x.at));
        } else out.push(new ExprError(`"${x.path.join('.')}" is not a known name.`, x.at, `Start with ci, inputs, env or matrix${closest(head ?? '', ['ci', 'inputs', 'env', 'matrix']) ? `; did you mean ${closest(head ?? '', ['ci', 'inputs', 'env', 'matrix'])}?` : '.'}`));
        return;
      }
      case 'call': {
        const spec = FUNCTIONS[x.name];
        if (!spec) {
          out.push(new ExprError(`"${x.name}" is not a function here.`, x.at, `Use one of: ${Object.keys(FUNCTIONS).join(', ')}.`));
        } else if (x.args.length < spec[0] || x.args.length > spec[1]) {
          out.push(new ExprError(`${x.name}() takes ${spec[0] === spec[1] ? spec[0] : `${spec[0]} to ${spec[1]}`} argument${spec[1] === 1 ? '' : 's'}.`, x.at));
        }
        x.args.forEach(walk);
        return;
      }
      case 'not':
        walk(x.x);
        return;
      case 'bin':
        walk(x.l);
        walk(x.r);
        return;
    }
  };
  walk(e);
  return out;
}

function hintFor(name: string, options: readonly string[], prefix: string): string {
  const near = closest(name, options);
  return near ? `Did you mean ${prefix}.${near}?` : `Use ${options.map((o) => `${prefix}.${o}`).join(', ')}.`;
}

/* ---------- Evaluating ---------- */

/** Finds a value by its path; undefined for a name that isn't known (the checker has already refused those). */
export type Lookup = (path: string[]) => Value | undefined;

export const truthy = (v: Value): boolean => v !== null && v !== false && v !== '' && v !== 0;

const text = (v: Value): string => (v === null ? '' : String(v));

function equal(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === typeof b) return a === b;
  return String(a) === String(b);
}

function order(a: Value, b: Value): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a);
  const y = Number(b);
  return a !== null && b !== null && a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) ? x - y : null;
}

/** Evaluates an expression with no status functions in it. Throws {@link ExprError} for one that slipped through. */
export function evalExpr(e: Expr, get: Lookup): Value {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'ref': {
      const v = get(e.path);
      if (v === undefined) throw new ExprError(`"${e.path.join('.')}" has no value.`, e.at);
      return v;
    }
    case 'not':
      return !truthy(evalExpr(e.x, get));
    case 'bin': {
      if (e.op === '&&') return truthy(evalExpr(e.l, get)) && truthy(evalExpr(e.r, get));
      if (e.op === '||') return truthy(evalExpr(e.l, get)) || truthy(evalExpr(e.r, get));
      const l = evalExpr(e.l, get);
      const r = evalExpr(e.r, get);
      if (e.op === '==') return equal(l, r);
      if (e.op === '!=') return !equal(l, r);
      const o = order(l, r);
      if (o === null) return false;
      return e.op === '<' ? o < 0 : e.op === '<=' ? o <= 0 : e.op === '>' ? o > 0 : o >= 0;
    }
    case 'call': {
      const args = e.args.map((a) => evalExpr(a, get));
      const [a = null, b = null] = args;
      switch (e.name) {
        case 'contains':
          return text(a).includes(text(b));
        case 'startsWith':
          return text(a).startsWith(text(b));
        case 'endsWith':
          return text(a).endsWith(text(b));
        case 'toLower':
          return text(a).toLowerCase();
        case 'toUpper':
          return text(a).toUpperCase();
        case 'format':
          return text(a).replace(/\{(\d{1,2})\}/g, (m, n: string) => (Number(n) + 1 < args.length ? text(args[Number(n) + 1]!) : m));
        default:
          throw new ExprError(`${e.name}() can't be used here.`, e.at, 'always(), failure() and success() decide when a job or step runs: use one as a term joined with &&.');
      }
    }
  }
}

/* ---------- Status functions ---------- */

const isStatus = (e: Expr): e is Extract<Expr, { t: 'call' }> => e.t === 'call' && (STATUS_FUNCTIONS as readonly string[]).includes(e.name);

function hasStatus(e: Expr): boolean {
  switch (e.t) {
    case 'call':
      return (STATUS_FUNCTIONS as readonly string[]).includes(e.name) || e.args.some(hasStatus);
    case 'not':
      return hasStatus(e.x);
    case 'bin':
      return hasStatus(e.l) || hasStatus(e.r);
    default:
      return false;
  }
}

/**
 * Splits a condition into when it runs (from always(), failure() or success(), which must be terms joined with `&&` at
 * the top) and the rest, which is decided before the run. Throws {@link ExprError} when a status function is used any
 * other way: it would need a runtime the runner doesn't have.
 */
export function splitCondition(e: Expr): { when: PlanWhen; rest: Expr | null } {
  const terms: Expr[] = [];
  const flatten = (x: Expr) => {
    if (x.t === 'bin' && x.op === '&&') {
      flatten(x.l);
      flatten(x.r);
    } else terms.push(x);
  };
  flatten(e);
  let when: PlanWhen = 'success';
  let seen: string | null = null;
  const rest: Expr[] = [];
  for (const t of terms) {
    if (isStatus(t)) {
      if (t.args.length) throw new ExprError(`${t.name}() takes no arguments.`, t.at);
      if (seen && seen !== t.name) throw new ExprError(`${seen}() and ${t.name}() can't be used together.`, t.at, 'A job or step runs on one of success, failure or always.');
      seen = t.name;
      when = t.name === 'always' ? 'always' : t.name === 'failure' ? 'failure' : 'success';
    } else rest.push(t);
  }
  for (const t of rest) {
    if (hasStatus(t)) throw new ExprError('always(), failure() and success() can only be a term joined with && at the top of a condition.', e.at, 'Write failure() && ci.branch == \'main\', not !failure() or failure() || ....');
  }
  const joined = rest.length ? rest.reduce((l, r) => ({ t: 'bin', op: '&&', l, r, at: r.at })) : null;
  return { when, rest: joined };
}

/* ---------- ${{ }} in text ---------- */

export type Interp = (string | Expr)[];

export const hasInterp = (src: string): boolean => src.includes('${{');

/**
 * Splits `text ${{ expr }} text` into its parts. An expression's offsets are relative to its own text; `at` on an
 * error is the offset of the `${{` it is in. A `${{` with no `}}` is an error.
 */
export function parseInterp(src: string): { parts: Interp; errors: { error: ExprError; at: number }[] } {
  const parts: Interp = [];
  const errors: { error: ExprError; at: number }[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('${{', i);
    if (open < 0) {
      parts.push(src.slice(i));
      break;
    }
    if (open > i) parts.push(src.slice(i, open));
    // The end is the first `}}` outside a quoted string.
    let j = open + 3;
    let quoted = false;
    let close = -1;
    for (; j < src.length; j++) {
      if (src[j] === "'") quoted = !quoted;
      else if (!quoted && src[j] === '}' && src[j + 1] === '}') {
        close = j;
        break;
      }
    }
    if (close < 0) {
      errors.push({ error: new ExprError('This ${{ is never closed.', 0, 'End it with }}.'), at: open });
      break;
    }
    try {
      parts.push(parseExpr(src.slice(open + 3, close)));
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      errors.push({ error: e, at: open + 3 + e.at });
    }
    i = close + 2;
  }
  return { parts, errors };
}

/** The text with every `${{ }}` replaced by its value (null is empty). */
export function renderInterp(parts: Interp, get: Lookup): string {
  return parts.map((p) => (typeof p === 'string' ? p : text(evalExpr(p, get)))).join('');
}

/** The names used by every expression in the parts, checked. */
export function checkInterp(parts: Interp, scope: Scope): ExprError[] {
  return parts.flatMap((p) => (typeof p === 'string' ? [] : checkExpr(p, scope).concat(hasStatus(p) ? [new ExprError('always(), failure() and success() decide when a job or step runs; they have no value to put in text.', p.at)] : [])));
}

/** The text of an `if:` with a `${{ }}` wrapper taken off (GitHub's style); null when it has `${{` anywhere else. */
export function unwrapIf(src: string): string | null {
  const t = src.trim();
  if (!hasInterp(t)) return t;
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(t);
  if (!m || hasInterp(m[1]!) || m[1]!.includes('}}')) return null;
  return m[1]!;
}
