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
import { ChatStore } from '../chat/store.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { burstEvidence, rateEvidence } from '../usagespend/spikes.js';
import { SpendStore } from '../usagespend/store.js';
import { LAB_POLICIES } from './authz.js';
import { Lab } from './index.js';
import { fitPrograms, registerLabTools, scoreShort } from './portalTools.js';
import { createLabRoutes } from './routes.js';
import { paceBlock, type PaceClaude } from './headline.js';
import { percentile, wasteKind } from './scorecard.js';

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
    assert.deepEqual(e.review, [{ ticket: 'T-4', type: 'task', ageMs: 4 * H, waitsFor: 'qa', waitsBasis: 'tag' }]);
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
    // A done ticket's cost is its LIFE's (S1b, gap 1): the requests from the oldest done ticket's creation (45 h ago) to the window's end,
    // not only the window's. Workers only: T-1 is W1's 0.50 (15 h ago) + 0.40 (35 h ago) = 0.90; T-2 is W2's 0.30; T-7 has no session.
    assert.deepEqual([byType.feature!.costWorkersUsd, byType.bug!.costWorkersUsd, byType.task!.costWorkersUsd], [0.9, 0.3, 0]);
    // All-in adds the lead chain's dollars over the life (L1 1.00 + 1.50, L2 2.00 = 4.50), split evenly over the four tickets its workers
    // were on with requests (T-1, T-2, T-4, T-5: 1.125 each): T-1 = 0.90 + 1.125, T-2 = 0.30 + 1.125.
    assert.deepEqual([byType.feature!.costAllInUsd, byType.bug!.costAllInUsd, byType.task!.costAllInUsd], [2.025, 1.425, 0]);
    // The same figures as Usage -> Attribution by ticket over the same span (the lab's ticketCosts calls the same function).
    const t1 = h.lab.ticketCosts(NOW - 45 * H, NOW).find((t) => t.ticket === 'T-1')!;
    assert.deepEqual([t1.ownUsd, t1.totalUsd], [byType.feature!.costWorkersUsd, byType.feature!.costAllInUsd]);
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
    for (const t of [...a.targets, ...b.targets]) assert.ok(['D-61', 'D-62', 'D-63', 'D-65'].includes(t.decision) && t.rule.length > 10, t.id);
    // Sub-agents allowed but none run: a warn, not a breach.
    h.db.prepare('DELETE FROM chat_usage WHERE session_id = ?').run('M1');
    assert.deepEqual(target(prog(h.lab.scorecard({ window: 'day' })!, 'M1'), 'lead_subagents').state, 'warn');
  } finally {
    h.done();
  }
});

test('T-549 (D-65): the six rows with state, figure, source and offenders; unavailable is a state with its reason', async () => {
  const h = await seeded();
  try {
    const ev = h.db.prepare(`INSERT INTO chat_events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, 'tool_result', ?)`);
    const result = (seq: number, hoursAgo: number, p: Record<string, unknown>) => ev.run('W3', seq, iso(at(hoursAgo)), JSON.stringify(p));
    // W3, in the window: 7 good results, a permission denial, a portal tool error and a failed command = 3 of 10 wasted (30 %).
    for (let i = 1; i <= 7; i++) result(i, 2, { toolName: 'Read', text: 'ok' });
    result(8, 2, { toolName: 'Bash', text: 'Permission to use Bash has been denied.', isError: true });
    result(9, 2, { toolName: 'mcp__pilot__ticket_get', text: 'not found', isError: true });
    result(10, 2, { toolName: 'Bash', text: 'exit code 1', isError: true });
    result(11, 30, { toolName: 'Bash', text: 'exit code 1', isError: true }); // before the window: not counted
    // Quota: c1 left 60 percent unused at its reset 3 h ago (a reading 5 min before), c2 10.
    const sample = h.db.prepare(`INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, ?, 'docker/api', 'session', ?, ?, 'ok', 'probe')`);
    sample.run(at(3) - 5 * 60_000, 'c1', 40, at(3));
    sample.run(at(2) - 5 * 60_000, 'c2', 90, at(2));
    h.db.prepare(`UPDATE chat_sessions SET workspace_id = 'kubernetes/kohi-event' WHERE id = 'L1'`).run();

    const s = h.lab.scorecard({ window: 'day' })!;
    const a = prog(s, 'L1');
    const d65 = a.targets.filter((t) => t.decision === 'D-65');
    assert.deepEqual(d65.map((t) => t.id), ['cost_per_done', 'lead_share', 'qa_opus_share', 'done_rate', 'quota_unused', 'wasted_tool_calls']);
    for (const t of d65) assert.ok(t.rule.length > 20 && t.figure.source.length > 5, `${t.id} states its rule and source`);
    const row = (id: CrewTarget['id']) => target(a, id);
    // 4.10 USD over 3 done tickets (T-1, T-2, T-7) = 1.37: under 8.
    assert.deepEqual([row('cost_per_done').state, row('cost_per_done').figure.value, row('cost_per_done').offenders], ['ok', 1.366667, []]);
    // The lead chain spent 3.00 of 4.10.
    assert.deepEqual([row('lead_share').state, row('lead_share').figure.value, row('lead_share').offenders], ['breach', 73.17, ['L1', 'L2']]);
    // QA and review: W2 (opus) and W4 (sonnet) = 50 percent.
    assert.deepEqual([row('qa_opus_share').state, row('qa_opus_share').figure.value, row('qa_opus_share').offenders], ['breach', 50, ['W2']]);
    // Feature and task done in 24 h: T-1 and T-7 = 2 a day against 48 (workspace claudepilot).
    assert.deepEqual([row('done_rate').state, row('done_rate').figure.value], ['breach', 2]);
    // The worst unused at a reset: 60 percent (c1).
    assert.deepEqual([row('quota_unused').state, row('quota_unused').figure.value, row('quota_unused').offenders], ['breach', 60, ['c1']]);
    assert.deepEqual([row('wasted_tool_calls').state, row('wasted_tool_calls').figure.value, row('wasted_tool_calls').offenders], ['breach', 30, ['W3']]);

    // Program B: no baseline for its workspace, no done ticket, no tool result: unavailable, each with a reason, never a 0.
    const b = prog(s, 'M1');
    const reason = (id: CrewTarget['id']) => [target(b, id).state, target(b, id).figure.value, target(b, id).figure.reason];
    assert.deepEqual(reason('done_rate'), ['unavailable', null, 'not_recorded']);
    assert.deepEqual(reason('cost_per_done'), ['unavailable', null, 'no_samples']);
    assert.deepEqual(reason('wasted_tool_calls'), ['unavailable', null, 'no_samples']);
    assert.deepEqual(reason('qa_opus_share'), ['unavailable', null, 'no_samples']);

    // An agent's own read never sees the quota (every Claude's), and the row says why.
    const own = prog(h.lab.scorecard({ window: 'day', sessionId: 'W3' })!, 'L1');
    assert.deepEqual([target(own, 'quota_unused').state, target(own, 'quota_unused').figure.reason], ['unavailable', 'no_source']);
    assert.ok(s.basis.d65, 'the D-65 rows have a written basis');
  } finally {
    h.done();
  }
});

