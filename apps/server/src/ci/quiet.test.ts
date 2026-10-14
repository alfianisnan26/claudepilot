import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// scripts/quiet.sh: the full output goes to a log, the context gets one line (and the tail on failure); the exit code is the command's.
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/quiet.sh');
const run = (args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
const logOf = (out: string) => /log=(\S+)/.exec(out)?.[1] ?? '';

test('success prints one line and keeps the whole output in the log', () => {
  const r = run(['--', 'bash', '-c', 'for i in $(seq 1 500); do echo line$i; done']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok rc=0 lines=500 log=\/tmp\/quiet-/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const log = logOf(r.stdout);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 500);
  rmSync(log, { force: true });
});

test('failure keeps the exit code and shows only the last lines', () => {
  const r = run(['-n', '3', '--', 'bash', '-c', 'for i in $(seq 1 50); do echo row$i; done; exit 7']);
  assert.equal(r.status, 7);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0]!, /^FAILED rc=7 lines=50 /);
  assert.deepEqual(lines.slice(1), ['row48', 'row49', 'row50']);
  rmSync(logOf(r.stdout), { force: true });
});

test('stderr is captured too and a bad option is refused', () => {
  const r = run(['--', 'bash', '-c', 'echo oops >&2; exit 1']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /oops/);
  rmSync(logOf(r.stdout), { force: true });
  assert.equal(run(['-n', 'x', '--', 'true']).status, 2);
  assert.equal(run([]).status, 2);
});
