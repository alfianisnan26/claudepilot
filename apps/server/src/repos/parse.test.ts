// What the host printed, parsed: well-formed output becomes typed records; hostile or broken output becomes less, never more.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUrl, localRemoteName, plain, repoId, validRefName, absPath, relPath } from './text.js';
import { parseFind, parseState, parseSync } from './parse.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

test('repo-find output: repositories by folder, links and odd entries dropped, limits noted, duplicates once', () => {
  const f = parseFind(
    ['#root\t/home/node', 'd\twork/a/.git', 'f\twork/b/.git', 'l\twork/link/.git', 'd\t.git', 'd\twork/a/.git', 'd\t../x/.git', 'd\twork/c/not-git', 'x\twork/d/.git', 'd\twork/e\tf/.git', '#truncated', '#timeout'].join('\n'),
  );
  assert.deepEqual(f.repos, [
    { path: '/home/node/work/a', type: 'd' },
    { path: '/home/node/work/b', type: 'f' },
    { path: '/home/node', type: 'd' },
  ]);
  assert.equal(f.root, '/home/node');
  assert.ok(f.truncated && f.timedOut);
  assert.deepEqual(parseFind('d\twork/a/.git\n').repos, [], 'nothing counts before the root line');
  assert.equal(parseFind('#root\trelative/path\nd\ta/.git').repos.length, 0, 'the root must be absolute');
});

const record = (...lines: string[]) => ['R\t/home/node/work/a', ...lines, 'Z'].join('\n');

test('repo-state records are typed and clipped', () => {
  const [r] = parseState(
    record(
      'T\t/home/node/work/a/.git\t/home/node/work/a/.git\t',
      `B\tmain\t${SHA}`,
      'D\t1\t2\t3\t4',
      'Q\ttools/',
      'Q\t/abs/',
      'Q\t../up/',
      'U\torigin/main\t5\t6',
      `H\t${SHA}\t2026-10-12T04:35:01+07:00\tAnn Author\tFix: the thing\twith a tab`,
      'S\t2',
      'P\t7',
      'X\tremote.origin.url https://u:pw@example.com/x.git?t=1',
      'X\tremote.origin.pushurl git@example.com:x/y.git',
      'X\tremote.pilot.url /home/node/.claudepilot/git/proj.git',
      'M\trebase',
      'L\t2',
      'F\t1760000000',
      `W\t/home/node/work/a\t${SHA}\tmain\t`,
      `W\t/home/node/work/a.worktrees/x\t${SHA2}\tfeat/x\tl`,
      'W\trelative\tx\ty\t',
      'Y\tsubmodule.mods/a.path mods/a',
      'Y\tsubmodule.mods/a.url https://u:pw@example.com/a.git',
      `N\t160000 ${SHA2} 0\tmods/a`,
      'N\t100644 abc 0\tnot-a-gitlink',
    ),
  );
  assert.ok(r);
  assert.equal(r.error, null);
  assert.deepEqual([r.branch, r.detached, r.unborn, r.oid], ['main', false, false, SHA]);
  assert.deepEqual(r.changes, { staged: 1, unstaged: 2, untracked: 3, conflicted: 4 });
  assert.deepEqual(r.untrackedDirs, ['tools'], 'folders, relative and inside only');
  assert.deepEqual(r.upstream, { name: 'origin/main', ahead: 5, behind: 6, gone: false });
  assert.deepEqual(r.head, { sha: SHA, at: '2026-10-11T21:35:01Z', author: 'Ann Author', subject: 'Fix: the thing with a tab' });
  assert.deepEqual([r.stash, r.unpushed, r.operation, r.filters, r.fetchedAtMs], [2, 7, 'rebase', 2, 1_760_000_000_000]);
  assert.deepEqual(r.remotes, [
    { name: 'origin', url: 'https://example.com/x.git', pushUrl: 'git@example.com:x/y.git', local: null },
    { name: 'pilot', url: '/home/node/.claudepilot/git/proj.git', pushUrl: null, local: 'proj' },
  ]);
  assert.deepEqual(r.worktrees.map((w) => [w.path, w.branch, w.locked]), [['/home/node/work/a', 'main', false], ['/home/node/work/a.worktrees/x', 'feat/x', true]]);
  assert.deepEqual(r.modules, [{ name: 'mods/a', path: 'mods/a', url: 'https://example.com/a.git' }]);
  assert.deepEqual(r.gitlinks, [{ path: 'mods/a', sha: SHA2 }]);
});

test('detached, unborn and gone upstreams; a gone upstream has no counts', () => {
  const [d] = parseState(record(`B\t(detached)\t${SHA}`, 'U\torigin/x\tgone'));
  assert.deepEqual([d!.branch, d!.detached, d!.upstream], [null, true, { name: 'origin/x', ahead: null, behind: null, gone: true }]);
  const [u] = parseState(record('B\tmain\t(initial)'));
  assert.deepEqual([u!.unborn, u!.oid, u!.branch], [true, null, 'main']);
});

