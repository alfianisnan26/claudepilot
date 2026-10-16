// T-736: tools/qa/rtk-history.sh rewrites the checkout it runs in, so it must refuse outside a job-run Job or on a dirty tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = join(ROOT, 'tools/qa/rtk-history.sh');

/** A scratch repo holding a copy of the script, one committed .ts file and an uncommitted edit of it. */
function scratchRepo() {
  const dir = tempDirectory('rtk-guard-');
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  mkdirSync(join(dir, 'tools/qa'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'tools/qa/rtk-history.sh'));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2; // uncommitted\n');
  return { dir, git };
}

function run(dir: string, marker: boolean) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir, RTK_BIN: '/nonexistent/rtk' };
  if (marker) env.JR_REPO_URL = 'https://example.invalid/repo.git';
  return spawnSync('bash', [join(dir, 'tools/qa/rtk-history.sh'), join(dir, 'out')], { cwd: dir, env, encoding: 'utf8' });
}

test('without the Job marker it refuses and leaves an uncommitted change intact', () => {
  const { dir, git } = scratchRepo();
  const before = git('status', '--porcelain');
  const r = run(dir, false);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /refusing/);
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'export const a = 2; // uncommitted\n');
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(existsSync(join(dir, 'out')), false);
});

test('with the marker but a dirty tree it still refuses and touches nothing', () => {
  const { dir, git } = scratchRepo();
  const before = git('status', '--porcelain');
  const r = run(dir, true);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'export const a = 2; // uncommitted\n');
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(existsSync(join(dir, 'out')), false);
});
