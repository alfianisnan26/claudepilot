// Test of scripts/ci-step-check.mjs: node --test scripts/ci-step-check.test.mjs
// Workflows are written at runtime in a temp folder; no network, no real command runs (stubs only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNested, checkScript, substitute } from './ci-step-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci-step-check.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ci-step-check-test-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function workflow(name, steps) {
  const file = join(dir, name);
  const body = steps
    .map(
      ([n, run]) =>
        `      - name: ${n}\n        run: |\n${run
          .split('\n')
          .map((l) => `          ${l}`)
          .join('\n')}\n`,
    )
    .join('');
  writeFileSync(
    file,
    `name: t\non: push\njobs:\n  deploy:\n    name: Deploy stg\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n${body}`,
  );
  return file;
}
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const GOOD = `bash scripts/ci-chroot-run.sh 'cd /srv/app && git pull && echo "deployed \${{ github.sha }}"'`;
// The bug of 2026-10-31: the inner ' closes the string early, so the helper gets other text than written, and the line still passes bash -n.
const BROKEN = `bash scripts/ci-chroot-run.sh 'cd /srv/app && echo 'deployed' && systemctl restart app'`;
const NESTED_SYNTAX = `bash scripts/ci-chroot-run.sh 'if [ -d /srv ]; then echo yes'`;

test('a clean step passes bash -n, with its nested script', () => {
  const file = workflow('good.yml', [['Deploy', GOOD]]);
  const r = cli(file, 'deploy', 'Deploy');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok {3}deploy #2 Deploy: bash -n clean, 1 nested script\(s\) clean/);
});

test('a single-quoted script closed early by an inner quote is a problem though bash -n passes', () => {
  assert.equal(spawnSync('bash', ['-n'], { input: BROKEN }).status, 0, 'the outer line alone looks fine');
  const r = cli(workflow('broken.yml', [['Deploy', BROKEN]]), 'deploy');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /closed early by an inner ' .*the helper gets "cd \/srv\/app && echo deployed && systemctl restart app"/);
});

test('a syntax error inside the nested script is found', () => {
  const r = cli(workflow('nested.yml', [['Deploy', NESTED_SYNTAX]]), 'Deploy stg', '2');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /nested 1 \(bash scripts\/ci-chroot-run.sh\): bash -n: .*(syntax error|unexpected end)/);
});

test('a syntax error in the run block itself is found', () => {
  const r = cli(workflow('outer.yml', [['Build', 'if true; then\n  echo x\n']]));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /deploy #2 Build: bash -n:/);
});

test("the '\\'' idiom, $'...', --opt='...' and a heredoc with an apostrophe are not problems", () => {
  const script = [
    `bash x.sh 'echo '\\''quoted'\\'' && true'`,
    `ssh host 'printf "%s\\n" "it is"; ls'`,
    `printf $'a\\tb\\n'`,
    `docker run --entrypoint='/bin/sh -c' img`,
    `cat <<EOF`,
    `it's a heredoc`,
    `EOF`,
    `sh -c 'echo ok; exit 0'`,
  ].join('\n');
  assert.deepEqual(checkScript(script), []);
  const { nested } = findNested(script);
  assert.deepEqual(
    nested.map((n) => n.script),
    [`echo 'quoted' && true`, 'printf "%s\\n" "it is"; ls', 'echo ok; exit 0'],
  );
});

test('--nested-cmd adds a helper; plain commands are not helpers', () => {
  assert.equal(findNested(`jq '.a | .b' f.json`).nested.length, 0);
  assert.equal(findNested(`deployer --script 'if x; then'`).nested.length, 0);
  assert.equal(checkScript(`deployer --script 'if x; then'`, { extra: /^deployer$/ }).length, 1);
});

test('${{ }} expressions take --expr values, else a placeholder', () => {
  assert.equal(
    substitute('echo ${{ secrets.HOST }} ${{github.sha}}', { 'secrets.HOST': 'stg.example.invalid' }),
    'echo stg.example.invalid __github_sha__',
  );
});

test('--run executes with stubs and env and shows what the helper received', () => {
  const file = workflow('run.yml', [['Deploy', `${GOOD}\nssh "$TARGET" 'uptime'\necho "done on $TARGET"`]]);
  const r = cli(
    file,
    'deploy',
    'deploy',
    '--run',
    '--stub',
    'scripts/ci-chroot-run.sh',
    '--stub',
    'ssh=up 3 days',
    '--env',
    'TARGET=stg',
    '--expr',
    'github.sha=abc123',
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /stub scripts\/ci-chroot-run.sh: \[cd \/srv\/app && git pull && echo "deployed abc123"\]/);
  assert.match(r.stdout, /stub ssh: \[stg\] \[uptime\]/);
  assert.match(r.stdout, /up 3 days/);
  assert.match(r.stdout, /done on stg/);
});

test('--run fails when the step fails (a missing helper with set -e)', () => {
  const r = cli(workflow('fail.yml', [['Deploy', GOOD]]), 'deploy', '--run');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /run {2}deploy #2 Deploy: exit 127/);
});

test('--list, an unknown job, a missing file', () => {
  const file = workflow('list.yml', [
    ['One', 'true'],
    ['Two', 'true'],
  ]);
  const l = cli(file, '--list');
  assert.equal(l.status, 0);
  assert.equal(l.stdout, 'deploy #1 (unnamed) (no run)\ndeploy #2 One\ndeploy #3 Two\n');
  assert.equal(cli(file, 'nope').status, 2);
  assert.equal(cli(join(dir, 'missing.yml')).status, 2);
  assert.equal(cli().status, 2);
});