test('T-549 (D-65): thresholds: warn from 80 percent of a ceiling; the done rate is scaled to a day and breaches far under its baseline', async () => {
  const h = await seeded();
  try {
    h.db.prepare(`INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, 'c1', 'docker/api', 'session', ?, ?, 'ok', 'probe')`).run(at(3) - 60_000, 75, at(3));
    const a = prog(h.lab.scorecard({ window: 'day' })!, 'L1');
    assert.deepEqual([target(a, 'quota_unused').state, target(a, 'quota_unused').figure.value], ['warn', 25], '25 of a 30 ceiling is past 80 percent');
    h.db.prepare(`UPDATE claude_usage_samples SET used_pct = 90`).run();
    assert.deepEqual([target(prog(h.lab.scorecard({ window: 'day' })!, 'L1'), 'quota_unused').state], ['ok']);
    // The window scales to a day: T-1, T-6 and T-7 (feature, feature, task) done in a week = 3 / 7 = 0.43 a day, far under konfersi's 47: a breach.
    h.db.prepare(`UPDATE chat_sessions SET workspace_id = 'kubernetes/konfersi' WHERE id = 'L1'`).run();
    const week = target(prog(h.lab.scorecard({ window: 'week' })!, 'L1'), 'done_rate');
    assert.deepEqual([week.state, week.figure.value], ['breach', 0.43]);
  } finally {
    h.done();
  }
});

test('T-549 (D-65): the done baseline is picked by workspace id: kubernetes/kohi-event is ClaudePilot (48)', async () => {
  const h = await seeded();
  try {
    const baseline = async (ws: string) => {
      h.db.prepare(`UPDATE chat_sessions SET workspace_id = ? WHERE id = 'L1'`).run(ws);
      const t = target(prog(h.lab.scorecard({ window: 'week' })!, 'L1'), 'done_rate');
      return [t.state, t.figure.source.includes('(48 a day)') ? 48 : t.figure.source.includes('(47 a day)') ? 47 : null] as const;
    };
    assert.deepEqual(await baseline('kubernetes/kohi-event'), ['breach', 48]);
    assert.deepEqual(await baseline('kubernetes/konfersi'), ['breach', 47]);
    // No listed id (Event left pilot, D-67; a name that merely contains a program's word): unavailable, never another program's baseline.
    assert.deepEqual(await baseline('kubernetes/event'), ['unavailable', null]);
    assert.deepEqual(await baseline('kubernetes/event-konfersi-x'), ['unavailable', null]);
  } finally {
    h.done();
  }
});

test('T-549 (D-65): a permission denial, a portal tool error and a failed command are told apart', () => {
  assert.equal(wasteKind('Bash', 'Permission to use Bash with command rm has been denied.'), 'denied');
  assert.equal(wasteKind('mcp__pilot__ticket_comment', 'Claude requested permissions to use mcp__pilot__ticket_comment, but you haven’t granted it yet.'), 'denied');
  assert.equal(wasteKind('mcp__pilot__ticket_get', 'ticket not found'), 'portal');
  assert.equal(wasteKind('Bash', 'exit code 2'), 'failed');
  assert.equal(wasteKind(null, null), 'failed');
});

