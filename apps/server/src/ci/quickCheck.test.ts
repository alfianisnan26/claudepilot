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
// NODE_TEST_CONTEXT is dropped: a nested `node --test` under it reports to the parent and exits 0 even when a test fails.
const GIT_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
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

/** The verdict is the last line of the output. */
const last = (out: string) => out.trimEnd().split('\n').pop() ?? '';

test('T-612: a missing tool is SKIPPED, never passed: the last line names it and the exit is not 0', () => {
  const f = fixture(0);
  rmSync(join(f.work, 'node_modules/.bin/prettier'));
  const r = run(f.work, f.fake, ['--test', 'pkg/x.test.mjs']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::: format SKIPPED \(no prettier\)/);
  assert.match(r.stdout, /::: lint ok/);
  assert.doesNotMatch(r.stdout, /all passed/);
  assert.equal(last(r.stdout), 'QUICK CHECK INCOMPLETE: SKIPPED format (the other steps passed)');
  // A failure and a skip together: both are named.
  rmSync(join(f.work, 'node_modules/.bin/eslint'));
  tool(join(f.work, 'pkg/node_modules/.bin/vitest'), 'exit 1');
  const both = run(f.work, f.fake, ['--test', 'pkg/x.test.mjs']);
  assert.equal(both.status, 1);
  assert.equal(last(both.stdout), 'QUICK CHECK FAILED: test:pkg/x.test.mjs (also SKIPPED: format lint)');
});

test('each verdict branch: FAILED, FAILED nothing ran, INCOMPLETE, all passed (one exact last line each)', () => {
  const f = fixture(1);
  const failed = run(f.work, f.fake, []);
  assert.equal(failed.status, 1);
  assert.equal(last(failed.stdout), 'QUICK CHECK FAILED: format');
  // Checks turned off and no test: nothing ran, with no skip to name, is still a failure.
  const off = run(f.work, f.fake, ['--no-format', '--no-lint']);
  assert.equal(off.status, 1, off.stdout + off.stderr);
  assert.equal(last(off.stdout), 'QUICK CHECK FAILED: nothing ran (every check was skipped)');
  tool(join(f.work, 'node_modules/.bin/prettier'), 'exit 0');
  rmSync(join(f.work, 'node_modules/.bin/eslint'));
  const incomplete = run(f.work, f.fake, []);
  assert.equal(incomplete.status, 1);
  assert.equal(last(incomplete.stdout), 'QUICK CHECK INCOMPLETE: SKIPPED lint (the other steps passed)');
  const passed = run(f.work, f.fake, ['--no-lint']);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(last(passed.stdout), 'QUICK CHECK: all passed');
});

