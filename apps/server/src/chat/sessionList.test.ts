// The Sessions list model (packages/contracts/src/chatList.ts): filters, search, grouping, attention
// order, the parent/child tree with rollups, left-behind rows and sessions of removed workspaces.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attentionTier, buildListView, matchesQuery, needsYou, rollupLine, type ChatSession, type ListRow } from '@portal/contracts';

let n = 0;
/** A session as the portal lists it; `at` is minutes ago for the last activity. */
function session(over: Partial<ChatSession> & { at?: number } = {}): ChatSession {
  const { at = 10, ...rest } = over;
  const id = rest.id ?? `s${++n}`;
  return {
    id,
    workspaceId: 'docker/api',
    cwd: '/home/node/work/api',
    title: `Session ${id}`,
    state: 'idle',
    origin: 'ui',
    model: null,
    mode: 'default',
    effort: null,
    ultracode: false,
    ultracodeAvailable: false,
    process: 'live',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 0,
    waitingFor: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastActivityAt: new Date(Date.now() - at * 60_000).toISOString(),
    endedReason: null,
    claudeId: '',
    claudeName: 'Default',
    predecessorId: null,
    successorId: null,
    archivedAt: null,
    ticketId: null,
    parentId: null,
    worktree: null,
    startedBy: 'ui',
    bypassCapable: false,
    claudeSessionId: id,
    previousClaudes: [],
    switching: null,
    ...rest,
  };
}

const ids = (rows: ListRow[]) => rows.map((r) => r.session.id);

test('order: waiting first, then interrupted, working, idle, ended; the newest first inside a tier', () => {
  const list = [
    session({ id: 'ended', state: 'ended', at: 1 }),
    session({ id: 'idle-new', state: 'idle', at: 2 }),
    session({ id: 'idle-old', state: 'idle', at: 30 }),
    session({ id: 'working', state: 'working', at: 50 }),
    session({ id: 'interrupted', state: 'interrupted', at: 90 }),
    session({ id: 'waiting', state: 'waiting', waiting: 1, at: 200 }),
    session({ id: 'idle-but-asks', state: 'idle', waiting: 2, at: 300 }),
  ];
  const v = buildListView(list);
  assert.deepEqual(ids(v.groups[0]!.rows), ['waiting', 'idle-but-asks', 'interrupted', 'working', 'idle-new', 'idle-old', 'ended']);
  assert.deepEqual(ids(v.attention), ['waiting', 'idle-but-asks'], 'the queue is what waits on you, wherever it is grouped');
  assert.equal(attentionTier(list[0]!), 4);
  assert.ok(needsYou(list[4]!) && needsYou(list[5]!) && !needsYou(list[1]!));
  // Ended for safety is something to look at.
  assert.ok(needsYou(session({ state: 'ended', endedReason: 'credential: Claude Code stopped using the pool’s key' })));
  assert.ok(!needsYou(session({ state: 'ended', endedReason: 'closed by operator' })));
});

test('filters and search: a filter keeps its states, search needs every word and looks at title, workspace, Claude, folder, branch, ticket and id', () => {
  const list = [
    session({ id: 'a', title: 'Fix login', state: 'working' }),
    session({ id: 'b', title: 'Docs pass', state: 'idle', workspaceId: 'docker/web', claudeName: 'Satria' }),
    session({ id: 'c', title: 'Flaky test', state: 'ended' }),
    session({ id: 'd', title: 'Worker', state: 'waiting', waiting: 1, worktree: { path: '/home/node/work/api.worktrees/fix-x', branch: 'pilot/fix-x', repo: '/home/node/work/api' }, ticketId: 'T-12' }),
  ];
  const shown = (o: Parameters<typeof buildListView>[1]) => ids(buildListView(list, o).groups.flatMap((g) => g.rows)).sort();
  assert.deepEqual(shown({ filter: 'working' }), ['a']);
  assert.deepEqual(shown({ filter: 'idle' }), ['b']);
  assert.deepEqual(shown({ filter: 'ended' }), ['c']);
  assert.deepEqual(shown({ filter: 'attention' }), ['d']);
  assert.deepEqual(shown({ query: 'login' }), ['a']);
  assert.deepEqual(shown({ query: 'satria web' }), ['b'], 'every word must match');
  assert.deepEqual(shown({ query: 'pilot/fix' }), ['d'], 'the branch');
  assert.deepEqual(shown({ query: 't-12' }), ['d'], 'the ticket');
  assert.deepEqual(shown({ query: 'nothing like this' }), []);
  assert.ok(matchesQuery(list[0]!, '  '), 'blank matches everything');
  const v = buildListView(list, { filter: 'working' });
  assert.deepEqual([v.shown, v.total], [1, 4]);
});

