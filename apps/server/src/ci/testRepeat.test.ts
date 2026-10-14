import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// scripts/test-repeat.sh (T-324): a command run N times, beside busy loops if asked; one result line, one line per failed run, exit 1 on any.
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/test-repeat.sh');
const run = (args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

test('every run passes: one result line, exit 0', () => {
  const r = run(['-n', '4', '--', 'true']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^repeat runs=4 pass=4 fail=0 skipped=0 hogs=0 cpus=\d+ load=/);
});

test('a run that fails is counted and named, the exit code is 1; --grep shows a measured number per run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-repeat-'));
  try {
    // every second run fails: a counter file in a temporary folder
    const flaky = `n=$(cat ${dir}/n 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${dir}/n; echo "measured $n MB/s"; [ $((n % 2)) -eq 1 ] || { echo "not ok 1 - run $n"; exit 1; }`;
    const r = run(['-n', '4', '--grep', '[0-9]+ MB/s', '--', 'bash', '-c', flaky]);
    assert.equal(r.status, 1);
    const lines = r.stdout.trim().split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('run ') && l.includes('failed')).map((l) => l.split(':')[0]), ['run 2 failed', 'run 4 failed']);
    assert.deepEqual(lines.filter((l) => /^run \d: \d MB\/s$/.test(l)), ['run 1: 1 MB/s', 'run 2: 2 MB/s', 'run 3: 3 MB/s', 'run 4: 4 MB/s']);
    assert.match(lines.at(-1)!, /^repeat runs=4 pass=2 fail=2 skipped=0 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skipped test is counted apart; hogs run and are stopped; bad input is refused', () => {
  const r = run(['-n', '2', '--hogs', '1', '--', 'echo', '# skipped 1']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /repeat runs=2 pass=2 fail=0 skipped=2 hogs=1 /);
  assert.equal(run(['-n', 'x', '--', 'true']).status, 2);
  assert.equal(run(['--hogs', '-1', '--', 'true']).status, 2);
  assert.equal(run([]).status, 2);
});
