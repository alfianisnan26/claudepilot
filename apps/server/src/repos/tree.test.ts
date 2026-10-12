// From records to the tree: what each repository is, how they relate, who needs attention, the counts, and what changed between two looks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepoState } from '@portal/contracts';
import { describe, diffScan } from './events.js';
import type { RawRepo } from './parse.js';
import { repoId } from './text.js';
import { addSummaries, attentionOf, buildNodes, orderNodes, summarize, type NodeCore } from './tree.js';

const WS = 'docker/t';
const H = (c: string) => c.repeat(40);
const id = (p: string) => repoId(WS, p);
const clean = (t: string) => t;

function raw(path: string, over: Partial<RawRepo> = {}): RawRepo {
  const gd = `${path}/.git`;
  return {
    path,
    error: null,
    gitDir: gd,
    commonDir: gd,
    superproject: null,
    branch: 'main',
    detached: false,
    unborn: false,
    oid: H('a'),
    upstream: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    untrackedDirs: [],
    head: { sha: H('a'), at: '2026-10-12T00:00:00Z', author: 'Ann', subject: 'x' },
    stash: 0,
    unpushed: null,
    remotes: [],
    operation: null,
    filters: 0,
    fetchedAtMs: null,
    worktrees: [],
    modules: [],
    gitlinks: [],
    log: null,
    ...over,
  };
}
const failed = (path: string, error: RawRepo['error']): RawRepo => raw(path, { error });

function pool() {
  const uni = raw('/h/uni', {
    modules: [
      { name: 'mods/a', path: 'mods/a', url: 'https://x/a.git' },
      { name: 'mods/b', path: 'mods/b', url: 'https://x/b.git' },
      { name: 'mods/c', path: 'mods/c', url: 'https://x/c.git' },
    ],
    gitlinks: [
      { path: 'mods/a', sha: H('1') },
      { path: 'mods/b', sha: H('2') },
      { path: 'mods/c', sha: H('3') },
    ],
  });
  const a = raw('/h/uni/mods/a', { gitDir: '/h/uni/.git/modules/mods/a', commonDir: '/h/uni/.git/modules/mods/a', superproject: '/h/uni', detached: true, branch: null, head: { sha: H('9'), at: null, author: null, subject: 'newer' } });
  const b = raw('/h/uni/mods/b', { gitDir: '/h/uni/.git/modules/mods/b', commonDir: '/h/uni/.git/modules/mods/b', superproject: '/h/uni', detached: true, branch: null, head: { sha: H('2'), at: null, author: null, subject: 'pinned' } });
  const helper = raw('/h/uni/tools/helper');
  const proj = raw('/h/proj', { worktrees: [{ path: '/h/proj', head: H('a'), branch: 'main', detached: false, locked: false, prunable: false }, { path: '/h/proj.worktrees/x', head: H('a'), branch: 'feat/x', detached: false, locked: true, prunable: false }] });
  const wt = raw('/h/proj.worktrees/x', { gitDir: '/h/proj/.git/worktrees/x', commonDir: '/h/proj/.git', branch: 'feat/x' });
  const orphanWt = raw('/h/lost.worktrees/y', { gitDir: '/h/lost/.git/worktrees/y', commonDir: '/h/lost/.git' });
  const orphanSub = raw('/h/far/sub', { gitDir: '/h/elsewhere/.git/modules/sub', commonDir: '/h/elsewhere/.git/modules/sub', superproject: '/h/elsewhere' });
  return buildNodes(WS, [uni, a, b, failed('/h/uni/mods/c', 'notrepo'), helper, proj, wt, orphanWt, orphanSub], new Map(), clean);
}

test('what each repository is, and how they relate: superproject and submodules, a nested one, a worktree, a not-cloned submodule, orphans', () => {
  const nodes = pool();
  const by = new Map(nodes.map((n) => [n.path, n]));
  const k = (p: string) => [by.get(p)!.kind, by.get(p)!.parentId, by.get(p)!.name];
  assert.deepEqual(k('/h/uni'), ['repo', null, 'uni']);
  assert.deepEqual(k('/h/uni/mods/a'), ['submodule', id('/h/uni'), 'mods/a']);
  assert.deepEqual(k('/h/uni/mods/c'), ['missing', id('/h/uni'), 'mods/c']);
  assert.deepEqual(k('/h/uni/tools/helper'), ['nested', id('/h/uni'), 'tools/helper']);
  assert.deepEqual(k('/h/proj.worktrees/x'), ['worktree', id('/h/proj'), 'x']);
  assert.equal(by.get('/h/proj.worktrees/x')!.mainId, id('/h/proj'));
  assert.deepEqual(by.get('/h/proj.worktrees/x')!.worktree, { locked: true, prunable: false }, 'the flags come from the main repository’s list');
  assert.deepEqual(k('/h/lost.worktrees/y'), ['worktree', null, 'y']);
  assert.equal(by.get('/h/lost.worktrees/y')!.mainId, id('/h/lost'), 'the main repository is named even when it isn’t in the tree');
  assert.deepEqual(k('/h/far/sub'), ['submodule', null, 'sub'], 'a submodule whose superproject wasn’t read sits at the top');
  assert.equal(nodes.length, 9);
});

