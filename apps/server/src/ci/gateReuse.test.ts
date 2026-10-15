// T-578: the reuse of a green gate verdict (scripts/gate-reuse.mjs) and the per-file progress reporter (scripts/gate-progress-reporter.mjs).
// The decision is pure: same tree, green, from a gate Job, under 24 h reuses; every other case runs the gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = `${REPO}scripts/gate-reuse.mjs`;
interface Rec { source: string; job: string; verdict: string; commit: string; tree: string; steps: string; files: string; finished: number }
const reuse = (await import(pathToFileURL(SCRIPT).href)) as {
  decideGateReuse: (text: string, o: { tree: string; now: number }) => { reuse: boolean; why?: string; record?: Rec };
  parseGateResult: (log: string, e: { commit: string; tree: string }) => { ok: boolean; why?: string; record?: Rec };
  FULL_STEPS: string;
};
const reporter = (await import(pathToFileURL(`${REPO}scripts/gate-progress-reporter.mjs`).href)) as {
  progressLines: (e: { type: string; data: Record<string, unknown> }, files: Map<string, unknown>, now: number) => string[];
  summaryLines: (files: Map<string, unknown>) => string[];
};

const hex = (c: string) => c.repeat(40);
const NOW = 1_800_000_000;
const rec = (over: Partial<Rec> = {}): Rec => ({ source: 'gate-job', job: 'claudepilot-gate-abc1234-9f0a', verdict: 'green', commit: hex('a'), tree: hex('b'), steps: reuse.FULL_STEPS, files: '', finished: NOW - 3600, ...over });
const decide = (r: unknown, tree = hex('b'), now = NOW) => reuse.decideGateReuse(typeof r === 'string' ? r : JSON.stringify(r), { tree, now });

test('the same tree, green, from a gate Job, under 24 h: reuse (another commit of the same tree too)', () => {
  const d = decide(rec());
  assert.equal(d.reuse, true);
  assert.equal(d.record!.job, 'claudepilot-gate-abc1234-9f0a');
  assert.equal(decide(rec({ commit: hex('c') })).reuse, true, 'the tree decides, not the commit');
  assert.equal(decide(rec({ finished: NOW - 24 * 3600 })).reuse, true, 'exactly 24 h is still inside');
});

test('every doubt runs the gate: another tree, red, older than 24 h, unreadable, empty, forged source, subset, future', () => {
  const run = (r: unknown, tree?: string) => { const d = decide(r, tree); assert.equal(d.reuse, false, JSON.stringify(r)); return d.why; };
  assert.match(run(rec(), hex('d'))!, /another tree/);
  assert.match(run(rec({ verdict: 'red' }))!, /not green/);
  assert.match(run(rec({ finished: NOW - 24 * 3600 - 1 }))!, /older than 24 h/);
  assert.match(run('{not json')!, /unreadable/);
  assert.match(run('')!, /no verdict stored/);
  assert.match(run(rec({ source: 'branch' }))!, /did not come from a gate Job/);
  assert.match(run(rec({ source: 'file' }))!, /did not come from a gate Job/);
  assert.match(run(rec({ job: 'my-forged-job' }))!, /names no gate Job/);
  assert.match(run(rec({ steps: 'typecheck' }))!, /not of the whole gate/);
  assert.match(run(rec({ files: 'src/a.test.ts' }))!, /file subset/);
  assert.match(run(rec({ finished: NOW + 3600 }))!, /future/);
  assert.match(run(rec({ finished: 'x' as unknown as number }))!, /finish time/);
  assert.match(run('[]')!, /not an object/);
  assert.match(run(rec({ tree: 'short' }), 'short')!, /no tree/);
  assert.equal(reuse.decideGateReuse(JSON.stringify(rec()), { tree: hex('b'), now: Number.NaN }).reuse, false, 'no clock');
});

test('the record comes from the LAST GATE-RESULT line of the Job log, for the commit and tree asked for', () => {
  const good = `GATE-RESULT ${JSON.stringify(rec())}`;
  const expect = { commit: hex('a'), tree: hex('b') };
  assert.equal(reuse.parseGateResult(`x\n${good}\n`, expect).ok, true);
  assert.match(reuse.parseGateResult('GATE-VERDICT: green\n', expect).why!, /no GATE-RESULT/);
  assert.match(reuse.parseGateResult('GATE-RESULT nope\n', expect).why!, /not JSON/);
  assert.match(reuse.parseGateResult(good, { commit: hex('c'), tree: hex('b') }).why!, /another commit/);
  assert.match(reuse.parseGateResult(good, { commit: hex('a'), tree: hex('c') }).why!, /another tree/);
  const forged = `GATE-RESULT ${JSON.stringify(rec({ source: 'branch' }))}`;
  assert.equal(reuse.parseGateResult(`${good}\n${forged}\n`, expect).ok, false, 'a later forged line wins over an earlier good one: closed');
  assert.equal(reuse.parseGateResult(`  ${good}\n`, expect).ok, false, 'only a line that starts with GATE-RESULT counts');
});

test('the command line: decide prints reuse or run with the reason and exits 0 or 1; record prints the JSON', () => {
  const sh = (args: string[], input: string) => spawnSync('node', [SCRIPT, ...args], { input, encoding: 'utf8' });
  const ok = sh(['decide', '--tree', hex('b'), '--now', String(NOW)], JSON.stringify(rec()));
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(`^reuse claudepilot-gate-abc1234-9f0a ${hex('a')} ${hex('b')} \\d{4}-`));
  const no = sh(['decide', '--tree', hex('c'), '--now', String(NOW)], JSON.stringify(rec()));
  assert.equal(no.status, 1);
  assert.match(no.stdout, /^run: the stored verdict is of another tree/);
  assert.equal(sh(['decide', '--tree', hex('b')], '').status, 1, 'nothing stored: run');
  const r = sh(['record', '--commit', hex('a'), '--tree', hex('b')], `GATE-RESULT ${JSON.stringify(rec())}\n`);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), rec());
  assert.equal(sh(['record', '--commit', hex('a'), '--tree', hex('b')], 'GATE-VERDICT: green\n').status, 1);
});

test('the progress reporter: a start line per file, FAIL and slow lines, a summary per file', () => {
  const files = new Map();
  const ev = (type: string, name: string, ms: number, file = `${process.cwd()}/src/a.test.ts`) => ({ type, data: { name, file, details: { duration_ms: ms } } });
  assert.deepEqual(reporter.progressLines(ev('test:pass', 'fast', 20), files, 1000), ['progress: start src/a.test.ts']);
  assert.deepEqual(reporter.progressLines(ev('test:pass', 'slow one', 7300), files, 8300), ['progress: slow src/a.test.ts slow one 7.3s']);
  assert.deepEqual(reporter.progressLines(ev('test:fail', 'broken\n  test', 90), files, 9000), ['progress: FAIL src/a.test.ts broken test 0.1s']);
  assert.deepEqual(reporter.progressLines({ type: 'test:start', data: {} }, files, 9000), [], 'other events say nothing');
  assert.deepEqual(reporter.progressLines(ev('test:pass', 'b1', 5, `${process.cwd()}/src/b.test.ts`), files, 9100), ['progress: start src/b.test.ts']);
  assert.deepEqual(reporter.summaryLines(files), ['progress: file src/a.test.ts pass=2 fail=1 8.0s', 'progress: file src/b.test.ts pass=1 fail=0 0.0s']);
});