test('T-490 (D-63): the opus share of QA and review workers per program, with its workspace; a worker started with a why is no offender', async () => {
  const h = await seeded();
  try {
    const s = h.lab.scorecard({ window: 'day', compare: true })!;
    const a = prog(s, 'L1');
    const b = prog(s, 'M1');
    assert.deepEqual([a.workspaceId, b.workspaceId], ['docker/api', 'docker/api']);
    // A's QA and review workers with a request in the day: W2 (qa-verifier, opus) and W4 (reviewer, sonnet): 1 of 2 = 50 %.
    const q = a.current.efficiency.qaReviewOpus;
    assert.deepEqual([q.sessions, q.opus, q.opusWithWhy, q.share.value, q.share.basis], [2, 1, 0, 50, 'measured']);
    // The day before: none (W1 is an implementer); B: X1's role was never recorded. Nothing to divide by: unavailable, never 0.
    assert.deepEqual([a.previous!.efficiency.qaReviewOpus.sessions, a.previous!.efficiency.qaReviewOpus.share.value, a.previous!.efficiency.qaReviewOpus.share.reason], [0, null, 'no_samples']);
    assert.deepEqual([b.current.efficiency.qaReviewOpus.sessions, b.current.efficiency.qaReviewOpus.share.reason], [0, 'no_samples']);
    assert.ok(s.basis.qaReviewOpus, 'the figure has a written source');
    // The short tool result carries the share and the workspace.
    const short = scoreShort(a);
    assert.deepEqual([short.workspace, short.now!.qa_review_opus_pct, short.now!.qa_review_sessions, short.now!.qa_review_opus_with_why], ['docker/api', 50, 2, 0]);
    assert.equal(short.before!.qa_review_opus_pct, 'unavailable:no_samples');

    // W2's lead gave a reason (session_spawn why): still counted on opus, now with a why, and no longer a D-63 offender.
    h.db.prepare('UPDATE chat_sessions SET spawn_why = ? WHERE id = ?').run('Release gate on the exact commit.', 'W2');
    const again = prog(h.lab.scorecard({ window: 'day' })!, 'L1');
    const q2 = again.current.efficiency.qaReviewOpus;
    assert.deepEqual([q2.opus, q2.opusWithWhy, q2.share.value], [1, 1, 50]);
    assert.deepEqual([target(again, 'qa_review_model').state, target(again, 'qa_review_model').offenders], ['ok', []]);
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

test('the 6h window: done, per hour, reopened, cost, CI and review over the last 6 hours, and the 6 hours before', async () => {
  const h = await seeded();
  try {
    const a = prog(h.lab.scorecard({ window: '6h' })!, 'L1');
    const e = a.current.effectiveness;
    assert.deepEqual([a.current.fromMs, a.current.toMs], [NOW - 6 * H, NOW]);
    // Done in [NOW-6h, NOW): T-2 (2 h ago) and T-7 (1 h ago); T-1 (10 h ago) is out; T-3 reopened 3 h ago; T-5 wont_do 1 h ago.
    assert.deepEqual([e.done.value, e.donePerHour.value, e.reopened.value, e.wontDo.value], [2, 0.33, 1, 1]);
    assert.deepEqual(e.byType.map((t) => [t.type, t.done]), [['bug', 1], ['task', 1]]);
    // L2 2.00 (5 h ago) + W2 0.30 + W4 0.20 + W5 0.10; lead 2.00 of 2.60.
    assert.deepEqual([a.current.cost.total.value, a.current.cost.lead.value, a.current.cost.workers.value, a.current.cost.perDoneAllIn.value], [2.6, 2, 0.6, 1.3]);
    // r1 (2 h ago) and r3 (1 h ago); r2 (8 h ago) is out.
    assert.equal(e.ciRuns.value, 2);
    assert.equal(e.reviewBacklog.value, 1); // T-4, in review since 4 h ago
    // The 6 hours before: T-1 done 10 h ago; no request of A in [NOW-12h, NOW-6h).
    assert.deepEqual([a.previous!.fromMs, a.previous!.effectiveness.done.value, a.previous!.cost.total.value, a.previous!.effectiveness.ciRuns.value], [NOW - 12 * H, 1, 0, 1]);
  } finally {
    h.done();
  }
});

test('the week window: every done ticket of the week, lead time p50 and p90 over two, and the week’s dollars', async () => {
  const h = await seeded();
  try {
    const a = prog(h.lab.scorecard({ window: 'week' })!, 'L1');
    const e = a.current.effectiveness;
    assert.deepEqual([a.current.fromMs, a.current.toMs], [NOW - 168 * H, NOW]);
    // T-1, T-2, T-7 and T-6 (30 h ago); 4 / 168 = 0.024.
    assert.deepEqual([e.done.value, e.donePerHour.value], [4, 0.02]);
    const feature = e.byType.find((t) => t.type === 'feature')!;
    // T-6 took 10 h and T-1 20 h: p50 at rank ceil(1) = 10 h, p90 at rank ceil(1.8) = 20 h.
    assert.deepEqual([feature.done, feature.leadTimeP50Ms, feature.leadTimeP90Ms], [2, 10 * H, 20 * H]);
    // Every request of A: lead 1.00 + 2.00 + 1.50 = 4.50, workers 0.50 + 0.30 + 0.20 + 0.10 + 0.40 = 1.50.
    assert.deepEqual([a.current.cost.total.value, a.current.cost.lead.value, a.current.cost.workers.value, a.current.cost.perDoneAllIn.value], [6, 4.5, 1.5, 1.5]);
    assert.equal(e.ciRuns.value, 4); // r1 to r4
    assert.equal(a.previous!.fromMs, NOW - 336 * H);
  } finally {
    h.done();
  }
});

test('review waits for: the tag first, else read now from a pending deploy, a live QA session or a person; an older window keeps the tag only', async () => {
  const h = await seeded();
  try {
    const db = h.db;
    // T-4 loses its tag: W4 (reviewer, waiting) holds it, so it waits for QA.
    db.prepare(`DELETE FROM ticket_tags WHERE ticket_number = 4 AND tag = 'waits-qa'`).run();
    // T-8: in review for 20 h; a deploy of its run waits for approval (made 30 h ago, still pending). A's by W3's comment.
    db.prepare(
      `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at)
       VALUES (8, 'feature', 'normal', 2, 'in_review', 'Seed', 'human', 'ui', 'Admin', ?, ?), (9, 'bug', 'normal', 2, 'in_review', 'Seed', 'human', 'ui', 'Admin', ?, ?)`,
    ).run(iso(at(45)), iso(at(1)), iso(at(45)), iso(at(1)));
    db.prepare(`UPDATE tickets SET assignee_kind = 'user', assignee_ref = 'Owner' WHERE number = 9`).run();
    const ev = db.prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, data) VALUES (?, ?, ?, ?, 'x', ?)`);
    ev.run(8, iso(at(22)), 'status', 'ui', JSON.stringify({ from: 'open', to: 'in_progress' }));
    ev.run(8, iso(at(20)), 'status', 'ui', JSON.stringify({ from: 'in_progress', to: 'in_review' }));
    ev.run(8, iso(at(19)), 'comment', 'session:W3', null);
    // T-9: in review since 30 h ago, assigned to a person.
    ev.run(9, iso(at(31)), 'status', 'ui', JSON.stringify({ from: 'open', to: 'in_progress' }));
    ev.run(9, iso(at(30)), 'status', 'ui', JSON.stringify({ from: 'in_progress', to: 'in_review' }));
    ev.run(9, iso(at(29)), 'comment', 'session:W3', null);
    db.prepare(
      `INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, sha, status, actor, session_id, ticket_id, created_at, finished_at)
       VALUES ('r8', 8, 'docker/api', 'r', 'repo', 'deploy', 'manual', 'refs/heads/x', 'abc', 'running', 'agent', NULL, 'T-8', ?, NULL)`,
    ).run(iso(at(30)));
    db.prepare(
      `INSERT INTO ci_deployments (id, run_id, run_number, job, repo_id, environment, pipeline, sha, ref, actor, approval, outcome, created_at)
       VALUES ('d8', 'r8', 8, 'release', 'r', 'cluster', 'deploy', 'abc', 'refs/heads/x', 'agent', 'pending', NULL, ?)`,
    ).run(iso(at(30)));

    const s = h.lab.scorecard({ window: 'day', compare: true })!;
    const a = prog(s, 'L1');
    assert.deepEqual(a.current.effectiveness.review, [
      { ticket: 'T-9', type: 'bug', ageMs: 30 * H, waitsFor: 'owner', waitsBasis: 'derived' },
      { ticket: 'T-8', type: 'feature', ageMs: 20 * H, waitsFor: 'deploy', waitsBasis: 'derived' },
      { ticket: 'T-4', type: 'task', ageMs: 4 * H, waitsFor: 'qa', waitsBasis: 'derived' },
    ]);
    // The day before: only T-9 was in review then (since 6 h before that window's end); what it waits for is not read back in time.
    assert.deepEqual(a.previous!.effectiveness.review, [{ ticket: 'T-9', type: 'bug', ageMs: 6 * H, waitsFor: null, waitsBasis: null }]);
    // A tag wins over what the portal shows.
    db.prepare(`INSERT INTO ticket_tags (ticket_number, tag) VALUES (8, 'waits-stg')`).run();
    const t8 = prog(h.lab.scorecard({ window: 'day' })!, 'L1').current.effectiveness.review.find((r) => r.ticket === 'T-8')!;
    assert.deepEqual([t8.waitsFor, t8.waitsBasis], ['stg', 'tag']);
  } finally {
    h.done();
  }
});

test('a deleted continuation keeps its lead chain and its workers in the program (links put back from the audit and the kept parent)', async () => {
  const h = await seeded();
  let clock = NOW;
  const chat = new ChatStore(h.store, () => new Date(clock));
  try {
    const db = h.db;
    const session = (id: string, hoursAgo: number, state: string, o: { parent?: string; continues?: string; agent?: string } = {}) =>
      db
        .prepare(
          `INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, parent_id, continued_from, agent)
           VALUES (?, 'docker/api', ?, ?, ?, ?, ?, 'c1', ?, ?, ?)`,
        )
        .run(id, `title ${id}`, state, iso(at(hoursAgo)), iso(at(hoursAgo)), iso(at(hoursAgo)), o.parent ?? null, o.continues ?? null, o.agent ?? null);
    // Program C: K1 continued as K2, K2 continued as K3; Y2 started by K2, Y3 by K3.
    session('K1', 30, 'ended');
    session('K2', 20, 'ended', { continues: 'K1' });
    session('K3', 10, 'idle', { continues: 'K2' });
    session('Y2', 15, 'working', { parent: 'K2', agent: 'implementer' });
    session('Y3', 5, 'idle', { parent: 'K3', agent: 'qa-verifier' });
    for (const [id, from, hoursAgo] of [['K2', 'K1', 20], ['K3', 'K2', 10]] as const) {
      clock = at(hoursAgo);
      chat.addAudit({ severity: 'info', kind: 'session.continued', sessionId: id, workspaceId: 'docker/api', actor: 'ui', detail: { from, chain: 1 } });
    }
    // Requests, and the links usage spend keeps from each (as its service does on every request).
    const spend = new SpendStore(h.store);
    const use = (id: string, parent: string | null, hoursAgo: number, usd: number) => {
      db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, cost_usd, requests) VALUES (?, ?, ?, 'docker/api', 'c1', 'claude-opus-5-5', ?, 1)`).run(
        iso(at(hoursAgo)),
        at(hoursAgo),
        id,
        usd,
      );
      spend.keepSession({ sessionId: id, workspaceId: 'docker/api', claudeId: 'c1', parentId: parent, ticketId: null, title: `title ${id}` }, at(hoursAgo));
    };
    use('K2', null, 12, 1);
    use('Y2', 'K2', 11, 0.5);
    use('K3', null, 4, 2);
    use('Y3', 'K3', 3, 0.25);
    // The delete: K3 no longer continues K2, and Y2 has no parent (chat/store.ts deleteSession).
    chat.deleteSession('K2');
    assert.equal((db.prepare(`SELECT continued_from AS c FROM chat_sessions WHERE id = 'K3'`).get() as { c: string | null }).c, null);
    assert.equal((db.prepare(`SELECT parent_id AS p FROM chat_sessions WHERE id = 'Y2'`).get() as { p: string | null }).p, null);

    const s = h.lab.scorecard({ window: 'day' })!;
    assert.deepEqual(s.programs.map((p) => p.program).sort(), ['K1', 'L1', 'M1'], 'one program for C, named by its first row');
    const c = prog(s, 'K1');
    assert.deepEqual([c.leads, c.workers], [['K1', 'K2', 'K3'], 2]);
    // K2 (deleted) and K3 are the lead; Y2 and Y3 the workers.
    assert.deepEqual([c.current.cost.total.value, c.current.cost.lead.value, c.current.cost.workers.value], [3.75, 3, 0.75]);
    assert.equal(c.current.efficiency.handovers.value, 2); // K2 (20 h ago) and K3 (10 h ago)
    // A worker of C reads C.
    assert.deepEqual(h.lab.scorecard({ window: 'day', sessionId: 'Y2' })!.programs.map((p) => p.program), ['K1']);
  } finally {
    h.done();
  }
});

