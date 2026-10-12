import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepoNode, RepoState, RepoSummary } from '@portal/contracts';
import { actorLabel, attentionWord, branchLabel, chipsOf, clip, compact, detailsOf, eventTone, filterQuery, homePath, parseRoots, plainSummary, summaryParts, summaryTone, ticketOf, treeRows, worstTone } from './labels';

const state = (over: Partial<RepoState> = {}): RepoState => ({
  branch: 'main',
  detached: false,
  unborn: false,
  head: { sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', subject: 'Fix it', at: '2026-10-12T00:00:00.000Z', author: 'Ann' },
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

let n = 0;
const node = (over: Partial<RepoNode> = {}): RepoNode => ({
  id: `r_${String(++n).padStart(12, '0')}`,
  workspaceId: 'docker/x',
  path: '/home/node/work/x',
  name: 'x',
  kind: 'repo',
  parentId: null,
  depth: 0,
  mainId: null,
  state: state(),
  error: null,
  worktree: null,
  submodule: null,
  drifted: 0,
  sessions: [],
  sync: null,
  attention: { score: 0, reasons: [] },
  firstSeenAt: '2026-10-12T00:00:00.000Z',
  scannedAt: '2026-10-12T00:00:00.000Z',
  ...over,
});

const labels = (r: RepoNode) => chipsOf(r).map((c) => c.label);

test('a clean repository has no chips; a repository with changes says how many', () => {
  assert.deepEqual(labels(node()), []);
  const dirty = node({ state: state({ changes: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 } }) });
  assert.deepEqual(labels(dirty), ['Changes 6']);
  assert.match(chipsOf(dirty)[0]!.title, /1 staged, 2 modified, 3 untracked/);
});

test('ahead and behind: one chip for each way, Diverged for both, Unpushed only when there is nothing ahead to say it', () => {
  const up = (ahead: number, behind: number) => ({ name: 'origin/main', ahead, behind, gone: false });
  assert.deepEqual(labels(node({ state: state({ upstream: up(2, 0), unpushed: 2 }) })), ['Ahead 2']);
  assert.equal(chipsOf(node({ state: state({ upstream: up(2, 0), unpushed: 2 }) }))[0]!.tone, 'warning', 'commits on no remote are at risk');
  assert.equal(chipsOf(node({ state: state({ upstream: up(2, 0), unpushed: 0 }) }))[0]!.tone, 'neutral', 'ahead of a branch that is itself on a remote branch is only information');
  assert.deepEqual(labels(node({ state: state({ upstream: up(0, 3) }) })), ['Behind 3']);
  assert.deepEqual(labels(node({ state: state({ upstream: up(1, 3), unpushed: 1 }) })), ['Diverged']);
  assert.deepEqual(labels(node({ state: state({ upstream: null, unpushed: 4 }) })), ['Unpushed 4']);
  assert.deepEqual(labels(node({ state: state({ upstream: up(0, 0), unpushed: 0 }) })), []);
});

test('conflicts and a half-done operation come first and are red', () => {
  const r = node({ state: state({ operation: 'merge', changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 2 } }) });
  assert.deepEqual(labels(r), ['Merging', 'Conflicts 2']);
  assert.deepEqual(chipsOf(r).map((c) => c.tone), ['danger', 'danger']);
  assert.equal(chipsOf(node({ state: state({ operation: 'rebase' }) }))[0]!.label, 'Rebasing');
});

test('an unreadable repository and a submodule that is not cloned have one chip and nothing else', () => {
  assert.deepEqual(labels(node({ state: null, error: 'timeout' })), ['Unreadable']);
  assert.match(chipsOf(node({ state: null, error: 'unsafe' }))[0]!.title, /Another user/);
  assert.deepEqual(labels(node({ kind: 'missing', state: null, submodule: { recorded: null, url: 'https://example.com/a.git', drifted: false } })), ['Not cloned']);
  assert.deepEqual(labels(node({ state: null })), [], 'never read: nothing to say yet');
});

test('detached is a chip for a repository and not for a submodule (which normally is); drift names what it is off', () => {
  const detached = state({ branch: null, detached: true });
  assert.deepEqual(labels(node({ state: detached })), ['Detached']);
  assert.deepEqual(labels(node({ kind: 'submodule', state: detached })), []);
  const drifted = node({ kind: 'submodule', state: detached, submodule: { recorded: 'f00dfeedf00dfeed', url: null, drifted: true } });
  assert.deepEqual(labels(drifted), ['Drift']);
  assert.match(chipsOf(drifted)[0]!.title, /a1b2c3d.*f00dfee/);
  assert.deepEqual(labels(node({ drifted: 2 })), ['Drift 2']);
});

test('the branch slot: the branch, the commit of a detached HEAD, or no commits', () => {
  assert.equal(branchLabel(node()), 'main');
  assert.equal(branchLabel(node({ state: state({ branch: null, detached: true }) })), 'a1b2c3d');
  assert.equal(branchLabel(node({ state: state({ unborn: true, head: null }) })), 'main (no commits)');
  assert.equal(branchLabel(node({ state: null })), null);
});

test('home folders read as ~', () => {
  assert.equal(homePath('/home/node/work/uni'), '~/work/uni');
  assert.equal(homePath('/Users/ann'), '~');
  assert.equal(homePath('/srv/repos/x'), '/srv/repos/x');
});

test('the tree: parents first as given; the attention filter keeps what needs a look and the parents on the way; folding hides what is below', () => {
  const top = node({ name: 'uni' });
  const a = node({ name: 'mods/a', kind: 'submodule', parentId: top.id, depth: 1, attention: { score: 3, reasons: ['unpushed', 'drift'] } });
  const b = node({ name: 'mods/b', kind: 'submodule', parentId: top.id, depth: 1 });
  const deep = node({ name: 'wt', kind: 'worktree', parentId: a.id, depth: 2, attention: { score: 1, reasons: ['dirty'] } });
  const lone = node({ name: 'lone' });
  const all = [top, a, deep, b, lone];

  const rows = treeRows(all);
  assert.deepEqual(rows.map((r) => r.node.name), ['uni', 'mods/a', 'wt', 'mods/b', 'lone']);
  assert.deepEqual(rows.map((r) => r.folds), [true, true, false, false, false]);

  const attention = treeRows(all, { attentionOnly: true });
  assert.deepEqual(attention.map((r) => r.node.name), ['uni', 'mods/a', 'wt']);
  assert.deepEqual(attention.map((r) => r.context), [true, false, false], 'uni is only there for its children');

  const found = treeRows(all, { query: ' MODS/b ' });
  assert.deepEqual(found.map((r) => r.node.name), ['uni', 'mods/b'], 'a typed name picks by name, folder or branch, with the parents above it');
  assert.deepEqual(found.map((r) => r.context), [true, false]);
  assert.deepEqual(treeRows(all, { query: 'mods', attentionOnly: true }).map((r) => r.node.name), ['uni', 'mods/a'], 'both filters apply: mods/b matches the name but needs no attention');
  assert.deepEqual(treeRows(all, { query: 'zzz' }), []);

  const folded = treeRows(all, { folded: new Set([top.id]) });
  assert.deepEqual(folded.map((r) => r.node.name), ['uni', 'lone']);
  assert.equal(folded[0]!.folded, true);
  assert.deepEqual(treeRows(all, { folded: new Set([a.id]) }).map((r) => r.node.name), ['uni', 'mods/a', 'mods/b', 'lone']);
});

test('tones: the worst reason sets it; a summary says what its count is made of', () => {
  assert.equal(worstTone([]), 'neutral');
  assert.equal(worstTone(['detached', 'dirty']), 'warning');
  assert.equal(worstTone(['dirty', 'conflicted']), 'danger');
  const s: RepoSummary = { repos: 23, worktrees: 1, dirty: 2, ahead: 3, behind: 3, diverged: 2, detached: 1, unpushed: 3, conflicted: 1, missing: 1, drifted: 1, errors: 0, attention: 8 };
  assert.equal(summaryTone(s), 'danger');
  assert.equal(summaryTone({ ...s, conflicted: 0 }), 'warning');
  assert.equal(summaryTone({ ...s, conflicted: 0, diverged: 0, behind: 0, unpushed: 0, dirty: 0, drifted: 0 }), 'neutral');
  assert.deepEqual(summaryParts(s), ['1 in conflict', '2 diverged', '1 behind', '3 unpushed', '2 with changes', '1 detached', '1 off the record', '1 not cloned']);
  assert.equal(attentionWord(1), '1 repo needs attention');
  assert.equal(attentionWord(8), '8 repos need attention');
});

test('the timeline: filters stand for server queries; an actor reads as a word', () => {
  assert.deepEqual(filterQuery('all'), {});
  assert.deepEqual(filterQuery('commits'), { kind: 'head_moved,branch_changed' });
  assert.deepEqual(filterQuery('audit'), { group: 'audit' });
  assert.equal(actorLabel('ui'), 'Person');
  assert.equal(actorLabel('session:abc'), 'Session');
  assert.equal(actorLabel('ticket:T-12'), 'Ticket T-12');
  assert.equal(actorLabel('portal-mcp:tok1'), 'Agent token');
  assert.equal(actorLabel('portal:sync'), 'Keep synced');
  assert.equal(actorLabel('workspace'), 'Workspace');
  assert.equal(ticketOf('ticket:T-12'), 'T-12');
  assert.equal(ticketOf('ticket:../x y'), null);
  assert.equal(ticketOf('ui'), null);
  assert.equal(eventTone({ kind: 'conflicted', data: {} }), 'danger');
  assert.equal(eventTone({ kind: 'sync', data: { outcome: 'refused' } }), 'warning');
  assert.equal(eventTone({ kind: 'sync', data: { outcome: 'updated' } }), 'success');
  assert.equal(eventTone({ kind: 'head_moved', data: {} }), 'neutral');
});

test('an event line drops the repository name; opened, it lists the commits, the move or the reason', () => {
  assert.equal(plainSummary({ repo: 'uni', summary: 'uni: 2 new commits by Ann' }), '2 new commits by Ann');
  assert.equal(plainSummary({ repo: 'uni', summary: 'Scan failed: x' }), 'Scan failed: x');
  assert.equal(plainSummary({ repo: null, summary: 'Scan requested' }), 'Scan requested');
  assert.deepEqual(detailsOf({ kind: 'head_moved', data: { fromSha: 'aaaaaaaaaaaaaaaa', toSha: 'bbbbbbbbbbbbbbbb', commits: 7, subjects: ['Fix it', 'Add tests'], fastForward: true } }), ['aaaaaaa → bbbbbbb', '“Fix it”', '“Add tests”', 'and 5 more']);
  assert.deepEqual(detailsOf({ kind: 'head_moved', data: { toSha: 'bbbbbbbbbbbbbbbb', fastForward: false } }), ['– → bbbbbbb', 'Not a fast-forward: the history changed.']);
  assert.deepEqual(detailsOf({ kind: 'branch_changed', data: { from: 'main', to: null } }), ['main → detached']);
  assert.deepEqual(detailsOf({ kind: 'sync', data: { outcome: 'refused', error: 'it has diverged' } }), ['it has diverged']);
  assert.deepEqual(detailsOf({ kind: 'dirty', data: { staged: 1, unstaged: 0, untracked: 2, conflicted: 0 } }), ['1 staged, 2 untracked']);
  assert.deepEqual(detailsOf({ kind: 'worktree_deleted', data: { path: '/home/node/p.worktrees/x', branch: 'x', branchDeleted: true } }), ['/home/node/p.worktrees/x', 'Branch x (deleted)']);
  assert.deepEqual(detailsOf({ kind: 'scan_requested', data: { repoId: null } }), []);
});

test('the scan folders as typed: one per line, blanks and repeats dropped', () => {
  assert.deepEqual(parseRoots(' work \n\nwork\n~/x/y  \n'), ['work', '~/x/y']);
  assert.deepEqual(parseRoots(''), []);
});

test('huge numbers and long names are cut to fit: a count is compact, a name is clipped', () => {
  assert.deepEqual([0, 7, 999, 1000, 1234, 9999, 10_000, 54_321, 100_000, 5_000_000].map(compact), ['0', '7', '999', '1k', '1.2k', '9.9k', '10k', '54k', '99k+', '99k+']);
  assert.equal(compact(-3), '0');
  assert.equal(compact(Number.NaN), '0');
  const dirty = node({ state: state({ changes: { staged: 0, unstaged: 0, untracked: 54_321, conflicted: 0 } }) });
  assert.deepEqual(labels(dirty), ['Changes 54k'], 'the chip stays as wide as any other');
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('a'.repeat(200), 40).length, 40);
  assert.ok(clip('a'.repeat(200), 40).endsWith('…'));
});
