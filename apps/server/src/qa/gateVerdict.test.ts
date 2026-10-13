// scripts/gate-verdict.sh (T-37): the one reading of a gate's result, for the pipeline's gate, the in-cluster gate Job and scripts/gate-job.sh.
// Fixture logs are written as scripts/gate.sh leaves them; the script runs for real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/gate-verdict.sh', import.meta.url));
const verdict = (...args: string[]) => {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  return { code: r.status, out: r.stdout.trim() };
};

/** A logs folder as scripts/gate.sh leaves it: the summary lines and the server suite's log. */
function logs(summary: string[], suite?: string): string {
  const dir = join(tempDirectory('cp-verdict-'), 'gate.logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SUMMARY.txt'), summary.map((l) => `${l}\n`).join(''));
  if (suite !== undefined) writeFileSync(join(dir, 'server-suite.log'), suite);
  return dir;
}
const ALL_OK = ['npm-ci rc=0 12s', 'typecheck rc=0 54s', 'web-build rc=0 39s', 'server-suite rc=0 1449s'];

test('logs: every step at rc=0 and the last suite summary at 0 failing and 0 timed out is green', () => {
  assert.deepEqual(verdict('logs', logs(ALL_OK, '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n')), { code: 0, out: 'GATE-VERDICT: green' });
});

test('logs: the rerun alone decides (the last summary), and says which files passed only alone', () => {
  const dir = logs([...ALL_OK, 'server-suite-rerun: passed alone: src/connect/hub.test.ts'], '# tests 2475\n# fail 1\n# cancelled 0\nnot ok 972 - the control stream\n# tests 22\n# fail 0\n# cancelled 0\n');
  const v = verdict('logs', dir);
  assert.equal(v.code, 0);
  assert.deepEqual(v.out.split('\n'), ['note: server-suite-rerun: passed alone: src/connect/hub.test.ts', 'GATE-VERDICT: green']);
});

test('logs: a file that passed only alone is reported as flaky, with the tests that failed in the full run (T-95)', () => {
  const dir = logs([...ALL_OK, 'server-suite-rerun: passed alone: src/notify/pipeline.test.ts', 'server-suite-flaky: a deploy that waits for a person'], '# fail 1\n# fail 0\n# cancelled 0\n');
  const v = verdict('logs', dir);
  assert.equal(v.code, 0);
  assert.deepEqual(v.out.split('\n'), ['note: server-suite-rerun: passed alone: src/notify/pipeline.test.ts', 'note: flaky, passed on rerun: a deploy that waits for a person', 'GATE-VERDICT: green']);
});

test('failures: each failing test with its own report, the passing ones left out (T-95: the run log showed only "not ok")', () => {
  const f = join(tempDirectory('cp-verdict-'), 'suite.log');
  writeFileSync(
    f,
    [
      'ok 1 - fine',
      '  ---',
      '  duration_ms: 1',
      '  ...',
      '# Subtest: a deploy that waits',
      'not ok 2 - a deploy that waits',
      '  ---',
      "  error: 'Expected values to be strictly equal'",
      "  expected: 'held'",
      "  actual: 'sent'",
      '  stack: |-',
      '    TestContext.<anonymous> (src/notify/pipeline.test.ts:126:12)',
      '  ...',
      'ok 3 - after',
      '  ---',
      '  ...',
      '# fail 1',
    ].join('\n'),
  );
  const out = verdict('failures', f).out;
  assert.match(out, /^not ok 2 - a deploy that waits$/m);
  assert.match(out, /expected: 'held'\n\s+actual: 'sent'/);
  assert.match(out, /pipeline\.test\.ts:126:12/);
  assert.doesNotMatch(out, /ok 1 - fine|ok 3 - after|# fail/);
});

test('logs: red for a failed step, failing or timed-out tests, a suite with no summary, or no summary at all', () => {
  assert.deepEqual(verdict('logs', logs(['npm-ci rc=0 1s', 'typecheck rc=2 50s', 'web-build rc=0 1s', 'server-suite rc=0 1s'], '# fail 0\n')), { code: 1, out: 'GATE-VERDICT: red: typecheck failed' });
  assert.deepEqual(verdict('logs', logs(['npm-ci rc=1 1s'])), { code: 1, out: 'GATE-VERDICT: red: npm-ci failed' });
  assert.match(verdict('logs', logs(ALL_OK, '# fail 0\n# cancelled 0\n# fail 2\n# cancelled 0\n')).out, /red: the server suite has 2 failing and 0 timed-out tests/);
  assert.match(verdict('logs', logs(ALL_OK, '# fail 0\n# cancelled 1\n')).out, /red: the server suite has 0 failing and 1 timed-out tests/);
  assert.match(verdict('logs', logs(ALL_OK, 'killed\n')).out, /red: the server suite has an unknown number of failing/);
  assert.deepEqual(verdict('logs', join(tempDirectory('cp-verdict-'), 'none')), { code: 1, out: 'GATE-VERDICT: red: the gate left no summary' });
});

test('logs: only the steps asked for count (a typecheck and web build Job has no suite)', () => {
  const dir = logs(['npm-ci rc=0 1s', 'typecheck rc=0 50s', 'web-build rc=0 30s']);
  assert.deepEqual(verdict('logs', dir, 'typecheck,web-build'), { code: 0, out: 'GATE-VERDICT: green' });
  assert.equal(verdict('logs', dir).code, 1, 'the whole gate needs the suite');
});

test('joblog: the last verdict line of a Job’s log; none is red', () => {
  const file = (text: string) => {
    const f = join(tempDirectory('cp-verdict-'), 'job.log');
    writeFileSync(f, text);
    return f;
  };
  assert.deepEqual(verdict('joblog', file('=== SUMMARY\nnpm-ci rc=0 1s\nGATE-VERDICT: green\n')), { code: 0, out: 'GATE-VERDICT: green' });
  assert.deepEqual(verdict('joblog', file('GATE-VERDICT: green\nGATE-VERDICT: red: typecheck failed\n')), { code: 1, out: 'GATE-VERDICT: red: typecheck failed' });
  assert.deepEqual(verdict('joblog', file('npm ERR! 401\n')), { code: 1, out: 'GATE-VERDICT: red: the job gave no verdict' });
  assert.deepEqual(verdict('joblog', '/nonexistent/job.log'), { code: 1, out: 'GATE-VERDICT: red: the job gave no verdict' });
  assert.equal(verdict('nonsense').code, 2);
});
