// scripts/quick-check.sh (D-66): the light checks before CI, as one cluster Job. Against a fake job-run that runs the Job's command in the
// test repository itself (as the Job's clone would), with fake prettier, eslint and vitest: every check runs even when one fails, the verdict
// names every failure, only the branch's changed files are checked, and the pushed commit is what job-run gets.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/quick-check.sh');
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** The machine's git configuration (signing, hooks) stays out of the fixture. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...GIT_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const tool = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A repository whose `stg` is on a bare origin, and a work branch that changes two files, deletes one and adds a package with a test. */
function fixture(prettierExit: number) {
  const root = mkdtempSync(join(tmpdir(), 'qc-'));
  roots.push(root);
  const work = join(root, 'work');
  sh(root, `git init -q --bare origin.git && git init -q -b stg work`);
  writeFileSync(join(work, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(work, 'gone.md'), 'old\n');
  writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
  sh(work, `git add -A && git commit -qm base && git remote add origin ../origin.git && git push -q origin stg && git fetch -q origin`);
  sh(work, `git checkout -q -b dev/T-1-x`);
  writeFileSync(join(work, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(work, 'b.md'), '# b\n');
  mkdirSync(join(work, 'pkg'), { recursive: true });
  writeFileSync(join(work, 'pkg/package.json'), '{}\n');
  writeFileSync(join(work, 'pkg/x.test.mjs'), 'test\n');
  sh(work, `git rm -q gone.md && git add -A && git commit -qm change`);
  // What `npm ci` would have put in the Job's clone: the tools log their arguments and exit as told.
  const log = join(root, 'tools.log');
  tool(join(work, 'node_modules/.bin/prettier'), `echo "prettier $*" >> ${log}; exit ${prettierExit}`);
  tool(join(work, 'node_modules/.bin/eslint'), `echo "eslint $*" >> ${log}; exit 0`);
  tool(join(work, 'pkg/node_modules/.bin/vitest'), `echo "vitest $* in $(basename "$PWD")" >> ${log}; exit 0`);
  // The script next to a fake job-run.sh (it calls the one beside it, no override): records its arguments, then runs the command where the
  // Job's clone would be.
  const fake = join(root, 'bin/quick-check.sh');
  mkdirSync(join(root, 'bin'));
  copyFileSync(SCRIPT, fake);
  tool(join(root, 'bin/job-run.sh'), `printf '%s\\n' "$@" > ${join(root, 'args')}; cd ${work} && bash -c "\${@: -1}"`);
  return { root, work, log, fake };
}

const run = (cwd: string, script: string, args: string[]) => spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8', env: GIT_ENV });

test('every check runs when the first fails, and the verdict names the failure', () => {
  const f = fixture(1);
  const r = run(f.work, f.fake, ['--test', 'pkg/x.test.mjs']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::: format FAILED \(exit 1\)/);
  assert.match(r.stdout, /::: lint ok/);
  assert.match(r.stdout, /::: test:pkg\/x\.test\.mjs ok/);
  assert.match(r.stdout, /QUICK CHECK FAILED: format$/m);
  const tools = readFileSync(f.log, 'utf8');
  // Only the branch's changed files (not the deleted one, not node_modules); lint only the code ones; the test from its package.
  assert.match(tools, /^prettier --check --ignore-unknown a\.ts b\.md pkg\/package\.json pkg\/x\.test\.mjs$/m);
  assert.match(tools, /^eslint a\.ts pkg\/x\.test\.mjs$/m);
  assert.match(tools, /^vitest run x\.test\.mjs in pkg$/m);
  assert.doesNotMatch(tools, /gone\.md/);
  // job-run gets the pushed commit and a bounded Job.
  const args = readFileSync(join(f.root, 'args'), 'utf8').split('\n');
  assert.equal(args[0], '--ref');
  assert.equal(args[1], sh(f.work, 'git rev-parse HEAD'));
  assert.deepEqual(args.slice(2, 4), ['--timeout', '900']);
});

test('all passed is exit 0 with one verdict line', () => {
  const f = fixture(0);
  const r = run(f.work, f.fake, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /QUICK CHECK: all passed$/m);
});

test('a branch with no changes and no tests needs no Job; a missing test file is a usage error', () => {
  const f = fixture(0);
  sh(f.work, 'git checkout -q stg');
  const none = run(f.work, f.fake, []);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /nothing to check/);
  const bad = run(f.work, f.fake, ['--test', 'nope.test.ts']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no test file nope\.test\.ts/);
});
