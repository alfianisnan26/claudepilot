import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkExpr, evalExpr, ExprError, hasInterp, parseExpr, parseInterp, renderInterp, splitCondition, unwrapIf, type Lookup, type Value } from './expr.js';
import { compile, globMatches, matches, resolveInputs, replan, type EventContext } from './compile.js';
import { expandMatrix } from './matrix.js';
import { isPipelineFile, parseDuration, validateFiles, validatePipeline } from './validate.js';
import { parseYaml } from './yaml.js';

const EXAMPLE = `# .pilot/ci.yml
name: CI
on:
  push: { branches: ['**'] }
  merge: { branches: [main] }
  manual:
    inputs:
      target: { type: choice, options: [staging, production], default: staging }
env:
  NODE_ENV: test
jobs:
  test:
    timeout: 15m
    steps:
      - run: npm ci
      - name: Unit tests
        run: npm test
      - name: Build
        run: npm run build
    artifacts:
      paths: [dist/**]
  deploy:
    needs: [test]
    if: ci.event == 'merge' && ci.branch == 'main'
    steps:
      - name: Deploy
        run: ./.pilot/scripts/deploy.sh "$PILOT_BRANCH"
`;

const ctx = (over: Partial<EventContext> = {}): EventContext => ({
  event: 'push',
  ref: 'refs/heads/ticket/12-login',
  sha: 'a'.repeat(40),
  base: null,
  actor: 'push',
  repo: 'app',
  ticket: 'T-12',
  inputs: {},
  workspace: 'docker/dev',
  runId: 'r1abc234',
  runNumber: 7,
  ...over,
});

const lookup =
  (values: Record<string, Value>): Lookup =>
  (path) =>
    values[path.join('.')];

const codes = (file: string, text: string) => validatePipeline(file, text).info.diagnostics.map((d) => `${d.severity}:${d.code}`);

/* ---------- Expressions ---------- */

