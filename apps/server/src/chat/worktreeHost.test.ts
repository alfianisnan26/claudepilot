// The session host's worktree commands (wt-add, wt-status, wt-list, wt-remove) against real repositories: what they accept, what
// they refuse, and, above all, that nothing the repository defines (hooks, filters, fsmonitor) runs while a worktree is made.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CP_SESSION } from './host.js';

let root: string;
let script: string;
const dirs: string[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-wt-script-'));
  script = join(root, 'cp-session');
  writeFileSync(script, CP_SESSION);
  chmodSync(script, 0o755);
});
after(() => {
  for (const d of [root, ...dirs]) rmSync(d, { recursive: true, force: true });
});

/** A files root with its own home-like folder, and an environment the host and git both run in (no global git configuration). */
function mkRoot() {
  const files = realpathSync(mkdtempSync(join(tmpdir(), 'cp-wt-files-')));
  dirs.push(files);
  const env = {
    ...process.env,
    CLAUDEPILOT_FILES_ROOT: files,
    CLAUDEPILOT_SESSIONS_DIR: join(files, '.claudepilot', 'sessions'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  return { files, env };
}

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

/** A repository at <files>/<name> with one commit on `main`. */
function mkRepo(files: string, env: NodeJS.ProcessEnv, name = 'proj', extra: (dir: string) => void = () => undefined) {
  const dir = join(files, name);
  mkdirSync(dir, { recursive: true });
  git(dir, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# proj\n');
  extra(dir);
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', 'first');
  return dir;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script, ...args], { env });
    let out = '';
    child.stdin.end();
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const fields = (out: string) => out.replace(/\n$/, '').split('\t');
const props = (out: string) => Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

test('wt-add makes a worktree of the repository on a new branch from the base, and says where, on what, from which commit', async () => {
  const { files, env } = mkRoot();
  const repo = mkRepo(files, env);
  const head = git(repo, env, 'rev-parse', 'HEAD');
  const wt = join(files, 'proj.worktrees', 'feat-x');
  const r = await run(['wt-add', repo, 'feat-x', 'feat/x', '-'], env);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fields(r.out), ['ok', wt, 'feat/x', head, repo, '']);
  assert.ok(existsSync(join(wt, 'README.md')), 'the files are checked out');
  assert.ok(lstatSync(join(wt, '.git')).isFile(), 'a linked worktree: .git is a file');
  assert.equal(git(wt, env, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/x');
  assert.equal(git(repo, env, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the repository itself is untouched');

  // From a base that isn't HEAD, and from a subfolder of the repository: the relative folder comes back.
  mkdirSync(join(repo, 'api'));
  writeFileSync(join(repo, 'api', 'a.txt'), 'a');
  git(repo, env, 'add', '-A');
  git(repo, env, 'commit', '-q', '-m', 'api');
  const second = join(files, 'proj.worktrees', 'from-first');
  const r2 = await run(['wt-add', join(repo, 'api'), 'from-first', 'from/first', head], env);
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(fields(r2.out), ['ok', second, 'from/first', head, repo, '/api']);
  assert.ok(!existsSync(join(second, 'api', 'a.txt')), 'the base’s tree, not the repository’s latest');
  // An existing branch no other worktree has is checked out as it is.
  git(repo, env, 'branch', 'existing');
  const third = join(files, 'proj.worktrees', 'existing');
  const r3 = await run(['wt-add', repo, 'existing', 'existing', '-'], env);
  assert.equal(r3.code, 0, r3.out);
  assert.equal(fields(r3.out)[2], 'existing');
});

test('wt-add refuses what it must: names, places and states, each with its own exit code, and leaves nothing behind', async () => {
  const { files, env } = mkRoot();
  const repo = mkRepo(files, env);
  const wt = (n: string) => join(files, 'proj.worktrees', n);
  const code = async (...args: string[]) => (await run(['wt-add', ...args], env)).code;

  for (const bad of ['', '-x', '--help', 'a..b', 'a b', 'x.lock', 'a//b', 'a/', 'a;b', 'a\nb', '$(id)', 'é', 'x'.repeat(101)]) assert.equal(await code(repo, 'b1', bad, '-'), 2, JSON.stringify(bad));
  for (const bad of ['', '-x', '--output=/tmp/x', 'a b', 'x;y', '$(id)']) assert.equal(await code(repo, 'b2', 'ok-branch', bad), 2, `base ${JSON.stringify(bad)}`);
  for (const bad of ['', '.hidden', '..', 'a/b', 'a b', 'x;y', '$(id)', 'x'.repeat(65)]) assert.equal(await code(repo, bad, 'ok-branch', '-'), 2, `leaf ${JSON.stringify(bad)}`);
  assert.equal(await code(join(files, 'not-there'), 'x', 'ok-branch', '-'), 2, 'a folder that is not there');
  assert.equal(await code(tmpdir(), 'x', 'ok-branch', '-'), 2, 'a folder outside the files root');
  assert.equal(await code(join(files, '.claudepilot'), 'x', 'ok-branch', '-'), 2, 'the portal’s own folder');
  mkdirSync(join(files, 'plain'));
  assert.equal(await code(join(files, 'plain'), 'x', 'ok-branch', '-'), 3, 'not a repository');
  assert.equal(await code(repo, 'x', 'ok-branch', 'no-such-base'), 5, 'unknown base');
  assert.equal(await code(repo, 'x', 'ok-branch', 'refs/heads/no-such'), 5);
  assert.ok(!existsSync(wt('x')), 'a refusal leaves no folder');
  assert.equal(git(repo, env, 'branch', '--list', 'ok-branch'), '', 'and no branch');

  // A folder that exists, a branch another worktree has, and a link where the worktree folder should be.
  assert.equal(await code(repo, 'one', 'one', '-'), 0);
  mkdirSync(wt('taken'), { recursive: true });
  assert.equal(await code(repo, 'taken', 'two', '-'), 6, 'the folder exists');
  assert.equal(await code(repo, 'another', 'one', '-'), 4, 'the branch is another worktree’s');
  assert.equal(await code(repo, 'another', 'main', '-'), 4, 'the branch the repository itself is on');
  rmSync(join(files, 'proj.worktrees'), { recursive: true, force: true });
  symlinkSync(tmpdir(), join(files, 'proj.worktrees'));
  assert.equal(await code(repo, 'linked', 'linked', '-'), 2, 'a link in place of the worktrees folder is never followed');
  rmSync(join(files, 'proj.worktrees'), { force: true });

  // The files root itself is not a repository a worktree can be made of.
  git(files, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(files, 'f.txt'), 'f');
  git(files, env, 'add', 'f.txt');
  git(files, env, 'commit', '-q', '-m', 'root');
  assert.equal(await code(files, 'r', 'rootb', '-'), 2, 'not a repository at the files root');
});

test('nothing the repository defines runs while a worktree is made: hooks, a hooks path, filters, fsmonitor', async () => {
  const { files, env } = mkRoot();
  const marker = join(files, 'RAN');
  const repo = mkRepo(files, env, 'proj', (dir) => {
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n');
    writeFileSync(join(dir, 'a.txt'), 'content\n');
  });
  // After the commit: everything a repository can define that would run on a checkout.
  const hook = `#!/bin/sh\ntouch ${marker}-hook\n`;
  for (const [dir, name] of [[join(repo, '.git', 'hooks'), 'post-checkout'], [join(repo, '.git', 'hooks'), 'reference-transaction'], [join(repo, '.githooks'), 'post-checkout']] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), hook);
    chmodSync(join(dir, name), 0o755);
  }
  git(repo, env, 'config', 'core.hooksPath', join(repo, '.githooks'));
  git(repo, env, 'config', 'filter.evil.smudge', `touch ${marker}-smudge; cat`);
  git(repo, env, 'config', 'filter.evil.clean', `touch ${marker}-clean; cat`);
  git(repo, env, 'config', 'filter.evil.process', `touch ${marker}-process`);
  git(repo, env, 'config', 'filter.evil.required', 'true');
  writeFileSync(join(repo, 'fsm.sh'), `#!/bin/sh\ntouch ${marker}-fsmonitor\n`);
  chmodSync(join(repo, 'fsm.sh'), 0o755);
  git(repo, env, 'config', 'core.fsmonitor', join(repo, 'fsm.sh'));

  const wt = join(files, 'proj.worktrees', 'safe');
  const r = await run(['wt-add', repo, 'safe', 'safe', '-'], env);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'content\n', 'the files are there, unfiltered');
  const status = await run(['wt-status', wt], env);
  assert.equal(status.code, 0, status.out);
  const list = await run(['wt-list', repo], env);
  assert.equal(list.code, 0, list.out);
  const removed = await run(['wt-remove', wt, 'safe'], env);
  assert.equal(removed.code, 0, removed.out);
  for (const kind of ['hook', 'smudge', 'clean', 'process', 'fsmonitor']) assert.ok(!existsSync(`${marker}-${kind}`), `${kind} ran`);
  // The proof that the markers would have appeared: the same repository, run by plain git.
  try {
    git(repo, env, 'worktree', 'add', '-q', join(files, 'plain-wt'), '-b', 'plain', 'HEAD');
  } catch {
    // the stand-in filter is no real process filter: git failing on it is the proof that it would have been started
  }
  assert.ok(existsSync(`${marker}-hook`) || existsSync(`${marker}-smudge`) || existsSync(`${marker}-process`), 'plain git does run them, so the test can fail');
});

test('wt-status reports what removing would lose: changes, untracked files, commits only this branch has', async () => {
  const { files, env } = mkRoot();
  const repo = mkRepo(files, env);
  const wt = join(files, 'proj.worktrees', 'st');
  assert.equal((await run(['wt-add', repo, 'st', 'st', '-'], env)).code, 0);
  const status = async () => props((await run(['wt-status', wt], env)).out);
  const head = git(repo, env, 'rev-parse', 'HEAD');
  assert.deepEqual(await status(), { dirty: '0', untracked: '0', unique: '0', branch: 'st', head });

  writeFileSync(join(wt, 'README.md'), 'changed\n');
  writeFileSync(join(wt, 'new.txt'), 'new\n');
  writeFileSync(join(wt, 'new2.txt'), 'new\n');
  assert.deepEqual(await status().then((s) => [s.dirty, s.untracked, s.unique]), ['1', '2', '0']);
  git(wt, env, 'add', '-A');
  git(wt, env, 'commit', '-q', '-m', 'work');
  assert.deepEqual(await status().then((s) => [s.dirty, s.untracked, s.unique]), ['0', '0', '1'], 'a commit only this branch has');
  git(repo, env, 'merge', '-q', '--ff-only', 'st');
  assert.equal((await status()).unique, '0', 'merged into main: nothing is only here');

  // A remote that has the commit also counts as having it.
  writeFileSync(join(wt, 'more.txt'), 'm');
  git(wt, env, 'add', '-A');
  git(wt, env, 'commit', '-q', '-m', 'more');
  assert.equal((await status()).unique, '1');
  const bare = join(files, 'remote.git');
  git(files, env, 'init', '-q', '--bare', bare);
  git(repo, env, 'remote', 'add', 'origin', bare);
  git(wt, env, 'push', '-q', 'origin', 'st');
  assert.equal((await status()).unique, '0', 'pushed');

  // Not a linked worktree (the repository itself), and not a folder that may be shown.
  assert.equal((await run(['wt-status', repo], env)).code, 2);
  assert.equal((await run(['wt-status', tmpdir()], env)).code, 2);
});

test('wt-list gives every worktree of the repository as JSON', async () => {
  const { files, env } = mkRoot();
  const repo = mkRepo(files, env);
  const a = join(files, 'proj.worktrees', 'a');
  const b = join(files, 'proj.worktrees', 'b');
  assert.equal((await run(['wt-add', repo, 'a', 'feat/a', '-'], env)).code, 0);
  assert.equal((await run(['wt-add', repo, 'b', 'feat/b', '-'], env)).code, 0);
  git(repo, env, 'worktree', 'lock', b);
  git(repo, env, 'worktree', 'add', '-q', '--detach', join(files, 'det'));
  const r = await run(['wt-list', a], env); // from inside one of them
  assert.equal(r.code, 0, r.out);
  const list = JSON.parse(r.out) as { path: string; branch: string | null; head: string; detached: boolean; locked: boolean; prunable: boolean }[];
  assert.deepEqual(list.map((w) => [w.path, w.branch, w.detached, w.locked]).sort(), [
    [repo, 'main', false, false],
    [a, 'feat/a', false, false],
    [b, 'feat/b', false, true],
    [join(files, 'det'), null, true, false],
  ].sort());
  assert.ok(list.every((w) => /^[0-9a-f]{40}$/.test(w.head)));
});

test('wt-remove: safe refuses a worktree with changes, force discards them, and the branch goes only when merged', async () => {
  const { files, env } = mkRoot();
  const repo = mkRepo(files, env);
  const wt = join(files, 'proj.worktrees', 'rm');
  assert.equal((await run(['wt-add', repo, 'rm', 'rm', '-'], env)).code, 0);
  writeFileSync(join(wt, 'scratch.txt'), 'unsaved\n');
  assert.equal((await run(['wt-remove', wt, 'safe'], env)).code, 7, 'an untracked file is something to lose');
  assert.ok(existsSync(join(wt, 'scratch.txt')), 'nothing was removed');
  assert.equal((await run(['wt-remove', wt, 'nonsense'], env)).code, 2);
  const forced = await run(['wt-remove', wt, 'force'], env);
  assert.equal(forced.code, 0, forced.out);
  assert.match(forced.out, /branch=deleted/, 'no commit of its own: merged, so the branch goes');
  assert.ok(!existsSync(wt));
  assert.equal(git(repo, env, 'branch', '--list', 'rm'), '');

  // A branch with a commit only it has: the folder goes, the branch (and the commit) stay.
  const wt2 = join(files, 'proj.worktrees', 'keep');
  assert.equal((await run(['wt-add', repo, 'keep', 'keep', '-'], env)).code, 0);
  writeFileSync(join(wt2, 'f.txt'), 'f');
  git(wt2, env, 'add', '-A');
  git(wt2, env, 'commit', '-q', '-m', 'only here');
  const clean = await run(['wt-remove', wt2, 'safe'], env);
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /branch=kept/);
  assert.equal(git(repo, env, 'log', '-1', '--format=%s', 'keep'), 'only here', 'the commit is still there');
  // Not a linked worktree: the repository itself is never removed.
  assert.equal((await run(['wt-remove', repo, 'force'], env)).code, 2);
  assert.ok(existsSync(join(repo, '.git')));
});
