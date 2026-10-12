// The session host's repository commands (repo-find, repo-state, repo-sync) against real repositories: what they report, what they
// refuse, and, above all, that nothing a repository defines (a hook, a filter, an fsmonitor, an ssh command) runs while the portal looks
// at it or syncs it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { buildPool, commitFile, mkFiles, runScript, type Pool } from './testkit.js';

let pool: Pool;
before(() => {
  pool = buildPool();
});

const lines = (out: string) => out.split('\n').filter(Boolean);
/** The tagged lines of one record of repo-state, by tag. */
function record(out: string, path: string): Map<string, string[][]> {
  const m = new Map<string, string[][]>();
  let inside = false;
  for (const l of lines(out)) {
    const [tag, ...rest] = l.split('\t');
    if (tag === 'R') inside = rest[0] === path;
    else if (inside && tag) (m.get(tag) ?? m.set(tag, []).get(tag)!).push(rest);
  }
  return m;
}
const state = async (path: string, prev = '-') => record((await runScript(pool.files, ['repo-state', path, prev])).out, path);

test('repo-find lists the repositories under the home folder, skips hidden and dependency folders, and takes ~ and ~/folder', async () => {
  const r = await runScript(pool.files, ['repo-find', '~', '6', '200']);
  assert.equal(r.code, 0);
  const out = lines(r.out);
  assert.equal(out[0], `#root\t${pool.files}`);
  const found = out.slice(1).map((l) => l.split('\t'));
  const dirs = found.map(([, rel]) => rel!.replace(/\/\.git$/, ''));
  for (const want of ['work/proj', 'work/proj.worktrees/feat-x', 'work/uni', 'work/uni/mods/a', 'work/uni/tools/helper', 'work/uni2/mods/b', 'work/detached', 'work/empty', 'work/evil']) assert.ok(dirs.includes(want), `${want} found`);
  assert.ok(!dirs.includes('work/uni2/mods/c'), 'a submodule nobody cloned has no .git to find');
  assert.ok(!dirs.some((d) => d.includes('node_modules') || d.includes('.hidden')), 'dependency and hidden folders are not walked');
  assert.equal(found.find(([, rel]) => rel === 'work/proj/.git')![0], 'd');
  assert.equal(found.find(([, rel]) => rel === 'work/proj.worktrees/feat-x/.git')![0], 'f', 'a linked worktree has a .git file');
  const sub = await runScript(pool.files, ['repo-find', '~/work/uni', '4', '50']);
  assert.deepEqual(lines(sub.out).slice(0, 2), [`#root\t${join(pool.files, 'work', 'uni')}`, 'd\t.git']);
  assert.equal((await runScript(pool.files, ['repo-find', join(pool.work, 'uni'), '4', '50'])).out, sub.out, 'an absolute path under the home folder is the same');
});

test('repo-find is bounded: a count limit says so, depth limits the walk, and a folder outside the home or missing is refused', async () => {
  const few = await runScript(pool.files, ['repo-find', '~', '6', '3']);
  assert.equal(lines(few.out).filter((l) => /^[dfl]\t/.test(l)).length, 3);
  assert.ok(lines(few.out).includes('#truncated'));
  const shallow = await runScript(pool.files, ['repo-find', '~', '2', '200']);
  assert.ok(lines(shallow.out).some((l) => l === 'd\twork/proj/.git') === false, 'depth 2 stops above work/proj/.git');
  assert.equal((await runScript(pool.files, ['repo-find', '~', '3', '200'])).out.includes('work/proj/.git'), true);
  for (const bad of [['/etc', '3', '10'], ['~/nope', '3', '10'], ['~', '0', '10'], ['~', '3', '0'], ['~', '99', '10'], ['~', 'x', '10'], ['~/../..', '3', '10']]) {
    assert.equal((await runScript(pool.files, ['repo-find', ...bad])).code, 2, bad.join(' '));
  }
});

test('repo-find says so when the walk runs out of time, and keeps what it found', async () => {
  const fake = mkFiles('cp-repos-fakefind-');
  writeFileSync(join(fake, 'find'), '#!/bin/sh\nsleep 5\n');
  chmodSync(join(fake, 'find'), 0o755);
  const slow = await runScript(pool.files, ['repo-find', '~', '6', '200'], { CLAUDEPILOT_FIND_SECONDS: '1', PATH: `${fake}:${process.env.PATH}` });
  assert.equal(slow.code, 0);
  assert.deepEqual(lines(slow.out), [`#root\t${pool.files}`, '#timeout']);
});