test('expressions: literals, operators, contexts and the pure functions', () => {
  const get = lookup({ 'ci.branch': 'main', 'ci.ref': 'refs/heads/main', 'inputs.n': 3, 'inputs.on': true, 'ci.ticket': '' });
  const ev = (src: string) => evalExpr(parseExpr(src), get);
  assert.equal(ev("ci.branch == 'main'"), true);
  assert.equal(ev("ci.branch != 'main'"), false);
  assert.equal(ev("ci.branch == 'main' && inputs.on"), true);
  assert.equal(ev("ci.branch == 'dev' || inputs.n >= 3"), true);
  assert.equal(ev('!inputs.on'), false);
  assert.equal(ev('inputs.n == "3"'.replace(/"/g, "'")), true, 'a number equals its text');
  assert.equal(ev("startsWith(ci.ref, 'refs/heads/')"), true);
  assert.equal(ev("contains(toUpper(ci.branch), 'AI')"), true);
  assert.equal(ev("endsWith(ci.branch, 'in')"), true);
  assert.equal(ev("format('{0}-{1}', ci.branch, inputs.n)"), 'main-3');
  assert.equal(ev("'it''s' == 'it''s'"), true);
  assert.equal(ev('ci.ticket'), '');
  assert.equal(ev('null == null'), true);
  assert.equal(ev("(ci.branch == 'a' || ci.branch == 'main') && !(inputs.n < 2)"), true);
});

test('expressions: mistakes name the character and what to write', () => {
  const err = (src: string): ExprError => {
    try {
      parseExpr(src);
    } catch (e) {
      return e as ExprError;
    }
    throw new Error(`no error for ${src}`);
  };
  assert.match(err("ci.branch = 'main'").hint ?? '', /==/);
  assert.match(err('ci.branch == "main"').message, /single quotes/);
  assert.match(err("ci.branch == 'main").message, /never closed/);
  assert.match(err('a && ').message, /ends too soon/);
  assert.match(err('a & b').hint ?? '', /&&/);
  assert.equal(err('(a == 1').message, 'A ) is missing.');
  assert.equal(err('a'.repeat(1001)).message.includes('at most'), true);
  assert.match(err('('.repeat(40) + 'a' + ')'.repeat(40)).message, /nested too deeply/);
});

test('expressions: the names an expression may use are checked, with suggestions', () => {
  const scope = { inputs: new Set(['target']), env: new Set(['NODE_ENV']), matrix: new Set<string>() };
  const check = (src: string) => checkExpr(parseExpr(src), scope).map((e) => `${e.message} | ${e.hint ?? ''}`);
  assert.deepEqual(check("ci.branch == 'x' && inputs.target == 'a' && env.NODE_ENV"), []);
  assert.match(check('ci.brnch')[0]!, /Did you mean ci\.branch/);
  assert.match(check('inputs.targt')[0]!, /Did you mean inputs\.target/);
  assert.match(check('env.OTHER')[0]!, /not set in env/);
  assert.match(check('github.ref')[0]!, /Start with ci/);
  assert.match(check('matrix.os')[0]!, /not a matrix key/);
  assert.match(check("regex(ci.branch, 'x')")[0]!, /not a function/);
  assert.match(check('contains(ci.branch)')[0]!, /takes 2 arguments/);
});

test('conditions: status functions are only terms joined with && and become `when`', () => {
  const split = (src: string) => splitCondition(parseExpr(src));
  assert.deepEqual(split('always()').when, 'always');
  assert.equal(split('always()').rest, null);
  const f = split("failure() && ci.branch == 'main'");
  assert.equal(f.when, 'failure');
  assert.ok(f.rest);
  assert.equal(split("ci.branch == 'main'").when, 'success');
  assert.equal(split("success() && ci.branch == 'main' && ci.ticket != ''").rest !== null, true);
  for (const bad of ['!failure()', "failure() || ci.branch == 'x'", 'failure() && always()', "contains(always(), 'x')"]) {
    assert.throws(() => split(bad), ExprError, bad);
  }
});

test('${{ }} in text: parts, rendering, and an unclosed one', () => {
  const get = lookup({ 'ci.sha': 'abc', 'inputs.t': 'prod' });
  const { parts, errors } = parseInterp('build-${{ ci.sha }}-${{ inputs.t }}!');
  assert.equal(errors.length, 0);
  assert.equal(renderInterp(parts, get), 'build-abc-prod!');
  assert.equal(hasInterp('plain'), false);
  assert.equal(parseInterp('a ${{ ci.sha').errors.length, 1);
  assert.equal(parseInterp("${{ format('}}', 1) }}").errors.length, 0, '}} inside a string does not end it');
  assert.equal(unwrapIf("${{ ci.branch == 'x' }}"), " ci.branch == 'x' ");
  assert.equal(unwrapIf("ci.branch == 'x'"), "ci.branch == 'x'");
  assert.equal(unwrapIf("a ${{ b }} c"), null);
});

/* ---------- YAML ---------- */

test('yaml: values and where things are in the text', () => {
  const text = 'name: CI\njobs:\n  test:\n    steps:\n      - run: npm ci\n      - run: npm test\n';
  const r = parseYaml(text);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.doc.where(['jobs', 'test', 'steps', 1, 'run']), { line: 6, column: 14 });
  assert.deepEqual(r.doc.where(['jobs', 'test', 'steps', 1, 'run'], 'key'), { line: 6, column: 9 });
  assert.deepEqual(r.doc.where(['jobs', 'nope', 'x']), { line: 3, column: 3 }, 'the nearest part that exists');
});

test('yaml: syntax errors, duplicates, empty and multi-document files say where and why', () => {
  const bad = parseYaml('a: [1, 2\nb: 3\n');
  assert.ok(!bad.ok);
  if (!bad.ok) assert.equal(bad.place.line, 2);
  const dup = parseYaml('a: 1\na: 2\n');
  assert.ok(!dup.ok);
  if (!dup.ok) assert.match(dup.message, /duplicated/);
  const empty = parseYaml('# nothing\n');
  assert.ok(!empty.ok);
  const multi = parseYaml('a: 1\n---\nb: 2\n');
  assert.ok(!multi.ok);
  if (!multi.ok) assert.match(multi.message, /One document/);
});

test('yaml: an alias bomb and deep nesting are refused, merges work', () => {
  const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 0; i < 40; i++) lines.push(`b${i}: [*a, *a, *a, *a]`);
  assert.ok(!parseYaml(lines.join('\n')).ok, 'more aliases than the limit');
  assert.ok(!parseYaml('['.repeat(60) + ']'.repeat(60)).ok, 'nesting beyond the limit');
  const merged = parseYaml('base: &b { x: 1 }\nuse:\n  <<: *b\n  y: 2\n');
  assert.ok(merged.ok);
  if (merged.ok) assert.deepEqual((merged.doc.value as { use: unknown }).use, { x: 1, y: 2 });
});

/* ---------- The pipeline format ---------- */

test('the example pipeline of the PRD is valid and reads as written', () => {
  const v = validatePipeline('.pilot/ci.yml', EXAMPLE);
  assert.deepEqual(v.info.diagnostics, []);
  assert.equal(v.info.valid, true);
  assert.equal(v.info.name, 'CI');
  assert.deepEqual(v.info.triggers, ['push', 'merge', 'manual']);
  assert.deepEqual(v.info.jobs, ['test', 'deploy']);
  assert.deepEqual(v.info.inputs.map((i) => [i.name, i.type, i.default, i.options]), [['target', 'choice', 'staging', ['staging', 'production']]]);
  assert.equal(v.pipeline?.id, 'ci');
  assert.equal(v.pipeline?.jobs[0]?.timeoutMs, 15 * 60_000);
  assert.equal(v.pipeline?.jobs[0]?.steps.length, 3);
});

test('the shapes agents carry over from GitHub and GitLab get a specific message', () => {
  const run = (yml: string) => validatePipeline('.pilot/x.yml', yml).info.diagnostics;
  const one = (yml: string, code: string) => {
    const d = run(yml).find((x) => x.code === code);
    assert.ok(d, `${code} in ${JSON.stringify(run(yml))}`);
    return d;
  };
  assert.match(one('on: push\njobs:\n  a:\n    steps:\n      - script: x\n', 'unsupported-key').hint ?? '', /run/);
  assert.match(one('on: push\njobs:\n  a:\n    script: [x]\n', 'unsupported-key').hint ?? '', /steps/);
  assert.match(one('on: push\nstages: [a]\njobs:\n  a:\n    steps: [{run: x}]\n', 'unsupported-key').hint ?? '', /needs/);
  assert.match(one('on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n', 'no-remote-actions').hint ?? '', /workspace/);
  assert.match(one('on: push\njobs:\n  a:\n    steps:\n      - uses: actions/upload-artifact@v4\n', 'no-remote-actions').hint ?? '', /artifacts/);
  assert.match(one('on: push\njobs:\n  a:\n    steps:\n      - uses: someone/their-action@main\n', 'no-remote-actions').message, /not available/);
  assert.match(one('on: pull_request\njobs:\n  a:\n    steps: [{run: x}]\n', 'unsupported-trigger').hint ?? '', /merge/);
  assert.match(one('on: workflow_dispatch\njobs:\n  a:\n    steps: [{run: x}]\n', 'unsupported-trigger').hint ?? '', /manual/);
  assert.match(one('on: push\njobs:\n  a:\n    allow_failure: true\n    steps: [{run: x}]\n', 'unsupported-key').hint ?? '', /continue-on-error/);
  assert.match(one('on: push\njobs:\n  a:\n    steps: [{run: "echo ${{ ci.branch }}"}]\n', 'no-interpolation-in-run').hint ?? '', /PILOT_BRANCH/);
  assert.equal(one('on: push\njobs:\n  a:\n    runs-on: macos-latest\n    steps: [{run: x}]\n', 'unsupported-runner').severity, 'error');
  assert.equal(one('on: push\njobs:\n  a:\n    steps: [{uses: actions/checkout@v4}, {run: x}]\n', 'ignored-checkout').severity, 'warning');
  assert.equal(one('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: x}]\n', 'ignored-runs-on').severity, 'warning');
});

test('mistakes: unknown keys suggest the nearest, durations and names say what to write', () => {
  const d = (yml: string, code: string) => validatePipeline('.pilot/x.yml', yml).info.diagnostics.find((x) => x.code === code);
  assert.match(d('on: push\njobs:\n  a:\n    timout: 5m\n    steps: [{run: x}]\n', 'unknown-key')?.hint ?? '', /timeout/);
  assert.match(d('on: push\njobs:\n  a:\n    timeout: 15\n    steps: [{run: x}]\n', 'bad-duration')?.hint ?? '', /15m/);
  assert.equal(d('on: push\njobs:\n  a:\n    timeout: 7h\n    steps: [{run: x}]\n', 'timeout-too-long')?.severity, 'error');
  assert.equal(d('on: push\njobs:\n  a:\n    timeout: 5m\n    timeout-minutes: 5\n    steps: [{run: x}]\n', 'duplicate-timeout')?.severity, 'error');
  assert.match(d('on: push\njobs:\n  Build:\n    steps: [{run: x}]\n', 'bad-name')?.hint ?? '', /build/);
  assert.match(d('on: push\nenv:\n  PILOT_X: 1\njobs:\n  a:\n    steps: [{run: x}]\n', 'reserved-name')?.message ?? '', /PILOT_/);
  assert.match(d('on: push\njobs:\n  a:\n    steps: [{name: only a name}]\n', 'missing-key')?.hint ?? '', /only a name/);
  assert.equal(d('on: push\njobs:\n  a:\n    steps: [{run: x, working-directory: ../etc}]\n', 'bad-path')?.severity, 'error');
  assert.equal(d('on: push\njobs:\n  a:\n    steps: [{run: x}]\n    artifacts: { paths: [/etc/passwd] }\n', 'bad-path')?.severity, 'error');
  assert.equal(d('on: push\njobs:\n  a:\n    if: ci.brnch == 1\n    steps: [{run: x}]\n', 'unknown-name')?.severity, 'error');
  assert.equal(d('on: push\njobs:\n  a:\n    if: ci.branch = 1\n    steps: [{run: x}]\n', 'bad-expression')?.severity, 'error');
  assert.equal(d('on: push\njobs:\n  a:\n    steps: []\n', 'empty')?.severity, 'error');
  assert.equal(d('on: push\n', 'missing-key')?.severity, 'error');
  assert.equal(d('jobs:\n  a:\n    steps: [{run: x}]\n', 'missing-key')?.severity, 'error');
  assert.equal(d('on: []\njobs:\n  a:\n    steps: [{run: x}]\n', 'empty')?.severity, 'error');
});

test('needs: unknown jobs, self reference and cycles are named', () => {
  const d = (needs: string) => validatePipeline('.pilot/x.yml', `on: push\njobs:\n  a:\n    needs: ${needs}\n    steps: [{run: x}]\n  b:\n    needs: [a]\n    steps: [{run: x}]\n`).info.diagnostics;
  assert.ok(d('[zzz]').some((x) => x.code === 'unknown-job'));
  assert.ok(d('a').some((x) => x.code === 'needs-self'));
  const cycle = d('[b]').find((x) => x.code === 'needs-cycle');
  assert.match(cycle?.message ?? '', /a > b > a|b > a > b/);
});

test('secrets: names only, checked for shape, never also in env', () => {
  const d = (yml: string) => validatePipeline('.pilot/x.yml', yml).info.diagnostics.map((x) => `${x.severity}:${x.code}`);
  assert.deepEqual(d('on: push\njobs:\n  a:\n    secrets: [NPM_TOKEN, GH_TOKEN]\n    steps: [{run: x}]\n'), []);
  assert.deepEqual(d('on: push\njobs:\n  a:\n    secrets: NPM_TOKEN\n    steps: [{run: x}]\n'), ['error:bad-type']);
  assert.deepEqual(d('on: push\njobs:\n  a:\n    secrets: [lower-case, PILOT_X, 5]\n    steps: [{run: x}]\n'), ['error:bad-name', 'error:bad-name', 'error:bad-name']);
  assert.deepEqual(d('on: push\njobs:\n  a:\n    secrets: [A, A]\n    steps: [{run: x}]\n'), ['error:duplicate']);
  assert.deepEqual(d('on: push\nenv: { T: x }\njobs:\n  a:\n    secrets: [T]\n    steps: [{run: x}]\n'), ['error:secret-env-clash']);
  const ok = validatePipeline('.pilot/x.yml', 'on: push\njobs:\n  a:\n    secrets: [NPM_TOKEN]\n    steps: [{run: x}]\n').pipeline!;
  assert.deepEqual(ok.jobs[0]!.secrets, ['NPM_TOKEN']);
  const plan = compile(ok, ctx(), { maxParallel: 1 });
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(plan.plan.jobs[0]!.secrets, ['NPM_TOKEN']);
});

test('matrix: the product, exclude and include as GitHub does them; the size is limited when the file is read', () => {
  const combos = (m: object) => expandMatrix({ axes: {}, include: [], exclude: [], ...m });
  assert.deepEqual(combos({ axes: { os: ['a', 'b'], n: [1, 2] } }).map((c) => `${c.os}${c.n}`), ['a1', 'a2', 'b1', 'b2']);
  assert.deepEqual(combos({ axes: { os: ['a', 'b'], n: [1, 2] }, exclude: [{ os: 'b', n: 1 }] }).map((c) => `${c.os}${c.n}`), ['a1', 'a2', 'b2']);
  assert.deepEqual(combos({ axes: { os: ['a', 'b'] }, include: [{ os: 'a', extra: 'x' }] }), [{ os: 'a', extra: 'x' }, { os: 'b' }], 'an include that fits adds its other keys to the combination it matches');
  assert.deepEqual(combos({ axes: { os: ['a'] }, include: [{ os: 'z', only: 1 }] }), [{ os: 'a' }, { os: 'z', only: 1 }], 'one that fits none is a combination of its own');
  assert.deepEqual(combos({ include: [{ a: 1 }, { a: 2 }] }), [{ a: 1 }, { a: 2 }], 'a matrix of only includes');
  const d = (yml: string) => validatePipeline('.pilot/x.yml', yml).info.diagnostics.map((x) => `${x.severity}:${x.code}`);
  const job = (strategy: string) => `on: push\njobs:\n  a:\n    strategy: ${strategy}\n    steps: [{run: x}]\n`;
  assert.deepEqual(d(job('{ matrix: { node: [20, 22], os: [linux] } }')), []);
  assert.deepEqual(d(job('{ matrix: { node: 20 } }')), ['error:bad-type', 'error:empty-matrix']);
  assert.deepEqual(d(job('{ matrix: { node: [] } }')), ['error:bad-type', 'error:empty-matrix']);
  assert.deepEqual(d(job('{ matrix: { n: [1,2,3,4,5,6], m: [1,2,3,4,5,6] } }')), ['error:too-many'], '36 combinations');
  assert.deepEqual(d(job('{ fail-fast: false }')), ['error:missing-key']);
  assert.deepEqual(d(job('{ matrix: { n: [1] }, fail-fast: maybe, max-parallel: 99 }')), ['error:bad-type', 'error:bad-type']);
  assert.deepEqual(d(job('{ matrix: { n: [1] }, parallel: 2 }')), ['error:unsupported-key']);
  assert.deepEqual(d(job('{ matrix: { "bad key": [1] } }')), ['error:bad-name', 'error:empty-matrix']);
  // matrix.* is known inside the job, and nowhere else.
  assert.deepEqual(d('on: push\njobs:\n  a:\n    strategy: { matrix: { os: [a] } }\n    if: matrix.os == \'a\'\n    env: { OS: "${{ matrix.os }}" }\n    steps:\n      - if: matrix.os != \'b\'\n        run: x\n'), []);
  assert.deepEqual(d('on: push\njobs:\n  a:\n    steps: [{run: x}]\n  b:\n    if: matrix.os == \'a\'\n    steps: [{run: x}]\n'), ['error:unknown-name']);
});

test('matrix: one job per combination, needs wait for all of them, names say which, the context decides conditions', () => {
  const p = pipelineOf(
    [
      'on: push',
      'jobs:',
      '  test:',
      '    name: Test',
      '    strategy:',
      '      matrix:',
      '        node: [20, 22]',
      '        os: [linux, mac]',
      '        exclude: [{ node: 20, os: mac }]',
      '      fail-fast: false',
      '      max-parallel: 2',
      '    if: matrix.os == \'linux\' || matrix.node == 22',
      '    env: { NODE: "${{ matrix.node }}" }',
      '    steps:',
      '      - name: "on ${{ matrix.os }}"',
      '        run: echo "$NODE"',
      '  report:',
      '    needs: [test]',
      '    steps: [{ run: echo done }]',
      '',
    ].join('\n'),
  );
  const c = compile(p, ctx(), { maxParallel: 4 });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.deepEqual(c.plan.jobs.map((j) => j.id), ['test-m1', 'test-m2', 'test-m3', 'report']);
  assert.deepEqual(c.plan.jobs.slice(0, 3).map((j) => j.name), ['Test (20, linux)', 'Test (22, linux)', 'Test (22, mac)']);
  assert.deepEqual(c.plan.jobs.slice(0, 3).map((j) => j.env.NODE), ['20', '22', '22']);
  assert.deepEqual(c.plan.jobs.slice(0, 3).map((j) => j.steps[0]!.name), ['on linux', 'on linux', 'on mac']);
  assert.deepEqual(c.plan.jobs[3]!.needs, ['test-m1', 'test-m2', 'test-m3']);
  assert.deepEqual(c.plan.jobs[0]!.group, { id: 'test', failFast: false, maxParallel: 2 });
  assert.equal(c.plan.jobs[3]!.group, null);
});

test('not-yet features are errors until they are built, schedules included', () => {
  const got = codes('.pilot/x.yml', 'on:\n  schedule: [{cron: "0 3 * * *"}]\njobs:\n  a:\n    environment: prod\n    extends: .base\n    steps: [{run: x}]\n');
  assert.equal(got.filter((c) => c === 'error:not-yet').length, 2, 'environment is built (FR41)');
});

test('environment: a name or { name, url }; it reaches the plan, and no approval gate comes from the file', () => {
  const ok = validatePipeline('.pilot/deploy.yml', 'on: manual\njobs:\n  a:\n    environment: production\n    steps: [{run: x}]\n  b:\n    environment: { name: staging, url: "https://x.example" }\n    steps: [{run: x}]\n');
  assert.deepEqual(ok.info.diagnostics, []);
  assert.deepEqual(ok.pipeline!.jobs.map((j) => j.environment), ['production', 'staging']);
  const c = compile(ok.pipeline!, { event: 'manual', ref: 'refs/heads/main', sha: 'a'.repeat(40), base: null, actor: 'ui', repo: 'app', ticket: null, inputs: {}, workspace: 'docker/x', runId: 'rabc123', runNumber: 1 }, { maxParallel: 2 });
  assert.ok(c.ok);
  if (c.ok) assert.deepEqual(c.plan.jobs.map((j) => [j.environment, j.approval]), [['production', null], ['staging', null]]);
  assert.deepEqual(codes('.pilot/d.yml', 'on: manual\njobs:\n  a:\n    environment: Production!\n    steps: [{run: x}]\n'), ['error:bad-environment']);
  assert.deepEqual(codes('.pilot/d.yml', 'on: manual\njobs:\n  a:\n    environment: { name: prod, gate: x }\n    steps: [{run: x}]\n'), ['error:unknown-key']);
});

test('diagnostics carry the line and column of the key or value, and a syntax error says where', () => {
  const v = validatePipeline('.pilot/ci.yml', 'on: push\njobs:\n  test:\n    steps:\n      - run: npm ci\n        timout: 5m\n');
  const d = v.info.diagnostics.find((x) => x.code === 'unknown-key')!;
  assert.deepEqual([d.line, d.column, d.path], [6, 9, 'jobs.test.steps[0].timout']);
  const bad = validatePipeline('.pilot/ci.yml', 'on: push\njobs: [\n');
  assert.equal(bad.info.diagnostics[0]?.code, 'yaml-syntax');
  assert.equal(bad.pipeline, null);
  assert.equal(validatePipeline('.pilot/ci.yml', 'x'.repeat(200_000)).info.diagnostics[0]?.code, 'too-large');
  assert.equal(validatePipeline('.pilot/ci.yml', '- a\n- b\n').info.diagnostics[0]?.code, 'bad-type');
  // The commonest mistake of all: a shell command with ": " in it, unquoted.
  const colon = validatePipeline('.pilot/ci.yml', 'on: push\njobs:\n  a:\n    steps:\n      - run: echo "error: boom" >&2\n').info.diagnostics[0]!;
  assert.deepEqual([colon.code, colon.line], ['yaml-syntax', 5]);
  assert.match(colon.hint ?? '', /quoted, or written as a block/);
});

test('a commit\'s files: only .pilot/*.yml directly are pipelines; clashes and unreadable files are reported', () => {
  assert.equal(isPipelineFile('.pilot/ci.yml'), true);
  assert.equal(isPipelineFile('.pilot/ci.yaml'), true);
  assert.equal(isPipelineFile('.pilot/steps/x.yml'), false);
  assert.equal(isPipelineFile('.pilot/scripts/deploy.sh'), false);
  assert.equal(isPipelineFile('other/ci.yml'), false);
  const ok = 'on: push\njobs:\n  a:\n    steps: [{run: x}]\n';
  const { pipelines } = validateFiles([
    { path: '.pilot/ci.yml', text: ok },
    { path: '.pilot/ci.yaml', text: ok },
    { path: '.pilot/big.yml', text: null, skipped: 'too_large' },
    { path: '.pilot/steps/x.yml', text: 'ignored' },
  ]);
  assert.deepEqual(pipelines.map((p) => [p.info.file, p.info.valid]), [['.pilot/big.yml', false], ['.pilot/ci.yaml', true], ['.pilot/ci.yml', false]]);
  assert.equal(pipelines[2]?.info.diagnostics[0]?.code, 'duplicate-pipeline');
});

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('15'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('m'), null);
});