test('efficiency: cost by token class, requests, context per role and per lead, top sessions, model mix, roles, live per Claude, spikes', async () => {
  const h = await seeded();
  try {
    const db = h.db;
    // Only L2's request has tokens (Opus 5.5, input price p): input 1,000 p; output 5 x 1,000 p; cache read 0.05 x 100,000 p; cache write
    // 1.25 x 10,000 p = 23,500 p in all.
    db.prepare(`UPDATE chat_usage SET input_tokens = 1000, output_tokens = 1000, cache_read_tokens = 100000, cache_write_tokens = 10000 WHERE session_id = 'L2'`).run();
    const ctx = db.prepare(`UPDATE chat_sessions SET context_used = ? WHERE id = ?`);
    for (const [id, n] of [['L2', 150000], ['W1', 90000], ['W2', 40000], ['W4', 60000], ['W5', 20000], ['W3', 70000]] as const) ctx.run(n, id);
    const spike = db.prepare(`INSERT INTO usage_spikes (at_ms, kind, subject, session_id, workspace_id, claude_id, evidence) VALUES (?, ?, ?, ?, 'docker/api', ?, ?)`);
    spike.run(at(2), 'burst', 'W3', 'W3', 'c2', JSON.stringify(burstEvidence(30, 20, 1.5)));
    spike.run(at(1), 'rate', 'c1', null, 'c1', JSON.stringify(rateEvidence(5, { baselineUsd: 1, factor: 5, periods: 10 }, { sessionId: 'L2', share: 0.8 })));
    spike.run(at(1), 'burst', 'S1', 'S1', 'c1', JSON.stringify(burstEvidence(25, 20, 1))); // a solo chat's: not A's

    const a = prog(h.lab.scorecard({ window: 'day', compare: true })!, 'L1');
    const f = a.current.efficiency;
    assert.deepEqual(
      [f.costParts.input.value, f.costParts.output.value, f.costParts.cacheRead.value, f.costParts.cacheWrite.value, f.costParts.input.basis],
      [4.26, 21.28, 21.28, 53.19, 'estimate'],
    );
    // L1, L2, W1, W2, W4, W5: one request each.
    assert.deepEqual([f.requests.value, f.requestsPerSession.value], [6, 1]);
    // W3 made no request in the window, so its context is not a sample; L1 never recorded one.
    assert.deepEqual(f.contextByRole, [
      { key: 'implementer', sessions: 2, p50: 20000, p90: 90000 },
      { key: 'lead', sessions: 1, p50: 150000, p90: 150000 },
      { key: 'qa-verifier', sessions: 1, p50: 40000, p90: 40000 },
      { key: 'reviewer', sessions: 1, p50: 60000, p90: 60000 },
    ]);
    assert.deepEqual(f.contextByLead, [
      { key: 'L1', sessions: 1, p50: 90000, p90: 90000, leadTokens: null },
      { key: 'L2', sessions: 3, p50: 40000, p90: 60000, leadTokens: 150000 },
    ]);
    assert.deepEqual(
      f.topSessions.map((t) => [t.session, t.role, t.costUsd]),
      [['L2', 'lead', 2], ['L1', 'lead', 1], ['W1', 'implementer', 0.5], ['W2', 'qa-verifier', 0.3], ['W4', 'reviewer', 0.2]],
    );
    assert.deepEqual(
      f.modelMix.map((m) => [m.role, m.model, m.requests, m.costUsd]),
      [
        ['lead', 'claude-opus-5-5', 2, 3],
        ['implementer', 'claude-opus-5-5', 1, 0.5],
        ['qa-verifier', 'claude-opus-5-5', 1, 0.3],
        ['reviewer', 'claude-sonnet-5-5', 1, 0.2],
        ['implementer', 'claude-sonnet-5-5', 1, 0.1],
      ],
    );
    // Started in the window: L2 (24 h ago, the window's first moment), W5, W2, W4; L1 and W1 are older.
    assert.deepEqual(
      f.roles.map((r) => [r.role, r.sessions, r.started, r.requestsPerSession]),
      [['implementer', 2, 1, 1], ['lead', 2, 1, 1], ['qa-verifier', 1, 1, 1], ['reviewer', 1, 1, 1]],
    );
    // Live now: W2, W3, W4 on c2; L2 and W5 on c1.
    assert.deepEqual(f.liveByClaude, [{ claude: 'c2', live: 3 }, { claude: 'c1', live: 2 }]);
    assert.deepEqual([f.handovers.value, f.handoversPerHour.value], [1, 0.04]); // L2
    assert.equal(f.spikesCount.value, 2);
    assert.deepEqual(
      f.spikes.map((x) => [x.kind, x.session, x.role, x.claude, x.summary]),
      [['burst', 'W3', 'implementer', 'c2', '30 requests in 10 min (limit 20)'], ['rate', 'L2', 'lead', 'c1', '$5.00 in 15 min, 5x the usual']],
    );
    // The day before: no live count (it is a "now" figure) and no token, so no share.
    assert.deepEqual([a.previous!.efficiency.liveByClaude, a.previous!.efficiency.costParts.input.reason], [[], 'no_samples']);
    // A table this store does not have: unavailable, not 0.
    db.exec('DROP TABLE usage_spikes');
    const gone = prog(h.lab.scorecard({ window: 'day' })!, 'L1').current.efficiency;
    assert.deepEqual([gone.spikesCount.value, gone.spikesCount.reason, gone.spikes], [null, 'no_source', []]);
  } finally {
    h.done();
  }
});

