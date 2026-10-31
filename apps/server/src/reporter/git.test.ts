// The UI reporter's real git runner (git.ts) against a temporary repository: checkout discovery by remote, `merge-base --is-ancestor`
// exit codes, the `Ticket:` trailer search (exact refs only), and whether an observed commit exists. The workspace exec is a local
// child process with the same argument list the portal sends into a workspace (no shell).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ReposOverview, WorkspaceRepos } from '@portal/contracts';
import { remoteNames, workspaceGit, type GitExec } from './git.js';

const REPO = 'platform/konfersi-landing-page';

function repoFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-reporter-git-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim();
  let n = 0;
  const commit = (message: string) => {
    writeFileSync(join(dir, 'f.txt'), String(++n));
    git('add', 'f.txt');
    git('commit', '-q', '--no-gpg-sign', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', `git@gitea.example:${REPO}.git`);
  const base = commit('base');
  const fix = commit('Fix the hero\n\nTicket: KONF-7');
  const near = commit('Something else\n\nTicket: KONF-70');
  const live = commit('Later work');
  git('checkout', '-q', '-b', 'side', base);
  const side = commit('Side work\n\nTicket: T-9');
  git('checkout', '-q', 'main');
  return { dir, base, fix, near, live, side, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The workspace exec as the portal's: an argument list, output chunks, the exit code, close. */
const localExec = async (_ws: string, command: string[]): Promise<GitExec> => {
  const p = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  return {
    onData: (cb) => {
      p.stdout.on('data', cb);
      p.stderr.on('data', () => undefined);
    },
    onExit: (cb) => void p.on('close', (code) => cb(code)),
    close: () => void (p.exitCode === null && p.kill()),
  };
};

function runner(dir: string, remote = `git@gitea.example:${REPO}.git`) {
  const repos = {
    overview: async () => ({ workspaces: [{ workspaceId: 'docker/konf', running: true }] }) as unknown as ReposOverview,
    workspace: async () => ({ repos: [{ kind: 'repo', path: dir, state: { remotes: [{ name: 'origin', url: remote }] } }] }) as unknown as WorkspaceRepos,
  };
  return workspaceGit({ repos, exec: localExec, timeoutMs: 10_000 });
}

test('git: is-ancestor maps 0 to true, 1 to false and anything else (an unknown commit) to unknown', async () => {
  const r = repoFixture();
  try {
    const git = runner(r.dir);
    assert.equal(await git.isAncestor(REPO, r.fix, r.live), true, 'the fix is in the live commit');
    assert.equal(await git.isAncestor(REPO, r.fix.slice(0, 12), r.live), true, 'a short sha');
    assert.equal(await git.isAncestor(REPO, r.side, r.live), false, 'a side branch is not');
    assert.equal(await git.isAncestor(REPO, r.live, r.fix), false, 'a later commit is not in an earlier one');
    assert.equal(await git.isAncestor(REPO, '0123456789abcdef0123456789abcdef01234567', r.live), null, 'a commit this checkout does not have');
    assert.equal(await git.isAncestor(REPO, 'not-a-sha', r.live), null, 'never passed to git');
  } finally {
    r.done();
  }
});

test('git: the Ticket trailer search finds exactly the refs asked for, on every branch', async () => {
  const r = repoFixture();
  try {
    const git = runner(r.dir);
    assert.deepEqual(await git.trailerCommits(REPO, ['KONF-7']), [r.fix], 'KONF-70 is not KONF-7');
    assert.deepEqual((await git.trailerCommits(REPO, ['KONF-7', 'T-9']))!.sort(), [r.fix, r.side].sort(), 'the key and the stable id, any branch');
    assert.deepEqual(await git.trailerCommits(REPO, ['KONF-8']), []);
    assert.deepEqual(await git.trailerCommits(REPO, ['KONF-7|.*', '$(id)']), [], 'refs that are not refs never reach git');
  } finally {
    r.done();
  }
});

test('git: whether an observed commit exists; no checkout of the repo is unknown, never a guess', async () => {
  const r = repoFixture();
  try {
    const git = runner(r.dir);
    assert.equal(await git.commitExists(REPO, r.live), true);
    assert.equal(await git.commitExists(REPO, r.base.slice(0, 7)), true, 'a short sha');
    assert.equal(await git.commitExists(REPO, '0123456789abcdef0123456789abcdef01234567'), false, 'a commit nobody made (a forged meta tag)');
    assert.equal(await git.commitExists(REPO, 'zz'), false);
    const elsewhere = runner(r.dir, 'git@gitea.example:someone/else.git');
    assert.equal(await elsewhere.commitExists(REPO, r.live), null, 'no workspace has this repo');
    assert.equal(await elsewhere.isAncestor(REPO, r.fix, r.live), null);
    assert.equal(await elsewhere.trailerCommits(REPO, ['KONF-7']), null);
  } finally {
    r.done();
  }
});

test('git: a remote names the repo on any host, with or without .git', () => {
  assert.ok(remoteNames(`https://gitea.example/${REPO}.git`, REPO));
  assert.ok(remoteNames(`git@gitea.example:${REPO}`, REPO));
  assert.ok(!remoteNames(`https://gitea.example/x${REPO}`, REPO));
  assert.ok(!remoteNames('https://gitea.example/platform/konfersi-landing-page-v2', REPO));
});