test('archived sessions are a list of their own: left out by default, and the only ones shown when asked', () => {
  const list = [session({ id: 'open' }), session({ id: 'old', state: 'ended', archivedAt: new Date().toISOString() })];
  assert.deepEqual(ids(buildListView(list).groups[0]!.rows), ['open']);
  assert.deepEqual(ids(buildListView(list, { archived: true }).groups[0]!.rows), ['old']);
  assert.equal(buildListView(list).archived, 1);
});

test('grouping: by workspace, Claude, worktree and ticket, with "none of" groups last and groups ordered by their most urgent session', () => {
  const wt = (branch: string) => ({ path: `/home/node/work/api.worktrees/${branch}`, branch, repo: '/home/node/work/api' });
  const list = [
    session({ id: 'a', workspaceId: 'docker/api', claudeId: '', claudeName: 'Default', state: 'idle', at: 1, ticketId: 'T-1', worktree: wt('one') }),
    session({ id: 'b', workspaceId: 'docker/api', claudeId: 'c2', claudeName: 'Work', state: 'working', at: 2 }),
    session({ id: 'c', workspaceId: 'docker/web', claudeId: '', claudeName: 'Default', state: 'waiting', waiting: 1, at: 3, worktree: wt('two'), ticketId: 'T-2' }),
    session({ id: 'd', workspaceId: 'docker/web', claudeId: '', claudeName: 'Default', state: 'ended', at: 4 }),
  ];
  const keys = (by: 'workspace' | 'claude' | 'worktree' | 'ticket') => buildListView(list, { groupBy: by }).groups.map((g) => [g.title, ids(g.rows)]);
  assert.deepEqual(keys('workspace'), [['web', ['c', 'd']], ['api', ['b', 'a']]], 'web has the session that needs you');
  assert.deepEqual(keys('claude'), [['Default', ['c', 'd']], ['Work', ['b']], ['Default', ['a']]], 'a Claude is per workspace');
  assert.deepEqual(keys('worktree'), [['two', ['c']], ['one', ['a']], ['No worktree', ['b', 'd']]]);
  assert.deepEqual(keys('ticket'), [['T-2', ['c']], ['T-1', ['a']], ['No ticket', ['b', 'd']]]);
  const byClaude = buildListView(list, { groupBy: 'claude' }).groups;
  assert.deepEqual(byClaude.map((g) => g.subtitle), ['web', 'api', 'api']);
  assert.equal(byClaude[0]!.waiting, 1);
});

