// The dev image's Playwright Chromium (T-970): job-run's Jobs run on images/workspace/Dockerfile.dev, which bakes Playwright's Chromium at
// one pinned version with PLAYWRIGHT_BROWSERS_PATH set, leaves that folder to node (another Playwright version installs beside it), and
// docs/dev-session.md names the same version. Static checks of the build file; the image itself is built by the coordinator.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const DOCKERFILE = readFileSync(new URL('../../../../images/workspace/Dockerfile.dev', import.meta.url), 'utf8');
const DOCS = readFileSync(new URL('../../../../docs/dev-session.md', import.meta.url), 'utf8');
/** The Dockerfile's instructions, continuation lines joined, comments dropped. */
const instructions = DOCKERFILE.replace(/\\\n/g, ' ').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const argAt = instructions.findIndex((l) => l.startsWith('ARG PLAYWRIGHT_VERSION='));
const VERSION = argAt >= 0 ? instructions[argAt]!.slice('ARG PLAYWRIGHT_VERSION='.length).trim() : '';
const installAt = instructions.findIndex((l) => l.startsWith('RUN ') && l.includes('playwright@'));
const install = installAt >= 0 ? instructions[installAt]! : '';

test('ARG PLAYWRIGHT_VERSION is an exact x.y.z, declared before the install', () => {
  assert.ok(argAt >= 0, 'the image has the build argument');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'an exact version, never a range, a tag or a placeholder');
  assert.ok(installAt > argAt, 'the argument is declared before the install uses it');
});

test('PLAYWRIGHT_BROWSERS_PATH is set in the image, before the install', () => {
  const envAt = instructions.indexOf('ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright');
  assert.ok(envAt >= 0, 'ENV in the image, so every Playwright in a Job finds the baked browser');
  assert.ok(installAt > envAt, 'the install lands in that folder');
});

test('the install is pinned to the argument, brings the system libraries, checks the browser landed and leaves the folder to node', () => {
  assert.equal(instructions.filter((l) => l.includes('playwright@')).length, 1, 'one install of Playwright');
  assert.match(install, /npx -y "playwright@\$\{PLAYWRIGHT_VERSION\}" install --with-deps chromium/, 'pinned, with the system libraries, Chromium only');
  assert.ok(!/playwright(?!@\$\{PLAYWRIGHT_VERSION\})@/.test(install), 'no other version');
  assert.match(install, /ls -d "\$\{PLAYWRIGHT_BROWSERS_PATH\}"\/chromium-\*/, 'the build fails when no Chromium landed');
  assert.match(install, /chown -R node:node "\$\{PLAYWRIGHT_BROWSERS_PATH\}"/, 'node may add another version’s browser beside it');
  assert.ok(install.indexOf('chown') > install.indexOf(' install --with-deps'), 'the chown comes after the download');
  assert.match(install, /rm -rf \/var\/lib\/apt\/lists\/\* \/root\/\.npm/, 'apt lists and the npm cache do not stay in the layer');
  const users = instructions.filter((l) => l.startsWith('USER '));
  assert.equal(users.at(-1), 'USER node', 'the image ends as node again');
  assert.ok(instructions.lastIndexOf('USER node') > installAt, 'after the install (which runs as root)');

  // The guard runs in the image's shell: an exact x.y.z passes, anything else ends the build. Run it for real.
  const guard = /echo "\$\{PLAYWRIGHT_VERSION\}" \| grep -Eq '([^']+)'/.exec(install);
  assert.ok(guard, 'the install starts with a version guard');
  const accepts = (v: string) => {
    try {
      execFileSync('sh', ['-c', `echo "${v}" | grep -Eq '${guard[1]}'`]);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(accepts(VERSION), true, VERSION);
  for (const bad of ['latest', '^1.50.0', '1.50', '1.50.0-beta', '1.50.0 x', 'next', '']) assert.equal(accepts(bad), false, bad);
});

test('the image labels itself with the Playwright version', () => {
  assert.match(DOCKERFILE, /^LABEL .*claudepilot\.playwright="\$\{PLAYWRIGHT_VERSION\}"/m);
});

test('docs/dev-session.md names the same Playwright version and the browsers folder', () => {
  assert.ok(DOCS.includes(`playwright@${VERSION}`), `the job-run docs say playwright@${VERSION} matches the baked browser`);
  assert.ok(DOCS.includes('PLAYWRIGHT_BROWSERS_PATH=/ms-playwright'), 'and where it is');
});
