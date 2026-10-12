// The service end to end: the real session host script and real git in a temporary home folder, a real store, fake chats. A scan finds
// the pool of repositories, keeps it, notices what changes, names who did it, and the few things the portal does on request
// (a worktree, a fast-forward sync) are audited and safe.

import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { RepoNode } from '@portal/contracts';
import { buildPool, chatSession, commitFile, reposHarness, WS, type Pool } from './testkit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { repoId } from './text.js';

let pool: Pool;
before(() => {
  pool = buildPool();
});

const nodeAt = (list: RepoNode[], path: string) => list.find((n) => n.path === path);
const id = (path: string) => repoId(WS, path);

describe('a scan of a pool of repositories', () => {
  let h: Awaited<ReturnType<typeof reposHarness>>;
  before(async () => {
    h = await reposHarness({ files: pool.files });
  });
  after(() => h.done());

  test('finds every repository, submodule, worktree and nested one, each tracked on its own, as a tree', async () => {
    const w = await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const paths = w.repos.map((n) => n.path);
    assert.ok(!paths.some((p) => p.includes('node_modules') || p.includes('.hidden')));
    const uni = nodeAt(w.repos, pool.path('uni'))!;
    assert.deepEqual([uni.kind, uni.parentId, uni.depth, uni.drifted], ['repo', null, 0, 1]);
    const a = nodeAt(w.repos, pool.path('uni', 'mods', 'a'))!;
    assert.deepEqual([a.kind, a.parentId, a.depth, a.name, a.submodule?.drifted], ['submodule', uni.id, 1, 'mods/a', true]);
    assert.equal(nodeAt(w.repos, pool.path('uni', 'mods', 'b'))!.submodule!.drifted, false);
    const uni2c = nodeAt(w.repos, pool.path('uni2', 'mods', 'c'))!;
    assert.deepEqual([nodeAt(w.repos, pool.path('uni', 'mods', 'c'))!.kind, uni2c.kind, uni2c.state, uni2c.submodule!.url], ['submodule', 'missing', null, pool.path('src-c')], 'cloned in uni, declared but not cloned in uni2');
    const helper = nodeAt(w.repos, pool.path('uni', 'tools', 'helper'))!;
    assert.deepEqual([helper.kind, helper.parentId, helper.name], ['nested', uni.id, 'tools/helper']);
    const proj = nodeAt(w.repos, pool.path('proj'))!;
    const wt = nodeAt(w.repos, pool.path('proj.worktrees', 'feat-x'))!;
    assert.deepEqual([wt.kind, wt.parentId, wt.mainId, wt.depth, wt.state!.branch], ['worktree', proj.id, proj.id, 1, 'feat/x']);
    assert.deepEqual([proj.state!.changes, proj.state!.head!.subject, proj.state!.head!.author], [{ staged: 1, unstaged: 1, untracked: 1, conflicted: 0 }, 'second: add two', 'Ann Author']);
    // the tree is parents first: every node comes after its parent
    for (const n of w.repos) if (n.parentId) assert.ok(w.repos.findIndex((p) => p.id === n.parentId) < w.repos.indexOf(n), `${n.name} comes after its parent`);
    assert.deepEqual([nodeAt(w.repos, pool.path('detached'))!.state!.detached, nodeAt(w.repos, pool.path('empty'))!.state!.unborn, nodeAt(w.repos, pool.path('stashy'))!.state!.stash], [true, true, 1]);
    const creds = nodeAt(w.repos, pool.path('creds'))!.state!.remotes;
    assert.deepEqual(creds.map((r) => [r.name, r.url, r.local]), [['origin', 'https://example.com/x/y.git', null], ['pilot', join(pool.files, '.claudepilot', 'git', 'proj.git'), 'proj']]);
    assert.equal(nodeAt(w.repos, pool.path('evil'))!.state!.filters, 1);
    assert.ok(w.scan.at && w.scan.ms !== null && !w.scan.truncated && !w.scan.error);
    assert.ok(w.summary.repos >= 15 && w.summary.worktrees === 1 && w.summary.missing === 1 && w.summary.drifted >= 1, JSON.stringify(w.summary));
    assert.deepEqual(['PWNED-fsmonitor', 'PWNED-hook', 'PWNED-filter', 'PWNED-smudge'].filter((m) => existsSync(join(pool.files, m))), [], 'nothing of the hostile repository ran');
  });

  test('the first scan reports what it found; a second finds nothing new, and tells open pages only when something changed', async () => {
    const first = h.repos.events({ workspaceId: WS, limit: 200 }).events;
    assert.ok(first.filter((e) => e.kind === 'discovered').length >= 12);
    assert.ok(first.filter((e) => e.kind === 'discovered').every((e) => e.data.initial === true && e.actor === 'workspace'));
    assert.equal(first.filter((e) => e.kind === 'worktree_added').length, 1);
    const before = first.length;
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.equal(h.repos.events({ workspaceId: WS, limit: 200 }).events.length, before, 'no news, no events');
  });

  test('a change in a repository is noticed once and told as what it is: commits with their authors, a branch switch, dirty and clean, a worktree added and gone, a repository gone', async () => {
    const synced = pool.path('synced');
    const stashy = pool.path('stashy');
    commitFile(pool, synced, 'new.txt', 'n\n', 'a new commit');
    pool.g(stashy, 'checkout', '-q', '-b', 'topic');
    writeFileSync(join(pool.path('detached'), 'scratch.txt'), 'x');
    pool.g(pool.path('proj'), 'worktree', 'add', '-q', '-b', 'feat/y', '../proj.worktrees/feat-y');
    pool.g(pool.path('proj'), 'worktree', 'remove', '--force', '../proj.worktrees/feat-x');
    rmSync(pool.path('creds'), { recursive: true, force: true });
    const since = Number(h.repos.events({ workspaceId: WS, limit: 1 }).events[0]!.id);
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const news = h.repos.events({ workspaceId: WS, limit: 100 }).events.filter((e) => Number(e.id) > since).map((e) => `${e.kind}:${e.repo}`).sort();
    assert.deepEqual(news, ['branch_changed:stashy', 'dirty:detached', 'head_moved:synced', 'removed:creds', 'worktree_added:proj', 'worktree_removed:proj']);
    const moved = h.repos.events({ workspaceId: WS, kind: 'head_moved' }).events[0]!;
    assert.deepEqual([moved.data.commits, moved.data.authors, moved.data.subjects, moved.data.fastForward], [1, ['Ann Author'], ['a new commit'], true]);
    assert.equal(moved.summary, 'synced: 1 new commit by Ann Author');
    const w = await h.repos.workspace(WS);
    assert.equal(nodeAt(w.repos, pool.path('creds')), undefined, 'a repository that is gone leaves the tree');
    assert.ok(nodeAt(w.repos, pool.path('proj.worktrees', 'feat-y')));
    // and it is quiet again
    const count = h.repos.events({ workspaceId: WS, limit: 200 }).events.length;
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.equal(h.repos.events({ workspaceId: WS, limit: 200 }).events.length, count);
    // clean again
    rmSync(join(pool.path('detached'), 'scratch.txt'));
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.equal(h.repos.events({ workspaceId: WS, kind: 'clean' }).events[0]!.repo, 'detached');
  });

  test('a change is put down to the one chat that was in the repository, and to the workspace when none or several were', async () => {
    const synced = pool.path('synced');
    const topic = pool.path('stashy');
    const empty = pool.path('empty');
    h.sessions.sessions = [
      chatSession({ id: 's1', cwd: join(synced, 'src') }),
      chatSession({ id: 's2', cwd: topic }),
      chatSession({ id: 's3', cwd: topic }),
      chatSession({ id: 'old', cwd: synced, state: 'ended', lastActivityAt: '2020-01-01T00:00:00.000Z' }),
      chatSession({ id: 'parked', cwd: empty, lastActivityAt: '2020-01-01T00:00:00.000Z' }),
    ];
    const since = Number(h.repos.events({ workspaceId: WS, limit: 1 }).events[0]!.id);
    commitFile(pool, synced, 'by-s1.txt', 's1\n', 'by the chat');
    commitFile(pool, topic, 'by-two.txt', 's\n', 'by one of two chats');
    commitFile(pool, pool.path('empty'), 'first.txt', 'f\n', 'first commit, nobody there');
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const news = h.repos.events({ workspaceId: WS, limit: 100 }).events.filter((e) => Number(e.id) > since && e.kind === 'head_moved');
    const by = (repo: string) => news.find((e) => e.repo === repo)!;
    assert.deepEqual([by('synced').actor, by('synced').sessionId], ['session:s1', 's1'], 'one chat in it, and a chat that ended long ago doesn’t count');
    assert.deepEqual([by('stashy').actor, by('stashy').sessionId, by('stashy').data.sessions?.sort()], ['workspace', null, ['s2', 's3']], 'two chats: the workspace’s own, with who could have');
    assert.equal(by('empty').actor, 'workspace', 'a chat parked there that did nothing since the last look is not blamed for what was done in a terminal');
    const w = await h.repos.workspace(WS);
    assert.deepEqual(nodeAt(w.repos, synced)!.sessions.map((s) => s.id), ['s1'], 'the chats running in a repository show on it');
    assert.deepEqual(nodeAt(w.repos, topic)!.sessions.map((s) => s.id).sort(), ['s2', 's3']);
    h.sessions.sessions = [];
  });

  test('the summary and the attention list: per workspace, worst first', async () => {
    const o = await h.repos.overview();
    assert.equal(o.workspaces.length, 1);
    assert.deepEqual(o.workspaces[0]!.summary, o.total);
    assert.ok(o.attention.length > 0 && o.attention.length <= 30);
    for (let i = 1; i < o.attention.length; i++) assert.ok(o.attention[i - 1]!.attention.score >= o.attention[i]!.attention.score);
    assert.ok(o.attention.every((n) => n.attention.reasons.length > 0));
    const d = h.repos.detail(id(pool.path('uni')));
    assert.equal(d.repo.name, 'uni');
    assert.deepEqual(d.children.map((c) => c.name).sort(), ['mods/a', 'mods/b', 'mods/c', 'tools/helper']);
    assert.throws(() => h.repos.detail('r_000000000000'), /No such repository/);
  });
});