test('tree: a session started by another is nested under it, a parent shows a rollup over all it started, and a child elsewhere says where it came from', () => {
  const list = [
    session({ id: 'boss', title: 'Coordinator', state: 'working', at: 1 }),
    session({ id: 'w1', title: 'Worker 1', parentId: 'boss', state: 'waiting', waiting: 1, at: 2, costUsd: 0.5 }),
    session({ id: 'w2', title: 'Worker 2', parentId: 'boss', state: 'ended', at: 3, costUsd: 0.25 }),
    session({ id: 'sub', title: 'Sub-worker', parentId: 'w1', state: 'working', at: 4, costUsd: 0.125 }),
    session({ id: 'far', title: 'Worker far', parentId: 'boss', workspaceId: 'docker/web', state: 'idle', at: 5 }),
  ];
  const flat = buildListView(list);
  assert.deepEqual(ids(flat.groups[0]!.rows), ['boss'], 'one tree when nothing is grouped');
  const boss = flat.groups[0]!.rows.find((r) => r.session.id === 'boss')!;
  assert.deepEqual(ids(boss.children), ['w1', 'far', 'w2'], 'children by need, then recency');
  assert.deepEqual(ids(boss.children.find((c) => c.session.id === 'w1')!.children), ['sub']);
  assert.deepEqual(boss.rollup, { total: 4, working: 1, waiting: 1, idle: 1, interrupted: 0, ended: 1, costUsd: 0.875 });
  assert.equal(rollupLine(boss.rollup), '4 started · 1 needs you · 1 working · 1 idle · 1 ended');
  assert.equal(rollupLine(null), null);

  // Grouped by workspace, the far worker sits in its own workspace and names the coordinator.
  const grouped = buildListView(list, { groupBy: 'workspace' });
  const web = grouped.groups.find((g) => g.title === 'web')!;
  assert.deepEqual(ids(web.rows), ['far']);
  assert.equal(web.rows[0]!.parentTitle, 'Coordinator');
  // A filter that hides the parent leaves the child at the top, still naming it.
  const waitingOnly = buildListView(list, { filter: 'attention' });
  assert.deepEqual(ids(waitingOnly.groups[0]!.rows), ['w1']);
  assert.equal(waitingOnly.groups[0]!.rows[0]!.parentTitle, 'Coordinator');
});

test('a chat that moved shows once under its current Claude and as "ran here earlier" under the others, and sessions of removed workspaces are marked', () => {
  const list = [
    session({ id: 'moved', title: 'Greetings', claudeId: 'b', claudeName: 'Work', previousClaudes: [{ claudeId: 'a', name: 'Satria' }], state: 'idle' }),
    session({ id: 'orphan', workspaceId: 'docker/gone', state: 'ended' }),
  ];
  const v = buildListView(list, { groupBy: 'claude', workspaces: (id) => (id === 'docker/gone' ? { gone: true } : { gone: false, status: 'running' }) });
  assert.deepEqual(
    v.groups.map((g) => [g.title, g.rows.map((r) => [r.session.id, r.earlier]), g.count]),
    [['Work', [['moved', false]], 1], ['Default', [['orphan', false]], 1], ['Satria', [['moved', true]], 0]],
    'the earlier row is the same chat and doesn’t count as a session',
  );
  assert.equal(v.shown, 2, 'two sessions, whatever the groups show');
  assert.equal(v.groups.find((g) => g.title === 'Default')!.rows[0]!.workspaceGone, true);
  // Not grouped by Claude, a chat is one row.
  const flat = buildListView(list);
  assert.deepEqual(flat.groups[0]!.rows.map((r) => r.session.id).sort(), ['moved', 'orphan']);
  assert.ok(flat.groups[0]!.rows.every((r) => !r.earlier));
});

test('a list never loops or loses rows, even when parents point at each other', () => {
  const list = [session({ id: 'x', parentId: 'y', at: 1 }), session({ id: 'y', parentId: 'x', at: 2 }), session({ id: 'z', parentId: 'z', at: 3 })];
  const v = buildListView(list);
  const flatten = (rows: ListRow[]): string[] => rows.flatMap((r) => [r.session.id, ...flatten(r.children)]);
  assert.deepEqual(flatten(v.groups[0]!.rows).sort(), ['x', 'y', 'z'], 'every session is shown exactly once');
  assert.equal(v.shown, 3);
});

/* ---------- Moves in the transcript (packages/contracts/src/chatMoves.ts) ---------- */

import { foldMoves, type ChatEvent } from '@portal/contracts';

