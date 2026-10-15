// The HTTP surface: what the routes accept and answer, and how they refuse. The service and the host are the real ones (see
// service.test.ts); this is the shape of the API a page is written against.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { CreateRepoWorktreeResult, RepoDetail, RepoEventPage, RepoNode, RepoSettings, ReposOverview, RepoSyncResult, WorkspaceRepos } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createReposRoutes, createWorkspaceReposRoutes } from './routes.js';
import { buildPool, commitFile, reposHarness, WS } from './testkit.js';
import { repoId } from './text.js';

/** The routes as app.ts mounts them (the session guard and the workspace-name guard are app.ts's), with its error handler. */
async function rig() {
  const pool = buildPool();
  const h = await reposHarness({ files: pool.files });
  const app = new Hono();
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  const ws = new Hono();
  // Like app.ts's session guard: the caller is the signed-in owner (the workspace routes ask the seam, T-531).
  ws.use('*', async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
    await next();
  });
  ws.route('/', createWorkspaceReposRoutes(h.repos));
  app.route('/api/workspaces', ws);
  app.route('/api/repos', createReposRoutes(h.repos));
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
  return { pool, h, call, data };
}
const W = '/api/workspaces/docker/t1/repos';

test('a workspace’s tree, a scan, the overview and one repository', async () => {
  const { pool, h, call, data } = await rig();
  try {
    const empty = await data<WorkspaceRepos>(await call('GET', W));
    assert.deepEqual([empty.repos, empty.scan.at, empty.running, empty.settings.defaultRoots], [[], null, true, ['~']]);
    const scanned = await data<WorkspaceRepos>(await call('POST', `${W}/scan`));
    assert.ok(scanned.repos.length >= 15 && scanned.scan.at && !scanned.scan.error);
    assert.equal((await data<WorkspaceRepos>(await call('GET', W))).repos.length, scanned.repos.length);
    const o = await data<ReposOverview>(await call('GET', '/api/repos'));
    assert.deepEqual([o.workspaces.length, o.workspaces[0]!.workspaceId, o.workspaces[0]!.summary.repos], [1, WS, scanned.summary.repos]);
    const uni = scanned.repos.find((n) => n.name === 'uni')!;
    const d = await data<RepoDetail>(await call('GET', `/api/repos/${uni.id}`));
    assert.deepEqual([d.repo.id, d.children.length, d.repo.drifted], [uni.id, 4, 1]);
    // one repository read again answers with that repository
    commitFile(pool, pool.path('uni', 'tools', 'helper'), 'n.txt', 'n', 'new');
    const helper = scanned.repos.find((n) => n.name === 'tools/helper')!;
    const again = await data<RepoNode>(await call('POST', `/api/repos/${helper.id}/scan`));
    assert.notEqual(again.state!.head!.sha, helper.state!.head!.sha);
    const events = await data<RepoEventPage>(await call('GET', `/api/repos/events?repoId=${helper.id}&kind=head_moved,scan_requested`));
    assert.deepEqual(events.events.map((e) => [e.kind, e.actor]), [['scan_requested', 'ui'], ['head_moved', 'workspace']].reverse());
  } finally {
    h.done();
  }
});