test('a scan that hits a limit says so and removes nothing it did not see', async () => {
  const h = await reposHarness({ files: pool.files, config: { maxRepos: 10, depth: 6 } });
  try {
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const full = await reposHarness({ files: pool.files });
    try {
      await full.repos.scanWorkspace(WS, { actor: 'ui' });
      const before = (await full.repos.workspace(WS)).repos.length;
      assert.ok(before > 10);
      // the limited harness knows only what a limited walk found, and later walks the same limited way: nothing it knew is called gone
      const w = await h.repos.workspace(WS);
      assert.equal(w.scan.truncated, true);
      await h.repos.scanWorkspace(WS, { actor: 'ui' });
      assert.equal(h.repos.events({ workspaceId: WS, kind: 'removed' }).events.length, 0);
    } finally {
      full.done();
    }
  } finally {
    h.done();
  }
});

test('a stopped workspace is not scanned, and a workspace that can’t be reached is reported once', async () => {
  const stopped = await reposHarness({ files: pool.files, running: false });
  try {
    await assert.rejects(() => stopped.repos.scanWorkspace(WS, { actor: 'ui' }), /isn’t running/);
  } finally {
    stopped.done();
  }
  const broken = await reposHarness({ files: pool.files, host: { ensure: async () => Promise.reject(new Error('The workspace’s image is old.')), run: async () => ({ code: 0, out: '' }) } });
  try {
    await broken.repos.scanWorkspace(WS, { actor: 'ui' });
    await broken.repos.scanWorkspace(WS, { actor: 'ui' });
    const w = await broken.repos.workspace(WS);
    assert.equal(w.scan.error, 'The workspace’s image is old.');
    assert.deepEqual(broken.repos.events({ workspaceId: WS }).events.map((e) => e.kind), ['scan_failed'], 'told once while it keeps failing');
  } finally {
    broken.done();
  }
});

