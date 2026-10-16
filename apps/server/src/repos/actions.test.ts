// What the portal does to repositories when asked, and on its own timer: worktrees made and removed, fast-forward syncs, "keep synced",
// settings, and the scans that follow a workspace's start and a chat's turn. Everything runs against real git through the real host
// script; every action is in the audit with who asked.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WORKTREE_DIRTY } from '@portal/contracts';
import { buildPool, chatSession, commitFile, reposHarness, WS } from './testkit.js';
import { repoId } from './text.js';

const id = (path: string) => repoId(WS, path);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rig(opts: Parameters<typeof reposHarness>[0] extends infer O ? Partial<O> : never = {}) {
  const pool = buildPool();
  const h = await reposHarness({ files: pool.files, ...opts });
  await h.repos.scanWorkspace(WS, { actor: 'ui' });
  return { pool, h };
}
const audit = (h: Awaited<ReturnType<typeof reposHarness>>) => h.repos.events({ workspaceId: WS, group: 'audit', limit: 50 }).events;

test('a worktree is made through the host, shows in the tree under its repository, and is told once, as the portal’s own doing', async () => {
  const { pool, h } = await rig();
  try {
    const proj = id(pool.path('proj'));
    const made = await h.repos.createWorktree(proj, { branch: 'feat/made' }, 'ui');
    assert.equal(made.branch, 'feat/made');
    assert.equal(made.commit, pool.g(pool.path('proj'), 'rev-parse', 'HEAD'));
    const wt = made.worktree;
    assert.deepEqual([wt.kind, wt.parentId, wt.mainId, wt.depth, wt.path, wt.state?.branch], ['worktree', proj, proj, 1, join(pool.work, 'proj.worktrees', 'feat-made'), 'feat/made']);
    assert.equal(wt.sync!.enabled, false);
    const news = h.repos.events({ workspaceId: WS, limit: 10 }).events;
    assert.deepEqual(news.filter((e) => e.kind === 'worktree_created').map((e) => [e.actor, e.repo, e.data.branch]), [['ui', 'proj', 'feat/made']]);
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const kinds = h.repos.events({ workspaceId: WS, limit: 200 }).events.filter((e) => e.data.branch === 'feat/made' || e.data.path === wt.path).map((e) => e.kind);
    assert.deepEqual(kinds, ['worktree_created'], 'a later scan doesn’t announce it again');
    // the default branch, an agent as the actor, and "keep synced" from the start
    const dflt = await h.repos.createWorktree(proj, { sync: true }, 'session:abc');
    assert.match(dflt.branch, /^wt\/[0-9a-f]{6}$/);
    assert.equal(dflt.worktree.sync!.enabled, true);
    const created = audit(h).find((e) => e.kind === 'worktree_created' && e.data.branch === dflt.branch)!;
    assert.deepEqual([created.actor, created.sessionId], ['session:abc', 'abc']);
    // T-6: a Portal MCP token's label is kept on the event, as it was then
    const viaMcp = await h.repos.createWorktree(proj, { branch: 'feat/by-mcp' }, 'portal-mcp:ptk_1', 'relay');
    const byMcp = audit(h).find((e) => e.kind === 'worktree_created' && e.data.branch === viaMcp.branch)!;
    assert.deepEqual([byMcp.actor, byMcp.actorLabel], ['portal-mcp:ptk_1', 'relay']);
    assert.equal(created.actorLabel, null, 'a session’s event has no token label');
    // a worktree of a worktree is a worktree of the same repository
    const again = await h.repos.createWorktree(wt.id, { branch: 'feat/from-wt', base: 'feat/made' }, 'ui');
    assert.equal(again.worktree.mainId, proj);
  } finally {
    h.done();
  }
});