test('repo-state reads a repository: branch, change counts, HEAD, stashes, no remote, worktrees', async () => {
  const s = await state(join(pool.work, 'proj'));
  const head = pool.g(pool.path('proj'), 'rev-parse', 'HEAD');
  assert.deepEqual(s.get('B'), [['main', head]]);
  assert.deepEqual(s.get('D'), [['1', '1', '1', '0']], 'one staged, one unstaged and one untracked file');
  const [sha, at, author, subject] = s.get('H')![0]!;
  assert.deepEqual([sha, author, subject], [head, 'Ann Author', 'second: add two']);
  assert.match(at!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[Z+-]/);
  assert.deepEqual(s.get('S'), [['0']]);
  assert.equal(s.get('P'), undefined, 'no remote: nothing to be unpushed to');
  assert.deepEqual(s.get('L'), [['0']]);
  assert.deepEqual(s.get('T'), [[join(pool.path('proj'), '.git'), join(pool.path('proj'), '.git'), '']]);
  assert.deepEqual(s.get('W')!.map((w) => [w[0], w[2]]), [[pool.path('proj'), 'main'], [pool.path('proj.worktrees', 'feat-x'), 'feat/x']]);
});

test('repo-state of a linked worktree says its git dir is not the common one; of a submodule, who its superproject is', async () => {
  const wt = await state(pool.path('proj.worktrees', 'feat-x'));
  const [gd, gc] = wt.get('T')![0]!;
  assert.equal(gd, join(pool.path('proj'), '.git', 'worktrees', 'feat-x'));
  assert.equal(gc, join(pool.path('proj'), '.git'));
  assert.equal(wt.get('W'), undefined, 'only the main working folder lists the worktrees');
  const sub = await state(pool.path('uni', 'mods', 'a'));
  assert.equal(sub.get('T')![0]![2], pool.path('uni'), 'show-superproject-working-tree');
  assert.deepEqual(sub.get('U'), [['origin/main', '1', '0']], 'one commit ahead of where it was cloned from');
  assert.deepEqual(sub.get('P'), [['1']]);
});

test('repo-state reports what a superproject declares and records, and the empty folder of a submodule nobody cloned is not taken for its superproject', async () => {
  const uni = await state(pool.path('uni'));
  assert.deepEqual(uni.get('Y')!.map((y) => y[0]!.split(' ')[0]).sort(), ['submodule.mods/a.path', 'submodule.mods/a.url', 'submodule.mods/b.path', 'submodule.mods/b.url', 'submodule.mods/c.path', 'submodule.mods/c.url']);
  assert.deepEqual(uni.get('N')!.map((n) => n[1]), ['mods/a', 'mods/b', 'mods/c']);
  assert.match(uni.get('N')![0]![0]!, /^160000 [0-9a-f]{40} 0$/);
  assert.deepEqual(uni.get('D'), [['0', '0', '1', '0']], 'a nested repository the superproject doesn’t record is just untracked to it');
  assert.deepEqual(uni.get('Q'), [['tools/']], 'and its untracked folder is listed, for the portal to leave out');
  const missing = await runScript(pool.files, ['repo-state', pool.path('uni2', 'mods', 'c'), '-']);
  assert.deepEqual(lines(missing.out), [`R\t${pool.path('uni2', 'mods', 'c')}`, 'E\tnotrepo', 'Z']);
});

test('repo-state: detached, no commit yet, a stash, an upstream that is ahead of nothing; remotes lose their credentials and a local remote is visible', async () => {
  assert.deepEqual((await state(pool.path('detached'))).get('B')![0]![0], '(detached)');
  assert.deepEqual((await state(pool.path('empty'))).get('B')![0], ['main', '(initial)']);
  assert.equal((await state(pool.path('empty'))).get('H'), undefined);
  assert.deepEqual((await state(pool.path('stashy'))).get('S'), [['1']]);
  const synced = await state(pool.path('synced'));
  assert.deepEqual(synced.get('U'), [['origin/main', '0', '0']]);
  const creds = await state(pool.path('creds'));
  const x = creds.get('X')!.map((r) => r[0]);
  assert.ok(x.includes('remote.origin.url https://example.com/x/y.git'), x.join('|'));
  assert.ok(x.some((v) => v!.startsWith('remote.pilot.url ') && v!.endsWith('/.claudepilot/git/proj.git')));
  assert.ok(!JSON.stringify([...creds]).includes('p@ss') && !JSON.stringify([...creds]).includes('token=abc'));
});