const e = (seq: number, kind: ChatEvent['kind'], text: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({ seq, at: '2026-10-12T07:00:00Z', kind, text, ...extra });
const transfer = (id: string) => ({ fromClaude: 'Default', toClaude: 'satria', sourceSessionId: 's', path: '/p', messages: 2, truncated: false, handoff: true, handoffId: id });

test('moves: a finished move folds into its divider, with its opening and the first thing the new Claude said; the chat before and after is untouched', () => {
  const events = [
    e(1, 'user', 'hello'),
    e(2, 'assistant', 'hi'),
    e(3, 'result', ''),
    e(4, 'system', 'Default is writing the handoff…', { handoffId: 'm1' }),
    e(5, 'user', 'write the handoff', { handoffId: 'm1', actor: 'portal:handoff' }),
    e(6, 'assistant', 'DOCUMENT', { handoffId: 'm1' }),
    e(7, 'result', '', { handoffId: 'm1' }),
    e(8, 'system', 'Starting satria…', { handoffId: 'm1' }),
    e(9, 'user', '<transferred_context>', { handoffId: 'm1', transfer: transfer('m1') }),
    e(10, 'system', 'Ready', { handoffId: 'm1' }),
    e(11, 'assistant', 'Got it.', { handoffId: 'm1' }),
    e(12, 'result', '', { handoffId: 'm1' }),
    e(13, 'system', 'Moved to satria', { transfer: transfer('m1') }),
    e(14, 'user', 'carry on'),
  ];
  const { events: shown, moves } = foldMoves(events);
  assert.deepEqual(shown.map((x) => x.seq), [1, 2, 3, 13, 14], 'the chat before, the divider, the chat after');
  const move = moves.get(13)!;
  assert.deepEqual([move.status, move.id, move.members.length], ['done', 'm1', 9]);
  assert.equal(move.marker?.text, 'Moved to satria');
  assert.equal(move.opening?.seq, 9);
  assert.equal(move.acknowledgement, 'Got it.');
});

test('moves: one that is still going shows its last row; one that failed shows why, and neither has a divider or card', () => {
  const running = foldMoves([e(1, 'user', 'hi'), e(2, 'system', 'Default is writing the handoff…', { handoffId: 'a' }), e(3, 'system', 'Starting satria…', { handoffId: 'a' })]);
  assert.deepEqual(running.events.map((x) => x.seq), [1, 3]);
  assert.deepEqual([running.moves.get(3)!.status, running.moves.get(3)!.marker], ['running', null]);
  const failed = foldMoves([
    e(1, 'user', 'hi'),
    e(2, 'system', 'Starting satria…', { handoffId: 'b' }),
    e(3, 'user', '<transferred_context>', { handoffId: 'b', transfer: transfer('b') }),
    e(4, 'error', 'rate limited', { handoffId: 'b' }),
    e(5, 'system', 'The move to satria didn’t finish: satria didn’t take the context: rate limited. Still on Default.', { handoffId: 'b' }),
    e(6, 'user', 'still here'),
  ]);
  assert.deepEqual(failed.events.map((x) => x.seq), [1, 5, 6]);
  assert.equal(failed.moves.get(5)!.status, 'failed');
});

test('moves: two moves fold separately, and a transcript without moves comes back as it is', () => {
  const two = foldMoves([
    e(1, 'user', 'a'),
    e(2, 'user', 'ctx1', { handoffId: 'x', transfer: transfer('x') }),
    e(3, 'system', 'Moved to satria', { transfer: transfer('x') }),
    e(4, 'user', 'b'),
    e(5, 'user', 'ctx2', { handoffId: 'y', transfer: transfer('y') }),
    e(6, 'system', 'Moved to Default', { transfer: transfer('y') }),
  ]);
  assert.deepEqual(two.events.map((x) => x.seq), [1, 3, 4, 6]);
  assert.deepEqual([...two.moves.keys()], [3, 6]);
  const plain = [e(1, 'user', 'x'), e(2, 'user', '<transferred_context>', { transfer: transfer('legacy') }), e(3, 'system', 'New session on Work · transferred from Default')];
  const same = foldMoves(plain);
  assert.deepEqual(same.events, plain, 'a transcript from before moves were tagged is left alone');
  assert.equal(same.moves.size, 0);
});