test('a workspace on a target that isn’t scanned (Kubernetes) is left alone: no scan, no timer, no worktree, nothing in the overview', async () => {
  const h = await reposHarness({ files: pool.files, config: { auto: true } });
  try {
    h.state.supported = false;
    await assert.rejects(() => h.repos.scanWorkspace(WS, { actor: 'ui' }), /Kubernetes/);
    await h.repos.tick();
    await h.repos.tick();
    assert.equal(h.calls().length, 0, 'not one command was run in it');
    assert.deepEqual([(await h.repos.workspace(WS)).running, (await h.repos.overview()).workspaces], [false, []]);
    await assert.rejects(() => h.repos.createWorktree(id(pool.path('proj')), {}, 'ui'), /No such repository|Kubernetes/);
    h.state.supported = true;
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    h.state.supported = false;
    await assert.rejects(() => h.repos.createWorktree(id(pool.path('proj')), {}, 'ui'), /Kubernetes/);
    await assert.rejects(() => h.repos.syncNow(id(pool.path('synced')), 'ui'), /Kubernetes/);
  } finally {
    h.done();
  }
});

test('the timer walks the folders every third interval, reads what it knows every time, and a repository that times out rests, longer each time, until someone asks', async () => {
  const clock = { t: Date.parse('2026-10-12T10:00:00Z') };
  const slowPath = pool.path('stashy');
  let slowOn = false;
  const base = (await import('./testkit.js')).localHost(pool.files);
  const host = {
    calls: base.calls,
    ensure: base.ensure,
    run: async (ws: string, args: string[]) => {
      const r = await base.run(ws, args);
      // the host "times out" on one repository: its record is replaced by what the script prints when git takes too long
      if (slowOn && args[0] === 'repo-state' && args.includes(slowPath)) r.out = r.out.replace(new RegExp(`R\\t${slowPath}\\n[\\s\\S]*?\\nZ\\n`), `R\t${slowPath}\nE\ttimeout\nZ\n`);
      return r;
    },
  };
  const h = await reposHarness({ files: pool.files, now: clock, host, config: { intervalS: 60 } });
  const finds = () => base.calls.filter((c) => c[0] === 'repo-find').length;
  const reads = (path: string) => base.calls.filter((c) => c[0] === 'repo-state' && c.includes(path)).length;
  try {
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.equal(finds(), 1, 'a request walks');
    pool.g(pool.work, 'init', '-q', '-b', 'main', 'late-arrival');
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(finds(), 1, 'the timer’s next round doesn’t walk');
    assert.equal((await h.repos.workspace(WS)).repos.some((n) => n.name === 'late-arrival'), false, 'a new repository waits for the next walk');
    assert.ok(reads(pool.path('proj')) >= 2, 'the ones it knows are read every round');
    clock.t += 130_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(finds(), 2, 'every third interval it walks');
    assert.ok((await h.repos.workspace(WS)).repos.some((n) => n.name === 'late-arrival'));
    // a repository that times out
    slowOn = true;
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    const slow = (await h.repos.workspace(WS)).repos.find((n) => n.path === slowPath)!;
    assert.deepEqual([slow.error, slow.state, slow.attention.reasons], ['timeout', null, ['error']]);
    const readsAfter = reads(slowPath);
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(reads(slowPath), readsAfter, 'it rests: the next round leaves it alone');
    assert.equal((await h.repos.workspace(WS)).repos.find((n) => n.path === slowPath)!.error, 'timeout', 'and what was known of it stays');
    slowOn = false;
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.equal(reads(slowPath), readsAfter + 1, 'a request reads it');
    assert.equal((await h.repos.workspace(WS)).repos.find((n) => n.path === slowPath)!.error, null);
    assert.equal(h.repos.events({ workspaceId: WS, kind: 'scan_failed' }).events.filter((e) => e.repo === 'stashy').length, 1, 'told once');
  } finally {
    h.done();
  }
});

