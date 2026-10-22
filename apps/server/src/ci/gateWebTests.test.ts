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

// \`nice\` runs every step; the fake one answers for the server suite (\`node ... --test\`) as a green suite would, and runs the rest.
const FAKE_NICE = `#!/usr/bin/env bash
[ "$1" = -n ] && shift 2
case " $* " in *" --test "*) printf '# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n'; exit 0 ;; esac
exec "$@"
`;
const ALL = 'typecheck,web-build,web-tests,server-suite';
/** The gate.sh of a commit from before T-1992: no web-tests step, the old default. */
const oldGate = () =>
  read('scripts/gate.sh')
    .replaceAll(ALL, 'typecheck,web-build,server-suite')
    .split('\n')
    .filter((l) => !l.includes('web-tests'))
    .join('\n');

interface GateRun {
  steps: string;
  note: string;
  summary: string;
  npm: string[];
  verdict: { code: number | null; out: string };
}

/** What the gate Job does (deploy/k3s-build/gate-job.yaml): today's verdict script trims the steps for the commit's gate.sh, the commit's gate.sh
 * runs them, the verdict reads the same steps. The commit's gate.sh is \`gate\` (default: today's). */
function gateRun(opts: { red?: boolean; gate?: string } = {}): GateRun {
  const root = tempDirectory('cp-gate-web-');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, 'scripts/gate.sh'), opts.gate ?? read('scripts/gate.sh'));
  writeFileSync(join(repo, 'scripts/gate-verdict.sh'), read('scripts/gate-verdict.sh'));
  // the suite runs from apps/server (the fake nice answers for it)
  mkdirSync(join(repo, 'apps/server'), { recursive: true });
  writeFileSync(join(repo, 'apps/server/.keep'), '');
  // no gh here: the gate asks it for a package token, and a test must never see one
  for (const [name, body] of [['npm', FAKE_NPM], ['nice', FAKE_NICE], ['gh', '#!/usr/bin/env bash\nexit 1\n']] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(root, 'npm.log');
  if (opts.red) writeFileSync(`${log}.red`, '');
  const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'gate');
  const verdictSh = read('scripts/gate-verdict.sh');
  const verdictPath = join(root, 'gate-verdict.sh');
  writeFileSync(verdictPath, verdictSh);
  const trimmed = spawnSync('bash', [verdictPath, 'steps', ALL, join(repo, 'scripts/gate.sh')], { env, encoding: 'utf8' });
  assert.equal(trimmed.status, 0, trimmed.stderr);
  const steps = trimmed.stdout.trim();
  const gateDir = join(root, 'gate');
  spawnSync('bash', [join(repo, 'scripts/gate.sh')], { cwd: repo, env: { ...env, GATE_DIR: gateDir, GATE_STEPS: steps }, encoding: 'utf8' });
  const summary = readFileSync(join(`${gateDir}.logs`, 'SUMMARY.txt'), 'utf8');
  const npm = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const v = spawnSync('bash', [verdictPath, 'logs', `${gateDir}.logs`, steps], { env, encoding: 'utf8' });
  return { steps, note: trimmed.stderr.trim(), summary, npm, verdict: { code: v.status, out: v.stdout.trim() } };
}

test('the gate runs the web unit tests by default, after the web build, and a failing web test makes it red', () => {
  const green = gateRun();
  assert.equal(green.steps, ALL);
  assert.equal(green.note, '');
  assert.deepEqual(green.npm, ['ci --no-audit --no-fund', 'run typecheck', 'run build -w @portal/web', 'test -w @portal/web']);
  assert.match(green.summary, /^web-tests rc=0 /m);
  assert.deepEqual(green.verdict, { code: 0, out: 'GATE-VERDICT: green' });

  const red = gateRun({ red: true });
  assert.match(red.summary, /^web-tests rc=1 /m);
  assert.deepEqual(red.verdict, { code: 1, out: 'GATE-VERDICT: red: web-tests failed' });
});