test('what the routes refuse: a malformed or unknown id, a body that isn’t JSON, a value that isn’t valid, a scan of a stopped workspace', async () => {
  const { h, call, data } = await rig();
  try {
    const w = await data<WorkspaceRepos>(await call('POST', `${W}/scan`));
    const proj = w.repos.find((n) => n.name === 'proj')!;
    for (const [m, p] of [['GET', '/api/repos/nope'], ['GET', '/api/repos/r_000000000000'], ['POST', '/api/repos/r_000000000000/scan'], ['POST', '/api/repos/../etc/worktrees']] as const) {
      assert.equal((await call(m, p, {})).status, 404, `${m} ${p}`);
    }
    assert.equal((await call('POST', `/api/repos/${proj.id}/worktrees`, '{not json')).status, 400);
    assert.equal((await call('POST', `/api/repos/${proj.id}/worktrees`, [1])).status, 400, 'an array isn’t a request');
    assert.equal((await call('POST', `/api/repos/${proj.id}/worktrees`, { branch: 'a..b' })).status, 422);
    assert.equal((await call('POST', `${W}/scan`, { repoId: 'x' })).status, 422);
    assert.equal((await call('GET', '/api/repos/events?limit=abc')).status, 422);
    assert.equal((await call('DELETE', `/api/repos/${proj.id}/worktree?mode=sometimes`)).status, 422);
    assert.equal((await call('DELETE', `/api/repos/${proj.id}/worktree`)).status, 409, 'a repository isn’t a worktree');
    assert.equal((await call('PUT', `/api/repos/${proj.id}/sync`, { enabled: true })).status, 409, 'only worktrees can be kept synced');
    assert.equal((await call('PUT', `${W}/settings`, { roots: ['../x'] })).status, 422);
    h.state.running = false;
    assert.equal((await call('POST', `${W}/scan`)).status, 409);
    assert.equal((await call('POST', `/api/repos/${proj.id}/sync`)).status, 409);
  } finally {
    h.done();
  }
});

test('a worktree is made with 201, kept synced or not, and removed again; its sync is asked for and answered', async () => {
  const { pool, h, call, data } = await rig();
  try {
    const w = await data<WorkspaceRepos>(await call('POST', `${W}/scan`));
    const synced = w.repos.find((n) => n.name === 'synced')!;
    const res = await call('POST', `/api/repos/${synced.id}/worktrees`, { branch: 'follow', base: 'origin/main', sync: true });
    assert.equal(res.status, 201);
    const made = await data<CreateRepoWorktreeResult>(res);
    assert.deepEqual([made.branch, made.worktree.kind, made.worktree.sync?.enabled, made.worktree.parentId], ['follow', 'worktree', true, synced.id]);
    commitFile(pool, pool.path('other'), 'r.txt', 'r', 'for the route');
    pool.g(pool.path('other'), 'push', '-q', 'origin', 'main');
    const sync = await data<RepoSyncResult>(await call('POST', `/api/repos/${made.worktree.id}/sync`));
    assert.deepEqual([sync.outcome, sync.repo.id, sync.note], ['updated', made.worktree.id, null]);
    const off = await data<RepoNode>(await call('PUT', `/api/repos/${made.worktree.id}/sync`, { enabled: false }));
    assert.equal(off.sync!.enabled, false);
    assert.equal((await call('PUT', `/api/repos/${made.worktree.id}/sync`, { enabled: 'yes' })).status, 422);
    const removed = await call('DELETE', `/api/repos/${made.worktree.id}/worktree?mode=safe`);
    assert.equal(removed.status, 200);
    assert.deepEqual(await data(removed), { branchDeleted: true });
    assert.equal((await call('GET', `/api/repos/${made.worktree.id}`)).status, 404, 'a removed worktree is gone');
    const audit = await data<RepoEventPage>(await call('GET', '/api/repos/events?group=audit&limit=2'));
    assert.equal(audit.events.length, 2);
    assert.ok(audit.next, 'more before these');
    const more = await data<RepoEventPage>(await call('GET', `/api/repos/events?group=audit&before=${audit.next}&limit=50`));
    assert.ok(more.events.every((e) => Number(e.id) < Number(audit.next)));
    assert.deepEqual(new Set([...audit.events, ...more.events].map((e) => e.kind)), new Set(['worktree_deleted', 'sync', 'sync_setting', 'worktree_created', 'scan_requested']));
  } finally {
    h.done();
  }
});

test('settings are read and set per workspace', async () => {
  const { h, call, data } = await rig();
  try {
    assert.deepEqual(await data<RepoSettings>(await call('GET', `${W}/settings`)), { roots: null, defaultRoots: ['~'], auto: false });
    const set = await data<RepoSettings>(await call('PUT', `${W}/settings`, { roots: ['work'], auto: true }));
    assert.deepEqual([set.roots, set.auto], [['~/work'], true]);
    assert.deepEqual(await data<RepoSettings>(await call('GET', `${W}/settings`)), set);
    assert.equal((await call('PUT', `${W}/settings`, '')).status, 400);
    assert.equal(repoId(WS, '/x').length, 14);
  } finally {
    h.done();
  }
});