test('submodule drift: the checked-out commit against the recorded one, counted on the superproject; a not-cloned one is missing', () => {
  const by = new Map(pool().map((n) => [n.path, n]));
  assert.deepEqual(by.get('/h/uni/mods/a')!.submodule, { recorded: H('1'), url: 'https://x/a.git', drifted: true });
  assert.deepEqual(by.get('/h/uni/mods/b')!.submodule, { recorded: H('2'), url: 'https://x/b.git', drifted: false });
  assert.deepEqual(by.get('/h/uni/mods/c')!.submodule, { recorded: H('3'), url: 'https://x/c.git', drifted: false });
  assert.equal(by.get('/h/uni')!.drifted, 1);
  assert.equal(by.get('/h/uni/mods/c')!.state, null);
});

test('the tree is parents first with depth, worktrees after other children, and a cycle can not hide a node', () => {
  const ordered = orderNodes(pool());
  assert.deepEqual(
    ordered.map(({ node, depth }) => [node.name, depth]),
    [['sub', 0], ['proj', 0], ['x', 1], ['uni', 0], ['mods/a', 1], ['mods/b', 1], ['mods/c', 1], ['tools/helper', 1], ['y', 0]],
    'sorted by folder at each level, worktrees after the other kinds (an orphan one last at the top)',
  );
  const cyc = orderNodes([
    { id: 'a', path: '/a', kind: 'repo' as const, parentId: 'b' },
    { id: 'b', path: '/b', kind: 'repo' as const, parentId: 'a' },
  ]);
  assert.deepEqual(cyc.map((x) => x.node.id).sort(), ['a', 'b']);
});

test('an untracked folder that holds repositories tracked on their own is not a change of the repository around it', () => {
  const outer = raw('/h/pool', { changes: { staged: 0, unstaged: 0, untracked: 3, conflicted: 0 }, untrackedDirs: ['clones', 'scratch', 'wt'] });
  const clone = raw('/h/pool/clones/one');
  const wt = raw('/h/pool/wt/x', { gitDir: '/h/lone/.git/worktrees/x', commonDir: '/h/lone/.git' });
  const [pool] = buildNodes(WS, [outer, clone, wt], new Map(), clean).filter((n) => n.path === '/h/pool');
  assert.equal(pool!.state!.changes.untracked, 1, 'only the scratch folder is the repository’s own news');
  const alone = buildNodes(WS, [outer], new Map(), clean)[0]!;
  assert.equal(alone.state!.changes.untracked, 3, 'nothing is left out for a repository the portal didn’t read');
});

test('a repository that could not be read keeps what was known of it, with the reason', () => {
  const prev = new Map([['/h/proj.worktrees/x', { kind: 'worktree' as const, parentId: id('/h/proj'), mainId: id('/h/proj'), name: 'x' }]]);
  const nodes = buildNodes(WS, [failed('/h/proj.worktrees/x', 'timeout'), failed('/h/new', 'ownership'), failed('/h/gone', 'notrepo')], prev, clean);
  const by = new Map(nodes.map((n) => [n.path, n]));
  assert.deepEqual([by.get('/h/proj.worktrees/x')!.kind, by.get('/h/proj.worktrees/x')!.error, by.get('/h/proj.worktrees/x')!.state], ['worktree', 'timeout', null]);
  assert.deepEqual([by.get('/h/new')!.kind, by.get('/h/new')!.error], ['repo', 'unsafe']);
  assert.equal(by.has('/h/gone'), false, 'a folder that isn’t a repository isn’t a node');
});

const st = (over: Partial<RepoState> = {}): RepoState => ({
  branch: 'main',
  detached: false,
  unborn: false,
  head: { sha: H('a'), at: null, author: null, subject: '' },
  upstream: null,
  changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  stash: 0,
  unpushed: null,
  remotes: [],
  operation: null,
  filters: 0,
  fetchedAt: null,
  ...over,
});
const n = (over: Partial<Pick<NodeCore, 'kind' | 'state' | 'error' | 'submodule'>>) => ({ kind: 'repo' as const, state: st(), error: null, submodule: null, ...over });

