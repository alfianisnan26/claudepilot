import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { snake, registerUsageSpendTools } from './portalTools.js';
import { HOUR, MIN, NOW, spendHarness } from './testkit.js';

type Row = { result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: any }; error?: unknown };
const where = (m: Row) => m.result?.structuredContent as any;
const err = (m: Row) => m.result?.structuredContent?.error?.code as string | undefined;
/** The one line a model reads first (the tool's summary); the rest of the text is the data as JSON. */
const text = (m: Row) => (m.result?.content?.[0]?.text ?? '').split('\n')[0]!;
/** Refused before the handler ran: an argument that does not fit its schema, or a tool this token cannot call. */
const refused = (m: Row) => !!(m.error || m.result?.isError);

// The seeded world (UTC, now is 2026-10-12 15:00; every request is today):
//   P "Parent task"  docker/api  c1 Kresna  ticket T-1               $1.00 (own)
//   K "Child"        docker/api  c1 Kresna  started by P             $2.00
//   W "Other"        docker/web  c2 Satria                           $4.00
// Budgets: B1 docker/api daily $10 (3.00 used: 30 %), B2 docker/web daily $3 that pauses (4.00 used: 133.3 %, used up), B3 everything monthly $100 (7.00: 7 %).
async function rig(settings: Record<string, string | number | boolean> = {}) {
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  const h = await spendHarness({ settings });
  registerUsageSpendTools(h.spend, registry);
  h.seed.claude('c1', 'docker/api', 'Kresna');
  h.seed.claude('c2', 'docker/web', 'Satria');
  h.seed.session('P', { workspaceId: 'docker/api', claudeId: 'c1', ticketId: 'T-1', title: 'Parent task' });
  h.seed.session('K', { workspaceId: 'docker/api', claudeId: 'c1', parentId: 'P', title: 'Child' });
  h.seed.session('W', { workspaceId: 'docker/web', claudeId: 'c2', title: 'Other' });
  h.clock.t = NOW;
  h.seed.usage({ atMs: NOW - 2 * HOUR, session: 'P', costUsd: 1, input: 100 });
  h.seed.usage({ atMs: NOW - HOUR, session: 'K', costUsd: 2, input: 200 });
  h.seed.usage({ atMs: NOW - 30 * MIN, session: 'W', workspace: 'docker/web', claude: 'c2', costUsd: 4, input: 400 });
  const b1 = await h.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/api' }, period: 'day', limitUsd: 10 });
  const b2 = await h.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/web' }, period: 'day', limitUsd: 3, mode: 'pause' });
  const b3 = await h.spend.createBudget({ scope: { kind: 'all' }, period: 'month', limitUsd: 100 });
  return { mcp, h, b1, b2, b3, done: () => (h.done(), mcp.done()) };
}

test('snake_case all the way down', () => {
  assert.deepEqual(snake({ spentUsd: { value: 1, basis: 'estimate' }, topSession: { sessionId: 's', share: 5 }, list: [{ windowMin: 15 }] }), {
    spent_usd: { value: 1, basis: 'estimate' },
    top_session: { session_id: 's', share: 5 },
    list: [{ window_min: 15 }],
  });
});

