// The summary strip, the Requests report, the recommendation and the palette through the service (docs/prd/claude-usage.md §20.5 to §20.8):
// scripted probes for the plan windows, seeded `chat_usage` rows for the spend. Expected values are hand-worked next to the scenario.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claude, HOUR, MIN, NOW, planResult, seedClaude, seedUsage, usageHarness, win } from './fixtures.js';
import type { ProbeResult } from './probe.js';
import { ClaudeUsageMonitor } from './service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
/** NOW is 2026-10-12 01:00 UTC; the day began at 00:00. */
const DAY0 = Date.UTC(2026, 9, 12);
const reset5h = NOW + 4 * HOUR;
const resetWeek = NOW + 3 * 24 * HOUR;

async function runAt(h: Awaited<ReturnType<typeof usageHarness>>, times: number[]) {
  for (const t of times) {
    h.clock.t = t;
    await h.usage.tick();
    await sleep(5);
  }
}

test('the strip: spend today and its speed, the Claude that runs out first, the soonest reset, and the same per Claude', async () => {
  // Plan windows. c1 (Default, ws1): session 10, 25, 40 % at 01:00, 01:30, 02:00 resetting 05:00 -> 30 points/h, over, out at 04:00 (hand: see service.insight.test.ts).
  // c2 (Satria, ws2): session 10 % in all three readings resetting 06:00 -> speed 0, under; week 5 % -> under.
  const clock = { t: NOW };
  const probe = (async (c: { id: string }): Promise<ProbeResult> => {
    if (c.id === 'c1') return planResult([win('session', clock.t >= NOW + 60 * MIN ? 40 : clock.t >= NOW + 30 * MIN ? 25 : 10, reset5h, 'Session'), win('week', 20, resetWeek, 'Week')]);
    return planResult([win('session', 10, reset5h + HOUR, 'Session'), win('week', 5, resetWeek, 'Week')]);
  }) as never;
  const h = await usageHarness({ now: clock, probe });
  try {
    h.source.list = [claude({ id: 'c1' }), claude({ id: 'c2', name: 'Satria', workspaceId: 'docker/ws2', workspaceName: 'ws2' })];
    seedClaude(h.store, 'c1', 'docker/ws1', 'Default');
    seedClaude(h.store, 'c2', 'docker/ws2', 'Satria', 'claudes/0123456789abcdef');
    // Spend. 00:40 (no Claude recorded: Default's): 1000 in, 500 out, 2000 read, $0.30, took 10 min (began 00:30). 01:50 on Satria: 400 in, 200 out, 100 written, $0.10.
    seedUsage(h.store, [
      { at: DAY0 + 40 * MIN, ws: 'docker/ws1', claude: '', input: 1000, output: 500, cacheRead: 2000, cost: 0.3, duration: 10 * MIN },
      { at: DAY0 + 110 * MIN, ws: 'docker/ws2', claude: 'c2', input: 400, output: 200, cacheWrite: 100, cost: 0.1 },
    ]);
    await runAt(h, [NOW, NOW + 30 * MIN, NOW + 60 * MIN]);
    const s = await h.usage.summary({ tzOffsetMin: 0 });

    // Overall today (hand): $0.30 + $0.10 = $0.40; tokens (1000 + 500) + (400 + 200 + 100) = 2200; read 2000; 2 requests.
    assert.deepEqual([s.today.costUsd.value, s.today.costUsd.basis, s.today.tokens.value, s.today.cacheRead.value, s.today.requests.value, s.today.from], [0.4, 'estimate', 2200, 2000, 2, iso(DAY0)]);
    // Speed since the first request began: 00:40 less 10 min = 00:30, to 02:00: 90 min. 2200 / 90 = 24.4 tokens/min, 2000 / 90 = 22.2 read, 0.40 / 90 = $0.0044.
    assert.deepEqual([s.speed.today.spanMin, s.speed.today.requests, s.speed.today.tokensPerMin.value, s.speed.today.cacheReadPerMin.value, s.speed.today.costPerMin.value], [90, 2, 24.4, 22.2, 0.0044]);
    // Trailing 15 min (01:45, 02:00]: only 01:50: 700 / 15 = 46.7 tokens/min, $0.10 / 15 = 0.0067, nothing read.
    assert.deepEqual([s.speed.trailing.requests, s.speed.trailing.tokensPerMin.value, s.speed.trailing.cacheReadPerMin.value, s.speed.trailing.costPerMin.value], [1, 46.7, 0, 0.0067]);
    // The limit: c1 runs out first (04:00, before its 05:00 reset); c2 is under.
    assert.deepEqual([s.limit.claudeId, s.limit.claudeName, s.limit.status.value, s.limit.window?.key, s.limit.etaAt.value, s.limit.projectedPct.value], ['c1', 'Default', 'over', 'session', iso(NOW + 3 * HOUR), 130]);
    // The next reset: c1's session at 05:00 comes before c2's at 06:00.
    assert.deepEqual([s.nextReset.claudeId, s.nextReset.at.value, s.nextReset.at.basis, s.nextReset.window?.key], ['c1', iso(reset5h), 'measured', 'session']);
    // Per Claude: the most spent first, each with its own numbers and the palette slot it keeps.
    assert.deepEqual(s.claudes.map((c) => [c.claudeId, c.slot, c.today.costUsd.value, c.today.tokens.value, c.today.requests.value]), [['c1', 0, 0.3, 1500, 1], ['c2', 1, 0.1, 700, 1]]);
    const [c1, c2] = s.claudes;
    // c1 alone, today: 1500 tokens over 90 min = 16.7. c2: its one request began at 01:50 (no recorded duration) so ten minutes ago: 700 / 10 = 70.
    assert.equal(c1!.speed.today.tokensPerMin.value, 16.7);
    assert.deepEqual([c2!.speed.today.spanMin, c2!.speed.today.tokensPerMin.value, c2!.speed.today.costPerMin.value], [10, 70, 0.01]);
    assert.deepEqual([c2!.limit.status.value, c2!.nextReset.at.value], ['under', iso(reset5h + HOUR)]);
    assert.deepEqual(s.scope, { claudeId: null, claudeName: null });

    // One Claude: everything narrows to it; a stranger is a 404.
    const one = await h.usage.summary({ claudeId: 'c2', tzOffsetMin: 0 });
    assert.deepEqual([one.scope, one.today.costUsd.value, one.today.requests.value, one.claudes.length, one.limit.claudeId, one.limit.status.value], [{ claudeId: 'c2', claudeName: 'Satria' }, 0.1, 1, 1, 'c2', 'under']);
    await assert.rejects(() => h.usage.summary({ claudeId: 'nobody' }), /No such Claude/);
  } finally {
    h.done();
  }
});

