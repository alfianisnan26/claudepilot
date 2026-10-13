import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttributionBy } from '@portal/contracts';
import { creatorOf, OWNER_ACTOR } from './actor.js';
import { attribute, lineage, rootOf, shareOf, unattributed, workspaceNameOf, type AttributionInput, type GrouperFactory } from './attribution.js';
import type { PersonaRecord, SessionInfo, UsageRow } from './model.js';

// The fixture, worked out by hand (dollars; t0 + n is "n minutes in"):
//
//   S1 "Parent"     docker/api  c1  ticket T-1   no parent    row a (t0+1)  $1.00  in 100 out 50 cacheR 1000 cacheW 200  1 request, 2 sub-agents
//                                                             row b (t0+2)  $0.50  in  50 out 25 cacheR  500 cacheW 100  1 request
//   S2 "Child A"    docker/api  c1  no ticket    parent S1   row   (t0+3)  $2.00  in 200 out 100                          1 request
//   S3 "Child B"    docker/web  c2  ticket T-2   parent S1   row   (t0+4)  $3.00  in 300 out 150                          1 request, 1 sub-agent
//   S4 "Grandchild" docker/api  c1  no ticket    parent S2   row   (t0+5)  $0.25  in  10 out   5                          1 request
//   S5 "Solo"       docker/web  c2  no ticket    no parent   row   (t0+6)  $4.00  in 400 out 200                          1 request
//   S6 (deleted: nothing kept of it)  docker/api  c1         row   (t0+7)  $0.75  in  30 out  20                          1 request
//
// Window: $1.00 + 0.50 + 2.00 + 3.00 + 0.25 + 4.00 + 0.75 = $11.50, 7 requests.
const T0 = Date.UTC(2026, 9, 12, 3, 0, 0);
const MIN = 60_000;

const row = (session: string, workspaceId: string, claudeId: string, atMin: number, costUsd: number, over: Partial<UsageRow> = {}): UsageRow => ({
  atMs: T0 + atMin * MIN,
  sessionId: session,
  workspaceId,
  claudeId,
  model: 'claude-opus-4-5',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd,
  requests: 1,
  agents: 0,
  kind: 'turn',
  ...over,
});

const ROWS: UsageRow[] = [
  row('S1', 'docker/api', 'c1', 1, 1.0, { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, agents: 2 }),
  row('S1', 'docker/api', 'c1', 2, 0.5, { input: 50, output: 25, cacheRead: 500, cacheWrite: 100 }),
  row('S2', 'docker/api', 'c1', 3, 2.0, { input: 200, output: 100 }),
  row('S3', 'docker/web', 'c2', 4, 3.0, { input: 300, output: 150, agents: 1 }),
  row('S4', 'docker/api', 'c1', 5, 0.25, { input: 10, output: 5 }),
  row('S5', 'docker/web', 'c2', 6, 4.0, { input: 400, output: 200 }),
  row('S6', 'docker/api', 'c1', 7, 0.75, { input: 30, output: 20 }),
];

const info = (sessionId: string, workspaceId: string, claudeId: string, title: string, over: Partial<SessionInfo> = {}): [string, SessionInfo] => [
  sessionId,
  { sessionId, workspaceId, claudeId, parentId: null, ticketId: null, title, state: 'idle', exists: true, ...over },
];

const SESSIONS = new Map<string, SessionInfo>([
  info('S1', 'docker/api', 'c1', 'Parent', { ticketId: 'T-1' }),
  info('S2', 'docker/api', 'c1', 'Child A', { parentId: 'S1' }),
  info('S3', 'docker/web', 'c2', 'Child B', { parentId: 'S1', ticketId: 'T-2' }),
  info('S4', 'docker/api', 'c1', 'Grandchild', { parentId: 'S2' }),
  info('S5', 'docker/web', 'c2', 'Solo'),
  // S6 is not here: it was deleted before its links were kept.
]);

// Personas as recorded at launches: S1 had Dev at t0 and Ops from t0+1.5 (so its two rows differ); S2 had none from t0+3; S3's first
// record comes after its request; S4 and S6 have none; S5 had Dev from t0.
const rec = (atMin: number, personaId: string | null, name: string | null): PersonaRecord => ({ atMs: T0 + atMin * MIN, personaId, name, revision: personaId ? 1 : null });
const PERSONAS = new Map<string, PersonaRecord[]>([
  ['S1', [rec(0, 'p1', 'Dev'), rec(1.5, 'p2', 'Ops')]],
  ['S2', [rec(3, null, null)]],
  ['S3', [rec(5, 'p1', 'Dev')]],
  ['S5', [rec(0, 'p1', 'Dev')]],
]);