test('an admin’s token reads the whole portal: the summary, the attribution rows, the budgets; dollars say they are estimates', async () => {
  const r = await rig();
  try {
    const t = r.mcp.token('read');
    const sum = await r.mcp.call(t.secret, 'usage_summary');
    const s = where(sum);
    assert.deepEqual([s.scope, s.timezone, s.today.cost_usd, s.today.requests, s.today.input_tokens], ['portal', 'UTC', 7, 3, 700]);
    assert.deepEqual(s.budgets, { total: 3, near: 0, high: 0, exhausted: 1, paused: 1 });
    assert.deepEqual(s.basis.cost_usd, 'estimate');
    assert.match(s.basis.note, /not a bill/);
    assert.deepEqual(s.alerts.map((a: any) => [a.kind, a.level, a.paused, a.summary]), [['budget', 'exhausted', true, 'web daily: used up · paused']]);
    assert.match(text(sum), /Today \$7\.00 \(estimated\) in 3 requests; this month \$7\.00\. 3 budgets \(1 used up, 1 pausing\)/);

    // By session: W $4, then P $3 with its child K $2 below it.
    const tree = where(await r.mcp.call(t.secret, 'usage_attribution', { by: 'session', range: '1d' }));
    assert.deepEqual(tree.rows.map((x: any) => [x.key, x.session.depth, x.own.cost_usd, x.total.cost_usd, x.share_pct.value, x.share_pct.basis]), [
      ['W', 0, 4, 4, 57.14, 'estimate'],
      ['P', 0, 1, 3, 42.86, 'estimate'],
      ['K', 1, 2, 2, 28.57, 'estimate'],
    ]);
    assert.deepEqual(Object.keys(tree.rows[0].label).sort(), ['source', 'untrusted_text'], 'a session’s title is labelled as text from elsewhere');
    assert.equal(tree.rows[1].session.ticket_id, 'T-1');
    // T-282: the short row carries dollars and requests; full adds the tokens and the times.
    assert.deepEqual(Object.keys(tree.rows[0].own).sort(), ['cost_usd', 'requests']);
    assert.equal(tree.rows[0].first_at, undefined);
    const fullTree = where(await r.mcp.call(t.secret, 'usage_attribution', { by: 'session', range: '1d', full: true }));
    assert.equal(fullTree.rows[0].own.input_tokens !== undefined && 'first_at' in fullTree.rows[0], true);
    assert.equal(tree.coverage_pct.value, 100);
    assert.deepEqual(where(await r.mcp.call(t.secret, 'usage_attribution', { by: 'workspace', range: '1d' })).rows.map((x: any) => [x.label, x.total.cost_usd]), [['web', 4], ['api', 3]]);
    // Nobody recorded a persona: one unknown row with its reason, and nothing attributed.
    const persona = where(await r.mcp.call(t.secret, 'usage_attribution', { by: 'persona', range: '1d' }));
    assert.deepEqual(persona.rows.map((x: any) => [x.state, x.reason, x.total.cost_usd]), [['unknown', 'not_recorded', 7]]);
    assert.deepEqual(persona.coverage_pct, { value: 0, basis: 'estimate' });
    // The tree of one session, for an admin.
    assert.deepEqual(where(await r.mcp.call(t.secret, 'usage_attribution', { by: 'session', range: '1d', session_id: 'P' })).rows.map((x: any) => x.key), ['P', 'K']);

    const budgets = where(await r.mcp.call(t.secret, 'usage_budgets'));
    assert.deepEqual(budgets.budgets.map((b: any) => [b.scope_label, b.mode, b.level, b.paused, b.used_pct.value]), [['api', 'alert', 'ok', false, 30], ['web', 'pause', 'exhausted', true, 133.3], ['Everything', 'alert', 'ok', false, 7]]);
    assert.deepEqual(budgets.thresholds, { warn: 80, critical: 95 });
    assert.ok(!/email|organi[sz]ation|credential|password/i.test(JSON.stringify([s, tree, budgets])), 'nothing names an account');
    assert.ok(refused(await r.mcp.call(t.secret, 'usage_attribution', { by: 'team' })), 'a dimension that does not exist');
    assert.ok(refused(await r.mcp.call(t.secret, 'usage_attribution', { limit: 0 })));
  } finally {
    r.done();
  }
});

