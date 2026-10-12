// The Portal MCP tools of round 4 (docs/prd/claude-usage.md §20.10), through the real MCP endpoint: pace in claude_usage, the summary, the report, the
// advice, and who may call them. Expected values are hand-worked (the same story as service.insight.test.ts and service.summary.test.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { claude, HOUR, MIN, NOW, planResult, seedClaude, seedUsage, usageHarness, win } from './fixtures.js';
import { registerClaudeUsageTools } from './portalTools.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const reset5h = NOW + 4 * HOUR;
const resetWeek = NOW + 3 * 24 * HOUR;

type Call = { structuredContent: any; content: { text: string }[]; isError?: boolean };

async function rig() {
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  const clock = { t: NOW };
  const u = await usageHarness({
    now: clock,
    probe: (async (c: { id: string }) => {
      if (c.id === 'own') return planResult([win('session', clock.t >= NOW + 60 * MIN ? 40 : clock.t >= NOW + 30 * MIN ? 25 : 10, reset5h, 'Session'), win('week', 20, resetWeek, 'Week')]);
      return planResult([win('session', 70, reset5h + HOUR, 'Session')]);
    }) as never,
  });
  const own = claude({ id: 'own', name: 'Satria', workspaceId: 'docker/api', workspaceName: 'api' });
  const other = claude({ id: 'other', name: 'Rama', workspaceId: 'docker/api', workspaceName: 'api' });
  u.source.list = [own];
  u.source.sessions.set('sa', { workspaceId: 'docker/api', claudeId: 'own' });
  seedClaude(u.store, 'own', 'docker/api', 'Satria', 'claudes/0123456789abcdef');
  seedClaude(u.store, 'other', 'docker/api', 'Rama', 'claudes/fedcba9876543210');
  // 00:30: 1000 in, 500 out, 2000 read, $0.30 on Satria, a model name with a hidden character (it comes from the workspace's Claude Code).
  seedUsage(u.store, [{ at: Date.UTC(2026, 9, 12, 0, 30), ws: 'docker/api', claude: 'own', model: 'claude-opus​-4-5', input: 1000, output: 500, cacheRead: 2000, cost: 0.3 }]);
  registerClaudeUsageTools(u.usage, registry);
  // The scheduler probes one Claude per workspace at a time: Satria alone at 01:00, 01:30 and 02:00, then Rama joins the workspace and is read a minute later.
  for (const t of [NOW, NOW + 30 * MIN, NOW + 60 * MIN]) {
    clock.t = t;
    await u.usage.tick();
    await sleep(5);
  }
  u.source.list = [own, other];
  clock.t = NOW + 61 * MIN;
  await u.usage.tick();
  await sleep(5);
  return { mcp, u, done: () => (u.done(), mcp.done()) };
}

test('claude_usage carries each window’s pace and the Claude’s outlook, every figure with its basis, and the sentence says it is an estimate', async () => {
  const r = await rig();
  try {
    const { client, close } = await r.mcp.client(r.mcp.token('read').secret, 'modern');
    try {
      const one = (await client.callTool({ name: 'claude_usage', arguments: { claude_id: 'own' } })) as Call;
      const c = one.structuredContent.claudes[0];
      const session = c.windows.find((w: { key: string }) => w.key === 'session');
      // Satria's session was read 10 % at 01:00, 25 % at 01:30 and 40 % at 02:00 (hand: 30 points/h, 130 % at the 05:00 reset, out at 04:00).
      assert.deepEqual(session.pace.speed_pct_per_hour, { value: 30, basis: 'estimate' });
      assert.deepEqual(session.pace.projected_pct_at_reset, { value: 130, basis: 'estimate' });
      assert.deepEqual(session.pace.runs_out_at, { value: iso(NOW + 3 * HOUR), basis: 'estimate' });
      assert.deepEqual(session.pace.status, { value: 'over', basis: 'estimate' });
      assert.equal(session.pace.low_confidence, false);
      assert.equal(c.outlook.status.value, 'over');
      assert.equal(c.outlook.window.key, 'session');
      // A week with no growth: the ETA is unavailable, and says why in a code and in words.
      const week = c.windows.find((w: { key: string }) => w.key === 'week');
      assert.deepEqual([week.pace.runs_out_at.value, week.pace.runs_out_at.basis, week.pace.runs_out_at.reason], [null, 'unavailable', 'no_growth']);
      assert.match(week.pace.runs_out_at.why, /never reaches 100/);
      assert.match(one.content[0]!.text, /At this pace \(an estimate\) session runs out about .*, before it resets\./);
    } finally {
      await close();
    }
  } finally {
    r.done();
  }
});