/* ---------- From pipeline and event to plan ---------- */

const pipelineOf = (yml: string) => {
  const v = validatePipeline('.pilot/ci.yml', yml);
  assert.ok(v.pipeline, JSON.stringify(v.info.diagnostics));
  return v.pipeline;
};

test('which pipelines an event starts', () => {
  const p = pipelineOf('on:\n  push: { branches: [main, "release/*"], tags: ["v*"] }\n  merge: { branches: [main] }\njobs:\n  a:\n    steps: [{run: x}]\n');
  const on = (event: EventContext['event'], ref: string) => matches(p, { event, ref });
  assert.equal(on('push', 'refs/heads/main'), true);
  assert.equal(on('push', 'refs/heads/release/1.0'), true);
  assert.equal(on('push', 'refs/heads/release/1.0/x'), false, '* stays inside one segment');
  assert.equal(on('push', 'refs/heads/feature'), false);
  assert.equal(on('push', 'refs/tags/v1.2'), true);
  assert.equal(on('push', 'refs/tags/x1'), false);
  assert.equal(on('merge', 'refs/heads/main'), true);
  assert.equal(on('manual', 'refs/heads/x'), false);
  const onlyMerge = pipelineOf('on: { merge: { branches: [main] } }\njobs:\n  a:\n    steps: [{run: x}]\n');
  assert.equal(matches(onlyMerge, { event: 'push', ref: 'refs/heads/main' }), false);
  assert.equal(matches(onlyMerge, { event: 'merge', ref: 'refs/heads/main' }), true);
  assert.equal(matches(onlyMerge, { event: 'merge', ref: 'refs/heads/dev' }), false);
  const plain = pipelineOf('on: push\njobs:\n  a:\n    steps: [{run: x}]\n');
  assert.equal(matches(plain, { event: 'push', ref: 'refs/heads/anything/at/all' }), true);
  assert.equal(matches(plain, { event: 'merge', ref: 'refs/heads/main' }), true, 'a protected branch that moved is also a push to it');
  assert.equal(matches(plain, { event: 'push', ref: 'refs/tags/v1' }), false, 'no tags unless asked for');
  assert.equal(matches(pipelineOf('on: manual\njobs:\n  a:\n    steps: [{run: x}]\n'), { event: 'manual', ref: 'refs/heads/x' }), true);
  assert.equal(globMatches(['**'], 'a/b/c'), true);
  assert.equal(globMatches(['a/**/c'], 'a/c'), true);
  assert.equal(globMatches(['a?'], 'ab'), true);
});

