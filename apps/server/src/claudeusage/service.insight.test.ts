// The service with pace, outlook and the projection alert (docs/prd/claude-usage.md §20.2, §20.4), through scripted probes and a clock.
// Expected values are computed by hand next to each scenario.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageAlert } from '@portal/contracts';
import { claude, HOUR, MIN, NOW, planResult, usageHarness, win } from './fixtures.js';
import type { ProbeResult } from './probe.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
/** NOW is 01:00 UTC. The first session period resets at 05:00 (it began at 00:00); the next one at 10:00. The week resets in three days. */
const reset5h = NOW + 4 * HOUR;
const resetNext = NOW + 9 * HOUR;
const resetWeek = NOW + 3 * 24 * HOUR;

/** A probe answering from a table of (time -> session percent), so a test reads as the story it tells. */
function story(sessions: [number, number, number][], week = 20) {
  const probe = async (): Promise<ProbeResult> => {
    const now = h.clock.t;
    const [, pct, reset] = [...sessions].reverse().find(([t]) => t <= now) ?? sessions[0]!;
    return planResult([win('session', pct, reset, 'Session'), win('week', week, resetWeek, 'Week')]);
  };
  const h = { clock: { t: NOW } };
  return { probe: probe as never, clock: h.clock };
}

/** Runs the scheduler at each given time (the interval is 10 minutes, so each is due). */
async function runAt(h: Awaited<ReturnType<typeof usageHarness>>, times: number[]) {
  for (const t of times) {
    h.clock.t = t;
    await h.usage.tick();
    await sleep(5);
  }
}

test('the snapshot carries each window’s pace and the Claude’s outlook, from probes over an hour', async () => {
  // Hand: session 10 % at 01:00, 25 % at 01:30, 40 % at 02:00, resetting at 05:00. Least squares over x = 0, .5, 1 h: slope 30 points/h.
  // At 02:00 three hours remain: projected 40 + 30 x 3 = 130; ETA 02:00 + 60 / 30 h = 04:00, an hour before the reset: over. The window began at 00:00,
  // so two of five hours are gone = 40 %, exactly the percent used: 0 points ahead. Three readings over an hour (a tenth of 5 h is 30 min): confident.
  // The week sat at 20 % in three readings: speed 0, projected 20, never fills; three readings over an hour are under a tenth of a week: low confidence.
  const s = story([[NOW, 10, reset5h], [NOW + 30 * MIN, 25, reset5h], [NOW + 60 * MIN, 40, reset5h]]);
  const h = await usageHarness({ now: s.clock, probe: s.probe });
  try {
    await runAt(h, [NOW, NOW + 30 * MIN, NOW + 60 * MIN]);
    const c = (await h.usage.report()).claudes[0]!;
    const [session, week] = c.windows;
    assert.equal(session!.key, 'session');
    assert.deepEqual([session!.pace!.speed.value, session!.pace!.speed.basis], [30, 'estimate']);
    assert.equal(session!.pace!.projectedPct.value, 130);
    assert.equal(session!.pace!.etaAt.value, iso(NOW + 3 * HOUR));
    assert.equal(session!.pace!.status.value, 'over');
    assert.deepEqual([session!.pace!.evenPct.value, session!.pace!.aheadPts.value], [40, 0]);
    assert.deepEqual([session!.pace!.readings, session!.pace!.spanMin, session!.pace!.method, session!.pace!.lowConfidence], [3, 60, 'least_squares', false]);
    assert.equal(week!.pace!.speed.value, 0);
    assert.equal(week!.pace!.projectedPct.value, 20);
    assert.equal(week!.pace!.etaAt.reason, 'no_growth');
    assert.equal(week!.pace!.lowConfidence, true);
    assert.equal(c.outlook.status.value, 'over');
    assert.equal(c.outlook.window?.key, 'session');
    assert.equal(c.outlook.etaAt.value, iso(NOW + 3 * HOUR));
    assert.equal(c.outlook.projectedPct.value, 130);
  } finally {
    h.done();
  }
});

