// Pilot metrics over the Portal MCP (T-2360 section D, metricsTools.ts): the five tools are declared and registered; who may call them (an
// admin's token, a lead's agent token; a worker's or an unknown session's token gets the same NOT_FOUND); argument validation; the short
// shapes; the size budget on a large seeded store; the findings on a golden fixture. The lab's clock is injected: nothing reads the real one.
// No token-shaped literal: the commit sha is built here.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { clearResolvers, declaredToolPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { MAX_RESULT_CHARS } from '../portalmcp/server.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { LAB_TOOL_POLICIES } from './authz.js';
import { Lab } from './index.js';
import { writeSnapshots } from './metricsSnapshots.js';
import { fitRows, hours, registerMetricsTools, TICKETS_DEFAULT } from './metricsTools.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hoursAgo: number) => NOW - hoursAgo * H;
const SHA = 'cd34'.repeat(10);
const TOOLS = ['metrics_overview', 'metrics_flow_times', 'metrics_trend', 'metrics_insights', 'metrics_tickets'];

afterEach(() => clearResolvers());

/** The golden fixture of metricsRoutes.test.ts (T-1's full journey, won't-do, blocked, in review, stalled), plus a lead L1 and its worker W1. */
async function seeded() {
  const dataDir = mkdtempSync(join(tmpdir(), 'metrics-mcp-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const db = store.db!;
  const lab = new Lab({ store, now: () => NOW, settings: { get: () => undefined } });
  const ticket = (n: number, status: string, o: { createdAgo: number; closedAgo?: number; type?: string; priority?: string; tags?: string[]; updatedAgo?: number }) => {
    db.prepare(
      `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, 2, ?, 'Seed text that must never reach a result', 'human', 'ui', 'Admin', ?, ?, ?)`,
    ).run(n, o.type ?? 'feature', o.priority ?? 'normal', status, iso(at(o.createdAgo)), iso(at(o.updatedAgo ?? o.closedAgo ?? 0)), o.closedAgo === undefined ? null : iso(at(o.closedAgo)));
    for (const t of o.tags ?? []) db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)').run(n, t);
  };
  const status = (n: number, hoursAgo: number, from: string, to: string) =>
    db.prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, data) VALUES (?, ?, 'status', 'session:W1', 'x', ?)`).run(n, iso(at(hoursAgo)), JSON.stringify({ from, to }));
  const comment = (n: number, hoursAgo: number, body: string, o: { actor?: string; data?: unknown } = {}) =>
    db
      .prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, 'comment', ?, 'x', ?, ?)`)
      .run(n, iso(at(hoursAgo)), o.actor ?? 'session:W1', body, o.data === undefined ? null : JSON.stringify(o.data));
  const merged = (n: number, hoursAgo: number) =>
    db.prepare(`INSERT INTO ticket_merge_status (ticket_number, repo, pr, pr_head, state, actor, actor_label, at) VALUES (?, 'claudepilot', 7, ?, 'merged', 'system', 'gate', ?)`).run(n, SHA, iso(at(hoursAgo)));
  const session = (id: string, parent: string | null) =>
    db
      .prepare(
        `INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, parent_id, continued_from, max_workers, subagents) VALUES (?, 'docker/api', 'A title an agent chose', 'ended', ?, ?, ?, 'c1', ?, NULL, 2, 0)`,
      )
      .run(id, iso(at(20)), iso(at(20)), iso(at(1)), parent);

  session('L1', null);
  session('W1', 'L1');
  ticket(1, 'done', { createdAgo: 10, closedAgo: 1, tags: ['claudepilot', 'area-lab'], priority: 'high' });
  status(1, 9, 'open', 'in_progress');
  comment(1, 8.5, 'Plan: the loader first.');
  comment(1, 6, `Done so far.\nSelf-test: claudepilot-job-1 on ${SHA} fail 3`);
  comment(1, 4, 'QA: pass', { actor: 'session:Q1', data: { verdict: 'pass', role: 'qa' } });
  merged(1, 3);
  ticket(2, 'wont_do', { createdAgo: 6, closedAgo: 2, tags: ['konfersi'] });
  ticket(3, 'done', { createdAgo: 20, closedAgo: 5, tags: ['konfersi'], type: 'bug' });
  ticket(4, 'done', { createdAgo: 40, closedAgo: 30, tags: ['claudepilot'] });
  ticket(5, 'in_review', { createdAgo: 12, updatedAgo: 5, tags: ['claudepilot'] });
  status(5, 5, 'in_progress', 'in_review');
  ticket(6, 'blocked', { createdAgo: 12, updatedAgo: 2, tags: ['konfersi'] });
  ticket(9, 'in_progress', { createdAgo: 12, updatedAgo: 8, tags: ['claudepilot'] });
  ticket(8, 'done', { createdAgo: 4, closedAgo: 3, tags: ['program-kohi'] });
  return { store, db, lab, ticket, status, done: () => (lab.close(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

type Call = { result?: { isError?: boolean; structuredContent?: any }; error?: unknown };
const data = (m: Call) => {
  assert.ok(!m.error && !m.result?.isError, `the call failed: ${JSON.stringify(m).slice(0, 400)}`);
  return m.result!.structuredContent;
};
const code = (m: Call) => m.result?.structuredContent?.error?.code ?? (m.error ? 'RPC_ERROR' : null);

async function harness() {
  const h = await seeded();
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  registerMetricsTools(h.lab, registry);
  return { h, mcp, registry, done: () => (mcp.done(), h.done()) };
}

test('registered and declared: five read-only agent-scope tools; agent reach enforced by the handler', async () => {
  const { registry, done } = await harness();
  try {
    for (const name of TOOLS) {
      const t = registry.get(name);
      assert.ok(t, name);
      assert.equal(t.scope, 'agent', name);
      assert.equal(t.hints?.readOnly, true, name);
      assert.deepEqual(declaredToolPolicies().get(name), { kind: 'agent', reach: 'session' }, name);
      assert.ok(name in LAB_TOOL_POLICIES, name);
      assert.ok(t.description.length <= 1000, `${name}: description at most 1,000 characters`);
    }
  } finally {
    done();
  }
});

test('policy: an admin token and a lead read; a worker and an unknown session get the same NOT_FOUND as each other', async () => {
  const { mcp, done } = await harness();
  try {
    const admin = mcp.token('read').secret;
    const lead = (await mcp.agentToken('docker/api', 'L1')).secret;
    const worker = (await mcp.agentToken('docker/api', 'W1')).secret;
    const stranger = (await mcp.agentToken('docker/api', 'X9')).secret;
    const args: Record<string, Record<string, unknown>> = { metrics_trend: { metric: 'effectiveness' } };
    for (const name of TOOLS) {
      assert.equal(data(await mcp.call(admin, name, args[name] ?? {})).reach, 'portal', name);
      assert.equal(data(await mcp.call(lead, name, args[name] ?? {})).reach, 'lead', name);
      const w = await mcp.call(worker, name, args[name] ?? {});
      const s = await mcp.call(stranger, name, args[name] ?? {});
      assert.equal(code(w), 'NOT_FOUND', `${name}: a worker is refused`);
      assert.deepEqual(w.result, s.result, `${name}: a worker reads exactly like an unknown session`);
    }
    // A program that is not there: NOT_FOUND for the admin too.
    assert.equal(code(await mcp.call(admin, 'metrics_overview', { program: 'nope' })), 'NOT_FOUND');
  } finally {
    done();
  }
});

test('validation: a bad window, metric, group_by, stage, program id or a group without group_by is refused', async () => {
  const { mcp, done } = await harness();
  try {
    const admin = mcp.token('read').secret;
    const bad: [string, Record<string, unknown>][] = [
      ['metrics_overview', { window: '1h' }],
      ['metrics_overview', { program: 'a b' }],
      ['metrics_flow_times', { group_by: 'colour' }],
      ['metrics_flow_times', { window: '30d' }],
      ['metrics_trend', {}],
      ['metrics_trend', { metric: 'x' }],
      ['metrics_trend', { metric: 'efficiency', window: '1y' }],
      ['metrics_insights', { window: 'week' }],
      ['metrics_tickets', { stage: 'nap' }],
      ['metrics_tickets', { group: 'high' }],
      ['metrics_tickets', { limit: 0 }],
      ['metrics_tickets', { limit: 101 }],
      ['metrics_tickets', { cursor: 'forged.cursor' }],
    ];
    for (const [name, args] of bad) {
      const r = await mcp.call(admin, name, args);
      assert.ok(r.error || r.result?.isError, `${name} ${JSON.stringify(args)} is refused`);
      assert.notEqual(code(r), 'NOT_FOUND', `${name} ${JSON.stringify(args)}: a validation error, not a not found`);
    }
  } finally {
    done();
  }
});

test('shapes: overview, flow times, trend and tickets are short, in hours, with unavailable reasons; no ticket text, no session title', async () => {
  const { h, mcp, done } = await harness();
  try {
    const admin = mcp.token('read').secret;
    const ov = data(await mcp.call(admin, 'metrics_overview', {}));
    assert.deepEqual([ov.program.id, ov.window, ov.now], ['all', '24h', iso(NOW)]);
    assert.deepEqual([ov.flow.done, ov.flow.wont_do, ov.flow.before.done], [3, 1, 1]);
    assert.deepEqual(ov.flow.stages.implement, { n: 1, left_out: 2, p50_h: 3, p90_h: 3, before_p50_h: null });
    assert.deepEqual(ov.flow.rounds, { n: 1, median: 2, reworked: 1, fails: 1 });
    assert.deepEqual(ov.open, { open: 0, in_progress: 1, blocked: 1, in_review: 1, oldest_review_h: 5, stalled: 1 });
    // No live session: the efficiency score is unavailable, never 0, and each part says why.
    assert.equal(ov.efficiency.value, null);
    assert.ok(Object.values(ov.efficiency.parts).every((v) => typeof v === 'string' && (v as string).startsWith('unavailable:')));
    assert.equal(typeof ov.more, 'string');
    const full = data(await mcp.call(admin, 'metrics_overview', { full: true, program: 'claudepilot', window: '7d' }));
    assert.equal(full.program.id, 'claudepilot');
    assert.equal(typeof full.basis.stages, 'string');
    assert.equal(full.efficiency.components[0].source, undefined, 'full: the sources are named once in basis');

    const memor = data(await mcp.call(admin, 'metrics_overview', { program: 'memor-id' }));
    assert.deepEqual([memor.program.unavailable, memor.open], ['unavailable:no_source', 'unavailable:no_source']);

    const fl = data(await mcp.call(admin, 'metrics_flow_times', { group_by: 'lead' }));
    assert.equal(fl.group_by, 'lead');
    assert.deepEqual(fl.groups.map((g: any) => [g.key, g.done]), [['unrecorded', 2], ['area-lab', 1]]);
    assert.deepEqual(fl.groups.find((g: any) => g.key === 'area-lab').p50_h, { start: 1, report: 1.5, implement: 3, test: 2, deliver: 2, resolve: 9, work: 8 });
    const flFull = data(await mcp.call(admin, 'metrics_flow_times', { group_by: 'type', full: true }));
    assert.deepEqual(flFull.groups.map((g: any) => g.key).sort(), ['bug', 'feature']);
    assert.equal(flFull.groups[0].stages.resolve.n >= 1, true);

    writeSnapshots(h.db, at(2), [{ program: 'all', values: { effectiveness: 60 } }]);
    writeSnapshots(h.db, at(1), [{ program: 'all', values: { effectiveness: 70 } }]);
    const tr = data(await mcp.call(admin, 'metrics_trend', { metric: 'effectiveness' }));
    assert.deepEqual([tr.window, tr.unit, tr.first, tr.last, tr.min, tr.max], ['7d', 'score 0-100', 60, 70, 60, 70]);
    assert.deepEqual(tr.points, [[at(2), 60], [at(1), 70]]);
    const none = data(await mcp.call(admin, 'metrics_trend', { metric: 'resolveP50', window: '30d', program: 'konfersi' }));
    assert.deepEqual([none.points, none.last, none.unit], [[], null, 'ms']);
    assert.match(none.summary, /unavailable/);

    const tk = data(await mcp.call(admin, 'metrics_tickets', { stage: 'resolve', group_by: 'priority', group: 'high' }));
    assert.deepEqual(tk.rows.map((r: any) => r.ticket), ['T-1']);
    assert.deepEqual(tk.rows[0].h, { start: 1, report: 1.5, implement: 3, test: 2, deliver: 2, resolve: 9, work: 8 });
    assert.deepEqual([tk.rows[0].rounds, tk.rows[0].fails, tk.rows[0].closed], [2, 1, iso(at(1))]);

    const all = JSON.stringify([ov, full, fl, flFull, tr, tk]);
    assert.ok(!all.includes('Seed text') && !all.includes('A title an agent chose') && !all.includes('Plan: the loader'), 'no ticket text and no session title');
  } finally {
    done();
  }
});

test('insights on the golden fixture: blocked share and review wait (warn) before the slowest stage (info), with ticket ids', async () => {
  const { mcp, done } = await harness();
  try {
    const admin = mcp.token('read').secret;
    const ins = data(await mcp.call(admin, 'metrics_insights', {}));
    assert.deepEqual(ins.items, [
      { kind: 'blocked_share', severity: 'warn', text: '33 % of open work is blocked (1 of 3).', tickets: ['T-6'] },
      { kind: 'review_wait', severity: 'warn', text: 'T-5 has waited 5 h in review (target 2 h).', tickets: ['T-5'] },
      { kind: 'slowest_stage', severity: 'info', text: 'Slowest stage: implement, median 3 h (p90 3 h) over 1 tickets; 2 left out with no implement recorded.', tickets: [] },
    ]);
    assert.equal(ins.summary, '3 findings for all over the last 24h.');
    const memor = data(await mcp.call(admin, 'metrics_insights', { program: 'memor-id' }));
    assert.deepEqual(memor.items.map((i: any) => i.kind), ['no_data']);
  } finally {
    done();
  }
});

test('size budget: a large store (3,000 done tickets, 300 leads, a month of snapshots) stays under the result limit in every tool', async () => {
  const { h, mcp, done } = await harness();
  try {
    const ins = h.db.prepare(
      `INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at) VALUES (?, ?, 'normal', 2, 'done', 'x', 'human', 'ui', 'Admin', ?, ?, ?)`,
    );
    const tag = h.db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)');
    // Every ticket type the tickets table's CHECK allows.
    const TYPES = ['task', 'bug', 'feature', 'question', 'request', 'incident', 'approval', 'chore'];
    const ev = h.db.prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, data) VALUES (?, ?, 'status', 'session:W1', 'x', ?)`);
    h.db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) {
      const n = 1000 + i;
      const closed = at((i % 160) + 0.5); // spread over the last 7 days
      ins.run(n, TYPES[i % TYPES.length]!, iso(closed - 20 * H), iso(closed), iso(closed));
      tag.run(n, 'claudepilot');
      tag.run(n, `area-l${i % 300}`);
      ev.run(n, iso(closed - 10 * H), JSON.stringify({ from: 'open', to: 'in_progress' }));
    }
    h.db.exec('COMMIT');
    const rows = [];
    for (let t = at(30 * 24); t <= NOW; t += 10 * 60_000) rows.push(t);
    for (const t of rows) writeSnapshots(h.db, t, [{ program: 'all', values: { effectiveness: 50, efficiency: 40, startP50: 123_456 } }]);

    const admin = mcp.token('read').secret;
    const calls: [string, Record<string, unknown>][] = [
      ['metrics_overview', { window: '7d' }],
      ['metrics_overview', { window: '7d', full: true }],
      ['metrics_flow_times', { window: '7d', group_by: 'lead' }],
      ['metrics_flow_times', { window: '7d', group_by: 'lead', full: true }],
      ['metrics_flow_times', { window: '7d', group_by: 'type', full: true }],
      ['metrics_trend', { metric: 'startP50', window: '30d' }],
      ['metrics_insights', { window: '7d' }],
      ['metrics_tickets', { window: '7d' }],
      ['metrics_tickets', { window: '7d', limit: 100 }],
    ];
    for (const [name, args] of calls) {
      const r = await mcp.call(admin, name, args);
      const d = data(r);
      assert.ok(JSON.stringify(d).length < MAX_RESULT_CHARS, `${name} ${JSON.stringify(args)}: ${JSON.stringify(d).length} characters`);
    }
    const short = data(await mcp.call(admin, 'metrics_flow_times', { window: '7d', group_by: 'lead' }));
    assert.equal(short.groups.length, 30, 'the short form keeps 30 groups');
    assert.ok(h.lab.metrics.flow('all', '7d', 'lead')!.groups.length > 300, 'the 300 seeded leads and the fixture’s');
    const fullLead = data(await mcp.call(admin, 'metrics_flow_times', { window: '7d', group_by: 'lead', full: true }));
    assert.ok(fullLead.omitted > 0 && fullLead.groups.length + fullLead.omitted === h.lab.metrics.flow('all', '7d', 'lead')!.groups.length, 'full: what does not fit is counted in omitted');
    const tr = data(await mcp.call(admin, 'metrics_trend', { metric: 'startP50', window: '30d' }));
    assert.ok(tr.points.length <= 200 && tr.points.length > 150, `${tr.points.length} points`);
    const tk = data(await mcp.call(admin, 'metrics_tickets', { window: '7d' }));
    assert.deepEqual([tk.rows.length, tk.total > 2000], [TICKETS_DEFAULT, true]);
    const ov = data(await mcp.call(admin, 'metrics_overview', { window: '7d' }));
    assert.ok(ov.flow.done > 2000);
    // Paging past the service's 200 rows: three pages of (up to) 100, each cut to the size budget, carry on where the last one stopped.
    const want = [...h.lab.metrics.tickets('all', '7d', {})!.rows, ...h.lab.metrics.tickets('all', '7d', { offset: 200 })!.rows].map((r) => r.ticket);
    const got: string[] = [];
    let page = data(await mcp.call(admin, 'metrics_tickets', { window: '7d', limit: 100 }));
    got.push(...page.rows.map((r: any) => r.ticket));
    for (let i = 0; i < 2; i++) {
      assert.equal(typeof page.next_cursor, 'string');
      page = data(await mcp.call(admin, 'metrics_tickets', { window: '7d', limit: 100, cursor: page.next_cursor }));
      assert.ok(JSON.stringify(page).length < MAX_RESULT_CHARS);
      got.push(...page.rows.map((r: any) => r.ticket));
    }
    assert.ok(got.length > 200, `${got.length} rows over three pages`);
    assert.deepEqual(got, want.slice(0, got.length), 'no row skipped or repeated across the pages');
  } finally {
    done();
  }
});

test('metrics_tickets pages with next_cursor; a cursor is bound to its query; a lead pages too', async () => {
  const { mcp, done } = await harness();
  try {
    const admin = mcp.token('read').secret;
    const lead = (await mcp.agentToken('docker/api', 'L1')).secret;
    for (const token of [admin, lead]) {
      const first = data(await mcp.call(token, 'metrics_tickets', { limit: 2 }));
      assert.deepEqual([first.total, first.rows.map((r: any) => r.ticket)], [4, ['T-1', 'T-2']]);
      assert.equal(typeof first.next_cursor, 'string');
      const second = data(await mcp.call(token, 'metrics_tickets', { limit: 2, cursor: first.next_cursor }));
      assert.deepEqual(second.rows.map((r: any) => r.ticket), ['T-8', 'T-3']);
      assert.equal(second.next_cursor, null, 'the last page');
      assert.match(second.summary, /from row 3/);
      assert.equal(code(await mcp.call(token, 'metrics_tickets', { limit: 2, cursor: first.next_cursor, stage: 'resolve' })), 'INVALID_CURSOR');
    }
    // A worker with a cursor a lead got: still the same NOT_FOUND (the reach is checked before anything else).
    const worker = (await mcp.agentToken('docker/api', 'W1')).secret;
    const first = data(await mcp.call(admin, 'metrics_tickets', { limit: 2 }));
    assert.equal(code(await mcp.call(worker, 'metrics_tickets', { limit: 2, cursor: first.next_cursor })), 'NOT_FOUND');
    assert.equal(code(await mcp.call(worker, 'metrics_tickets', { group: 'high' })), 'NOT_FOUND');
  } finally {
    done();
  }
});

test('hours and fitRows', () => {
  assert.deepEqual([hours(null), hours(H), hours(90 * 60_000), hours(1)], [null, 1, 1.5, 0]);
  const rows = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
  const fit = fitRows({ head: 1 }, 'rows', rows, 1000, 'more');
  assert.ok(JSON.stringify(fit).length <= 1000);
  assert.equal((fit.rows as unknown[]).length + (fit.omitted as number), 50);
  assert.deepEqual(fitRows({}, 'rows', rows.slice(0, 2), 10_000, 'more'), { rows: rows.slice(0, 2) });
});