test('compile: the example becomes a plan with the contract variables, conditions decided and artifacts kept', () => {
  const p = pipelineOf(EXAMPLE);
  const feature = compile(p, ctx(), { maxParallel: 2 });
  assert.ok(feature.ok);
  if (!feature.ok) return;
  const plan = feature.plan;
  assert.equal(plan.runId, 'r1abc234');
  assert.equal(plan.pipeline, 'ci');
  assert.equal(plan.env.PILOT_BRANCH, 'ticket/12-login');
  assert.equal(plan.env.PILOT_TICKET, 'T-12');
  assert.equal(plan.env.PILOT_SHA_SHORT, 'aaaaaaa');
  assert.equal(plan.env.NODE_ENV, 'test');
  assert.equal(plan.env.CI, 'true');
  assert.equal(plan.maxParallel, 2);
  assert.deepEqual(plan.jobs.map((j) => [j.id, j.skip, j.needs, j.when]), [['test', null, [], 'success'], ['deploy', 'condition', ['test'], 'success']]);
  assert.deepEqual(plan.jobs[0]!.steps.map((s) => s.name), ['npm ci', 'Unit tests', 'Build']);
  assert.deepEqual(plan.jobs[0]!.artifacts, { paths: ['dist/**'], expireDays: 14, when: 'success' });
  assert.equal(plan.jobs[0]!.timeoutMs, 900_000);
  const merged = compile(p, ctx({ event: 'merge', ref: 'refs/heads/main', ticket: null }), { maxParallel: 2 });
  assert.ok(merged.ok);
  if (merged.ok) assert.equal(merged.plan.jobs[1]!.skip, null, 'the deploy runs on a merge into main');
  assert.equal(JSON.stringify(plan).includes('${{'), false, 'nothing dynamic is left in the plan');
});