test('attention: worst first, a submodule is normally detached, behind only counts when nothing is ahead', () => {
  assert.deepEqual(attentionOf(n({})), { score: 0, reasons: [] });
  assert.deepEqual(attentionOf(n({ state: st({ changes: { staged: 1, unstaged: 0, untracked: 0, conflicted: 2 }, operation: 'merge' }) })).reasons, ['conflicted', 'operation', 'dirty']);
  assert.deepEqual(attentionOf(n({ state: st({ upstream: { name: 'o/m', ahead: 1, behind: 2, gone: false }, unpushed: 1 }) })).reasons, ['diverged', 'unpushed']);
  assert.deepEqual(attentionOf(n({ state: st({ upstream: { name: 'o/m', ahead: 0, behind: 2, gone: false } }) })).reasons, ['behind']);
  assert.deepEqual(attentionOf(n({ state: st({ detached: true, branch: null }) })).reasons, ['detached']);
  assert.deepEqual(attentionOf(n({ kind: 'submodule', state: st({ detached: true, branch: null }), submodule: { recorded: H('1'), url: null, drifted: false } })).reasons, []);
  assert.deepEqual(attentionOf(n({ kind: 'submodule', submodule: { recorded: H('1'), url: null, drifted: true } })).reasons, ['drift']);
  assert.deepEqual(attentionOf(n({ kind: 'missing', state: null })).reasons, ['missing']);
  assert.deepEqual(attentionOf(n({ state: null, error: 'timeout' })).reasons, ['error']);
  const worse = attentionOf(n({ state: st({ changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 1 } }) })).score;
  assert.ok(worse > attentionOf(n({ state: st({ changes: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } }) })).score);
});

test('the summary counts each condition once per repository, not-cloned submodules apart, and adds up', () => {
  const nodes = pool().map((x, i) => (i === 0 ? { ...x, state: st({ changes: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 }, unpushed: 2, upstream: { name: 'o/m', ahead: 2, behind: 1, gone: false } }) } : x));
  const s = summarize(nodes);
  assert.deepEqual([s.repos, s.worktrees, s.missing, s.drifted, s.dirty, s.diverged, s.unpushed, s.ahead, s.behind], [8, 2, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(s.attention, 3, 'the dirty and diverged one, the drifted submodule, the not-cloned one');
  const total = addSummaries([s, s]);
  assert.equal(total.repos, 16);
  assert.equal(total.missing, 2);
});

/* ---------- Events ---------- */

const core = (path: string, over: Partial<NodeCore> = {}): NodeCore => ({
  id: id(path),
  workspaceId: WS,
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind: 'repo',
  parentId: null,
  mainId: null,
  state: st(),
  error: null,
  worktree: null,
  submodule: null,
  drifted: 0,
  ...over,
});
const kinds = (r: ReturnType<typeof diffScan>) => r.events.map((e) => e.kind);
const run = (previous: NodeCore[], next: NodeCore[], extra: Partial<Parameters<typeof diffScan>[0]> = {}) => diffScan({ previous, next, logs: new Map(), confirmedGone: new Set(), initial: false, ...extra });

test('a scan that finds nothing new says nothing; the first one says what it found', () => {
  const a = core('/h/a');
  assert.deepEqual(run([a], [a]).events, []);
  const first = run([], [a, core('/h/w', { kind: 'worktree', parentId: a.id, mainId: a.id, state: st({ branch: 'feat' }) }), core('/h/m', { kind: 'missing', state: null })], { initial: true });
  assert.deepEqual(kinds(first), ['discovered', 'worktree_added']);
  assert.equal(first.events[0]!.data.initial, true);
  assert.equal(first.events[1]!.repoId, a.id, 'a worktree is the main repository’s news');
});

test('branch, commits, dirty and clean, conflicts, divergence: one event per change, and a branch switch is not also commits', () => {
  const a = core('/h/a');
  const moved = core('/h/a', { state: st({ head: { sha: H('b'), at: null, author: null, subject: 'n' } }) });
  const log = new Map([['/h/a', { kind: 'ff' as const, count: 2, commits: [{ sha: H('b'), author: 'Bob', subject: 'two' }, { sha: H('c'), author: 'Ann', subject: 'one' }] }]]);
  const r = run([a], [moved], { logs: log });
  assert.deepEqual(kinds(r), ['head_moved']);
  assert.deepEqual(r.events[0]!.data, { from: H('a').slice(0, 12), to: H('b').slice(0, 12), fromSha: H('a'), toSha: H('b'), fastForward: true, branch: 'main', commits: 2, authors: ['Bob', 'Ann'], subjects: ['two', 'one'] });
  assert.equal(r.events[0]!.summary, 'a: 2 new commits by Bob, Ann');
  const switched = core('/h/a', { state: st({ branch: 'feat', head: { sha: H('b'), at: null, author: null, subject: '' } }) });
  assert.deepEqual(kinds(run([a], [switched])), ['branch_changed']);
  const dirty = core('/h/a', { state: st({ changes: { staged: 1, unstaged: 2, untracked: 0, conflicted: 0 } }) });
  assert.deepEqual(kinds(run([a], [dirty])), ['dirty']);
  assert.deepEqual(kinds(run([dirty], [a])), ['clean']);
  const dirtier = core('/h/a', { state: st({ changes: { staged: 5, unstaged: 2, untracked: 0, conflicted: 0 } }) });
  assert.deepEqual(kinds(run([dirty], [dirtier])), [], 'more changes while dirty is not a new event');
  const conflicted = core('/h/a', { state: st({ changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 2 } }) });
  assert.deepEqual(kinds(run([a], [conflicted])), ['dirty', 'conflicted']);
  const div = core('/h/a', { state: st({ upstream: { name: 'o/m', ahead: 1, behind: 3, gone: false } }) });
  assert.deepEqual(kinds(run([a], [div])), ['diverged']);
  assert.deepEqual(kinds(run([div], [div])), []);
  const rewritten = run([a], [moved], { logs: new Map([['/h/a', { kind: 'rewritten' as const, count: null, commits: [] }]]) });
  assert.equal(rewritten.events[0]!.data.fastForward, false);
  assert.equal(rewritten.events[0]!.summary, 'a: moved to ' + H('b').slice(0, 12) + ' (history changed)');
});