test('a Claude on a pool and one signed out have no limit or reset, each with its reason; spend still counts', async () => {
  const h = await usageHarness({ probe: (async () => ({ runsOn: 'none', plan: null, windows: [], extra: null, problem: null, failed: false })) as never });
  try {
    h.source.list = [claude({ id: 'p', workspaceId: 'docker/p', workspaceName: 'p' }), claude({ id: 'n', workspaceId: 'docker/n', workspaceName: 'n' })];
    h.source.pools.add('docker/p');
    seedClaude(h.store, 'p', 'docker/p', 'Default');
    seedUsage(h.store, [{ at: NOW - 5 * MIN, ws: 'docker/p', claude: 'p', input: 600, cost: 1.5 }]);
    await h.usage.tick();
    await sleep(5);
    const s = await h.usage.summary({ tzOffsetMin: 0 });
    const by = new Map(s.claudes.map((c) => [c.claudeId, c]));
    assert.deepEqual([by.get('p')!.limit.status.reason, by.get('p')!.nextReset.at.reason, by.get('p')!.today.costUsd.value], ['no_limits', 'no_limits', 1.5]);
    assert.deepEqual([by.get('n')!.limit.status.reason, by.get('n')!.nextReset.at.reason], ['signed_out', 'signed_out']);
    // Nothing is under a limit, so the overall figure is the first reason, not a made-up time.
    assert.deepEqual([s.limit.status.value, s.limit.etaAt.value, s.nextReset.at.value], [null, null, null]);
    assert.equal(s.today.costUsd.value, 1.5);
  } finally {
    h.done();
  }
});