const input = (by: AttributionBy, over: Partial<AttributionInput> = {}): AttributionInput => ({
  by,
  rows: ROWS,
  sessions: SESSIONS,
  personas: PERSONAS,
  claudeName: (id) => ({ c1: 'Default', c2: 'Satria' })[id] ?? id,
  personaName: (id, recorded) => (id === 'p2' ? 'Ops (renamed)' : (recorded ?? id)),
  limit: 25,
  ...over,
});

const brief = (a: ReturnType<typeof attribute>) => a.rows.map((r) => [r.key, r.state, r.total.costUsd, r.total.requests]);

test('the window total is every request, however it is grouped', () => {
  const a = attribute(input('workspace'));
  assert.deepEqual(a.totals, { costUsd: 11.5, input: 1090, output: 550, cacheRead: 1500, cacheWrite: 300, requests: 7, agents: 3 });
});

test('by session: a tree in which a session total holds the sessions it started, and the roots add up to the window', () => {
  const a = attribute(input('session'));
  // Pre-order, siblings by cost: S1 (1.50 + S3 3.00 + S2 2.00 + S4 0.25 = 6.75), then S3 (3.00) before S2 (2.25), S2's S4, then S5 (4.00), S6 (0.75).
  assert.deepEqual(a.rows.map((r) => [r.key, r.session!.depth, r.own.costUsd, r.total.costUsd]), [
    ['S1', 0, 1.5, 6.75],
    ['S3', 1, 3.0, 3.0],
    ['S2', 1, 2.0, 2.25],
    ['S4', 2, 0.25, 0.25],
    ['S5', 0, 4.0, 4.0],
    ['S6', 0, 0.75, 0.75],
  ]);
  // The roots add up to the window: 6.75 + 4.00 + 0.75 = 11.50.
  assert.equal(a.rows.filter((r) => r.session!.depth === 0).reduce((s, r) => s + r.total.costUsd, 0), a.totals.costUsd);
  const s1 = a.rows[0]!;
  assert.deepEqual([s1.label, s1.own.requests, s1.total.requests, s1.own.agents, s1.sessions, s1.session!.children, s1.session!.ticketId], ['Parent', 2, 5, 2, 4, 2, 'T-1']);
  // A parent's own sub-agents (2) are in its own request; a child session's are its own (S3 has 1): the total adds them, once each.
  assert.equal(s1.total.agents, 3);
  assert.deepEqual([s1.total.input, s1.total.output, s1.total.cacheRead, s1.total.cacheWrite], [660, 330, 1500, 300]);
  // Shares of $11.50, to two decimals: 6.75 / 11.5 = 58.70 %, 4 / 11.5 = 34.78 %, 0.75 / 11.5 = 6.52 %; dollars are an estimate.
  assert.deepEqual(a.rows.map((r) => r.share.value), [58.7, 26.09, 19.57, 2.17, 34.78, 6.52]);
  assert.ok(a.rows.every((r) => r.share.basis === 'estimate'));
  // The deleted session has requests and no kept facts: it still shows, marked as not existing, named by its id.
  const s6 = a.rows[5]!;
  assert.deepEqual([s6.label, s6.session!.exists, s6.session!.title, s6.session!.workspaceName, s6.session!.parentId], ['Session S6', false, '', 'api', null]);
  assert.equal(a.coverage.value, 100);
  assert.equal(a.more, 0);
  assert.deepEqual([s1.firstAt, s1.lastAt], [new Date(T0 + MIN).toISOString(), new Date(T0 + 2 * MIN).toISOString()]);
});

test('by session with a limit: the roots past it sum into Others, with their children', () => {
  const a = attribute(input('session', { limit: 1 }));
  assert.deepEqual(a.rows.map((r) => [r.key, r.state, r.total.costUsd]), [
    ['S1', 'known', 6.75],
    ['S3', 'known', 3.0],
    ['S2', 'known', 2.25],
    ['S4', 'known', 0.25],
    ['others', 'others', 4.75],
  ]);
  assert.equal(a.more, 2);
  assert.equal(a.rows[4]!.sessions, 2, 'S5 and S6');
  assert.equal(a.rows[4]!.share.value, 41.3, '4.75 / 11.5');
});