test('compile: status functions become `when`, env and names are substituted, branch names never reach shell text', () => {
  const p = pipelineOf(
    [
      'on: { push: {}, manual: { inputs: { who: { default: world } } } }',
      'env: { GREETING: "hello ${{ inputs.who }}" }',
      'concurrency: { group: "ci-${{ ci.branch }}", cancel-in-progress: true }',
      'jobs:',
      '  build:',
      '    name: "Build ${{ ci.sha }}"',
      '    env: { LEVEL: "${{ env.GREETING }}!" }',
      '    steps:',
      '      - run: make',
      '      - name: report',
      '        if: failure() && ci.event == \'push\'',
      '        run: echo "$PILOT_BRANCH"',
      '      - run: skipped',
      '        if: ci.branch == \'nope\'',
      '  clean:',
      '    needs: [build]',
      '    if: always()',
      '    steps: [{run: rm -rf tmp}]',
      '',
    ].join('\n'),
  );
  const c = compile(p, ctx({ ref: 'refs/heads/x"; rm -rf /; "', inputs: { who: 'there' } }), { maxParallel: 1 });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.equal(c.group, 'ci-x"; rm -rf /; "', 'a group is a name, not a command');
  assert.equal(c.cancelInProgress, true);
  assert.equal(c.plan.env.GREETING, 'hello there');
  assert.equal(c.plan.jobs[0]!.name, `Build ${'a'.repeat(40)}`);
  assert.equal(c.plan.jobs[0]!.env.LEVEL, 'hello there!');
  assert.deepEqual(c.plan.jobs[0]!.steps.map((s) => [s.when, s.skip]), [['success', null], ['failure', null], ['success', 'condition']]);
  assert.equal(c.plan.jobs[0]!.steps[1]!.run, 'echo "$PILOT_BRANCH"');
  assert.equal(c.plan.jobs[1]!.when, 'always');
});

