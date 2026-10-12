// The workspace image's Claude Code pin (docs/prd/claude-version-pinning.md FR1): the build argument default is the portal's default pin, the install
// is exact and refuses anything else, the image labels itself, and the two update switches are in the image's environment AND a baked managed drop-in.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_LABELS, DEFAULT_CLAUDE_CODE_VERSION, secretVariableReserved } from '@portal/contracts';

const DOCKERFILE = readFileSync(new URL('../../../../images/workspace/Dockerfile', import.meta.url), 'utf8');
/** The Dockerfile's instructions, continuation lines joined, comments dropped. */
const instructions = DOCKERFILE.replace(/\\\n/g, ' ').split('\n').filter((l) => l.trim() && !l.startsWith('#'));

test('ARG CLAUDE_CODE_VERSION defaults to the portal’s default pin, and sits before the install', () => {
  const arg = instructions.findIndex((l) => l.startsWith('ARG CLAUDE_CODE_VERSION='));
  assert.ok(arg >= 0, 'the image has the build argument');
  assert.equal(instructions[arg], `ARG CLAUDE_CODE_VERSION=${DEFAULT_CLAUDE_CODE_VERSION}`, 'the default is DEFAULT_CLAUDE_CODE_VERSION (packages/contracts/src/claudeversion.ts)');
  const install = instructions.findIndex((l) => l.includes('npm install -g'));
  assert.ok(install > arg, 'the argument is declared before the install uses it');
});

test('the install is exact, checked, and the build fails when the CLI reports another version', () => {
  const installs = instructions.filter((l) => /npm install[^&]*@anthropic-ai\/claude-code/.test(l));
  assert.equal(installs.length, 1, 'one install of Claude Code');
  const run = installs[0]!;
  assert.match(run, /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/, 'pinned to the build argument, never unpinned or `latest`');
  assert.ok(!/@anthropic-ai\/claude-code(?!@)/.test(run.replace(/@anthropic-ai\/claude-code@/g, '')), 'no unpinned occurrence');
  assert.match(run, /claude --version/, 'it reads the version back');
  assert.match(run, /test "\$\(claude --version[^)]*\)" = "\$\{CLAUDE_CODE_VERSION\}"/, 'and fails the build when it differs from the argument');

  // The guard runs in the image's shell: an exact x.y.z passes, anything else ends the build. Run its first command for real.
  const guard = /echo "\$\{CLAUDE_CODE_VERSION\}" \| grep -Eq '([^']+)'/.exec(run)!;
  const accepts = (v: string) => {
    try {
      execFileSync('sh', ['-c', `echo "${v}" | grep -Eq '${guard[1]}'`]);
      return true;
    } catch {
      return false;
    }
  };
  for (const ok of ['2.1.296', '10.0.1']) assert.equal(accepts(ok), true, ok);
  for (const bad of ['latest', '^2.1.296', '2.1', '2.1.296-beta', '2.1.296 x', 'next', '']) assert.equal(accepts(bad), false, bad);
});

test('the image labels itself with the version it installed', () => {
  const label = instructions.find((l) => l.startsWith('LABEL '));
  assert.equal(label, `LABEL ${CLAUDE_LABELS.version}="\${CLAUDE_CODE_VERSION}"`);
});

test('the updaters are off in the image’s environment and in a baked managed drop-in, and Secrets & env cannot turn them back on', () => {
  assert.ok(instructions.includes('ENV DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1'), 'ENV in the image');
  const run = instructions.find((l) => l.includes('01-claudepilot-pin.json') && l.startsWith('RUN printf'))!;
  assert.ok(run, 'a RUN writes the pin drop-in');
  // Run it against a stand-in for the file's folder: what lands is exactly the two switches.
  const dir = mkdtempSync(join(tmpdir(), 'cp-pin-'));
  try {
    const script = run.slice(4).split('/etc/claude-code/managed-settings.d').join(dir);
    execFileSync('sh', ['-c', script]);
    const file = join(dir, '01-claudepilot-pin.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { env: { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' } });
    writeFileSync(join(dir, 'x'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A drop-in numbered before every other the delivery engine writes (05, 10, 20, 30, 40, 50): its `env` merges with theirs, and none of them may set a DISABLE_* name.
  assert.equal(secretVariableReserved('DISABLE_UPDATES') !== null && secretVariableReserved('DISABLE_AUTOUPDATER') !== null, true, 'a Secrets & env variable cannot be named DISABLE_*');
});

test('no other place in the image or the portal installs Claude Code unpinned', () => {
  assert.ok(!/npm install -g @anthropic-ai\/claude-code\s*$/m.test(DOCKERFILE), 'no bare install');
});