test('by ticket: a helper with no ticket of its own counts under its parent’s; a session with none anywhere is "none"; a deleted one is unknown', () => {
  const a = attribute(input('ticket'));
  // T-1: S1 1.50 + S2 2.00 + S4 0.25 = 3.75. T-2: S3 3.00. None: S5 4.00. Unknown (S6 was deleted): 0.75.
  assert.deepEqual(brief(a), [
    ['T-1', 'known', 3.75, 4],
    ['T-2', 'known', 3.0, 1],
    ['', 'none', 4.0, 1],
    ['', 'unknown', 0.75, 1],
  ]);
  assert.equal(a.rows[3]!.reason, 'session_deleted');
  assert.equal(a.rows[2]!.label, 'No ticket');
  // Known or none: 3.75 + 3.00 + 4.00 = 10.75 of 11.50 = 93.48 %.
  assert.deepEqual([a.coverage.value, a.coverage.basis], [93.48, 'estimate']);
});

test('by persona: the persona recorded at or before each request; a request before any record is "not recorded", never guessed', () => {
  const a = attribute(input('persona'));
  // Dev (p1): S1's row at t0+1 (1.00) + S5 (4.00) = 5.00. Ops (p2): S1's row at t0+2 (0.50), shown under its current name.
  // None: S2 (a record at exactly its time counts). Not recorded: S3 (its record is later), S4, S6 = 3.00 + 0.25 + 0.75 = 4.00.
  assert.deepEqual(
    a.rows.map((r) => [r.key, r.label, r.state, r.total.costUsd, r.reason ?? null]),
    [
      ['p1', 'Dev', 'known', 5.0, null],
      ['p2', 'Ops (renamed)', 'known', 0.5, null],
      ['', 'No persona', 'none', 2.0, null],
      ['', 'Not recorded', 'unknown', 4.0, 'not_recorded'],
    ],
  );
  // 7.50 of 11.50 recorded = 65.22 %.
  assert.equal(a.coverage.value, 65.22);
  assert.equal(a.rows[0]!.sessions, 2, 'S1 and S5');
});

test('by workspace and by Claude: where the requests ran', () => {
  const w = attribute(input('workspace'));
  assert.deepEqual(brief(w), [
    ['docker/web', 'known', 7.0, 2],
    ['docker/api', 'known', 4.5, 5],
  ]);
  assert.deepEqual(w.rows.map((r) => r.label), ['web', 'api']);
  const c = attribute(input('claude'));
  assert.deepEqual(c.rows.map((r) => [r.key, r.label, r.total.costUsd]), [
    ['c2', 'Satria', 7.0],
    ['c1', 'Default', 4.5],
  ]);
  assert.equal(c.coverage.value, 100);
});

test('a limit on a flat dimension keeps "none" and "unknown" out of Others', () => {
  const a = attribute(input('ticket', { limit: 1 }));
  assert.deepEqual(brief(a), [
    ['T-1', 'known', 3.75, 4],
    ['others', 'others', 3.0, 1],
    ['', 'none', 4.0, 1],
    ['', 'unknown', 0.75, 1],
  ]);
  assert.equal(a.more, 1);
});

test('nothing recorded: every share and the coverage are unavailable, with the reason', () => {
  for (const by of ['session', 'workspace', 'ticket', 'persona', 'claude'] as const) {
    const a = attribute(input(by, { rows: [] }));
    assert.deepEqual(a.totals, { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0 });
    assert.deepEqual(a.rows, []);
    assert.deepEqual(a.coverage, { value: null, basis: 'unavailable', reason: 'no_samples' });
  }
});

test('requests that cost nothing: tokens and counts stand, but a share of zero dollars is unavailable (no_cost), not 0 % or NaN', () => {
  const free = ROWS.map((r) => ({ ...r, costUsd: 0 }));
  const a = attribute(input('workspace', { rows: free }));
  assert.equal(a.totals.requests, 7);
  assert.equal(a.totals.input, 1090);
  assert.ok(a.rows.every((r) => r.share.value === null && r.share.reason === 'no_cost'));
  assert.deepEqual(a.coverage, { value: null, basis: 'unavailable', reason: 'no_cost' });
  assert.deepEqual(shareOf({ costUsd: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1, agents: 0 }, { costUsd: 4, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 2, agents: 0 }), { value: 25, basis: 'estimate' });
});