test('a commit from before T-1992 (its gate.sh has no web-tests step) is green with the default steps when its other steps pass', () => {
  const gate = oldGate();
  assert.ok(!gate.includes('web-tests'));
  const old = gateRun({ gate });
  assert.equal(old.steps, 'typecheck,web-build,server-suite');
  assert.match(old.note, /^gate: web-tests skipped: this commit's scripts\/gate\.sh has no web-tests step/);
  assert.doesNotMatch(old.summary, /web-tests/);
  assert.match(old.summary, /^server-suite rc=0 /m);
  assert.deepEqual(old.verdict, { code: 0, out: 'GATE-VERDICT: green' });
  // the old gate still fails on its own steps
  const broken = gateRun({ gate: gate.replace('step typecheck "${clean[@]}" nice -n 10 npm run typecheck', 'step typecheck false') });
  assert.deepEqual(broken.verdict, { code: 1, out: 'GATE-VERDICT: red: typecheck failed' });
});

test('steps: web-tests is dropped only for a gate.sh without it, wherever it stands, and never down to no steps', () => {
  const root = tempDirectory('cp-gate-steps-');
  const oldSh = join(root, 'old.sh');
  const newSh = join(root, 'new.sh');
  writeFileSync(oldSh, oldGate());
  writeFileSync(newSh, read('scripts/gate.sh'));
  const steps = (want: string, gate: string) => {
    const r = spawnSync('bash', [join(REPO, 'scripts/gate-verdict.sh'), 'steps', want, gate], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    return { code: r.status, out: r.stdout.trim(), note: r.stderr.trim() };
  };
  assert.deepEqual(steps(ALL, newSh), { code: 0, out: ALL, note: '' });
  assert.equal(steps(ALL, oldSh).out, 'typecheck,web-build,server-suite');
  assert.equal(steps('typecheck,web-build,web-tests', oldSh).out, 'typecheck,web-build', 'the last item');
  assert.equal(steps('web-tests,typecheck', oldSh).out, 'typecheck', 'the first item');
  assert.equal(steps('typecheck,web-build', oldSh).out, 'typecheck,web-build');
  assert.deepEqual(steps('web-tests', oldSh), { code: 0, out: 'web-tests', note: '' }, 'nothing else to run: kept, and the verdict says red');
});

test('every reader of the gate knows the web-tests step: the defaults, the Job, the pipeline and the check', () => {
  const all = ALL;
  assert.ok(read('scripts/gate.sh').includes(`steps=",\${GATE_STEPS:-${all}},"`));
  assert.ok(read('scripts/gate-verdict.sh').includes(`\${GATE_STEPS:-${all}}`), 'the verdict requires the web tests by default');
  const job = read('scripts/gate-job.sh');
  assert.ok(job.includes(`steps=\${2:-${all}}`));
  assert.match(job, /\(typecheck\|web-build\|web-tests\|server-suite\)/, 'gate-job.sh accepts the step');
  assert.match(read('.pilot/scripts/gate.sh'), /for step in npm-ci typecheck web-build web-tests server-suite; do/);
  const yaml = read('deploy/k3s-build/gate-job.yaml');
  assert.match(yaml, /for s in npm-ci typecheck web-build web-tests; do/);
  // the Job trims the steps for the commit's own gate.sh BEFORE it runs, and the verdict reads that same variable
  const trim = yaml.indexOf('GATE_STEPS=$(bash /tmp/gate-verdict.sh steps "$GATE_STEPS" scripts/gate.sh) && export GATE_STEPS');
  const run = yaml.indexOf('GATE_DIR=/tmp/gate bash scripts/gate.sh HEAD');
  const decode = yaml.indexOf('base64 -d > /tmp/gate-verdict.sh');
  assert.ok(decode >= 0 && decode < trim && trim >= 0 && trim < run, 'decode, trim, then gate.sh');
  assert.match(yaml.slice(run), /bash \/tmp\/gate-verdict\.sh logs \/tmp\/gate\.logs "\$GATE_STEPS"/);
  assert.match(read('.pilot/scripts/check.sh'), /scripts\/gate-job\.sh "\$sha" typecheck,web-build,web-tests\n/);
  // the web package's test command is the one the gate runs, and it covers the whole web source
  assert.match(read('apps/web/package.json'), /"test": "node --import tsx [^"]*--test 'src\/\*\*\/\*\.test\.ts'"/);
});
