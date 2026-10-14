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

test('scripts/slice-check.sh parses', () => {
  const r = spawnSync('bash', ['-n', fileURLToPath(new URL('../../../../scripts/slice-check.sh', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