test('repo-state names the commits since the last look: a fast-forward lists them, a rewritten history or an unknown commit says so', async () => {
  const proj = pool.path('proj');
  const first = pool.g(proj, 'rev-parse', 'HEAD~1');
  const head = pool.g(proj, 'rev-parse', 'HEAD');
  const ff = await state(proj, first);
  assert.deepEqual(ff.get('K'), [['ff', '1']]);
  assert.deepEqual(ff.get('C'), [[head, 'Ann Author', 'second: add two']]);
  assert.deepEqual((await state(proj, '0123456789012345678901234567890123456789')).get('K'), [['unknown']]);
  assert.equal((await state(proj, head)).get('K'), undefined, 'nothing moved');
  assert.equal((await state(proj, 'not-a-sha')).get('K'), undefined, 'a value that isn’t a commit id is ignored');
  const rewritten = pool.g(pool.path('other'), 'rev-parse', 'HEAD');
  pool.g(proj, 'fetch', '-q', pool.path('other'), 'main');
  assert.deepEqual((await state(proj, rewritten)).get('K'), [['rewritten']], 'a commit that is in the repository but not an ancestor of HEAD');
});

test('repo-state refuses what it must and does not make up records', async () => {
  const bad = await runScript(pool.files, ['repo-state', '/etc', '-', pool.path('remote.git'), '-', pool.path('nope'), '-']);
  assert.deepEqual(lines(bad.out), ['R\t/etc', 'E\trefused', 'Z', `R\t${pool.path('remote.git')}`, 'E\tnotrepo', 'Z', `R\t${pool.path('nope')}`, 'E\trefused', 'Z']);
  assert.equal((await runScript(pool.files, ['repo-state', pool.path('proj')])).code, 2, 'a path without its pair');
  assert.equal((await runScript(pool.files, ['repo-state'])).code, 2);
  const many = await runScript(pool.files, ['repo-state', ...Array.from({ length: 21 }, () => [pool.path('proj'), '-']).flat()]);
  assert.equal(many.code, 2, 'at most 20 repositories a call');
});

test('nothing a repository defines runs while it is read or synced: not its fsmonitor, hook, clean or smudge filter, and a control run shows plain git would', async () => {
  const marks = ['PWNED-fsmonitor', 'PWNED-hook', 'PWNED-filter', 'PWNED-smudge'].map((m) => join(pool.files, m));
  const clear = () => marks.forEach((m) => rmSync(m, { force: true }));
  clear();
  // control: plain git in that repository runs the fsmonitor
  execFileSync('git', ['status', '--short'], { cwd: pool.path('evil'), env: pool.env, stdio: 'ignore' });
  assert.ok(existsSync(marks[0]!), 'plain git runs the repository’s fsmonitor (the control)');
  clear();
  const s = await state(pool.path('evil'));
  assert.deepEqual(s.get('L'), [['1']], 'it reports one filter, never running it');
  assert.equal(s.get('D')![0]![2], '3', 'the untracked files are counted');
  await runScript(pool.files, ['repo-sync', pool.path('evil')]);
  await runScript(pool.files, ['repo-find', '~', '6', '100']);
  assert.deepEqual(marks.filter((m) => existsSync(m)), [], 'no marker was written');
});

/** A clone of the bare remote, in a folder of its own, ready to be synced. */
function clone(name: string): string {
  pool.g(pool.work, 'clone', '-q', 'remote.git', name);
  return pool.path(name);
}
async function sync(path: string) {
  const r = await runScript(pool.files, ['repo-sync', path]);
  const f = lines(r.out).find((l) => l.startsWith('sync\t'))?.split('\t') ?? [];
  return { code: r.code, outcome: f[1], from: f[2], to: f[3], ahead: f[4], behind: f[5], note: f[6] ?? '' };
}
function pushFromOther(name: string) {
  commitFile(pool, pool.path('other'), `${name}.txt`, name, `other: ${name}`);
  pool.g(pool.path('other'), 'push', '-q', 'origin', 'main');
}

test('repo-sync fetches the upstream and fast-forwards a clean branch; run again it is current', async () => {
  const dir = clone('sync-ok');
  pushFromOther('ok1');
  const before = pool.g(dir, 'rev-parse', 'HEAD');
  const r = await sync(dir);
  assert.equal(r.outcome, 'updated');
  assert.equal(r.from, before);
  assert.equal(r.to, pool.g(dir, 'rev-parse', 'HEAD'));
  assert.notEqual(r.from, r.to);
  assert.equal(pool.g(dir, 'rev-parse', 'HEAD'), pool.g(pool.path('other'), 'rev-parse', 'HEAD'));
  const again = await sync(dir);
  assert.equal(again.outcome, 'current');
  assert.equal(again.from, again.to);
});