test('open pages hear of a scan someone asked for and of a round that found something, not of a quiet round of the timer', async () => {
  const clock = { t: Date.parse('2026-10-12T10:00:00Z') };
  const h = await reposHarness({ files: pool.files, now: clock, config: { intervalS: 60 } });
  try {
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const after = h.changes();
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(h.changes(), after, 'nothing changed, nothing said');
    commitFile(pool, pool.path('empty'), 'f.txt', 'f', 'a commit');
    clock.t += 61_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer' });
    assert.equal(h.changes(), after + 1, 'a change is told');
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.equal(h.changes(), after + 2, 'a scan that was asked for is always answered');
  } finally {
    h.done();
  }
});

test('a request for one repository while everything is being scanned joins that scan; one while another repository is being scanned waits and then runs', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const base = (await import('./testkit.js')).localHost(pool.files);
  let held = false;
  const host = {
    ensure: async () => {
      if (!held) {
        held = true;
        await gate;
      }
    },
    run: base.run,
  };
  const h = await reposHarness({ files: pool.files, host });
  try {
    const full = h.repos.scanWorkspace(WS, { actor: 'ui' });
    const same = h.repos.scanWorkspace(WS, { actor: 'ui', scope: { path: pool.path('proj'), deep: true } });
    await sleep(30);
    assert.equal((await h.repos.workspace(WS)).scan.running, true);
    release();
    const [a, b] = await Promise.all([full, same]);
    assert.equal(a.repos.length, b.repos.length, 'the same scan answered both');
    assert.equal(base.calls.filter((c) => c[0] === 'repo-find').length, 1, 'once');
  } finally {
    h.done();
  }
});