test('the recommendation: the workspace follows the Claude the chat leaves; the one it leaves is not a candidate; missing both is refused', async () => {
  const h = await usageHarness({ probe: (async (c: { id: string }) => planResult([win('session', c.id === 'c3' ? 70 : 40, reset5h, 'Session')])) as never });
  try {
    h.source.list = [claude({ id: 'c1' }), claude({ id: 'c3', name: 'Rama' }), claude({ id: 'c9', name: 'Elsewhere', workspaceId: 'docker/ws9', workspaceName: 'ws9' })];
    // One probe at a time per workspace: c1, then (ten minutes later) c3; c9 is on another workspace.
    await runAt(h, [NOW, NOW + 10 * MIN]);
    const away = await h.usage.recommendFrom('c1');
    assert.deepEqual([away.workspaceId, away.from, away.recommended, away.candidates.map((c) => [c.claudeId, c.rank, c.reason, c.leftPct.value])], ['docker/ws1', 'c1', 'c3', [['c3', 1, 'room', 30]]]);
    // Moving the other way: c1 has 60 % left (one reading, no pace to penalise it).
    const back = await h.usage.recommend('docker/ws1', 'c3');
    assert.deepEqual(back.candidates.map((c) => [c.claudeId, c.leftPct.value, c.recommended]), [['c1', 60, true]]);
    await assert.rejects(() => h.usage.recommendFrom('nobody'), /No such Claude/);
    // Without a Claude to leave, every Claude of the workspace is a candidate.
    assert.deepEqual((await h.usage.recommend('docker/ws1')).candidates.map((c) => c.claudeId), ['c1', 'c3']);
  } finally {
    h.done();
  }
});

test('the palette: Claudes keep their slot in the snapshot, the report and the palette endpoint, in any order and after a restart', async () => {
  const h = await usageHarness();
  try {
    h.source.list = [claude({ id: 'b' }), claude({ id: 'a', workspaceId: 'docker/x', workspaceName: 'x' })];
    const first = (await h.usage.report()).claudes.map((c) => [c.claudeId, c.slot]);
    assert.deepEqual(first, [['b', 1], ['a', 0]], 'new at once: the lowest slot to the lowest key');
    h.source.list = [claude({ id: 'c', workspaceId: 'docker/y', workspaceName: 'y' }), ...h.source.list];
    h.clock.t += 10_000; // the list of Claudes is cached for a few seconds
    assert.deepEqual((await h.usage.report()).claudes.map((c) => [c.claudeId, c.slot]), [['c', 2], ['b', 1], ['a', 0]]);
    assert.deepEqual(h.usage.palette().claudes, { a: 0, b: 1, c: 2 });
    assert.equal(h.usage.palette().slots, 8);
    // A restart: a new monitor over the same database gives the same colours, whatever order it first sees them in.
    const again = new ClaudeUsageMonitor({ store: h.store, source: h.source, now: () => h.clock.t, log: () => {} });
    h.source.list = [...h.source.list].reverse();
    h.clock.t += 10_000;
    assert.deepEqual((await again.report()).claudes.map((c) => [c.claudeId, c.slot]), [['a', 0], ['b', 1], ['c', 2]]);
    again.stop();
  } finally {
    h.done();
  }
});