test('repo-sync leaves alone what it must: a diverged branch, changes to tracked files, a detached HEAD, no upstream, an operation in progress', async () => {
  const div = clone('sync-div');
  commitFile(pool, div, 'local.txt', 'l', 'local only');
  pushFromOther('div1');
  const d = await sync(div);
  assert.deepEqual([d.outcome, d.note, d.ahead, d.behind], ['refused', 'it has diverged', '1', '1']);
  assert.equal(pool.g(div, 'log', '-1', '--format=%s'), 'local only', 'nothing was merged, rebased or reset');

  const dirty = clone('sync-dirty');
  pushFromOther('dirty1');
  writeFileSync(join(dirty, 's.txt'), 'edited\n');
  const x = await sync(dirty);
  assert.deepEqual([x.outcome, x.note], ['refused', 'it has changes']);
  assert.equal(readFileSync(join(dirty, 's.txt'), 'utf8'), 'edited\n', 'the edit is untouched');
  // untracked files don't stop a fast-forward (git itself refuses to overwrite one)
  pool.g(dirty, 'checkout', '-q', '--', 's.txt');
  writeFileSync(join(dirty, 'scratch.txt'), 'mine\n');
  assert.equal((await sync(dirty)).outcome, 'updated');
  assert.equal(readFileSync(join(dirty, 'scratch.txt'), 'utf8'), 'mine\n');

  assert.deepEqual([(await sync(pool.path('detached'))).outcome, (await sync(pool.path('detached'))).note], ['refused', 'detached HEAD']);
  assert.equal((await sync(pool.path('evil'))).note, 'no upstream');
  assert.equal((await sync(pool.path('empty'))).note, 'no commit yet');
  const mid = clone('sync-mid');
  writeFileSync(join(mid, '.git', 'MERGE_HEAD'), `${pool.g(mid, 'rev-parse', 'HEAD')}\n`);
  assert.equal((await sync(mid)).note, 'an operation is in progress');
  assert.equal((await runScript(pool.files, ['repo-sync', pool.path('remote.git')])).code, 3, 'not a working folder');
  assert.equal((await runScript(pool.files, ['repo-sync', '/etc'])).code, 2);
});

test('repo-sync refuses a repository whose own settings run a program or change the fetch, and a URL it does not fetch from; nothing of theirs runs', async () => {
  const mark = join(pool.files, 'PWNED-ssh');
  rmSync(mark, { force: true });
  const hostile = clone('sync-hostile');
  pushFromOther('hostile1');
  pool.g(hostile, 'config', 'core.sshCommand', `touch ${mark}`);
  pool.g(hostile, 'config', 'credential.helper', `!touch ${mark}`);
  pool.g(hostile, 'config', 'url.ext::sh.insteadOf', 'x');
  const r = await sync(hostile);
  assert.equal(r.outcome, 'refused');
  assert.match(r.note, /^its own settings run programs or change the fetch: core\.sshcommand credential\.helper url\./);
  const include = clone('sync-include');
  pool.g(include, 'config', 'include.path', '../elsewhere.cfg');
  assert.match((await sync(include)).note, /include\.path/);
  const ext = clone('sync-ext');
  pool.g(ext, 'remote', 'set-url', 'origin', `ext::sh -c 'touch ${mark}'`);
  assert.equal((await sync(ext)).note, 'not a URL sync fetches from');
  assert.equal(existsSync(mark), false, 'no command of the repository ran');
});

test('repo-sync says why a fetch failed, in one line, and leaves the branch where it was', async () => {
  const dir = clone('sync-down');
  pool.g(dir, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/x.git');
  const before = pool.g(dir, 'rev-parse', 'HEAD');
  const r = await sync(dir);
  assert.equal(r.outcome, 'failed');
  assert.match(r.note, /127\.0\.0\.1/);
  assert.ok(!r.note.includes('\n'));
  assert.equal(pool.g(dir, 'rev-parse', 'HEAD'), before);
});

test('repo-track makes a worktree’s branch follow the remote branch it was started from, and writes nothing otherwise', async () => {
  const dir = clone('track-main');
  const wt = join(pool.work, 'track-main.worktrees', 'w1');
  pool.g(dir, 'worktree', 'add', '-q', '-b', 'w1', wt, pool.g(dir, 'rev-parse', 'origin/main'));
  assert.throws(() => pool.g(wt, 'rev-parse', '--abbrev-ref', '@{u}'), 'started from a commit id, it follows nothing');
  const r = await runScript(pool.files, ['repo-track', wt, 'origin/main']);
  assert.deepEqual([r.code, r.out.trim()], [0, 'tracking']);
  assert.equal(pool.g(wt, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
  const other = join(pool.work, 'track-main.worktrees', 'w2');
  pool.g(dir, 'worktree', 'add', '-q', '-b', 'w2', other, 'HEAD');
  const local = await runScript(pool.files, ['repo-track', other, 'main']);
  assert.deepEqual([local.code, local.out.trim()], [0, ''], 'a local branch as the base: nothing to follow');
  assert.throws(() => pool.g(other, 'rev-parse', '--abbrev-ref', '@{u}'));
  for (const bad of [[dir, 'origin/main'], ['/etc', 'origin/main'], [wt, '--help'], [wt, 'a b'], [wt, '']]) assert.equal((await runScript(pool.files, ['repo-track', ...bad])).code, 2, bad.join(' '));
});