test('--help prints the whole header and nothing of the code', () => {
  const r = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^# The light checks BEFORE/);
  assert.match(last(r.stdout), /^# Exit: 0 all passed;/);
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

test('T-960: a run where every check is skipped is a failure, never "all passed"', () => {
  const f = fixture(0);
  rmSync(join(f.work, 'node_modules'), { recursive: true, force: true }); // no prettier, no eslint
  const r = run(f.work, f.fake, []);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::: format SKIPPED \(no prettier\)/);
  assert.equal(last(r.stdout), 'QUICK CHECK FAILED: nothing ran (every check was skipped)');
  assert.doesNotMatch(r.stdout, /all passed/);
});

test('T-960: a Python test runs with unittest when the image has no pytest, and its failure is a failure', () => {
  const f = fixture(0);
  mkdirSync(join(f.work, 'py/tests'), { recursive: true });
  writeFileSync(join(f.work, 'py/package.json'), '{}\n');
  writeFileSync(
    join(f.work, 'py/tests/test_ok.py'),
    'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n',
  );
  writeFileSync(
    join(f.work, 'py/tests/test_bad.py'),
    'import unittest\nclass T(unittest.TestCase):\n    def test_bad(self):\n        self.assertEqual(1, 2)\n',
  );
  sh(f.work, 'git add -A && git commit -qm py');
  // PATH without pytest: python3 -m pytest fails, so the fallback is taken (a shim makes "python3 -m pytest" fail even where pytest exists).
  const shim = join(f.root, 'nopytest');
  const python = spawnSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(python, 'python3 on PATH');
  tool(join(shim, 'python3'), `if [ "$1 $2" = "-m pytest" ]; then exit 1; fi; exec ${python} "$@"`);
  const env = { ...GIT_ENV, PATH: `${shim}:${process.env.PATH}` };
  const ok = spawnSync('bash', [f.fake, '--test', 'py/tests/test_ok.py'], { cwd: f.work, encoding: 'utf8', env });
  assert.match(ok.stdout, /::: test:py\/tests\/test_ok\.py \(unittest, no pytest in the Job image\) ok/, ok.stdout + ok.stderr);
  const bad = spawnSync('bash', [f.fake, '--test', 'py/tests/test_bad.py'], { cwd: f.work, encoding: 'utf8', env });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /test_bad\.py \(unittest, no pytest in the Job image\) FAILED/);
});

/** T-2975: script checks run by node's own test runner (as Konfersi's backend runs them, test:scripts), never vitest. */
function scriptChecks(f: ReturnType<typeof fixture>, failing = false) {
  mkdirSync(join(f.work, 'scripts/lib'), { recursive: true });
  mkdirSync(join(f.work, 'pkg/tools'), { recursive: true });
  const body = (ok: boolean) => `import test from 'node:test';\nimport assert from 'node:assert';\ntest('t', () => assert.ok(${ok}));\n`;
  writeFileSync(join(f.work, 'scripts/snap.check.mjs'), body(!failing));
  writeFileSync(join(f.work, 'scripts/lib/util.test.mjs'), body(true));
  writeFileSync(join(f.work, 'pkg/tools/y.check.mjs'), body(true));
  sh(f.work, 'git add -A && git commit -qm scripts');
  // A vitest at the root and in pkg: it must not be called for these files (it does not collect *.check.mjs).
  tool(join(f.work, 'node_modules/.bin/vitest'), `echo "vitest $* in $(basename "$PWD")" >> ${f.log}; exit 1`);
}

test('T-2975: *.check.mjs and scripts/** tests run with node --test, never vitest; a failing one fails', () => {
  const f = fixture(0);
  scriptChecks(f);
  const tests = ['scripts/snap.check.mjs', 'scripts/lib/util.test.mjs', 'pkg/tools/y.check.mjs', 'pkg/x.test.mjs'];
  const r = run(
    f.work,
    f.fake,
    tests.flatMap((t) => ['--test', t]),
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^::: test:\.\/scripts\/snap\.check\.mjs \(node --test\) ok$/m);
  assert.match(r.stdout, /^::: test:\.\/scripts\/lib\/util\.test\.mjs \(node --test\) ok$/m);
  assert.match(r.stdout, /^::: test:pkg\/tools\/y\.check\.mjs \(node --test\) ok$/m);
  assert.equal(last(r.stdout), 'QUICK CHECK: all passed');
  const tools = readFileSync(f.log, 'utf8');
  assert.doesNotMatch(tools, /^vitest .*(check\.mjs|util\.test\.mjs)/m, 'vitest never got a script check');
  assert.match(tools, /^vitest run x\.test\.mjs in pkg$/m, 'an ordinary test file still goes to vitest');
  // The runner really ran it: a failing check is a failure.
  const g = fixture(0);
  scriptChecks(g, true);
  const bad = run(g.work, g.fake, ['--test', 'scripts/snap.check.mjs']);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.equal(last(bad.stdout), 'QUICK CHECK FAILED: test:./scripts/snap.check.mjs (node --test)');
});

test('T-2975: a repo with no prettier and no eslint whose --test passed is INCOMPLETE, never FAILED "nothing ran"', () => {
  const f = fixture(0);
  scriptChecks(f);
  rmSync(join(f.work, 'node_modules/.bin/prettier'));
  rmSync(join(f.work, 'node_modules/.bin/eslint'));
  const r = run(f.work, f.fake, ['--test', 'scripts/snap.check.mjs']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::: format SKIPPED \(no prettier\)/);
  assert.match(r.stdout, /::: lint SKIPPED \(no eslint\)/);
  assert.match(r.stdout, /::: test:\.\/scripts\/snap\.check\.mjs \(node --test\) ok/);
  assert.doesNotMatch(r.stdout, /FAILED/);
  assert.equal(last(r.stdout), 'QUICK CHECK INCOMPLETE: SKIPPED format lint (the other steps passed)');
});

test('--dir names the worktree, so a lane whose shell is back in another folder checks the right one (T-1053); a missing folder is a usage error', () => {
  const f = fixture(0);
  const r = run(f.root, f.fake, ['--dir', f.work, '--test', 'pkg/x.test.mjs']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /QUICK CHECK: all passed$/m);
  assert.equal(readFileSync(join(f.root, 'args'), 'utf8').split('\n')[1], sh(f.work, 'git rev-parse HEAD'), 'the worktree’s pushed commit');
  assert.match(readFileSync(f.log, 'utf8'), /^vitest run x\.test\.mjs in pkg$/m);
  assert.equal(run(f.root, f.fake, ['--dir', join(f.root, 'nope')]).status, 2);
});

/** A second package in the fixture, committed so the Job's clone has it; `files` are written relative to it. */
function pkg(f: ReturnType<typeof fixture>, name: string, packageJson: string, files: Record<string, string>) {
  mkdirSync(join(f.work, name), { recursive: true });
  writeFileSync(join(f.work, name, 'package.json'), packageJson);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(f.work, name, p)), { recursive: true });
    writeFileSync(join(f.work, name, p), body);
  }
  sh(f.work, 'git add -A && git commit -qm pkg');
}

