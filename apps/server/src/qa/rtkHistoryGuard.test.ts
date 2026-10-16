// T-736: the rtk measurement scripts (tools/qa/rtk-history.sh, rtk-classes.sh, rtk-measure.sh) rewrite the checkout they run in, so they
// share one guard (tools/qa/rtk-guard.sh): refuse outside a job-run Job (JR_REPO_URL) and unless `git status` succeeds and is clean.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPTS = ['rtk-history.sh', 'rtk-classes.sh', 'rtk-measure.sh'] as const;
const FILES = [...SCRIPTS, 'rtk-guard.sh'];
const EDITED = 'export const a = 2; // uncommitted\n';

/** The argument list each script needs (the out folder is inside the scratch repo's parent, so a clean tree stays clean). */
const outOf = (dir: string) => join(dir, '..', `${dir.split('/').pop()}-out`);
function args(script: string, dir: string): string[] {
  return script === 'rtk-measure.sh' ? ['light', outOf(dir), dir, 'scratch'] : [outOf(dir)];
}

/** A scratch repo holding copies of the scripts and one committed .ts file (clean). */
function scratchRepo() {
  const dir = tempDirectory('rtk-guard-');
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  mkdirSync(join(dir, 'tools/qa'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of FILES) copyFileSync(join(ROOT, 'tools/qa', f), join(dir, 'tools/qa', f));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

/** A stub rtk: records that it ran, then ends the calling script (its parent), so a run past the guard is short. */
function stubRtk(dir: string) {
  const bin = join(dir, '..', `${dir.split('/').pop()}-stub-rtk`);
  const sentinel = `${bin}.ran`;
  writeFileSync(bin, `#!/bin/sh\ntouch '${sentinel}'\nkill -TERM $PPID 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  return { bin, sentinel };
}

/** A second, independent repo with a committed file under apps/server/src/chat (what rtk-measure.sh light claudepilot rewrites). */
function otherRepo() {
  const dir = tempDirectory('rtk-guard-other-');
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  mkdirSync(join(dir, 'apps/server/src/chat'), { recursive: true });
  writeFileSync(join(dir, 'apps/server/src/chat/a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git, file: join(dir, 'apps/server/src/chat/a.ts') };
}

function run(dir: string, script: string, opts: { marker: boolean; rtk?: string; cwd?: string; args?: string[] }) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    RTK_BIN: opts.rtk ?? '/nonexistent/rtk',
    GIT_CEILING_DIRECTORIES: dirname(dir), // never find a repository above the scratch folder
  };
  if (opts.marker) env.JR_REPO_URL = 'https://example.invalid/repo.git';
  return spawnSync('bash', [join(dir, 'tools/qa', script), ...(opts.args ?? args(script, dir))], { cwd: opts.cwd ?? dir, env, encoding: 'utf8', timeout: 60_000 });
}

for (const script of SCRIPTS) {
  test(`${script}: without the Job marker it refuses, even on a clean tree`, () => {
    const { dir, git } = scratchRepo();
    const r = run(dir, script, { marker: false });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing.*JR_REPO_URL/);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: with the marker but an uncommitted edit it refuses and touches nothing`, () => {
    const { dir, git } = scratchRepo();
    writeFileSync(join(dir, 'src/a.ts'), EDITED);
    const before = git('status', '--porcelain');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), EDITED);
    assert.equal(git('status', '--porcelain'), before);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: a staged-only change refuses`, () => {
    const { dir, git } = scratchRepo();
    writeFileSync(join(dir, 'src/a.ts'), EDITED);
    git('add', 'src/a.ts');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(git('diff', '--cached', '--name-only').trim(), 'src/a.ts');
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: an untracked-only file refuses`, () => {
    const { dir } = scratchRepo();
    writeFileSync(join(dir, 'new.txt'), 'x\n');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'x\n');
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: when git status fails (no repository) it refuses and writes nothing`, () => {
    const { dir } = scratchRepo();
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /git status failed/);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: run with the cwd OUTSIDE its tree (a clean other repo), a dirty own tree still refuses`, () => {
    const { dir } = scratchRepo();
    writeFileSync(join(dir, 'src/a.ts'), EDITED);
    const clean = otherRepo(); // git status in the cwd would read clean
    const r = run(dir, script, { marker: true, cwd: clean.dir });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), EDITED);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: a missing guard file refuses (fail closed), nothing is written`, () => {
    const { dir, git } = scratchRepo();
    rmSync(join(dir, 'tools/qa/rtk-guard.sh'));
    git('add', '-A');
    git('commit', '-q', '-m', 'no guard');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot load/);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: a guard file that does not define rtk_guard refuses`, () => {
    const { dir, git } = scratchRepo();
    writeFileSync(join(dir, 'tools/qa/rtk-guard.sh'), '# empty\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'empty guard');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /rtk_guard is not defined/);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: marker set and clean tree gets past the guard (the stub rtk runs)`, () => {
    const { dir } = scratchRepo();
    const { bin, sentinel } = stubRtk(dir);
    const r = run(dir, script, { marker: true, rtk: bin });
    assert.doesNotMatch(r.stderr, /refusing/, r.stderr);
    assert.equal(existsSync(sentinel), true, `the stub never ran: ${r.stdout}${r.stderr}`);
    assert.equal(existsSync(outOf(dir)), true);
  });
}

/** rtk-measure.sh light <out> <other repo> claudepilot resets the OTHER repo, so that one is guarded too. */
const lightArgs = (dir: string, other: string) => ['light', outOf(dir), other, 'claudepilot'];

test('rtk-measure.sh light claudepilot: a dirty OTHER repo refuses, its edit survives, no out folder', () => {
  const { dir } = scratchRepo(); // clean own repo
  const o = otherRepo();
  writeFileSync(o.file, EDITED);
  const { bin } = stubRtk(dir);
  const r = run(dir, 'rtk-measure.sh', { marker: true, rtk: bin, args: lightArgs(dir, o.dir) });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(readFileSync(o.file, 'utf8'), EDITED);
  assert.equal(existsSync(outOf(dir)), false);
});

test('rtk-measure.sh light claudepilot: a dirty OTHER repo refuses with the cwd outside both repos', () => {
  const { dir } = scratchRepo();
  const o = otherRepo();
  const elsewhere = otherRepo(); // a clean repo as the cwd: a status in the cwd would read clean
  writeFileSync(o.file, EDITED);
  const { bin } = stubRtk(dir);
  const r = run(dir, 'rtk-measure.sh', { marker: true, rtk: bin, cwd: elsewhere.dir, args: lightArgs(dir, o.dir) });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(readFileSync(o.file, 'utf8'), EDITED);
  assert.equal(existsSync(outOf(dir)), false);
});

test('rtk-measure.sh light claudepilot: a clean other repo gets past the guard (the stub rtk runs)', () => {
  const { dir } = scratchRepo();
  const o = otherRepo();
  const { bin, sentinel } = stubRtk(dir);
  const r = run(dir, 'rtk-measure.sh', { marker: true, rtk: bin, args: lightArgs(dir, o.dir) });
  assert.doesNotMatch(r.stderr, /refusing/, r.stderr);
  assert.equal(existsSync(sentinel), true, `the stub never ran: ${r.stdout}${r.stderr}`);
});

test('every curl in the three scripts has --max-time and --retry', () => {
  for (const script of SCRIPTS) {
    const curls = readFileSync(join(ROOT, 'tools/qa', script), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#') && /\bcurl\b/.test(l));
    assert.ok(curls.length >= 1, `${script} has no curl line (the check would test nothing)`);
    for (const l of curls) {
      assert.match(l, /--max-time \d+/, `${script}: ${l}`);
      assert.match(l, /--retry \d+/, `${script}: ${l}`);
    }
  }
});

test('the three scripts source the shared guard before they write anything', () => {
  for (const script of SCRIPTS) {
    const lines = readFileSync(join(ROOT, 'tools/qa', script), 'utf8').split('\n');
    const guard = lines.findIndex((l) => /rtk_guard rtk-/.test(l));
    assert.ok(guard >= 0, `${script} does not call rtk_guard`);
    const firstWrite = lines.findIndex((l) => !l.trimStart().startsWith('#') && /mkdir|git (reset|checkout)|>>? *"/.test(l));
    assert.ok(firstWrite < 0 || guard < firstWrite, `${script}: a write comes before the guard (line ${firstWrite + 1})`);
  }
});

test('each script cds into the guarded folder after the guard and before its first git call (what the rtk-guard.sh header says)', () => {
  for (const script of SCRIPTS) {
    const lines = readFileSync(join(ROOT, 'tools/qa', script), 'utf8').split('\n');
    const code = (i: number) => !lines[i].trimStart().startsWith('#');
    const guard = lines.findIndex((l, i) => code(i) && /rtk_guard rtk-/.test(l));
    const cd = lines.findIndex((l, i) => code(i) && /\bcd "\$(here|repo)"/.test(l));
    const git = lines.findIndex((l, i) => code(i) && /\bgit (-c |ls-files|rev-|remote|fetch|status|reset|checkout|rm |mv |add |commit)/.test(l));
    assert.ok(guard >= 0 && cd > guard, `${script}: no cd into the guarded folder after the guard`);
    assert.ok(git > cd, `${script}: a git call (line ${git + 1}) comes before the cd (line ${cd + 1})`);
  }
});

test('rtk-classes.sh on a repo without docs/prd: no pathspec error on stderr', () => {
  const { dir } = scratchRepo();
  // An rtk that answers --version and declines every rewrite, so the script runs on to the end instead of stopping at the first call.
  const bin = join(dir, '..', `${dir.split('/').pop()}-plain-rtk`);
  writeFileSync(bin, '#!/bin/sh\n[ "$1" = --version ] && echo rtk-stub\nexit 1\n', { mode: 0o755 });
  const r = run(dir, 'rtk-classes.sh', { marker: true, rtk: bin });
  assert.doesNotMatch(r.stderr, /pathspec/, r.stderr);
  assert.ok(existsSync(join(outOf(dir), 'tools.tsv')), `the script did not get past its set-up: ${r.stderr}`);
});