test('an agent reads only its own session and the ones it started, and the budgets that count it; the rest is refused', async () => {
  const r = await rig();
  try {
    const agent = await r.mcp.agentToken('docker/api', 'P');
    const sum = await r.mcp.call(agent.secret, 'usage_summary');
    const s = where(sum);
    // P's own $1.00, and $3.00 with K below it: the last day, in the budgets' clock.
    assert.deepEqual([s.scope, s.session_id, s.own.cost_usd, s.own.requests, s.with_children.cost_usd, s.with_children.requests], ['session', 'P', 1, 1, 3, 2]);
    assert.deepEqual(s.budgets.map((b: any) => b.scope_label), ['api', 'Everything'], 'the web budget does not count this session');
    assert.match(text(sum), /\$3\.00 \(estimated\) in 2 requests over the last day/);

    const rows = where(await r.mcp.call(agent.secret, 'usage_attribution', { range: '1d' })).rows.map((x: any) => [x.key, x.session.depth, x.total.cost_usd]);
    assert.deepEqual(rows, [['P', 0, 3], ['K', 1, 2]], 'W is not in its tree');
    assert.deepEqual(where(await r.mcp.call(agent.secret, 'usage_attribution', { range: '1d', session_id: 'K' })).rows.map((x: any) => x.key), ['K'], 'a session it started is its to read');
    assert.equal(err(await r.mcp.call(agent.secret, 'usage_attribution', { session_id: 'W' })), 'FORBIDDEN');
    assert.equal(err(await r.mcp.call(agent.secret, 'usage_attribution', { workspace_id: 'docker/web' })), 'FORBIDDEN');
    assert.equal(err(await r.mcp.call(agent.secret, 'usage_attribution', { claude_id: 'c2' })), 'FORBIDDEN');
    const b = where(await r.mcp.call(agent.secret, 'usage_budgets'));
    assert.deepEqual(b.budgets.map((x: any) => x.scope_label), ['api', 'Everything']);
    assert.equal(where(await r.mcp.call(agent.secret, 'usage_spikes')).events.length, 0);

    // An agent can't change a budget, and never sees the tools that do.
    assert.ok(refused(await r.mcp.call(agent.secret, 'usage_budget_set', { scope: 'all', period: 'day', limit_usd: 1 })));
    assert.ok(refused(await r.mcp.call(agent.secret, 'usage_budget_delete', { id: r.b1.budget.id })));
    const { client, close } = await r.mcp.client(agent.secret, 'modern');
    try {
      const names = (await client.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith('usage_'));
      assert.deepEqual(names.sort(), ['usage_attribution', 'usage_budgets', 'usage_spikes', 'usage_summary']);
    } finally {
      await close();
    }
    assert.equal((await r.h.spend.budgets()).budgets.length, 3, 'nothing changed');
  } finally {
    r.done();
  }
});