test('T-857: a file the package test:scripts glob matches runs with node --test, not vitest; other files keep their runner', () => {
  const f = fixture(0);
  pkg(f, 'be', JSON.stringify({ scripts: { 'test:scripts': 'node --test scripts/*.check.mjs' } }), {
    'scripts/a.check.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n",
    'src/b.test.mjs': 'x\n',
  });
  tool(join(f.work, 'be/node_modules/.bin/vitest'), `echo "vitest $*" >> ${f.log}; exit 0`);
  const r = run(f.work, f.fake, ['--no-format', '--no-lint', '--test', 'be/scripts/a.check.mjs', '--test', 'be/src/b.test.mjs']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /::: test:be\/scripts\/a\.check\.mjs \(node --test\) ok/);
  assert.match(r.stdout, /::: test:be\/src\/b\.test\.mjs ok/);
  const tools = readFileSync(f.log, 'utf8');
  assert.doesNotMatch(tools, /a\.check\.mjs/, 'the node:test file never reached vitest');
  assert.match(tools, /^vitest run src\/b\.test\.mjs$/m);
  // A failing node:test file fails the check.
  writeFileSync(
    join(f.work, 'be/scripts/a.check.mjs'),
    "import { test } from 'node:test';\ntest('bad', () => { throw new Error('x'); });\n",
  );
  sh(f.work, 'git commit -qam bad');
  const bad = run(f.work, f.fake, ['--no-format', '--no-lint', '--test', 'be/scripts/a.check.mjs']);
  assert.equal(bad.status, 1);
  assert.equal(last(bad.stdout), 'QUICK CHECK FAILED: test:be/scripts/a.check.mjs (node --test)');
});

test('T-3101: a package with its own scripts/test.mjs entry runs the file through it (extensionless imports need its bundle)', () => {
  const f = fixture(0);
  pkg(f, 'lab', '{}\n', {
    'scripts/test.mjs': `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(f.log)}, 'entry ' + process.argv.slice(2).join(' ') + '\\n');\n`,
    'src/x.test.ts': "import './y';\n",
  });
  tool(join(f.work, 'lab/node_modules/.bin/vitest'), `echo "vitest $*" >> ${f.log}; exit 0`);
  const r = run(f.work, f.fake, ['--no-format', '--no-lint', '--test', 'lab/src/x.test.ts']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /::: test:lab\/src\/x\.test\.ts \(scripts\/test\.mjs\) ok/);
  const tools = readFileSync(f.log, 'utf8');
  assert.match(tools, /^entry src\/x\.test\.ts$/m);
  assert.doesNotMatch(tools, /vitest/);
});

test('the order: a declared runner wins over the T-2975 routing, which wins over the installed tools', () => {
  const f = fixture(0);
  pkg(f, 'lab', '{}\n', {
    'scripts/test.mjs': `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(f.log)}, 'entry ' + process.argv.slice(2).join(' ') + '\\n');\n`,
    'src/a.check.mjs': 'x\n',
  });
  pkg(f, 'be', JSON.stringify({ scripts: { 'test:scripts': 'node --test scripts/*.check.mjs' } }), {
    'tools/y.check.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n",
  });
  tool(join(f.work, 'lab/node_modules/.bin/vitest'), `echo "vitest $*" >> ${f.log}; exit 0`);
  tool(join(f.work, 'be/node_modules/.bin/vitest'), `echo "vitest $*" >> ${f.log}; exit 1`);
  const r = run(f.work, f.fake, ['--no-format', '--no-lint', '--test', 'lab/src/a.check.mjs', '--test', 'be/tools/y.check.mjs']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /::: test:lab\/src\/a\.check\.mjs \(scripts\/test\.mjs\) ok/);
  assert.match(r.stdout, /::: test:be\/tools\/y\.check\.mjs \(node --test\) ok/);
  const tools = readFileSync(f.log, 'utf8');
  assert.match(tools, /^entry src\/a\.check\.mjs$/m);
  assert.doesNotMatch(tools, /vitest/);
});

test('a plain vitest package (no test:scripts, no scripts/test.mjs) still runs vitest', () => {
  const f = fixture(0);
  pkg(f, 'plain', JSON.stringify({ scripts: { test: 'vitest run', 'test:scripts': 'node --test scripts/*.check.mjs' } }), {
    'src/z.test.ts': 'x\n',
  });
  tool(join(f.work, 'plain/node_modules/.bin/vitest'), `echo "vitest $*" >> ${f.log}; exit 0`);
  const r = run(f.work, f.fake, ['--no-format', '--no-lint', '--test', 'plain/src/z.test.ts']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /::: test:plain\/src\/z\.test\.ts ok/);
  assert.match(readFileSync(f.log, 'utf8'), /^vitest run src\/z\.test\.ts$/m);
});