test('health: refusals by scope, integrity and error endings in the window; pod memory and OOM are unavailable', async () => {
  const h = await seeded();
  let clock = NOW;
  const chat = new ChatStore(h.store, () => new Date(clock));
  try {
    const refuse = (sessionId: string, hoursAgo: number, scope: string) => {
      clock = at(hoursAgo);
      chat.addAudit({ severity: 'medium', kind: 'agent.refused', sessionId, workspaceId: 'docker/api', actor: `session:${sessionId}`, detail: { scope } });
    };
    refuse('L2', 2, 'cap');
    refuse('L2', 3, 'cap');
    refuse('W3', 1, 'messages');
    refuse('L2', 30, 'cap'); // the day before
    refuse('M1', 1, 'cap'); // program B's
    const end = h.db.prepare(`UPDATE chat_sessions SET state = ?, ended_reason = ?, state_since = ? WHERE id = ?`);
    end.run('ended', 'integrity: the host script changed', iso(at(5)), 'W1');
    end.run('interrupted', 'the session host could not start (exit 1)', iso(at(1)), 'W3');
    end.run('ended', 'closed by operator', iso(at(23)), 'L1'); // an ordinary end

    const a = prog(h.lab.scorecard({ window: 'day', compare: true })!, 'L1');
    const x = a.current.health;
    assert.deepEqual([x.refusals.value, x.refusalsByScope], [3, [{ scope: 'cap', count: 2 }, { scope: 'messages', count: 1 }]]);
    assert.deepEqual([x.badEndings.value, x.endings], [
      2,
      [
        { session: 'W1', kind: 'integrity', at: iso(at(5)) },
        { session: 'W3', kind: 'error', at: iso(at(1)) },
      ],
    ]);
    assert.deepEqual([x.podMemory.basis, x.podMemory.reason, x.oomRestarts.value], ['unavailable', 'no_source', null]);
    assert.deepEqual([a.previous!.health.refusals.value, a.previous!.health.badEndings.value], [1, 0]);
    const short = prog(h.lab.scorecard({ window: 'day' })!, 'M1').current.health;
    assert.equal(short.refusals.value, 1);
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
    assert.deepEqual(a.targets, {
      live_workers: 'breach',
      lead_subagents: 'ok',
      owner_queue: 'ok',
      qa_review_model: 'breach',
      cost_per_done: 'ok',
      lead_share: 'breach',
      qa_opus_share: 'breach',
      done_rate: 'unavailable',
      quota_unused: 'unavailable',
      wasted_tool_calls: 'unavailable',
    });
    const b = short.programs.find((p: any) => p.program === 'M1');
    assert.equal(b.now.per_done_usd, 'unavailable:no_samples');
    assert.equal(short.basis, undefined, 'the sources are in the full form');
    const fullCall = await mcp.call(admin.secret, 'crew_scorecard', { full: true, window: '6h' });
    assert.ok(!refused(fullCall), `the full form fits the result limit: ${JSON.stringify(fullCall).slice(0, 300)}`);
    const full = where(fullCall);
    assert.equal(full.window, '6h');
    const fa = full.programs.find((p: any) => p.program === 'L1');
    assert.deepEqual(fa.targets.find((t: any) => t.id === 'lead_share'), { id: 'lead_share', state: 'breach', value: 76.92, offenders: ['L1', 'L2'] }, 'a D-65 target is one short row in the full form');
    assert.equal(fa.targets.find((t: any) => t.id === 'quota_unused').value, 'unavailable:no_samples');
    // Each figure has its basis; its source is named once in `basis`.
    const done = full.programs[0].current.effectiveness.done;
    assert.deepEqual([done.basis, done.source, typeof full.basis.done, typeof full.basis.health], ['measured', undefined, 'string', 'string']);
    assert.ok(full.programs[0].current.efficiency.requests && full.programs[0].current.health.refusals);
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

test('MCP crew_scorecard full: 2, 3, 4 and 5 programs stay under the result limit; the rest are named and can be asked for', async () => {
  const h = await seeded();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(h.lab, registry);
  try {
    const admin = mcp.token('admin');
    const sizes: number[] = [];
    for (let n = 2; n <= 5; n++) {
      if (n > 2) {
        // A big program: a chain of 600 lead sessions (each continues the one before; the program's `leads` lists them all), about 9,000 characters in the full form.
        const ins = h.db.prepare(
          `INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, continued_from, max_workers, subagents) VALUES (?, 'docker/api', ?, ?, ?, ?, ?, 'c1', ?, 2, 0)`,
        );
        for (let i = 0; i < 600; i++) {
          const id = `N${n}-${String(i).padStart(4, '0')}`;
          ins.run(id, `title ${id}`, i === 599 ? 'idle' : 'ended', iso(at(20 - i / 100)), iso(at(20 - i / 100)), iso(at(20 - i / 100)), i === 0 ? null : `N${n}-${String(i - 1).padStart(4, '0')}`);
        }
        // A program needs a worker: one under the last lead.
        h.db.prepare(
          `INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, parent_id, agent) VALUES (?, 'docker/api', 'w', 'idle', ?, ?, ?, 'c1', ?, 'implementer')`,
        ).run(`N${n}w`, iso(at(3)), iso(at(3)), iso(at(3)), `N${n}-0599`);
        h.db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, cost_usd, requests, agents) VALUES (?, ?, ?, 'docker/api', 'c1', 'claude-opus-5-5', 1, 1, 0)`).run(iso(at(2)), at(2), `N${n}-0599`);
      }
      const call = await mcp.call(admin.secret, 'crew_scorecard', { full: true });
      assert.ok(!refused(call), `${n} programs: refused: ${JSON.stringify(call).slice(0, 200)}`);
      const text = (call as any).result.content[0].text as string;
      const body = text.slice(text.indexOf('\n') + 1);
      sizes.push(body.length);
      assert.ok(body.length <= 19_000, `${n} programs: ${body.length} characters`);
      const full = where(call);
      assert.equal(full.programs.length + (full.omitted?.length ?? 0), n, `${n} programs: every program is either carried or named`);
      assert.ok(full.programs.length >= 1, 'at least one program is carried');
      if (n >= 3) assert.ok(full.omitted?.length > 0, `${n} programs go over 19,000 characters: the rest are named in omitted (${sizes.join(', ')})`);
      for (const id of full.omitted ?? []) {
        const one = await mcp.call(admin.secret, 'crew_scorecard', { full: true, program: id });
        assert.ok(!refused(one) && where(one).programs[0].program === id, `omitted ${id} can be asked for alone`);
      }
    }
    console.log(`crew_scorecard full sizes at 2, 3, 4, 5 programs: ${sizes.join(', ')}`);
  } finally {
    mcp.done();
    h.done();
  }
});

test('fitPrograms: a program fits at exactly the ceiling and is left out one character over', () => {
  const head = { scope: 'portal' };
  const rows = [{ program: 'a', x: 'x'.repeat(20) }, { program: 'b', x: 'y'.repeat(20) }];
  const both = JSON.stringify({ ...head, programs: rows }).length;
  const exact = fitPrograms(head, rows, both) as any;
  assert.deepEqual([exact.programs.length, exact.omitted], [2, undefined], 'at the ceiling both fit');
  const over = fitPrograms(head, rows, both - 1) as any;
  assert.deepEqual([over.programs.map((r: any) => r.program), over.omitted], [['a'], ['b']], 'one character over, the second is named, not carried');
  const tiny = fitPrograms(head, rows, 1) as any;
  assert.deepEqual([tiny.programs.length, tiny.omitted], [1, ['b']], 'one program is always carried');
  assert.deepEqual((fitPrograms(head, [], 1) as any).programs, []);
});

/* ---------- T-600: the headline (lab/headline.ts) ---------- */

type PaceTriple = [used: number, even: number | null, projected?: number | null];
const pfig = (v: number | null | undefined) => (v === null || v === undefined ? { value: null, basis: 'unavailable', reason: 'no_samples' } : { value: v, basis: 'estimate' });
const win = (key: string, t: PaceTriple) => ({ key, usedPct: t[0], pace: { evenPct: pfig(t[1]), projectedPct: pfig(t[2]) } as never });
function claude(id: string, o: { runsOn?: PaceClaude['runsOn']; state?: PaceClaude['state']; session?: PaceTriple; week?: PaceTriple } = {}): PaceClaude {
  return { claudeId: id, claudeName: `Claude ${id}`, runsOn: o.runsOn ?? 'plan', state: o.state ?? 'ok', windows: [...(o.session ? [win('session', o.session)] : []), ...(o.week ? [win('week', o.week)] : [])] };
}

test('headline pace: signed-out, pooled, key and pace-less Claudes are left out; ratio is the sum of used over the sum of even', () => {
  const p = paceBlock([
    claude('a', { session: [30, 50, 60] }),
    claude('b', { session: [20, 50, 70] }),
    claude('c', { runsOn: 'none', state: 'signed_out', session: [90, 10, 95] }), // signed out
    claude('d', { runsOn: 'pool', state: 'no_limits', session: [90, 10, 95] }), // pooled
    claude('e', { runsOn: 'key', session: [90, 10, 95] }), // API key
    claude('f', { state: 'signed_out', session: [90, 10, 95] }), // state says signed out
    claude('g', { session: [40, null] }), // pace unavailable
  ]);
  assert.deepEqual([p.ratio.value, p.ratio.basis], [0.5, 'estimate']); // (30 + 20) / (50 + 50)
  assert.ok(p.ratio.source.length > 0);
  assert.deepEqual(p.claudes.map((c) => c.claude), ['a', 'b']);
  assert.equal(p.unusedAtResetPct, 35); // under 0.9: 100 - mean(60, 70)
});

test('headline pace: under 10 points of even pace is windows_just_reset; none readable is no_claude; no source is no_source', () => {
  const reset = paceBlock([claude('a', { session: [1, 4] }), claude('b', { session: [2, 5.9] })]);
  assert.deepEqual([reset.ratio.value, reset.ratio.basis, reset.ratio.reason, reset.unusedAtResetPct], [null, 'unavailable', 'windows_just_reset', null]);
  assert.equal(paceBlock([claude('a', { session: [5, 10] })]).ratio.value, 0.5, '10 is enough');
  assert.equal(paceBlock([claude('a', { session: [5, 9.9] })]).ratio.reason, 'windows_just_reset', '9.9 is not');
  for (const none of [[], [claude('c', { runsOn: 'none', state: 'signed_out', session: [9, 50] })], [claude('d', { runsOn: 'pool', session: [9, 50] })]]) {
    const p = paceBlock(none);
    assert.deepEqual([p.ratio.value, p.ratio.reason, p.claudes], [null, 'no_claude', []]);
  }
  const src = paceBlock(null);
  assert.deepEqual([src.ratio.reason, src.weekly.reason, src.claudes], ['no_source', 'no_source', []]);
});

test('headline pace: a ratio of 0.9 or more shows no unused quota; one Claude with even pace 0 has no ratio of its own; weekly the same way', () => {
  const p = paceBlock([claude('a', { session: [60, 60, 100], week: [30, 40] }), claude('b', { session: [3, 0, 100], week: [10, 20] })]);
  assert.equal(p.ratio.value, 1.05); // 63 / 60
  assert.equal(p.unusedAtResetPct, null);
  const b = p.claudes.find((c) => c.claude === 'b')!;
  assert.deepEqual([b.ratio.value, b.ratio.basis, b.ratio.reason], [null, 'unavailable', 'no_samples']);
  assert.equal(p.claudes.find((c) => c.claude === 'a')!.ratio.value, 1);
  assert.equal(p.weekly.value, 0.67); // 40 / 60
  assert.equal(paceBlock([claude('a', { session: [60, 60] })]).weekly.reason, 'no_source', 'no Claude reports a week');
  assert.equal(paceBlock([claude('a', { session: [10, 60, null] })]).unusedAtResetPct, null, 'under 0.9 but no projection: unknown, not guessed');
});

const PACES = [claude('a', { session: [30, 50, 60] }), claude('b', { session: [20, 50, 70] })];

test('headline: counts and dollars match the program rows; previous only with compare', async () => {
  const h = await seeded();
  try {
    const lab = new Lab({ store: h.store, now: () => NOW, paceSource: async () => PACES });
    const s = (await lab.scorecardWithPace({ window: 'day' }))!;
    const hl = s.headline!;
    assert.equal(hl.pace.ratio.value, 0.5);
    // Current [NOW-24h, NOW): done T-1, T-2, T-7 (A) and none in B; T-5 won't-do. Requests 8 (A 6, B 2), dollars A 4.10 + B 0.75 = 4.85 (the solo chat is no program).
    assert.deepEqual([hl.current.resolved.value, hl.current.wontDo.value, hl.current.resolved.basis], [3, 1, 'measured']);
    assert.deepEqual(hl.current.resolvedByProgram.map((r) => [r.program, r.count]).sort(), [['L1', 3], ['M1', 0]]);
    for (const r of hl.current.resolvedByProgram) assert.equal(r.count, prog(s, r.program).current.effectiveness.done.value, `${r.program} equals its program row`);
    assert.equal(hl.current.requestsPerHour.value, 0.33); // 8 / 24
    assert.equal(hl.current.usdPerHour.value, 0.202); // 4.85 / 24
    assert.equal(hl.current.perResolvedUsd.value, 1.62); // 4.85 / 3
    assert.equal(hl.current.usdPerHour.basis, 'estimate');
    // Created in the window: none (every seeded ticket is 45 h old). Closed: T-1, T-2, T-7, T-5 = 4.
    assert.equal(hl.current.createdPerClosed.value, 0);
    const cur = Object.fromEntries(hl.current.createdPerClosedByProgram.map((r) => [r.program, r]));
    assert.deepEqual([cur.L1!.created, cur.L1!.closed, cur.L1!.ratio.value], [0, 4, 0]);
    assert.deepEqual([cur.M1!.closed, cur.M1!.ratio.value, cur.M1!.ratio.reason], [0, null, 'no_samples'], 'none closed is not a division by zero');
    // Previous [NOW-48h, NOW-24h): T-6 done; ten tickets of the programs created (A 7, B 3); requests 2, dollars 1.90.
    const pv = hl.previous!;
    assert.deepEqual([pv.resolved.value, pv.requestsPerHour.value, pv.usdPerHour.value, pv.perResolvedUsd.value], [1, 0.08, 0.079, 1.9]);
    assert.equal(pv.createdPerClosed.value, 10);
    const prevRows = Object.fromEntries(pv.createdPerClosedByProgram.map((r) => [r.program, r]));
    assert.deepEqual([prevRows.L1!.created, prevRows.L1!.closed, prevRows.L1!.ratio.value, prevRows.M1!.created, prevRows.M1!.ratio.reason], [7, 1, 7, 3, 'no_samples']);
    assert.equal(pv.fromMs, NOW - 48 * H);
    assert.equal((await lab.scorecardWithPace({ window: 'day', compare: false }))!.headline!.previous, null);
  } finally {
    h.done();
  }
});

test('headline: none resolved gives no per-resolved cost, none closed gives no created-per-closed (never a division by zero)', async () => {
  const h = await seeded();
  try {
    const lab = new Lab({ store: h.store, now: () => NOW });
    h.db.prepare(`UPDATE tickets SET status = 'open', closed_at = NULL WHERE number = 7`).run(); // T-7 was done exactly 1 h ago
    const one = lab.scorecard({ window: '1h', compare: false })!.headline!.current;
    assert.deepEqual([one.resolved.value, one.wontDo.value], [0, 1], 'only T-5 closed in the hour, as won’t-do');
    assert.deepEqual([one.perResolvedUsd.value, one.perResolvedUsd.basis, one.perResolvedUsd.reason], [null, 'unavailable', 'no_samples']);
    assert.equal(one.usdPerHour.value, 0.1, 'the hour still has W5’s dollar tenth: cost is known, resolved is zero');
    assert.equal(one.createdPerClosed.value, 0); // 0 created / 1 closed
    h.db.prepare(`UPDATE tickets SET status = 'open', closed_at = NULL WHERE number = 5`).run();
    const nothing = lab.scorecard({ window: '1h', compare: false })!.headline!.current;
    assert.deepEqual([nothing.createdPerClosed.value, nothing.createdPerClosed.reason], [null, 'no_samples']);
    assert.ok(nothing.createdPerClosedByProgram.every((r) => r.ratio.value === null && r.ratio.reason === 'no_samples'));
  } finally {
    h.done();
  }
});

test('headline: an agent sees only its own program and no pace; a failing pace source is no_source', async () => {
  const h = await seeded();
  const logs: string[] = [];
  try {
    const lab = new Lab({ store: h.store, now: () => NOW, paceSource: async () => PACES, log: (m) => logs.push(m) });
    const mine = (await lab.scorecardWithPace({ window: 'day', sessionId: 'W3' }))!.headline!;
    assert.deepEqual([mine.pace.ratio.reason, mine.pace.weekly.reason, mine.pace.claudes], ['no_source', 'no_source', []], 'pace is quota of every program: an agent never gets it');
    assert.deepEqual(mine.current.resolvedByProgram.map((r) => r.program), ['L1'], 'no other program in any list');
    assert.deepEqual(mine.current.createdPerClosedByProgram.map((r) => r.program), ['L1']);
    assert.equal(mine.current.requestsPerHour.value, 0.25); // A's 6 requests only (B's 2 are not its)
    assert.equal(mine.current.usdPerHour.value, 0.171); // 4.10 / 24
    assert.equal(mine.current.resolved.value, 3);
    const other = (await lab.scorecardWithPace({ window: 'day', sessionId: 'M1' }))!.headline!;
    assert.deepEqual([other.current.resolved.value, other.current.requestsPerHour.value, other.current.resolvedByProgram.map((r) => r.program)], [0, 0.08, ['M1']]);
    const solo = (await lab.scorecardWithPace({ window: 'day', sessionId: 'S1' }))!.headline!;
    assert.deepEqual([solo.current.resolvedByProgram, solo.current.requestsPerHour.value, solo.current.resolved.value], [[], 0, 0]);
    // The owner's read has it.
    assert.equal((await lab.scorecardWithPace({ window: 'day' }))!.headline!.pace.ratio.value, 0.5);
    // A source that fails: no_source, one log line without the error text.
    const broken = new Lab({ store: h.store, now: () => NOW, log: (m) => logs.push(m), paceSource: async () => Promise.reject(new Error('probe secret-looking text')) });
    const b = (await broken.scorecardWithPace({ window: 'day' }))!;
    assert.equal(b.headline!.pace.ratio.reason, 'no_source');
    assert.ok(logs.some((l) => l.includes('pace source failed')) && !logs.some((l) => l.includes('secret-looking')));
    // No source wired: the same.
    assert.equal(h.lab.scorecard({ window: 'day' })!.headline!.pace.ratio.reason, 'no_source');
  } finally {
    h.done();
  }
});

test('headline: the route and the crew_scorecard tool carry it; an agent token gets no pace', async () => {
  const h = await seeded();
  const lab = new Lab({ store: h.store, now: () => NOW, paceSource: async () => PACES });
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerLabTools(lab, registry);
  try {
    const owner = (await (await app(lab).request('/api/lab/scorecard?window=day')).json()) as { data: CrewScorecard };
    assert.equal(owner.data.headline?.pace.ratio.value, 0.5);
    assert.equal(owner.data.headline?.current.resolved.value, 3);
    const w3 = app(lab, { kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId: 'W3', workspaceId: 'docker/api' } as Actor);
    const mine = (await (await w3.request('/api/lab/scorecard')).json()) as { data: CrewScorecard };
    assert.equal(mine.data.headline?.pace.ratio.reason, 'no_source');
    assert.deepEqual(mine.data.headline?.current.resolvedByProgram.map((r) => r.program), ['L1']);
    const admin = mcp.token('admin');
    assert.equal(where(await mcp.call(admin.secret, 'crew_scorecard', {})).headline.pace.ratio.value, 0.5, 'short form');
    const full = await mcp.call(admin.secret, 'crew_scorecard', { full: true });
    assert.ok(!refused(full) && where(full).headline.current.resolved.value === 3, 'full form fits the result limit');
    const agent = await mcp.agentToken('docker/api', 'W3');
    const hl = where(await mcp.call(agent.secret, 'crew_scorecard', {})).headline;
    assert.deepEqual([hl.pace.ratio.reason, hl.current.resolvedByProgram.map((r: any) => r.program)], ['no_source', ['L1']]);
  } finally {
    mcp.done();
    h.done();
  }
});