test('the summary, the report and the advice: admin reads, with figures that say how they are known', async () => {
  const r = await rig();
  try {
    const { client, close } = await r.mcp.client(r.mcp.token('read').secret, 'modern');
    try {
      const s = (await client.callTool({ name: 'claude_usage_summary', arguments: { tz_offset_min: 0 } })) as Call;
      assert.equal(s.isError, undefined);
      const sc = s.structuredContent;
      assert.deepEqual(sc.today.cost_usd, { value: 0.3, basis: 'estimate' });
      assert.deepEqual([sc.today.tokens.value, sc.today.tokens.basis, sc.today.requests.value], [1500, 'measured', 1]);
      assert.deepEqual([sc.limit.claude_id, sc.limit.status.value, sc.limit.runs_out_at.value], ['own', 'over', iso(NOW + 3 * HOUR)]);
      assert.match(s.content[0]!.text, /^Today \$0\.30 \(estimate\), 1 requests\. Satria runs out about /);

      const rep = (await client.callTool({ name: 'claude_usage_report', arguments: { range: '1d', tz_offset_min: 0 } })) as Call;
      const rc = rep.structuredContent;
      assert.deepEqual([rc.range, rc.totals.requests, rc.totals.cost_usd, rc.cache.read, rc.cache.uncached], ['1d', 1, 0.3, 2000, 1000]);
      assert.equal(rc.cache.hit_rate.basis, 'measured');
      assert.ok(Math.abs(rc.cache.hit_rate.value - 2000 / 3000) < 1e-12);
      assert.deepEqual(rc.by_claude.map((c: { claude_id: string; claude: string }) => [c.claude_id, c.claude]), [['own', 'Satria']]);
      // The model's name came from a workspace: labelled, hidden characters removed.
      assert.deepEqual(rc.by_model[0].model, { untrusted_text: 'claude-opus-4-5', source: 'claude-usage' });
      assert.deepEqual([rc.previous.coverage, rc.previous.change.requests.reason], ['none', 'not_recorded']);
      assert.equal(rc.buckets, undefined, 'the per-bucket rows are opt-in');
      const withBuckets = (await client.callTool({ name: 'claude_usage_report', arguments: { range: '1d', include_buckets: true } })) as Call;
      assert.equal(withBuckets.structuredContent.buckets.length, 24);
      assert.equal(((await client.callTool({ name: 'claude_usage_report', arguments: { range: '1y' } })) as Call).isError, true, 'a range that does not exist is refused');

      const adv = (await client.callTool({ name: 'claude_move_advice', arguments: { from_claude_id: 'own' } })) as Call;
      const ac = adv.structuredContent;
      // Rama read 70 % once: 30 % left, no pace: room.
      assert.deepEqual([ac.workspace_id, ac.recommended, ac.candidates.map((c: { claude_id: string; reason: string; left_pct: { value: number; basis: string } }) => [c.claude_id, c.reason, c.left_pct.value, c.left_pct.basis])], ['docker/api', 'other', [['other', 'room', 30, 'measured']]]);
      assert.match(adv.content[0]!.text, /^Move to Rama \(room, 30 % left\)\./);
      assert.ok(!/email|organi[sz]ation|\btoken\b|credential|orgName/i.test(JSON.stringify([sc, rc, ac])));
    } finally {
      await close();
    }
  } finally {
    r.done();
  }
});

test('an agent reads the plan usage of its own Claude with the pace, and cannot call the tools that show spend or other Claudes', async () => {
  const r = await rig();
  try {
    const agent = await r.mcp.agentToken('docker/api', 'sa');
    const { client, close } = await r.mcp.client(agent.secret, 'modern');
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('claude_usage'));
      for (const hidden of ['claude_usage_summary', 'claude_usage_report', 'claude_move_advice']) assert.ok(!names.includes(hidden), `${hidden} is not for agents`);
      const mine = (await client.callTool({ name: 'claude_usage', arguments: {} })) as Call;
      assert.deepEqual(mine.structuredContent.claudes.map((c: { claude_id: string }) => c.claude_id), ['own']);
      assert.equal(mine.structuredContent.claudes[0].outlook.status.value, 'over');
      await assert.rejects(() => client.callTool({ name: 'claude_usage_summary', arguments: {} }), /not found/i);
    } finally {
      await close();
    }
  } finally {
    r.done();
  }
});
