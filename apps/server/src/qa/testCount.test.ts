// T-2890: a test file whose report stops part way exits 0, and node's summary only counts fewer tests: the gate stayed green while
// lab/scorecard.test.ts lost up to 17 of its 34 tests (scripts/gate.sh ran the suite with --test-force-exit). scripts/test-count-reporter.mjs
// counts, per file, the tests registered against the tests reported; scripts/gate.sh and scripts/gate-verdict.sh turn a short file red.
// The reporter runs for real on a synthetic suite: a whole file and a MUTANT that ends its process after its second test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const REPORTER = repo('scripts/test-count-reporter.mjs');

/** Runs node --test on files written into a fresh folder, the gate's way (TAP to stdout, the counts to a file). */
function suite(files: Record<string, string>) {
  const dir = tempDirectory('cp-testcount-');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const counts = join(dir, 'counts.txt');
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${counts}`, ...Object.keys(files)],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 60_000 },
  );
  const tests = /^# tests (\d+)$/m.exec(r.stdout)?.[1];
  return { code: r.status, out: r.stdout, tests: tests === undefined ? null : Number(tests), counts: readFileSync(counts, 'utf8').trim().split('\n') };
}

const WHOLE = `import { test } from 'node:test';
test('one', () => {});
test('two, skipped', { skip: true }, () => {});
test('three, todo', { todo: true }, () => {});
test('four, fails', () => { throw new Error('red'); });
`;
// The mutant: the process ends after its second test, as a forced exit under load did; tests three to five never report.
const STOPS = `import { test } from 'node:test';
test('one', () => {});
test('two, ends the process', () => { setImmediate(() => process.exit(0)); });
test('three', async () => { await new Promise((r) => setTimeout(r, 1000)); });
test('four', () => {});
test('five', () => {});
`;

test('a whole file: every registered test is reported (a skip, a todo and a failure count), no short line', () => {
  const r = suite({ 'whole.test.mjs': WHOLE });
  assert.equal(r.tests, 4);
  assert.deepEqual(r.counts, ['total files=1 registered=4 reported=4']);
});

test('the mutant: node counts fewer tests and fails nothing about it; the reporter names the file short of its count', () => {
  const r = suite({ 'whole.test.mjs': WHOLE.replace("test('four, fails', () => { throw new Error('red'); });\n", ''), 'stops.test.mjs': STOPS });
  // node alone: no failing test, the missing three are simply not in the total. This is the hole the guard closes.
  assert.match(r.out, /^# fail 0$/m, 'node reports no failure for the lost tests');
  assert.ok(r.tests !== null && r.tests < 8, `node counted ${r.tests} of 8`);
  const short = r.counts.filter((l) => l.startsWith('short '));
  assert.equal(short.length, 1, r.counts.join('\n'));
  assert.match(short[0]!, /^short stops\.test\.mjs registered=5 reported=[0-4]$/);
  assert.match(r.counts.at(-1)!, /^total files=2 registered=8 reported=[3-7]$/);
});

test('gate-verdict: a short file in the summary is red and names it, whatever the suite totals say', () => {
  const dir = join(tempDirectory('cp-testcount-v-'), 'gate.logs');
  mkdirSync(dir, { recursive: true });
  const ok = ['npm-ci rc=0 1s', 'typecheck rc=0 1s', 'web-build rc=0 1s', 'web-tests rc=0 1s'];
  writeFileSync(join(dir, 'server-suite.log'), '# tests 4623\n# pass 4595\n# fail 0\n# cancelled 0\n');
  const verdict = () => spawnSync('bash', [repo('scripts/gate-verdict.sh'), 'logs', dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  writeFileSync(join(dir, 'SUMMARY.txt'), [...ok, 'server-suite rc=0 1s', 'server-suite-count: total files=2 registered=40 reported=40', ''].join('\n'));
  assert.deepEqual([verdict().status, verdict().stdout.trim()], [0, 'GATE-VERDICT: green']);
  writeFileSync(
    join(dir, 'SUMMARY.txt'),
    [...ok, 'server-suite rc=1 1s', 'server-suite-short: src/lab/scorecard.test.ts registered=34 reported=17', ''].join('\n'),
  );
  const v = verdict();
  assert.equal(v.status, 1);
  assert.equal(v.stdout.trim(), 'GATE-VERDICT: red: a test file reported fewer tests than it registered: src/lab/scorecard.test.ts registered=34 reported=17');
});

test('gate.sh: the server suite and its rerun run without --test-force-exit, and the first run carries the count reporter', () => {
  const gate = readFileSync(repo('scripts/gate.sh'), 'utf8');
  const runs = gate.split('\n').filter((l) => /node --import tsx --test /.test(l));
  assert.equal(runs.length, 2, 'the suite and the rerun');
  for (const l of runs) assert.doesNotMatch(l, /--test-force-exit/);
  assert.match(gate, /--test-reporter="\$dir\/scripts\/test-count-reporter\.mjs" --test-reporter-destination="\$counts"/);
  assert.match(runs[0]!, /"\$\{report\[@\]\}"/);
});
