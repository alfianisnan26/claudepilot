// T-1992: the release gate runs the web unit tests (apps/web/src/**/*.test.ts). Before, only scripts/gate-quick.sh ran them, so a red web
// test (features/ci/focusRing.test.ts) reached integration with a green gate. The real scripts/gate.sh runs here in a temporary repository,
// with a fake npm first on PATH (it records each call; `npm test` fails when asked to): nothing is installed, built or tested for real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// The gate runs its steps from \`env -i\` (only PATH survives), so the fake keeps its log beside itself.
const FAKE_NPM = `#!/usr/bin/env bash
log="$(dirname "$0")/../npm.log"
printf '%s\\n' "$*" >> "$log"
if [ "$1" = test ] && [ -f "$log.red" ]; then echo 'not ok 1 - focus ring'; exit 1; fi
exit 0
`;

function gateRun(red: boolean): { summary: string; npm: string[]; verdict: { code: number | null; out: string } } {
  const root = tempDirectory('cp-gate-web-');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(bin);
  for (const s of ['scripts/gate.sh', 'scripts/gate-verdict.sh']) writeFileSync(join(repo, s), read(s));
  writeFileSync(join(bin, 'npm'), FAKE_NPM);
  chmodSync(join(bin, 'npm'), 0o755);
  // no gh here: the gate asks it for a package token, and a test must never see one
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const log = join(root, 'npm.log');
  if (red) writeFileSync(`${log}.red`, '');
  const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'gate');
  const gateDir = join(root, 'gate');
  // the default steps: the server suite fails fast here (there is no apps/server), the web tests are what this test reads
  spawnSync('bash', [join(repo, 'scripts/gate.sh')], { cwd: repo, env: { ...env, GATE_DIR: gateDir }, encoding: 'utf8' });
  const summary = readFileSync(join(`${gateDir}.logs`, 'SUMMARY.txt'), 'utf8');
  const npm = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const v = spawnSync('bash', [join(repo, 'scripts/gate-verdict.sh'), 'logs', `${gateDir}.logs`, 'typecheck,web-build,web-tests'], { env, encoding: 'utf8' });
  return { summary, npm, verdict: { code: v.status, out: v.stdout.trim() } };
}

test('the gate runs the web unit tests by default, after the web build, and a failing web test makes it red', () => {
  const green = gateRun(false);
  assert.deepEqual(green.npm, ['ci --no-audit --no-fund', 'run typecheck', 'run build -w @portal/web', 'test -w @portal/web']);
  assert.match(green.summary, /^web-tests rc=0 /m);
  assert.deepEqual(green.verdict, { code: 0, out: 'GATE-VERDICT: green' });

  const red = gateRun(true);
  assert.match(red.summary, /^web-tests rc=1 /m);
  assert.deepEqual(red.verdict, { code: 1, out: 'GATE-VERDICT: red: web-tests failed' });
});

test('every reader of the gate knows the web-tests step: the defaults, the Job, the pipeline and the check', () => {
  const all = 'typecheck,web-build,web-tests,server-suite';
  assert.ok(read('scripts/gate.sh').includes(`steps=",\${GATE_STEPS:-${all}},"`));
  assert.ok(read('scripts/gate-verdict.sh').includes(`\${GATE_STEPS:-${all}}`), 'the verdict requires the web tests by default');
  const job = read('scripts/gate-job.sh');
  assert.ok(job.includes(`steps=\${2:-${all}}`));
  assert.match(job, /\(typecheck\|web-build\|web-tests\|server-suite\)/, 'gate-job.sh accepts the step');
  assert.match(read('.pilot/scripts/gate.sh'), /for step in npm-ci typecheck web-build web-tests server-suite; do/);
  assert.match(read('deploy/k3s-build/gate-job.yaml'), /for s in npm-ci typecheck web-build web-tests; do/);
  assert.match(read('.pilot/scripts/check.sh'), /scripts\/gate-job\.sh "\$sha" typecheck,web-build,web-tests\n/);
  // the web package's test command is the one the gate runs, and it covers the whole web source
  assert.match(read('apps/web/package.json'), /"test": "node --import tsx [^"]*--test 'src\/\*\*\/\*\.test\.ts'"/);
});