test('commits since the last look: kind and commits; a rewritten history carries no count', () => {
  const [a] = parseState(record('K\tff\t3', `C\t${SHA}\tAnn\tone`, `C\t${SHA2}\tBob\ttwo`, 'C\tnot-a-sha\tx\ty'));
  assert.deepEqual(a!.log, { kind: 'ff', count: 3, commits: [{ sha: SHA, author: 'Ann', subject: 'one' }, { sha: SHA2, author: 'Bob', subject: 'two' }] });
  const [b] = parseState(record('K\trewritten', `C\t${SHA}\tAnn\tone`));
  assert.equal(b!.log!.count, null);
  assert.equal(parseState(record(`C\t${SHA}\tAnn\tone`))[0]!.log, null, 'a commit line without its kind is dropped');
});

test('errors, unfinished records and several records in one output', () => {
  const out = ['R\t/home/node/a', 'E\tnotrepo', 'Z', 'R\t/home/node/b', 'E\tsomething-new', 'Z', 'R\t/home/node/c', `B\tmain\t${SHA}`, 'R\t/home/node/d', `B\tmain\t${SHA}`].join('\n');
  const recs = parseState(out);
  assert.deepEqual(recs.map((r) => [r.path, r.error]), [['/home/node/a', 'notrepo'], ['/home/node/b', 'unreadable'], ['/home/node/c', 'unreadable'], ['/home/node/d', 'unreadable']]);
  assert.deepEqual(parseState('junk\nlines\n'), []);
  assert.deepEqual(parseState('R\trelative\nZ\n'), [], 'a record for a path that isn’t absolute is ignored');
});

test('hostile text is cleaned, clipped or dropped: no escape sequences, no bidi overrides, no huge fields, no credentials in URLs', () => {
  const evil = `\u001b[31mred\u001b[0m\u{202e} txet\u0007`;
  const [r] = parseState(
    record(
      `H\t${SHA}\t2026-10-12T04:35:01Z\t${'A'.repeat(500)}\t${evil}${'x'.repeat(1000)}`,
      `B\tfeat/${'x'.repeat(300)}\t${SHA}`,
      'X\tremote.bad name.url https://x',
      `X\tremote.ok.url https://user:secret@host/x.git#frag`,
      'X\tremote.ctl.url https://host/\u0001x',
      ...Array.from({ length: 30 }, (_, i) => `X\tremote.r${i}.url https://h/${i}`),
    ),
  );
  assert.ok(r!.head!.author!.length <= 80);
  assert.ok(r!.head!.subject.length <= 200);
  assert.ok(!/[\u001b\u0007\u{202e}]/u.test(r!.head!.subject), 'controls and bidi are gone');
  assert.equal(r!.branch, null, 'a branch name over the limit is not kept');
  assert.equal(r!.remotes.length, 20, 'at most 20 remotes');
  assert.equal(r!.remotes.find((x) => x.name === 'ok')!.url, 'https://host/x.git');
  assert.ok(!r!.remotes.some((x) => x.name === 'bad name' || x.name === 'ctl'));
});

test('repo-sync lines: the outcome and what it says, or nothing', () => {
  assert.deepEqual(parseSync(`sync\tupdated\t${SHA}\t${SHA2}\t0\t0\t\n`), { outcome: 'updated', from: SHA, to: SHA2, ahead: 0, behind: 0, note: null });
  assert.deepEqual(parseSync('sync\trefused\t\t\t1\t2\tit has diverged\n'), { outcome: 'refused', from: null, to: null, ahead: 1, behind: 2, note: 'it has diverged' });
  assert.equal(parseSync('sync\tmerged\t\t\t\t\t\n'), null, 'an outcome the portal doesn’t know');
  assert.equal(parseSync('hello\n'), null);
  assert.equal(parseSync(`sync\tfailed\t\t\t\t\t${'e'.repeat(1000)}\n`)!.note!.length, 200);
});

test('text helpers', () => {
  assert.equal(plain('  a \n\t b\u0000 ', 10), 'a b');
  assert.equal(plain('x'.repeat(20), 5), 'xxxx…');
  assert.equal(cleanUrl('https://user:pw@host/p?q=1#f'), 'https://host/p');
  assert.equal(cleanUrl('git@host:owner/repo.git'), 'git@host:owner/repo.git');
  assert.equal(cleanUrl('https://host/\nx'), '');
  assert.equal(localRemoteName('/home/node/.claudepilot/git/my-app.git'), 'my-app');
  assert.equal(localRemoteName('file:///home/node/.claudepilot/git/x.git'), 'x');
  assert.equal(localRemoteName('/home/node/other/x.git'), null);
  assert.equal(repoId('docker/a', '/home/node/x'), repoId('docker/a', '/home/node/x'));
  assert.notEqual(repoId('docker/a', '/home/node/x'), repoId('docker/b', '/home/node/x'));
  assert.match(repoId('docker/a', '/x'), /^r_[0-9a-f]{12}$/);
  assert.equal(validRefName('feat/x-1.2'), 'feat/x-1.2');
  for (const bad of ['', 'a b', 'a..b', '-x', 'a~b', 'a\u0001b', 'a:b']) assert.equal(validRefName(bad), null, JSON.stringify(bad));
  assert.equal(absPath('/a/b/../c'), null);
  assert.equal(absPath('/a//b/'), '/a/b');
  assert.equal(absPath('a/b'), null);
  assert.equal(relPath('mods/a'), 'mods/a');
  for (const bad of ['../x', '/x', 'a/../b', '"quoted"', '', 'a//b']) assert.equal(relPath(bad), null, bad);
});