test('a worktree request that can’t be done is refused with what to fix, and leaves nothing behind', async () => {
  const { pool, h } = await rig();
  try {
    const proj = id(pool.path('proj'));
    const worktreesBefore = pool.g(pool.path('proj'), 'worktree', 'list').split('\n').length;
    await assert.rejects(() => h.repos.createWorktree(proj, { branch: 'a..b' }, 'ui'), (e: { code: string }) => e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => h.repos.createWorktree(proj, { branch: 'feat/x' }, 'ui'), (e: { code: string }) => e.code === 'CONFLICT', 'checked out in another worktree');
    await assert.rejects(() => h.repos.createWorktree(proj, { branch: 'new', base: 'no-such-ref' }, 'ui'), (e: { code: string }) => e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => h.repos.createWorktree(proj, { branch: 5 as never }, 'ui'), (e: { code: string }) => e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => h.repos.createWorktree(id(pool.path('uni2', 'mods', 'c')), {}, 'ui'), /isn’t cloned/);
    await assert.rejects(() => h.repos.createWorktree('r_000000000000', {}, 'ui'), /No such repository/);
    assert.equal(pool.g(pool.path('proj'), 'worktree', 'list').split('\n').length, worktreesBefore);
    h.state.running = false;
    await assert.rejects(() => h.repos.createWorktree(proj, {}, 'ui'), /isn’t running/);
    assert.deepEqual(audit(h).filter((e) => e.kind === 'worktree_created'), []);
  } finally {
    h.done();
  }
});

test('removing a worktree: refused while it has changes or a chat that hasn’t ended uses it, forced only on request, its branch kept unless merged', async () => {
  const { pool, h } = await rig();
  try {
    const proj = id(pool.path('proj'));
    const clean = (await h.repos.createWorktree(proj, { branch: 'feat/clean' }, 'ui')).worktree;
    const r = await h.repos.removeWorktree(clean.id, 'safe', 'portal-mcp:tok1');
    assert.deepEqual(r, { branchDeleted: true });
    const gone = audit(h).find((e) => e.kind === 'worktree_deleted')!;
    assert.deepEqual([gone.actor, gone.repo, gone.data.branch, gone.data.forced, gone.data.branchDeleted], ['portal-mcp:tok1', 'proj', 'feat/clean', false, true]);
    assert.equal((await h.repos.workspace(WS)).repos.some((n) => n.id === clean.id), false);

    const dirty = (await h.repos.createWorktree(proj, { branch: 'feat/dirty' }, 'ui')).worktree;
    commitFile(pool, dirty.path, 'kept.txt', 'k\n', 'work on the branch');
    writeFileSync(join(dirty.path, 'a.txt'), 'edited\n');
    await assert.rejects(() => h.repos.removeWorktree(dirty.id, 'safe', 'ui'), (e: { code: string; status: number }) => e.code === WORKTREE_DIRTY && e.status === 409);
    h.sessions.sessions = [chatSession({ id: 'live', cwd: dirty.path })];
    await assert.rejects(() => h.repos.removeWorktree(dirty.id, 'force', 'ui'), /A chat uses it/);
    h.sessions.sessions = [chatSession({ id: 'asleep', cwd: dirty.path, process: 'asleep' })];
    await assert.rejects(() => h.repos.removeWorktree(dirty.id, 'force', 'ui'), /A chat uses it/, 'a chat that sleeps wakes up in its folder');
    h.sessions.sessions = [chatSession({ id: 'done', cwd: dirty.path, state: 'ended' })];
    h.sessions.sessions = [];
    const forced = await h.repos.removeWorktree(dirty.id, 'force', 'ui');
    assert.equal(forced.branchDeleted, false, 'its commit is on no other branch, so the branch stays');
    assert.ok(pool.g(pool.path('proj'), 'branch', '--list', 'feat/dirty'));
    assert.equal(audit(h).find((e) => e.kind === 'worktree_deleted' && e.data.forced === true)!.summary.includes('changes discarded'), true);
    await assert.rejects(() => h.repos.removeWorktree(proj, 'safe', 'ui'), /Only a worktree/);
  } finally {
    h.done();
  }
});