test('a parent that is gone leaves its child a root that still names it; a cycle of parent links cannot lose a request', () => {
  const orphan = attribute(
    input('session', {
      rows: [row('K', 'docker/api', 'c1', 1, 1.0)],
      sessions: new Map([info('K', 'docker/api', 'c1', 'Kid', { parentId: 'GONE' })]),
    }),
  );
  assert.deepEqual(orphan.rows.map((r) => [r.key, r.session!.depth, r.session!.parentId]), [['K', 0, 'GONE']]);

  const loop = attribute(
    input('session', {
      rows: [row('A', 'docker/api', 'c1', 1, 1.0), row('B', 'docker/api', 'c1', 2, 2.0)],
      sessions: new Map([info('A', 'docker/api', 'c1', 'A', { parentId: 'B' }), info('B', 'docker/api', 'c1', 'B', { parentId: 'A' })]),
    }),
  );
  assert.deepEqual(loop.rows.map((r) => [r.key, r.session!.depth, r.total.costUsd]), [
    ['A', 0, 3.0],
    ['B', 1, 2.0],
  ]);
  assert.equal(loop.totals.costUsd, 3.0);
});

test('a parent with no requests of its own is still a row, so its children hang from it', () => {
  const a = attribute(
    input('session', {
      rows: [row('C1', 'docker/api', 'c1', 1, 2.0)],
      sessions: new Map([info('P', 'docker/api', 'c1', 'Idle parent'), info('C1', 'docker/api', 'c1', 'Worker', { parentId: 'P' })]),
    }),
  );
  assert.deepEqual(a.rows.map((r) => [r.key, r.own.requests, r.total.requests, r.total.costUsd, r.firstAt === null]), [
    ['P', 0, 1, 2.0, true],
    ['C1', 1, 1, 2.0, false],
  ]);
});

test('workspace names are the last part of the id', () => {
  assert.equal(workspaceNameOf('docker/api'), 'api');
  assert.equal(workspaceNameOf('local'), 'local');
  assert.equal(workspaceNameOf('k8s/ns/api'), 'api');
});

test('the roll-up of a child into its parent is one helper: the lineage, and the root at its end', () => {
  const sessions = new Map<string, SessionInfo>([
    info('R1', 'docker/api', 'c1', 'Root'),
    info('K1', 'docker/api', 'c1', 'Child', { parentId: 'R1' }),
    info('G1', 'docker/api', 'c1', 'Grandchild', { parentId: 'K1' }),
    info('X', 'docker/api', 'c1', 'Orphan', { parentId: 'GONE' }), // its parent was deleted before its links were kept
    info('A', 'docker/api', 'c1', 'A', { parentId: 'B' }),
    info('B', 'docker/api', 'c1', 'B', { parentId: 'A' }), // a cycle of parent links (corrupt data)
  ]);
  const ids = (id: string) => lineage(id, sessions).sessions.map((x) => x.sessionId);
  assert.deepEqual([ids('G1'), lineage('G1', sessions).broken], [['G1', 'K1', 'R1'], false], 'the session, then each parent up to the root');
  assert.deepEqual([ids('R1'), lineage('R1', sessions).broken], [['R1'], false]);
  assert.deepEqual([ids('X'), lineage('X', sessions).broken], [['X'], true], 'stops at a parent that is gone, and says so');
  assert.deepEqual([ids('NOBODY'), lineage('NOBODY', sessions).broken], [[], true]);
  assert.equal(lineage('A', sessions).broken, true, 'a cycle ends the walk instead of looping');
  assert.deepEqual([rootOf('G1', sessions).session?.sessionId, rootOf('G1', sessions).broken], ['R1', false]);
  assert.deepEqual([rootOf('X', sessions).session?.sessionId, rootOf('X', sessions).broken], ['X', true], 'the topmost session still known, flagged');
  assert.deepEqual(rootOf('NOBODY', sessions), { session: null, broken: true });
});