test('manual inputs: given values are checked, defaults and required work', () => {
  const p = pipelineOf('on:\n  manual:\n    inputs:\n      env: { type: choice, options: [a, b], default: a }\n      debug: { type: boolean }\n      note: { required: true }\njobs:\n  x:\n    steps: [{run: x}]\n');
  const inputs = p.on.manual!.inputs;
  assert.deepEqual(resolveInputs(inputs, { note: 'hi' }), { values: { env: 'a', debug: false, note: 'hi' }, problems: {} });
  assert.deepEqual(resolveInputs(inputs, { note: 'hi', debug: 'true', env: 'b' }).values, { env: 'b', debug: true, note: 'hi' });
  const bad = resolveInputs(inputs, { env: 'c', extra: 1 });
  assert.deepEqual(Object.keys(bad.problems).sort(), ['env', 'extra', 'note']);
  const c = compile(p, ctx({ event: 'manual', inputs: { env: 'b', debug: true, note: 'hi' } }), { maxParallel: 1 });
  assert.ok(c.ok);
  if (c.ok) assert.equal(c.plan.env.PILOT_INPUT_ENV, 'b');
});

test('replan gives a rerun its own id and number', () => {
  const c = compile(pipelineOf('on: push\njobs:\n  a:\n    steps: [{run: x}]\n'), ctx(), { maxParallel: 1 });
  assert.ok(c.ok);
  if (!c.ok) return;
  const again = replan(c.plan, 'r2zzz999', 8);
  assert.equal(again.runId, 'r2zzz999');
  assert.equal(again.env.PILOT_RUN_NUMBER, '8');
  assert.equal(c.plan.runId, 'r1abc234', 'the first plan is unchanged');
});