test('a repository is gone only when it was confirmed gone; a limit that hid it is not a removal', () => {
  const a = core('/h/a');
  const w = core('/h/w', { kind: 'worktree', parentId: a.id, mainId: a.id, state: st({ branch: 'feat' }) });
  assert.deepEqual(run([a, w], []).events, [], 'unseen is not gone');
  const r = run([a, w], [], { confirmedGone: new Set([a.id, w.id]) });
  assert.deepEqual(kinds(r), ['removed', 'worktree_removed']);
  assert.deepEqual(r.gone.sort(), [a.id, w.id].sort());
  const missing = core('/h/m', { kind: 'missing', state: null });
  assert.deepEqual(kinds(run([missing], [], { confirmedGone: new Set([missing.id]) })), [], 'a not-cloned submodule going quietly');
});

test('submodule drift is the superproject’s news, once, and again when it changes or clears; a clone and a deinit are found and removed', () => {
  const uni = core('/h/uni');
  const sub = (head: string, drifted: boolean) => core('/h/uni/m', { kind: 'submodule', parentId: uni.id, name: 'm', state: st({ head: { sha: head, at: null, author: null, subject: '' } }), submodule: { recorded: H('1'), url: null, drifted } });
  assert.deepEqual(kinds(run([uni, sub(H('1'), false)], [uni, sub(H('9'), true)])), ['head_moved', 'drift']);
  assert.deepEqual(kinds(run([uni, sub(H('9'), true)], [uni, sub(H('9'), true)])), [], 'same drift, no news');
  assert.deepEqual(kinds(run([uni, sub(H('9'), true)], [uni, sub(H('8'), true)])), ['head_moved', 'drift'], 'it moved again while drifting');
  const r = run([uni, sub(H('9'), true)], [uni, sub(H('1'), false)]);
  assert.deepEqual(kinds(r), ['head_moved', 'aligned']);
  assert.equal(r.events.at(-1)!.repoId, uni.id);
  const missing = core('/h/uni/m', { kind: 'missing', state: null, parentId: uni.id, name: 'm' });
  assert.deepEqual(kinds(run([uni, missing], [uni, sub(H('1'), false)])), ['discovered'], 'a submodule that got cloned is found');
  assert.deepEqual(kinds(run([uni, sub(H('1'), false)], [uni, missing])), ['removed'], 'one that was deinitialised is gone');
});

test('a read that starts failing is told once; summaries read as plain lines', () => {
  const a = core('/h/a');
  const bad = core('/h/a', { state: null, error: 'timeout' });
  assert.deepEqual(kinds(run([a], [bad])), ['scan_failed']);
  assert.deepEqual(kinds(run([bad], [bad])), []);
  assert.equal(describe('scan_failed', null, { error: 'The workspace didn’t answer.' }), 'Scan failed: The workspace didn’t answer.');
  assert.equal(describe('sync', 'a', { outcome: 'refused', error: 'it has changes' }), 'a: sync refused: it has changes');
  assert.equal(describe('settings', null, { roots: ['~/work'] }), 'Scan folders: ~/work');
  assert.equal(describe('settings', null, { roots: null }), 'Scan folders: default');
  assert.equal(describe('sync_setting', 'a', { enabled: true }), 'a: keep synced on');
});