test('sync: a clean branch is fast-forwarded when asked; a diverged one is left alone and says why; both are in the audit, the commits put down to who asked', async () => {
  const { pool, h } = await rig();
  try {
    const synced = id(pool.path('synced'));
    commitFile(pool, pool.path('other'), 'pushed.txt', 'p\n', 'pushed by other');
    pool.g(pool.path('other'), 'push', '-q', 'origin', 'main');
    h.sessions.sessions = [chatSession({ id: 'nearby', cwd: pool.path('synced') })];
    const r = await h.repos.syncNow(synced, 'ui');
    assert.equal(r.outcome, 'updated');
    assert.equal(r.to, pool.g(pool.path('other'), 'rev-parse', 'HEAD'));
    assert.equal(r.repo.state!.head!.sha, r.to);
    const log = h.repos.events({ workspaceId: WS, repoId: synced, limit: 2 }).events;
    assert.deepEqual(log.map((e) => [e.kind, e.actor]), [['head_moved', 'ui'], ['sync', 'ui']], 'what the sync changed is the sync’s doing, not that of the chat that happened to be there');
    assert.ok(log[0]!.data.commits! >= 1);
    // diverged
    const div = id(pool.path('stashy'));
    commitFile(pool, pool.path('stashy'), 'local.txt', 'l\n', 'local only');
    commitFile(pool, pool.path('other'), 'pushed2.txt', 'p\n', 'pushed again');
    pool.g(pool.path('other'), 'push', '-q', 'origin', 'main');
    pool.g(pool.path('stashy'), 'remote', 'set-url', 'origin', pool.path('remote.git'));
    pool.g(pool.path('stashy'), 'fetch', '-q', 'origin');
    pool.g(pool.path('stashy'), 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    const d = await h.repos.syncNow(div, 'ui');
    assert.deepEqual([d.outcome, d.note], ['refused', 'it has diverged']);
    assert.equal(pool.g(pool.path('stashy'), 'log', '-1', '--format=%s'), 'local only');
    const sync = audit(h).filter((e) => e.kind === 'sync');
    assert.deepEqual(sync.map((e) => [e.data.outcome, e.data.error ?? null]), [['refused', 'it has diverged'], ['updated', null]]);
    await assert.rejects(() => h.repos.syncNow(id(pool.path('uni2', 'mods', 'c')), 'ui'), /isn’t cloned/);
    const [a, b] = await Promise.allSettled([h.repos.syncNow(synced, 'ui'), h.repos.syncNow(synced, 'ui')]);
    assert.deepEqual([a.status, b.status], ['fulfilled', 'rejected'], 'a second request while one runs is refused, not queued');
  } finally {
    h.done();
  }
});

test('keep synced: opt in per worktree; only fast-forwards, at its pace, and told only when it moved or went wrong', async () => {
  const clock = { t: Date.parse('2026-10-12T10:00:00Z') };
  const { pool, h } = await rig({ now: clock, config: { syncEveryS: 900 } });
  try {
    const synced = id(pool.path('synced'));
    assert.throws(() => h.repos.setSync(synced, true, 'ui'), /Only a worktree/);
    const follow = await h.repos.createWorktree(synced, { branch: 'follow', base: 'origin/main', sync: true }, 'ui');
    assert.equal(follow.worktree.sync!.enabled, true);
    assert.equal(pool.g(follow.worktree.path, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main', 'a branch started from a remote one follows it');
    commitFile(pool, pool.path('other'), 'later.txt', 'l\n', 'later');
    pool.g(pool.path('other'), 'push', '-q', 'origin', 'main');
    const target = pool.g(pool.path('other'), 'rev-parse', 'HEAD');
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer', syncPass: true });
    assert.equal(pool.g(follow.worktree.path, 'rev-parse', 'HEAD'), target, 'fetched and fast-forwarded by the timer’s pass');
    const events = h.repos.events({ workspaceId: WS, limit: 10 }).events.filter((e) => e.actor === 'portal:sync').map((e) => e.kind);
    assert.deepEqual(events.sort(), ['head_moved', 'sync']);
    // not again until its time; then a no-op is not news
    const count = h.repos.events({ workspaceId: WS, limit: 200 }).events.length;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer', syncPass: true });
    clock.t += 1_000_000;
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer', syncPass: true });
    assert.equal(h.repos.events({ workspaceId: WS, limit: 200 }).events.length, count);
    // turning it off
    assert.equal(h.repos.setSync(follow.worktree.id, false, 'ui').sync!.enabled, false);
    assert.deepEqual(audit(h).filter((e) => e.kind === 'sync_setting').map((e) => e.data.enabled), [false]);
    // a worktree that didn't opt in is never touched
    const plain = await h.repos.createWorktree(synced, { branch: 'plain', base: 'origin/main' }, 'ui');
    commitFile(pool, pool.path('other'), 'later2.txt', 'l\n', 'later two');
    pool.g(pool.path('other'), 'push', '-q', 'origin', 'main');
    clock.t += 1_000_000;
    const before = pool.g(plain.worktree.path, 'rev-parse', 'HEAD');
    await h.repos.scanWorkspace(WS, { actor: 'portal:timer', syncPass: true });
    assert.equal(pool.g(plain.worktree.path, 'rev-parse', 'HEAD'), before);
  } finally {
    h.done();
  }
});

test('settings: scan only the folders a workspace names; bad folders are refused; every change is in the audit', async () => {
  const pool = buildPool();
  const h = await reposHarness({ files: pool.files });
  try {
    assert.deepEqual(h.repos.settings(WS), { roots: null, defaultRoots: ['~'], auto: false });
    for (const bad of [['../x'], ['a/../b'], ['/'], ['a\nb'], Array.from({ length: 9 }, (_, i) => `d${i}`), 'work' as never]) {
      assert.throws(() => h.repos.updateSettings(WS, { roots: bad as string[] }, 'ui'), (e: { code: string }) => e.code === 'VALIDATION_FAILED', JSON.stringify(bad));
    }
    assert.throws(() => h.repos.updateSettings(WS, { auto: 'yes' as never }, 'ui'), (e: { code: string }) => e.code === 'VALIDATION_FAILED');
    const s = h.repos.updateSettings(WS, { roots: ['work/uni', '~/work/uni', './work/proj/'], auto: true }, 'ui');
    assert.deepEqual([s.roots, s.auto], [['~/work/uni', '~/work/proj'], true], 'normalised, and listed once');
    const w = await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.deepEqual(w.repos.filter((n) => n.depth === 0).map((n) => n.name).sort(), ['proj', 'uni'], 'only the two folders, nothing else of the home');
    assert.deepEqual(audit(h).filter((e) => e.kind === 'settings').map((e) => [e.actor, e.summary]), [['ui', 'Automatic scans on'], ['ui', 'Scan folders: ~/work/uni, ~/work/proj']]);
    h.repos.updateSettings(WS, { roots: null }, 'ui');
    assert.equal(h.repos.settings(WS).roots, null);
    // a folder that isn’t there is said, and the rest is still scanned
    h.repos.updateSettings(WS, { roots: ['nowhere', 'work/proj'] }, 'ui');
    const partial = await h.repos.scanWorkspace(WS, { actor: 'ui' });
    assert.match(partial.scan.error!, /“~\/nowhere” isn’t a folder here/);
  } finally {
    h.done();
  }
});

test('the timer: the first look follows a workspace’s start, then every interval, never while stopped or switched off', async () => {
  const clock = { t: Date.parse('2026-10-12T10:00:00Z') };
  const pool = buildPool();
  const h = await reposHarness({ files: pool.files, now: clock, config: { auto: true, intervalS: 60 } });
  // `tick` starts a scan without waiting for it, and the scan registers as running only after `await #requireRunning`: reading `scan.running` at
  // once can see "not yet running" and return before a scan that is about to run (T-697). One turn of the event loop lets every microtask
  // of that start settle, so the scan is registered; then wait for it to end.
  const settled = async () => {
    await new Promise<void>((r) => setImmediate(r));
    for (let i = 0; i < 100 && (await h.repos.workspace(WS)).scan.running; i++) await sleep(50);
  };
  try {
    await h.repos.tick();
    assert.equal((await h.repos.workspace(WS)).scan.at, null, 'the first round only notices the workspace is running');
    clock.t += 20_000;
    await h.repos.tick();
    await settled();
    const first = (await h.repos.workspace(WS)).scan.at;
    assert.ok(first, 'then it scans');
    clock.t += 10_000;
    await h.repos.tick();
    await settled();
    assert.equal((await h.repos.workspace(WS)).scan.at, first, 'not before the interval (jittered by up to 20 %)');
    clock.t += 120_000;
    await h.repos.tick();
    await settled();
    const second = (await h.repos.workspace(WS)).scan.at;
    assert.notEqual(second, first);
    assert.ok((await h.repos.workspace(WS)).scan.nextAt, 'the next one is announced');
    h.repos.updateSettings(WS, { auto: false }, 'ui');
    clock.t += 1_000_000;
    await h.repos.tick();
    await settled();
    assert.equal((await h.repos.workspace(WS)).scan.at, second, 'switched off for the workspace');
    h.repos.updateSettings(WS, { auto: true }, 'ui');
    h.state.running = false;
    await h.repos.tick();
    clock.t += 1_000_000;
    h.state.running = true;
    await h.repos.tick();
    await h.repos.tick();
    assert.equal((await h.repos.workspace(WS)).scan.at, second, 'a workspace that stopped and started is noticed again, a few seconds later');
  } finally {
    h.done();
  }
});

test('a chat’s turn ending looks at the repository it is in, once, soon; a chat in a folder that is no repository is left alone', async () => {
  const pool = buildPool();
  const h = await reposHarness({ files: pool.files, config: { sessionScanDelayMs: 20, sessionScanGapMs: 0 } });
  try {
    h.repos.start();
    const proj = pool.path('proj');
    h.sessions.emit('s', { type: 'session', session: chatSession({ id: 's', cwd: proj, state: 'working' }) });
    await h.repos.scanWorkspace(WS, { actor: 'ui' });
    const baseline = h.repos.events({ workspaceId: WS, limit: 200 }).events.length;
    h.sessions.emit('s', { type: 'session', session: chatSession({ id: 's', cwd: proj, state: 'working' }) });
    commitFile(pool, proj, 'by-turn.txt', 't\n', 'made during the turn');
    h.sessions.sessions = [chatSession({ id: 's', cwd: proj, state: 'idle' })];
    h.sessions.emit('s', { type: 'session', session: chatSession({ id: 's', cwd: proj, state: 'idle' }) });
    for (let i = 0; i < 100 && h.repos.events({ workspaceId: WS, limit: 200 }).events.length === baseline; i++) await sleep(50);
    const news = h.repos.events({ workspaceId: WS, limit: 200 }).events.slice(0, 3);
    assert.ok(news.some((e) => e.kind === 'head_moved' && e.repo === 'proj' && e.actor === 'session:s'), news.map((e) => e.kind).join());
    // a folder outside any repository: nothing to look at
    const calls = h.calls().length;
    h.sessions.emit('t', { type: 'session', session: chatSession({ id: 't', cwd: join(pool.files, 'elsewhere'), state: 'working' }) });
    h.sessions.emit('t', { type: 'session', session: chatSession({ id: 't', cwd: join(pool.files, 'elsewhere'), state: 'idle' }) });
    await sleep(150);
    assert.equal(h.calls().length, calls);
  } finally {
    h.done();
  }
});