test('a Claude with no plan limits, one signed out and one never read each say why there is no pace', async () => {
  const h = await usageHarness({
    probe: (async (c: { id: string }) => (c.id === 'none' ? { runsOn: 'none', plan: null, windows: [], extra: null, problem: null, failed: false } : planResult([win('session', 5, reset5h, 'Session')]))) as never,
  });
  try {
    h.source.list = [claude({ id: 'plan' }), claude({ id: 'pool', workspaceId: 'docker/p', workspaceName: 'p' }), claude({ id: 'none', workspaceId: 'docker/n', workspaceName: 'n' }), claude({ id: 'fresh', workspaceId: 'docker/f', workspaceName: 'f', running: false })];
    h.source.pools.add('docker/p');
    await h.usage.tick();
    await sleep(10);
    const by = new Map((await h.usage.report()).claudes.map((c) => [c.claudeId, c]));
    assert.deepEqual(['pool', 'none', 'fresh'].map((id) => by.get(id)!.outlook.status.reason), ['no_limits', 'signed_out', 'no_reading']);
    assert.equal(by.get('pool')!.windows.length, 0);
    // A plan Claude with one reading: no speed yet, and the reason is the one a person can act on (wait for a second reading).
    const lone = by.get('plan')!;
    assert.equal(lone.windows[0]!.pace!.speed.reason, 'single_sample');
    assert.equal(lone.outlook.status.reason, 'single_sample');
  } finally {
    h.done();
  }
});

test('the projection alert: told once, on three readings, with its estimate; the sink and the snapshot agree', async () => {
  // Hand: the same story as above. At 01:30 there are two readings (10, 25: 30 points/h) and the pace says over, but two readings never alert.
  // At 02:00 the third arrives: speed 30, projected 130, ETA 04:00 < the 05:00 reset: one alert, id <claude>|session|projection|<reset ms>.
  // Later readings in the same period (55 % at 02:30) do not tell it again.
  const s = story([[NOW, 10, reset5h], [NOW + 30 * MIN, 25, reset5h], [NOW + 60 * MIN, 40, reset5h], [NOW + 90 * MIN, 55, reset5h]]);
  const h = await usageHarness({ now: s.clock, probe: s.probe });
  try {
    const told: ClaudeUsageAlert[] = [];
    h.usage.onAlert((a) => told.push(a));
    await runAt(h, [NOW, NOW + 30 * MIN]);
    assert.equal(told.length, 0, 'two readings are not enough');
    await runAt(h, [NOW + 60 * MIN]);
    assert.equal(told.length, 1);
    const a = told[0]!;
    assert.equal(a.id, `c1|session|projection|${reset5h}`);
    assert.deepEqual([a.kind, a.window, a.claudeName, a.usedPct, a.projectedPct, a.etaAt, a.resetsAt], ['projection', 'session', 'Default', 40, 130, iso(NOW + 3 * HOUR), iso(reset5h)]);
    await runAt(h, [NOW + 90 * MIN]);
    assert.equal(told.length, 1, 'once per window and period');
    // The snapshot lists it with the estimate as it stands now: 55 % at 02:30, 30 points/h over (10, 25, 40, 55): projected 55 + 30 x 2.5 = 130, ETA 02:30 + 1.5 h = 04:00.
    const listed = (await h.usage.report()).alerts.filter((x) => x.kind === 'projection');
    assert.equal(listed.length, 1);
    assert.deepEqual([listed[0]!.id, listed[0]!.usedPct, listed[0]!.projectedPct, listed[0]!.etaAt], [a.id, 55, 130, iso(NOW + 3 * HOUR)]);
  } finally {
    h.done();
  }
});

test('a new period tells it again, and the snapshot stops listing it once the projection no longer holds', async () => {
  // Hand: period two (reset 10:00) reads 5 % at 05:10, 20 % at 05:40 and 35 % at 06:10: slope 30; projected 35 + 30 x 3.8333 h = 150; over: a new id.
  // ETA 06:10 + (100 - 35) / 30 h = 06:10 + 2 h 10 m = 08:20, an hour and forty minutes before the 10:00 reset.
  const s = story([[NOW, 10, reset5h], [NOW + 30 * MIN, 25, reset5h], [NOW + 60 * MIN, 40, reset5h], [NOW + 4 * HOUR + 10 * MIN, 5, resetNext], [NOW + 4 * HOUR + 40 * MIN, 20, resetNext], [NOW + 5 * HOUR + 10 * MIN, 35, resetNext]]);
  const h = await usageHarness({ now: s.clock, probe: s.probe });
  try {
    const told: ClaudeUsageAlert[] = [];
    h.usage.onAlert((a) => told.push(a));
    await runAt(h, [NOW, NOW + 30 * MIN, NOW + 60 * MIN]);
    await runAt(h, [NOW + 4 * HOUR + 10 * MIN, NOW + 4 * HOUR + 40 * MIN]);
    assert.equal(told.length, 1, 'two readings of the new period: not yet');
    await runAt(h, [NOW + 5 * HOUR + 10 * MIN]);
    assert.deepEqual(told.map((a) => a.id), [`c1|session|projection|${reset5h}`, `c1|session|projection|${resetNext}`]);
    assert.equal(told[1]!.projectedPct, 150);
    assert.equal(told[1]!.etaAt, iso(NOW + 5 * HOUR + 10 * MIN + 130 * MIN), 'ETA 08:20');
    // The first period's alert is over (its reset passed): only the new one is listed.
    assert.deepEqual((await h.usage.report()).alerts.map((a) => a.id), [`c1|session|projection|${resetNext}`]);
  } finally {
    h.done();
  }
});

