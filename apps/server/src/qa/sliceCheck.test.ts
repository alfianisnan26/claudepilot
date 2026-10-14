import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sliceTests } from './sliceCheck.js';

const have = (...files: string[]) => (p: string) => files.includes(p);

test('a changed test file runs itself; a changed source file its sibling test; a deleted test is not run', () => {
  const exists = have('apps/server/src/chat/protocol.test.ts', 'apps/server/src/ci/links.test.ts');
  assert.deepEqual(sliceTests(['apps/server/src/chat/protocol.ts', 'apps/server/src/ci/links.test.ts', 'apps/server/src/ci/gone.test.ts', 'apps/server/src/ci/nosibling.ts', ''], exists), ['src/chat/protocol.test.ts', 'src/ci/links.test.ts']);
});

test('scripts and dev-session scripts map to src/qa or src/ci tests by name', () => {
  const exists = have('apps/server/src/qa/gateQuick.test.ts', 'apps/server/src/qa/factory.test.ts', 'apps/server/src/ci/deployPipeline.test.ts');
  assert.deepEqual(sliceTests(['scripts/gate-quick.sh', 'docs/dev-sessions/factory.mjs', 'scripts/k3s-status.sh'], exists), ['src/qa/factory.test.ts', 'src/qa/gateQuick.test.ts']);
});

test('documents, web code and type declarations derive no server test; the list is sorted and without duplicates', () => {
  const all = () => true;
  assert.deepEqual(sliceTests(['docs/prd/tickets.md', 'apps/web/src/features/chat/Transcript.tsx', 'apps/server/src/types.d.ts'], all), []);
  assert.deepEqual(sliceTests(['apps/server/src/b/x.ts', 'apps/server/src/a/y.test.ts', 'apps/server/src/b/x.test.ts'], all), ['src/a/y.test.ts', 'src/b/x.test.ts']);
});

const SCRIPT = fileURLToPath(new URL('../../../../scripts/slice-check.sh', import.meta.url));

test('scripts/slice-check.sh parses', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// The release gate runs on a clean copy that is not a git work tree; the script needs one (it exits 2 before it can say anything).
const inGitTree = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: fileURLToPath(new URL('.', import.meta.url)) }).status === 0;

test('a named test file that does not exist is a usage error before any check runs (node --test would pass over it silently)', { skip: !inGitTree && 'not a git work tree (the gate copy)' }, () => {
  const r = spawnSync('bash', [SCRIPT, '--base', 'HEAD', 'src/qa/sliceCheck.test.ts', 'apps/server/src/qa/no-such-file.test.ts'], { encoding: 'utf8', cwd: fileURLToPath(new URL('.', import.meta.url)) });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /no such test file: src\/qa\/no-such-file\.test\.ts $/m);
  assert.doesNotMatch(r.stdout, /typecheck/);
});