test('an unattributed group keeps its real totals and says why; a reason without its own label reads "Unknown"', () => {
  assert.deepEqual(unattributed('not_recorded'), { state: 'unknown', key: '', label: 'Not recorded', reason: 'not_recorded' });
  assert.deepEqual(unattributed('session_deleted'), { state: 'unknown', key: '', label: 'Unknown', reason: 'session_deleted' });
  assert.equal(unattributed('no_history').label, 'Unknown');
  // In a report: the persona report of the fixture has 4.00 dollars that are "not recorded": real dollars, a reason, not a zero.
  const row = attribute(input('persona')).rows.find((r) => r.state === 'unknown')!;
  assert.deepEqual([row.total.costUsd, row.total.requests, row.reason, row.share.value], [4, 3, 'not_recorded', 34.78]);
});

test('a new dimension plugs in as one grouper: usage per user, children rolled up to the creator of the ROOT session (PLAN-12, hand-checked)', () => {
  // R1 (made by alice) started K1 (made, say, by bob's token) which started G1; R2 is bob's; X's parent is gone; DEL was deleted with nothing kept.
  const creators: Record<string, string> = { R1: 'u_alice', K1: 'u_bob', G1: 'u_carol', R2: 'u_bob', X: 'u_dave' };
  const sessions = new Map<string, SessionInfo>([
    info('R1', 'docker/api', 'c1', 'Root'),
    info('K1', 'docker/api', 'c1', 'Child', { parentId: 'R1' }),
    info('G1', 'docker/api', 'c1', 'Grandchild', { parentId: 'K1' }),
    info('R2', 'docker/api', 'c1', 'Second root'),
    info('X', 'docker/api', 'c1', 'Orphan', { parentId: 'GONE' }),
  ]);
  const rows = [row('R1', 'docker/api', 'c1', 1, 1.0), row('K1', 'docker/api', 'c1', 2, 2.0), row('G1', 'docker/api', 'c1', 3, 0.5), row('R2', 'docker/api', 'c1', 4, 4.0), row('X', 'docker/api', 'c1', 5, 0.25), row('DEL', 'docker/api', 'c1', 6, 0.75)];
  const user: GrouperFactory = (i) => (r) => {
    const { session, broken } = rootOf(r.sessionId, i.sessions);
    if (!session || broken) return unattributed('session_deleted'); // the root is not known: whose it is cannot be said
    const who = creators[session.sessionId]!;
    return { state: 'known', key: who, label: who };
  };
  const a = attribute({ ...input('workspace'), by: 'user' as never, rows, sessions, groupers: { user } });
  // alice: her root R1 1.00 + K1 2.00 + G1 0.50 (all of them roll up to R1's creator, whoever made them) = 3.50. bob: R2 4.00.
  // Not known: X (its parent is gone) 0.25 and DEL (gone) 0.75 = 1.00, kept as one row with its reason. Window $8.50.
  assert.deepEqual(a.rows.map((r) => [r.key, r.state, r.total.costUsd, r.reason ?? null, r.share.value]), [
    ['u_bob', 'known', 4, null, 47.06],
    ['u_alice', 'known', 3.5, null, 41.18],
    ['', 'unknown', 1, 'session_deleted', 11.76],
  ]);
  assert.equal(a.totals.costUsd, 8.5);
  assert.equal(a.coverage.value, 88.24, '7.50 of 8.50');
  // Nobody provided it: the report says so rather than guessing a grouping.
  assert.throws(() => attribute({ ...input('workspace'), by: 'user' as never }), /no way to group by user/);
  // Today the creator is the one owner, whoever is asked about.
  assert.equal(creatorOf(sessions.get('G1')), OWNER_ACTOR);
  assert.equal(creatorOf(undefined), 'u_owner');
});

test('side questions: a `side` row is inside the window total and its session’s row, and shown apart in `side`; a window without one says 0', () => {
  const plain = attribute(input('workspace'));
  assert.deepEqual(plain.side, { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0 });
  const withSide = attribute(input('session', { rows: [...ROWS, row('S5', 'docker/web', 'c2', 8, 0.2, { input: 20, output: 10, kind: 'side' })] }));
  assert.deepEqual(withSide.side, { costUsd: 0.2, input: 20, output: 10, cacheRead: 0, cacheWrite: 0, requests: 1, agents: 0 });
  assert.equal(withSide.totals.costUsd, 11.7, 'counted in the window');
  assert.equal(withSide.totals.requests, 8);
  const solo = withSide.rows.find((r) => r.key === 'S5')!;
  assert.deepEqual([solo.own.costUsd, solo.own.requests], [4.2, 2], 'and in its session’s row');
});
