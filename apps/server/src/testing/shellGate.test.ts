// The shell-test gate (KONF-3073 follow-up): when it opens, and the guard that keeps every spawning test file behind it. Reads files only:
// nothing here spawns a process, so it runs everywhere.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHELL_TESTS_SKIP_REASON, shellTestsEnabled } from './shellGate.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the gate opens on CI (any value but empty, 0 or false) or RUN_SHELL_TESTS=1, and stays closed otherwise', () => {
  for (const env of [{ CI: 'true' }, { CI: '1' }, { CI: 'yes' }, { RUN_SHELL_TESTS: '1' }, { CI: 'false', RUN_SHELL_TESTS: '1' }]) assert.equal(shellTestsEnabled(env), true, JSON.stringify(env));
  for (const env of [{}, { CI: '' }, { CI: '0' }, { CI: 'false' }, { CI: ' FALSE ' }, { RUN_SHELL_TESTS: 'true' }, { RUN_SHELL_TESTS: '0' }]) assert.equal(shellTestsEnabled(env), false, JSON.stringify(env));
  assert.equal(SHELL_TESTS_SKIP_REASON, 'spawns shells; runs in CI');
});

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('every test file that imports child_process or node-pty takes its test functions from the gate, not node:test', () => {
  const spawns = /^import\s+(?!type\b)[^;]*from\s+'(?:node:)?child_process'|from\s+'(?:@lydell\/)?node-pty'/m;
  const gated = /from\s+'[./]+testing\/shellGate\.js'/;
  const offenders = testFiles(SRC)
    .filter((f) => spawns.test(readFileSync(f, 'utf8')) && !gated.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f));
  assert.deepEqual(offenders, [], 'import { test, describe, it, before, after } from testing/shellGate.js in these files');
});