test('only an admin token changes a budget, and says what it did; pausing and removing ask first', async () => {
  const r = await rig();
  try {
    const read = r.mcp.token('read');
    const operate = r.mcp.token('operate');
    const admin = r.mcp.token('admin');
    assert.equal(err(await r.mcp.call(read.secret, 'usage_budget_set', { scope: 'all', period: 'day', limit_usd: 1 })), 'SCOPE_REQUIRED');
    assert.equal(err(await r.mcp.call(operate.secret, 'usage_budget_set', { scope: 'all', period: 'day', limit_usd: 1 })), 'SCOPE_REQUIRED');
    assert.equal(err(await r.mcp.call(operate.secret, 'usage_budget_delete', { id: r.b1.budget.id })), 'SCOPE_REQUIRED');

    const made = await r.mcp.call(admin.secret, 'usage_budget_set', { scope: 'all', period: 'day', limit_usd: 50, name: 'Everyone' });
    assert.equal(text(made), 'Made the daily budget for Everything: $50.00 estimated, alerts only. 14% used so far (ok).');
    const id = where(made).budget.id as string;
    assert.deepEqual([where(made).did, where(made).budget.mode, where(made).budget.used_usd], ['created', 'alert', { value: 7, basis: 'estimate' }]);
    const changed = await r.mcp.call(admin.secret, 'usage_budget_set', { id, limit_usd: 100, limit_tokens: 5_000_000 });
    assert.equal(text(changed), 'Changed the daily budget for Everything: $100.00 estimated, 5,000,000 tokens, alerts only. 7% used so far (ok).');
    assert.equal(where(changed).did, 'updated');

    // Pausing asks first, and nothing changes until the token comes back.
    const ask = where(await r.mcp.call(admin.secret, 'usage_budget_set', { id, mode: 'pause' }));
    assert.equal(ask.status, 'confirmation_required');
    assert.match(ask.preview.effect, /refused until the period ends/);
    assert.equal(r.h.spend.budget(id).budget.mode, 'alert', 'asking changes nothing');
    const paused = await r.mcp.call(admin.secret, 'usage_budget_set', { id, mode: 'pause', confirm_token: ask.confirm_token });
    assert.match(text(paused), /pauses new messages when used up/);
    assert.equal(r.h.spend.budget(id).budget.mode, 'pause');
    // A new budget that pauses asks too; turning an alert budget's limit up does not.
    assert.equal(where(await r.mcp.call(admin.secret, 'usage_budget_set', { scope: 'all', period: 'month', limit_usd: 9, mode: 'pause' })).status, 'confirmation_required');
    assert.equal(r.h.spend.budgets().budgets.length, 4, 'still no fifth budget');

    // Refusals say why: a missing scope id, an unknown budget, a limit that is nothing.
    assert.equal(err(await r.mcp.call(admin.secret, 'usage_budget_set', { scope: 'claude', period: 'day', limit_usd: 1 })), 'VALIDATION_FAILED');
    assert.equal(err(await r.mcp.call(admin.secret, 'usage_budget_set', { scope_id: 'c1', period: 'day', limit_usd: 1 })), 'VALIDATION_FAILED');
    assert.equal(err(await r.mcp.call(admin.secret, 'usage_budget_set', { id: 'b_nope', limit_usd: 5 })), 'NOT_FOUND');
    assert.equal(err(await r.mcp.call(admin.secret, 'usage_budget_set', { scope: 'all', period: 'day', limit_usd: 0 })), 'VALIDATION_FAILED');

    // Removing asks first, names what goes, and says it did it.
    const del = where(await r.mcp.call(admin.secret, 'usage_budget_delete', { id }));
    assert.equal(del.status, 'confirmation_required');
    assert.match(del.preview.remove, /the daily budget for Everything/);
    assert.equal(r.h.spend.budgets().budgets.length, 4);
    const gone = await r.mcp.call(admin.secret, 'usage_budget_delete', { id, confirm_token: del.confirm_token });
    assert.match(text(gone), /^Removed the daily budget for Everything/);
    assert.equal(where(gone).removed, true);
    assert.equal(r.h.spend.budgets().budgets.length, 3);
    assert.equal(err(await r.mcp.call(admin.secret, 'usage_budget_delete', { id })), 'NOT_FOUND');
  } finally {
    r.done();
  }
});

test('spikes over the Portal MCP: an admin sees them all, an agent only its own tree; each says it is a heuristic and how its numbers are known', async () => {
  const r = await rig({ 'usage.spikes.burstRequests': 3, 'usage.spikes.rateFactor': 100 });
  try {
    for (let i = 0; i < 3; i++) r.h.seed.turn({ atMs: NOW - 4 * MIN + i * MIN, session: 'K', costUsd: 0.01 });
    for (let i = 0; i < 3; i++) r.h.seed.turn({ atMs: NOW - 4 * MIN + i * MIN, session: 'W', workspace: 'docker/web', claude: 'c2', costUsd: 0.01 });
    const admin = r.mcp.token('read');
    const all = await r.mcp.call(admin.secret, 'usage_spikes', { range: '1d' });
    const events = where(all).events;
    assert.deepEqual(events.map((e: any) => [e.kind, e.session_id, e.heuristic, e.summary]).sort(), [
      ['burst', 'K', true, '3 requests in 10 min (limit 3)'],
      ['burst', 'W', true, '3 requests in 10 min (limit 3)'],
    ]);
    assert.deepEqual(events.find((e: any) => e.session_id === 'K').evidence, { kind: 'burst', requests: 3, window_min: 10, threshold: 3, spent_usd: { value: 0.03, basis: 'estimate' } });
    assert.match(where(all).note, /Heuristics/);
    assert.match(text(all), /^2 spikes in 1d; latest: 3 requests in 10 min/);
    const agent = await r.mcp.agentToken('docker/api', 'P');
    const own = where(await r.mcp.call(agent.secret, 'usage_spikes', { range: '1d' })).events;
    assert.deepEqual(own.map((e: any) => e.session_id), ['K'], 'P reads the spikes of the session it started, not the other workspace’s');
    assert.equal(text(await r.mcp.call(r.mcp.token('read').secret, 'usage_spikes', { range: '1y' })).length > 0, true);
  } finally {
    r.done();
  }
});
