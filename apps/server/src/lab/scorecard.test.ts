// Crew scorecard (T-450 S1a): a seeded crew in sqlite. Program A: a lead (L1) continued as L2, five workers on two Claudes holding tickets
// of each kind (done, reopened, wont_do, in review, done without a start); program B: a lead with Agent-tool sub-agents, one worker with
// no role recorded, and a ticket in the owner's queue. A solo chat (S1) is no program. Every expected number carries its derivation.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import type { Actor, CrewProgramScore, CrewScorecard, CrewTarget } from '@portal/contracts';
import { clearResolvers, declaredPolicies, declaredToolPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { LAB_POLICIES } from './authz.js';
import { Lab } from './index.js';
import { registerLabTools } from './portalTools.js';
import { createLabRoutes } from './routes.js';
import { percentile } from './scorecard.js';

const H = 3_600_000;
// Any fixed moment: the lab's clock is injected, nothing reads the real one.
const NOW = Date.UTC(2026, 9, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hoursAgo: number) => NOW - hoursAgo * H;

afterEach(() => clearResolvers());

type Sess = { id: string; created: number; state: string; claude?: string; ticket?: string; parent?: string; continues?: string; agent?: string; maxWorkers?: number; subagents?: 0 | 1 };

async function seeded() {
  const dataDir = mkdtempSync(join(tmpdir(), 'crew-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const db = store.db!;
  const session = (s: Sess) =>
    db
      .prepare(
        `INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, ticket_id, parent_id, continued_from, agent, max_workers, subagents)
         VALUES (?, 'docker/api', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, `title ${s.id}`, s.state, iso(s.created), iso(s.created), iso(s.created), s.claude ?? 'c1', s.ticket ?? null, s.parent ?? null, s.continues ?? null, s.agent ?? null, s.maxWorkers ?? null, s.subagents ?? 0);
  const usage = (sessionId: string, hoursAgo: number, usd: number, model: string, o: { claude?: string; agents?: number } = {}) =>
    db
      .prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, cost_usd, requests, agents) VALUES (?, ?, ?, 'docker/api', ?, ?, ?, 1, ?)`)
      .run(iso(at(hoursAgo)), at(hoursAgo), sessionId, o.claude ?? 'c1', model, usd, o.agents ?? 0);
  const ticket = (n: number, type: string, status: string, o: { closedAgo?: number; assignee?: ['session' | 'user', string] } = {}) =>
    db
      .prepare(
        `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, assignee_kind, assignee_ref, created_at, updated_at, closed_at)
         VALUES (?, ?, 'normal', 2, ?, 'Seed', 'human', 'ui', 'Admin', ?, ?, ?, ?, ?)`,
      )
      .run(n, type, status, o.assignee?.[0] ?? null, o.assignee?.[1] ?? null, iso(at(45)), iso(at(o.closedAgo ?? 1)), o.closedAgo === undefined ? null : iso(at(o.closedAgo)));
  const event = (n: number, hoursAgo: number, kind: string, from: string | null, to: string | null, actor = 'ui') =>
    db
      .prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, data) VALUES (?, ?, ?, ?, 'x', ?)`)
      .run(n, iso(at(hoursAgo)), kind, actor, from && to ? JSON.stringify({ from, to }) : null);
  const run = (id: string, n: number, pipeline: string, status: string, hoursAgo: number, o: { session?: string; ticket?: string }) =>
    db
      .prepare(
        `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, sha, status, actor, session_id, ticket_id, created_at, finished_at)
         VALUES (?, ?, 'docker/api', 'r', 'repo', ?, 'manual', 'refs/heads/x', 'abc', ?, 'agent', ?, ?, ?, ?)`,
      )
      .run(id, n, pipeline, status, o.session ?? null, o.ticket ?? null, iso(at(hoursAgo + 0.5)), iso(at(hoursAgo)));

  // Program A: L1 (ended) continued as L2; W1 under L1, the rest under L2; two Claudes.
  session({ id: 'L1', created: at(40), state: 'ended', maxWorkers: 3 });
  session({ id: 'L2', created: at(24), state: 'idle', continues: 'L1', maxWorkers: 3 });
  session({ id: 'W1', created: at(38), state: 'ended', parent: 'L1', ticket: 'T-1', agent: 'implementer' });
  session({ id: 'W2', created: at(13), state: 'idle', parent: 'L2', ticket: 'T-2', agent: 'qa-verifier', claude: 'c2' });
  session({ id: 'W3', created: at(23), state: 'working', parent: 'L2', ticket: 'T-3', agent: 'implementer', claude: 'c2' });
  session({ id: 'W4', created: at(6), state: 'waiting', parent: 'L2', ticket: 'T-4', agent: 'reviewer', claude: 'c2' });
  session({ id: 'W5', created: at(3), state: 'idle', parent: 'L2', ticket: 'T-5', agent: 'implementer' });
  // Program B: M1 may start sub-agents and did; X1 has no role recorded.
  session({ id: 'M1', created: at(10), state: 'idle', maxWorkers: 2, subagents: 1 });
  session({ id: 'X1', created: at(9), state: 'ended', parent: 'M1', ticket: 'T-10' });
  // A solo chat: no worker, no program.
  session({ id: 'S1', created: at(5), state: 'idle' });

  // Current window [NOW-24h, NOW): A 1.00 + 2.00 (lead) + 0.50 + 0.30 + 0.20 + 0.10 (workers) = 4.10; previous: 1.50 (lead) + 0.40 = 1.90.
  usage('L1', 20, 1.0, 'claude-opus-5-5');
  usage('L2', 5, 2.0, 'claude-opus-5-5');
  usage('W1', 15, 0.5, 'claude-opus-5-5');
  usage('W2', 3, 0.3, 'claude-opus-5-5', { claude: 'c2' }); // a QA worker on opus: D-63 breach
  usage('W4', 3, 0.2, 'claude-sonnet-5-5', { claude: 'c2' });
  usage('W5', 1, 0.1, 'claude-sonnet-5-5');
  usage('L1', 30, 1.5, 'claude-opus-5-5');
  usage('W1', 35, 0.4, 'claude-opus-5-5');
  usage('M1', 2, 0.5, 'claude-opus-5-5', { agents: 2 }); // D-61: a lead with sub-agents
  usage('X1', 2, 0.25, 'claude-opus-5-5');
  usage('S1', 1, 9.0, 'claude-opus-5-5');

  // A's tickets.
  ticket(1, 'feature', 'done', { closedAgo: 10 }); // started 30 h ago: lead time 20 h
  event(1, 30, 'status', 'open', 'in_progress');
  event(1, 20, 'status', 'in_progress', 'in_review');
  event(1, 10, 'closed', 'in_review', 'done');
  ticket(2, 'bug', 'done', { closedAgo: 2 }); // lead time 10 h
  event(2, 12, 'status', 'open', 'in_progress');
  event(2, 2, 'closed', 'in_progress', 'done');
  ticket(3, 'feature', 'in_progress'); // done 6 h ago, reopened 3 h ago: not done, reopened once
  event(3, 22, 'status', 'open', 'in_progress');
  event(3, 6, 'closed', 'in_progress', 'done');
  event(3, 3, 'reopened', 'done', 'in_progress');
  ticket(4, 'task', 'in_review'); // in review for 4 h, waits for QA
  event(4, 5, 'status', 'open', 'in_progress');
  event(4, 4, 'status', 'in_progress', 'in_review');
  db.prepare(`INSERT INTO ticket_tags (ticket_number, tag) VALUES (4, 'waits-qa'), (4, 'area-lab')`).run();
  ticket(5, 'chore', 'wont_do', { closedAgo: 1 });
  event(5, 1, 'closed', 'open', 'wont_do');
  ticket(6, 'feature', 'done', { closedAgo: 30, assignee: ['session', 'W1'] }); // done in the PREVIOUS window (lead time 10 h)
  event(6, 40, 'status', 'open', 'in_progress');
  event(6, 30, 'closed', 'in_progress', 'done');
  ticket(7, 'task', 'done', { closedAgo: 1 }); // done with no start recorded; the program's by W5's comment
  event(7, 2, 'comment', null, null, 'session:W5');
  event(7, 1, 'closed', 'open', 'done');
  // B's tickets: T-11 in the owner's queue (a harness defect, D-62); T-93 is the one allowed.
  ticket(10, 'task', 'open');
  ticket(11, 'request', 'open', { assignee: ['user', 'Owner'] });
  event(11, 2, 'comment', null, null, 'session:M1');
  ticket(93, 'approval', 'open', { assignee: ['user', 'Owner'] });
  event(93, 2, 'comment', null, null, 'session:M1');
  // An unrelated ticket nobody in a program touched.
  ticket(20, 'bug', 'done', { closedAgo: 3 });

  // CI: A's runs (by session or by ticket), one in the previous window, one of nobody's.
  run('r1', 1, 'gate', 'passed', 2, { session: 'W3' });
  run('r2', 2, 'gate', 'failed', 8, { ticket: 'T-1' });
  run('r3', 3, 'deploy', 'cancelled', 1, { session: 'L2' });
  run('r4', 4, 'gate', 'passed', 30, { session: 'W1' });
  run('r5', 5, 'gate', 'passed', 1, { session: 'S9' });
  db.prepare(
    `INSERT INTO ci_deployments (id, run_id, run_number, job, repo_id, environment, pipeline, sha, ref, actor, approval, outcome, created_at)
     VALUES ('d1', 'r3', 3, 'release', 'r', 'cluster', 'deploy', 'abc', 'refs/heads/x', 'agent', 'rejected', NULL, ?)`,
  ).run(iso(at(1)));

  const lab = new Lab({ store, now: () => NOW });
  return { store, db, lab, done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

const prog = (s: CrewScorecard, id: string): CrewProgramScore => {
  const p = s.programs.find((x) => x.program === id);
  assert.ok(p, `program ${id}`);
  return p;
};
const target = (p: CrewProgramScore, id: CrewTarget['id']) => p.targets.find((t) => t.id === id)!;

test('percentile: nearest rank; null with no sample', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2); // ceil(2) - 1 = index 1
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9); // ceil(9) - 1 = index 8
});

test('programs: a lead chain with its continuation and every worker; a solo chat is none', async () => {
  const h = await seeded();
  try {
    const s = h.lab.scorecard({ window: 'day' })!;
    assert.deepEqual(s.programs.map((p) => p.program).sort(), ['L1', 'M1']);
    const a = prog(s, 'L1');
    assert.deepEqual([a.leads, a.workers, a.title], [['L1', 'L2'], 5, 'title L2']);
    assert.equal(prog(s, 'M1').workers, 1);
    assert.ok(s.basis.done && s.basis.cost && s.basis.targets, 'every figure has a written source');
  } finally {
    h.done();
  }
});

test('effectiveness: done by type and per hour, lead time p50 and p90, reopened, wont_do, review backlog, CI and deploys', async () => {
  const h = await seeded();
  try {
    const a = prog(h.lab.scorecard({ window: 'day' })!, 'L1');
    const e = a.current.effectiveness;
    // Done in [NOW-24h, NOW): T-1, T-2, T-7 (T-3 was reopened, T-6 is the previous window's, T-20 is nobody's).
    assert.deepEqual([e.done.value, e.done.basis], [3, 'measured']);
    assert.equal(e.donePerHour.value, 0.13); // 3 / 24 = 0.125, two decimals
    assert.deepEqual([e.reopened.value, e.wontDo.value], [1, 1]);
    const byType = Object.fromEntries(e.byType.map((t) => [t.type, t]));
    assert.deepEqual(Object.keys(byType).sort(), ['bug', 'feature', 'task']);
    assert.deepEqual([byType.feature!.done, byType.feature!.leadTimeP50Ms, byType.feature!.leadTimeP90Ms], [1, 20 * H, 20 * H]);
    assert.deepEqual([byType.bug!.leadTimeP50Ms, byType.bug!.noStart], [10 * H, 0]);
    assert.deepEqual([byType.task!.leadTimeP50Ms, byType.task!.noStart], [null, 1], 'a done ticket with no start is counted, not timed');
    assert.equal(byType.task!.perHour, 0.04); // 1 / 24
    // In review at the window's end: T-4 since 4 h ago, waiting for QA.
    assert.equal(e.reviewBacklog.value, 1);
    assert.deepEqual(e.review, [{ ticket: 'T-4', type: 'task', ageMs: 4 * H, waitsFor: 'qa' }]);
    // CI: r1 (W3) passed, r2 (T-1) failed, r3 (L2) cancelled; r4 is the previous window's, r5 nobody's.
    assert.equal(e.ciRuns.value, 3);
    assert.deepEqual(e.ci, [
      { pipeline: 'deploy', passed: 0, failed: 0, cancelled: 1 },
      { pipeline: 'gate', passed: 1, failed: 1, cancelled: 0 },
    ]);
    assert.equal(e.deploysCount.value, 1);
    assert.deepEqual([e.deploys[0]!.runNumber, e.deploys[0]!.environment, e.deploys[0]!.approval, e.deploys[0]!.outcome], [3, 'cluster', 'rejected', null]);
  } finally {
    h.done();
  }
});

test('cost: total, lead versus workers, per done ticket all-in and workers only; per type from usage spend’s ticketReport', async () => {
  const h = await seeded();
  try {
    const a = prog(h.lab.scorecard({ window: 'day' })!, 'L1');
    const c = a.current.cost;
    assert.deepEqual([c.total.value, c.lead.value, c.workers.value], [4.1, 3, 1.1]);
    assert.equal(c.total.basis, 'estimate');
    assert.equal(c.leadShare.value, 73.17); // 3 / 4.1
    assert.equal(c.perDoneAllIn.value, 1.366667); // 4.1 / 3
    assert.equal(c.perDoneWorkers.value, 0.366667); // 1.1 / 3
    const byType = Object.fromEntries(a.current.effectiveness.byType.map((t) => [t.type, t]));
    // Workers only: the done tickets' own sessions in the window: T-1 is W1's 0.50, T-2 is W2's 0.30, T-7 has no session.
    assert.deepEqual([byType.feature!.costWorkersUsd, byType.bug!.costWorkersUsd, byType.task!.costWorkersUsd], [0.5, 0.3, 0]);
    // All-in adds the leads' dollars apportioned to the tickets (T-449): at least the own part, never more than the window's total.
    assert.ok(byType.feature!.costAllInUsd > 0.5 && byType.bug!.costAllInUsd > 0.3);
    const allIn = a.current.effectiveness.byType.reduce((t, r) => t + r.costAllInUsd, 0);
    assert.ok(allIn <= 4.1 + 1e-9);
    // The same figures as Usage -> Attribution by ticket (the lab's ticketCosts calls the same function).
    const t1 = h.lab.ticketCosts(NOW - 24 * H, NOW - 1).find((t) => t.ticket === 'T-1')!;
    assert.equal(t1.ownUsd, byType.feature!.costWorkersUsd);
  } finally {
    h.done();
  }
});

test('targets: D-61 live workers and lead sub-agents, D-62 owner queue, D-63 QA on sonnet; a role never recorded is unavailable', async () => {
  const h = await seeded();
  try {
    const s = h.lab.scorecard({ window: 'day' })!;
    const a = prog(s, 'L1');
    const b = prog(s, 'M1');
    // A: W2 idle, W3 working, W4 waiting, W5 idle = 4 live over the lead's cap of 3.
    assert.deepEqual([target(a, 'live_workers').state, target(a, 'live_workers').figure.value, target(a, 'live_workers').offenders.sort()], ['breach', 4, ['W2', 'W3', 'W4', 'W5']]);
    assert.deepEqual([target(a, 'lead_subagents').state, target(a, 'owner_queue').state], ['ok', 'ok']);
    assert.deepEqual([target(a, 'qa_review_model').state, target(a, 'qa_review_model').offenders], ['breach', ['W2']], 'the reviewer on sonnet is fine');
    // B: no live worker; the lead ran 2 sub-agents; T-11 waits on the owner (T-93 is allowed); X1's role was never recorded.
    assert.equal(target(b, 'live_workers').state, 'ok');
    assert.deepEqual([target(b, 'lead_subagents').state, target(b, 'lead_subagents').figure.value, target(b, 'lead_subagents').offenders], ['breach', 2, ['M1']]);
    assert.deepEqual([target(b, 'owner_queue').state, target(b, 'owner_queue').offenders], ['breach', ['T-11']]);
    assert.deepEqual([target(b, 'qa_review_model').state, target(b, 'qa_review_model').figure.basis, target(b, 'qa_review_model').figure.reason], ['unavailable', 'unavailable', 'not_recorded']);
    for (const t of [...a.targets, ...b.targets]) assert.ok(['D-61', 'D-62', 'D-63'].includes(t.decision) && t.rule.length > 10, t.id);
    // Sub-agents allowed but none run: a warn, not a breach.
    h.db.prepare('DELETE FROM chat_usage WHERE session_id = ?').run('M1');
    assert.deepEqual(target(prog(h.lab.scorecard({ window: 'day' })!, 'M1'), 'lead_subagents').state, 'warn');
  } finally {
    h.done();
  }
});

test('the previous window to compare; unavailable is null with a reason, never 0 or a guess', async () => {
  const h = await seeded();
  try {
    const s = h.lab.scorecard({ window: 'day', compare: true })!;
    const a = prog(s, 'L1');
    const p = a.previous!;
    assert.deepEqual([p.fromMs, p.toMs], [NOW - 48 * H, NOW - 24 * H]);
    assert.deepEqual([p.effectiveness.done.value, p.cost.total.value, p.cost.lead.value, p.cost.workers.value], [1, 1.9, 1.5, 0.4]);
    assert.equal(p.effectiveness.byType[0]!.leadTimeP50Ms, 10 * H); // T-6
    assert.equal(p.effectiveness.ciRuns.value, 1); // r4
    assert.equal(p.effectiveness.reviewBacklog.value, 0);
    assert.equal(h.lab.scorecard({ window: 'day', compare: false })!.programs[0]!.previous, null);
    // B: nothing done, nothing spent before: divisions by nothing are unavailable (no_samples).
    const b = prog(s, 'M1');
    assert.deepEqual([b.current.cost.perDoneAllIn.value, b.current.cost.perDoneAllIn.basis, b.current.cost.perDoneAllIn.reason], [null, 'unavailable', 'no_samples']);
    assert.deepEqual([b.previous!.cost.leadShare.value, b.previous!.cost.leadShare.reason], [null, 'no_samples']);
    assert.equal(b.previous!.cost.total.value, 0, 'a measured nothing is 0');
    // A table this store does not have: no_source.
    h.db.exec('DROP TABLE ci_deployments');
    const gone = prog(h.lab.scorecard({ window: 'day' })!, 'L1').current.effectiveness;
    assert.deepEqual([gone.deploysCount.value, gone.deploysCount.basis, gone.deploysCount.reason, gone.deploys], [null, 'unavailable', 'no_source', []]);
    assert.equal(gone.ciRuns.value, 3, 'the rest still reads');
    // The 1h window: T-2 closed 2 h ago is out; T-7 closed 1 h ago is in.
    const hour = prog(h.lab.scorecard({ window: '1h' })!, 'L1').current.effectiveness;
    assert.deepEqual([hour.done.value, hour.wontDo.value], [1, 1]);
  } finally {
    h.done();
  }
});

/** The routes behind a stand-in for the sign-in guard (as slice2.test.ts). */
function app(lab: Lab, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/lab', createLabRoutes(lab));
  return a;
}

test('route: declared with the seam; the owner reads all; an agent its own program; anyone else the same 404', async () => {
  const h = await seeded();
  try {
    assert.equal(declaredPolicies().get('GET /api/lab/scorecard')?.kind, 'platform');
    assert.ok('GET /api/lab/scorecard' in LAB_POLICIES);
    assert.equal(declaredToolPolicies().get('crew_scorecard')?.kind, 'agent');
    const owner = app(h.lab);
    const all = (await (await owner.request('/api/lab/scorecard?window=day')).json()) as { data: CrewScorecard };
    assert.deepEqual(all.data.programs.map((p) => p.program).sort(), ['L1', 'M1']);
    assert.equal((await owner.request('/api/lab/scorecard?program=M1')).status, 200);
    assert.equal((await owner.request('/api/lab/scorecard?program=S1')).status, 404, 'a solo chat is no program');
    assert.equal((await owner.request('/api/lab/scorecard?window=year')).status, 422);
    assert.equal((await owner.request('/api/lab/scorecard?compare=yes')).status, 422);

    const bob = app(h.lab, { kind: 'user', userId: 'u_bob', loginSessionId: 'x', via: 'ui' } as Actor);
    assert.equal((await bob.request('/api/lab/scorecard')).status, 404);

    const w3 = app(h.lab, { kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId: 'W3', workspaceId: 'docker/api' } as Actor);
    const mine = (await (await w3.request('/api/lab/scorecard')).json()) as { data: CrewScorecard };
    assert.deepEqual(mine.data.programs.map((p) => p.program), ['L1'], 'a worker reads its own program');
    assert.equal((await w3.request('/api/lab/scorecard?program=L1')).status, 200);
    const other = await w3.request('/api/lab/scorecard?program=M1');
    assert.deepEqual([other.status, await other.json()], [404, { error: { code: 'NOT_FOUND' } }]);
    const solo = app(h.lab, { kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId: 'S1', workspaceId: 'docker/api' } as Actor);
    assert.deepEqual(((await (await solo.request('/api/lab/scorecard')).json()) as { data: CrewScorecard }).data.programs, []);
  } finally {
    h.done();
  }
});

type Row = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const refused = (m: Row) => !!(m.error || m.result?.isError);

test('MCP crew_scorecard: short by default, full on ask; an agent of program A gets its own only and not found for B; admin all', async () => {
  const h = await seeded();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(h.lab, registry);
  try {
    const admin = mcp.token('admin');
    const short = where(await mcp.call(admin.secret, 'crew_scorecard', {}));
    assert.equal(short.scope, 'portal');
    assert.deepEqual(short.programs.map((p: any) => p.program).sort(), ['L1', 'M1']);
    const a = short.programs.find((p: any) => p.program === 'L1');
    assert.deepEqual([a.now.done, a.now.cost_usd, a.now.lead_share_pct, a.before.done], [3, 4.1, 73.17, 1]);
    assert.deepEqual(a.targets, { live_workers: 'breach', lead_subagents: 'ok', owner_queue: 'ok', qa_review_model: 'breach' });
    const b = short.programs.find((p: any) => p.program === 'M1');
    assert.equal(b.now.per_done_usd, 'unavailable:no_samples');
    assert.equal(short.basis, undefined, 'the sources are in the full form');
    const full = where(await mcp.call(admin.secret, 'crew_scorecard', { full: true, window: '6h' }));
    assert.equal(full.window, '6h');
    assert.ok(full.basis.cost && full.programs[0].current.effectiveness.done.source);
    assert.ok(JSON.stringify(full).length > JSON.stringify(short).length);

    const w3 = await mcp.agentToken('docker/api', 'W3');
    const mine = where(await mcp.call(w3.secret, 'crew_scorecard', { compare: false }));
    assert.deepEqual([mine.scope, mine.programs.map((p: any) => p.program), mine.programs[0].before], ['program', ['L1'], null]);
    assert.ok(refused(await mcp.call(w3.secret, 'crew_scorecard', { program: 'M1' })), 'program B is not found for an agent of A');
    assert.equal(where(await mcp.call(w3.secret, 'crew_scorecard', { program: 'L1' })).programs.length, 1);
    const m1 = await mcp.agentToken('docker/api', 'M1');
    assert.deepEqual(where(await mcp.call(m1.secret, 'crew_scorecard', {})).programs.map((p: any) => p.program), ['M1']);
    assert.ok(refused(await mcp.call(m1.secret, 'crew_scorecard', { program: 'L1' })));
    assert.ok(refused(await mcp.call(admin.secret, 'crew_scorecard', { program: 'nope' })), 'not found for admin too');
    assert.ok(refused(await mcp.call(admin.secret, 'crew_scorecard', { window: 'year' })));
  } finally {
    mcp.done();
    h.done();
  }
});
