// KONF-3073 follow-up: the in-cluster image build never prints the GitHub Packages token. On 2026-11-21 a Secret made from stdin kept a
// trailing newline, npm sent "Bearer <token>\n" and its error printed the token into the kaniko Job's log. scripts/npm-ci-masked.sh trims
// the token before npm runs and masks it (and anything token-shaped) in everything the command prints; scripts/mask-secrets.sh is the
// filter. Fake commands stand in for npm. No token-shaped literal here: fixtures are built at runtime.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const NPM_CI = join(REPO, 'scripts/npm-ci-masked.sh');
const MASK = join(REPO, 'scripts/mask-secrets.sh');
const fakeToken = () => ['gh', 'o_', randomBytes(18).toString('hex')].join('');

function run(script: string, args: string[], env: Record<string, string>, input?: string) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '', ...env } });
}

test('npm-ci-masked: a token with a trailing newline reaches the command trimmed, and npm-style errors never show it', () => {
  const tok = fakeToken();
  // The fake "npm" prints what it got (length-checked), on both streams, the way npm 10 did on 2026-11-21, and fails.
  const fake = `printf 'len=%s\\n' "\${#NODE_AUTH_TOKEN}"; echo "npm error Bearer $NODE_AUTH_TOKEN" >&2; echo "user:$NODE_AUTH_TOKEN@x"; exit 7`;
  const r = run(NPM_CI, ['bash', '-c', fake], { NODE_AUTH_TOKEN: `${tok}\n` });
  assert.equal(r.status, 7, 'the command’s own exit status is kept');
  assert.ok(!r.stdout.includes(tok) && !r.stderr.includes(tok), 'the token is not printed');
  assert.match(r.stdout, new RegExp(`len=${tok.length}\\b`), 'the newline was trimmed before the command ran');
  assert.match(r.stdout, /npm error Bearer \[REDACTED\]/);
  assert.match(r.stdout, /user:\[REDACTED\]@x/);
});

test('npm-ci-masked: success passes output through; an empty or blank token refuses before the command runs', () => {
  const ok = run(NPM_CI, ['bash', '-c', 'echo added 469 packages'], { NODE_AUTH_TOKEN: ` ${fakeToken()} ` });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'added 469 packages');
  for (const blank of ['', ' \n\t']) {
    const r = run(NPM_CI, ['bash', '-c', 'echo RAN'], { NODE_AUTH_TOKEN: blank });
    assert.equal(r.status, 2);
    assert.ok(!r.stdout.includes('RAN'), 'the command did not run');
    assert.match(r.stderr, /NODE_AUTH_TOKEN is empty/);
  }
});

test('mask-secrets: hides MASK_TOKEN (any value, read from the environment) and GitHub-token shapes, keeps other text', () => {
  const plain = randomBytes(12).toString('hex');
  const other = ['github_', 'pat_', randomBytes(10).toString('hex')].join('');
  const r = run(MASK, [], { MASK_TOKEN: `${plain}\n` }, `a ${plain} b ${plain}\nkey ${fakeToken()} and ${other}\nnothing here\n`);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'a [REDACTED] b [REDACTED]\nkey [REDACTED] and [REDACTED]\nnothing here\n');
});

test('both portal Dockerfiles run npm ci through npm-ci-masked, and k3s-build trims the token and masks the failure log', () => {
  for (const f of ['Dockerfile', 'deploy/k3s-build/portal.Dockerfile']) {
    const src = readFileSync(join(REPO, f), 'utf8');
    assert.match(src, /COPY scripts\/mask-secrets\.sh scripts\/npm-ci-masked\.sh /, f);
    assert.match(src, /bash \/usr\/local\/lib\/build\/npm-ci-masked\.sh npm ci/, f);
    assert.doesNotMatch(src, /^\s*(RUN\s+)?npm ci\s*$/m, `${f}: no bare npm ci`);
  }
  const build = readFileSync(join(REPO, 'scripts/k3s-build.sh'), 'utf8');
  assert.match(build, /gh auth token \| tr -d '\[:space:\]'/);
  assert.match(build, /logs "job\/\$job" --tail=15 2>&1 \| masked/);
});