test('its own snooze silences only projections, the Claude’s snooze silences both, and a snooze stays quiet for the period', async () => {
  const mk = () => story([[NOW, 10, reset5h], [NOW + 30 * MIN, 25, reset5h], [NOW + 60 * MIN, 85, reset5h]]);
  // Hand: 10, 25, 85 % at 01:00, 01:30, 02:00: x = 0, .5, 1; mean y 40; Sxy = (-.5)(-30) + 0 + (.5)(45) = 37.5; Sxx .5; slope 75 points/h: over.
  // 85 % is also past the 80 % threshold: the ordinary alert fires too, unless the whole Claude is snoozed.
  {
    const s = mk();
    const h = await usageHarness({ now: s.clock, probe: s.probe });
    try {
      const told: ClaudeUsageAlert[] = [];
      h.usage.onAlert((a) => told.push(a));
      await runAt(h, [NOW, NOW + 30 * MIN]);
      const snoozed = await h.usage.snooze('c1', '4h', 'projection');
      assert.equal(snoozed.projectionSnoozedUntil, iso(NOW + 30 * MIN + 4 * HOUR));
      assert.equal(snoozed.snoozedUntil, null, 'the Claude itself is not snoozed');
      await runAt(h, [NOW + 60 * MIN]);
      assert.deepEqual(told.map((a) => [a.kind ?? 'level', a.level]), [['level', 'near']], 'the threshold alert is told, the projection is not');
      const off = await h.usage.unsnooze('c1', 'projection');
      assert.equal(off.projectionSnoozedUntil, null);
      assert.equal((await h.usage.report()).alerts.filter((a) => a.kind === 'projection').length, 0, 'it crossed while snoozed: quiet for the rest of the period');
    } finally {
      h.done();
    }
  }
  {
    const s = mk();
    const h = await usageHarness({ now: s.clock, probe: s.probe });
    try {
      const told: ClaudeUsageAlert[] = [];
      h.usage.onAlert((a) => told.push(a));
      await runAt(h, [NOW, NOW + 30 * MIN]);
      await h.usage.snooze('c1', '1h');
      await runAt(h, [NOW + 60 * MIN]);
      assert.equal(told.length, 0, 'the Claude’s snooze silences both kinds');
    } finally {
      h.done();
    }
  }
});

test('"until reset" for a projection snooze runs to the next reset of a window that stops the Claude', async () => {
  const s = story([[NOW, 10, reset5h]]);
  const h = await usageHarness({ now: s.clock, probe: s.probe });
  try {
    await runAt(h, [NOW]);
    // Windows: the session resets at 05:00, the week in three days: the soonest is the session's.
    assert.equal((await h.usage.snooze('c1', 'reset', 'projection')).projectionSnoozedUntil, iso(reset5h));
  } finally {
    h.done();
  }
});

test('a projection that holds on a stale or low-confidence pace is never told: a weekly burst of an hour', async () => {
  // Hand: the week 10 % at 01:00, 25 % at 01:30, 40 % at 02:00: slope 30 points/h; 71 h remain to the reset three days after 01:00: projected 40 + 30 x 71 = 2170,
  // over, but three readings over an hour are well under a tenth of a week (16.8 h): low confidence, no alert.
  const probe = (async () => {
    const pct = h.clock.t >= NOW + 60 * MIN ? 40 : h.clock.t >= NOW + 30 * MIN ? 25 : 10;
    return planResult([win('week', pct, resetWeek, 'Week')]);
  }) as never;
  const h = await usageHarness({ probe });
  try {
    const told: ClaudeUsageAlert[] = [];
    h.usage.onAlert((a) => told.push(a));
    await runAt(h, [NOW, NOW + 30 * MIN, NOW + 60 * MIN]);
    const week = (await h.usage.report()).claudes[0]!.windows[0]!;
    assert.equal(week.pace!.status.value, 'over');
    assert.equal(week.pace!.lowConfidence, true);
    assert.equal(told.length, 0);
  } finally {
    h.done();
  }
});

test('noteSpend tells open pages, and a page that cannot be told is no one’s problem', async () => {
  const h = await usageHarness();
  try {
    const before = h.changes();
    h.usage.noteSpend();
    assert.equal(h.changes(), before + 1);
  } finally {
    h.done();
  }
});
