import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageAlert } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { ProbeResult } from './probe.js';
import { ClaudeUsageMonitor, COOLDOWN_MS, TICK_MS, WATCH_MS } from './service.js';
import { claude, FakeSource, HOUR, INFO_REJECTED, INFO_WARNING, MIN, NOW, planResult, usageHarness, win } from './fixtures.js';

const INTERVAL = 600_000;
const reset5h = NOW + 4 * HOUR;
const resetWeek = NOW + 3 * 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A probe that answers from a script and records who it was asked about. */
function scripted(answer: (c: { id: string }, n: number) => ProbeResult | Promise<ProbeResult>) {
  const calls: string[] = [];
  const probe = async (c: { id: string }) => {
    calls.push(c.id);
    return answer(c, calls.length);
  };
  return { calls, probe: probe as never };
}

test('tick probes the Claudes that are due: running workspace, no pool, the interval passed', async () => {
  const s = scripted(() => planResult([win('session', 10, reset5h)]));
  const h = await usageHarness({ probe: s.probe });
  try {
    h.source.list = [claude({ id: 'run' }), claude({ id: 'stopped', workspaceId: 'docker/ws2', workspaceName: 'ws2', running: false }), claude({ id: 'pooled', workspaceId: 'docker/ws3', workspaceName: 'ws3' }), claude({ id: 'run2', workspaceId: 'docker/ws4', workspaceName: 'ws4' })];
    h.source.pools.add('docker/ws3');
    await h.usage.tick();
    await sleep(5);
    assert.deepEqual(s.calls.sort(), ['run', 'run2'], 'a stopped workspace is never touched, a pool has nothing to read');
    // Not due again until the interval has passed.
    h.clock.t += INTERVAL - MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 2);
    h.clock.t += 2 * MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 4);
  } finally {
    h.done();
  }
});

test('one probe at a time per workspace, two in all', async () => {
  const release: (() => void)[] = [];
  const s = scripted(() => new Promise<ProbeResult>((resolve) => release.push(() => resolve(planResult([win('session', 1, reset5h)])))));
  const h = await usageHarness({ probe: s.probe });
  try {
    h.source.list = [claude({ id: 'a1' }), claude({ id: 'a2' }), claude({ id: 'b1', workspaceId: 'docker/ws2', workspaceName: 'ws2' }), claude({ id: 'c1', workspaceId: 'docker/ws3', workspaceName: 'ws3' })];
    await h.usage.tick();
    await sleep(5);
    assert.deepEqual(s.calls, ['a1', 'b1'], 'a2 waits for its workspace, c1 for a free slot');
    await h.usage.tick();
    assert.equal(s.calls.length, 2, 'nothing starts while both slots are taken');
    release.splice(0).forEach((r) => r());
    await sleep(5);
    await h.usage.tick();
    await sleep(5);
    assert.deepEqual([...s.calls].sort(), ['a1', 'a2', 'b1', 'c1'], 'the rest follow, once, when a slot and the workspace are free');
    release.splice(0).forEach((r) => r());
  } finally {
    h.done();
  }
});

test('a failed probe keeps the last numbers and backs off, doubling to an hour; a good one starts over', async () => {
  let fail = false;
  const s = scripted(() => (fail ? { runsOn: 'unknown', plan: null, windows: [], extra: null, problem: 'timeout', failed: true } : planResult([win('session', 30, reset5h)])));
  const h = await usageHarness({ probe: s.probe });
  try {
    await h.usage.tick();
    await sleep(5);
    assert.equal(h.usage.headroom('c1').limiting?.usedPct, 30);
    fail = true;
    for (const wait of [INTERVAL, 2 * INTERVAL, 4 * INTERVAL]) {
      h.clock.t += wait - 1000;
      await h.usage.tick();
      await sleep(5);
      const before = s.calls.length;
      h.clock.t += 1000;
      await h.usage.tick();
      await sleep(5);
      assert.equal(s.calls.length, before + 1, `due after ${wait / MIN} minutes`);
    }
    const row = (await h.usage.report()).claudes[0]!;
    assert.equal(row.problem, 'timeout');
    assert.equal(row.windows[0]!.usedPct, 30, 'the last numbers stay');
    assert.equal(row.runsOn, 'plan');
    // Failures 4 and up wait an hour at most.
    for (let i = 0; i < 4; i++) {
      h.clock.t += HOUR;
      await h.usage.tick();
      await sleep(5);
    }
    const n = s.calls.length;
    h.clock.t += HOUR - 1000;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, n, 'not yet');
    h.clock.t += 1000;
    fail = false;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, n + 1);
    assert.equal((await h.usage.report()).claudes[0]!.problem, null, 'a good probe clears the problem');
    h.clock.t += INTERVAL;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, n + 2, 'and the wait is the interval again');
  } finally {
    h.done();
  }
});

test('T-1835: a window whose reset passed since the last probe is due at once, not after the interval or a backoff; once per reset', async () => {
  const soon = NOW + 5 * MIN;
  const next = soon + 5 * HOUR;
  let fail = false;
  const s = scripted((_c, n) => (fail ? { runsOn: 'unknown', plan: null, windows: [], extra: null, problem: 'timeout', failed: true } : planResult([win('session', 40, n === 1 ? soon : next), win('week', 20, resetWeek)])));
  const h = await usageHarness({ probe: s.probe });
  try {
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 1);
    h.clock.t = soon - MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 1, 'before the reset: the interval holds');
    h.clock.t = soon + MIN; // 6 minutes after the probe, the interval is 10
    assert.equal((await h.usage.report()).claudes[0]!.unavailable, 'period_reset');
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 2, 'the period ended: probed at once');
    assert.equal((await h.usage.report()).claudes[0]!.unavailable, null, 'the new period is read');
    h.clock.t += MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 2, 'once per reset: then the interval again');
    // A failing Claude backs off (20 minutes after one failure), but a reset in that time still makes it due.
    fail = true;
    h.clock.t = next - 3 * MIN; // more than the interval since the last probe: due, and it fails
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 3);
    fail = false;
    h.clock.t = next + MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 4, 'the backoff does not hold a Claude whose window reset');
  } finally {
    h.done();
  }
});

test('a Claude found signed out or on a key is looked at once an hour; a page open on the tab makes it faster', async () => {
  let result: ProbeResult = { runsOn: 'none', plan: null, windows: [], extra: null, problem: null, failed: false };
  const s = scripted(() => result);
  const h = await usageHarness({ probe: s.probe });
  try {
    await h.usage.tick();
    await sleep(5);
    h.clock.t += 30 * MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 1, 'signed out: not after half an hour');
    h.clock.t += 31 * MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 2);

    // A plan: the interval, and the fast one while a page is watching.
    result = planResult([win('session', 5, reset5h)]);
    h.clock.t += HOUR;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 3);
    h.clock.t += 3 * MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 3, '3 minutes is under the interval');
    const quiet = await h.usage.report();
    assert.equal(quiet.intervalMs, INTERVAL);
    const watching = await h.usage.report({ watch: true });
    assert.equal(watching.intervalMs, 120_000);
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 4, 'a page is open: 2 minutes is enough');
    h.clock.t += WATCH_MS + 1;
    assert.equal((await h.usage.report()).intervalMs, INTERVAL, 'and it goes back when nobody asks');
  } finally {
    h.done();
  }
});

test('probes are off with the switch off, and with a store the portal does not trust', async () => {
  const s = scripted(() => planResult([win('session', 1, reset5h)]));
  const off = await usageHarness({ probe: s.probe, settings: { probes: false } });
  try {
    await off.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 0);
    off.usage.onRateLimit('s1', 'c1', INFO_WARNING);
    off.source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
    off.usage.onRateLimit('s1', 'c1', INFO_WARNING);
    assert.equal(off.usage.headroom('c1').kind, 'plan', 'passive readings still work with the probes off');
  } finally {
    off.done();
  }
  const source = new FakeSource();
  const frozen = new ClaudeUsageMonitor({ store: { writable: false, deliveryAllowed: false, db: null } as unknown as Store, source, probe: s.probe, log: () => {}, now: () => NOW });
  await frozen.tick();
  await sleep(5);
  assert.equal(s.calls.length, 0);
  source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
  assert.doesNotThrow(() => frozen.onRateLimit('s1', 'c1', INFO_WARNING));
  assert.equal(frozen.headroom('c1').kind, 'unknown');
  const report = await frozen.report();
  assert.equal(report.claudes[0]!.state, 'unknown', 'it still lists what exists');
  await assert.rejects(() => frozen.check('c1'), /can’t save/);
  frozen.start();
  frozen.stop();
});

test('check now: refused for a pool, a stopped workspace, a Claude that is not there and within the cooldown; one at a time', async () => {
  let release!: () => void;
  const s = scripted(() => new Promise<ProbeResult>((resolve) => (release = () => resolve(planResult([win('session', 20, reset5h)])))));
  const h = await usageHarness({ probe: s.probe });
  try {
    h.source.list = [claude({ id: 'c1' }), claude({ id: 'c2', workspaceId: 'docker/ws2', workspaceName: 'ws2', running: false }), claude({ id: 'c3', workspaceId: 'docker/ws3', workspaceName: 'ws3' })];
    h.source.pools.add('docker/ws3');
    await assert.rejects(() => h.usage.check('nobody'), /No such Claude/);
    await assert.rejects(() => h.usage.check('c2'), /Start the workspace/);
    await assert.rejects(() => h.usage.check('c3'), /account pool/);
    const first = h.usage.check('c1');
    await sleep(5);
    await assert.rejects(() => h.usage.check('c1'), (e: Error & { code?: string }) => e.code === 'RATE_LIMITED' || /moment ago/.test(e.message));
    release();
    const done = await first;
    assert.equal(done.windows[0]!.usedPct, 20);
    assert.equal(done.source, 'probe');
    await assert.rejects(() => h.usage.check('c1'), /moment ago/, 'cooldown');
    h.clock.t += COOLDOWN_MS + 1;
    const again = h.usage.check('c1');
    await sleep(5);
    release();
    await again;
    assert.equal(s.calls.length, 2);
  } finally {
    h.done();
  }
});

test('check now while the workspace already runs a probe is refused, not queued', async () => {
  let release!: () => void;
  const s = scripted(() => new Promise<ProbeResult>((resolve) => (release = () => resolve(planResult([win('session', 20, reset5h)])))));
  const h = await usageHarness({ probe: s.probe });
  try {
    h.source.list = [claude({ id: 'a' }), claude({ id: 'b' })];
    const first = h.usage.check('a');
    await sleep(5);
    await assert.rejects(() => h.usage.check('b'), /already running/);
    release();
    await first;
  } finally {
    h.done();
  }
});

test('passive: a live session’s event updates the windows it carries and leaves the model windows as the probe left them', async () => {
  const s = scripted(() => planResult([win('session', 10, reset5h, 'Session'), win('week', 20, resetWeek, 'Week'), win('week_opus', 12.5, resetWeek, 'Opus')]));
  const h = await usageHarness({ probe: s.probe });
  try {
    await h.usage.tick();
    await sleep(5);
    h.source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
    h.clock.t += 5 * MIN;
    h.usage.onRateLimit('s1', '', INFO_WARNING); // '' as the reader knows it: the session's own Claude is found
    const r = (await h.usage.report()).claudes[0]!;
    assert.equal(r.source, 'live');
    assert.deepEqual(r.windows.map((w) => [w.key, w.usedPct]), [['session', 82], ['week', 63], ['week_opus', 12.5]]);
    assert.equal(r.windows[0]!.label, 'Session');
    assert.equal(r.state, 'near');
    assert.equal(r.plan, 'max', 'what the probe knew about the plan stays');
    assert.ok(h.changes() > 0, 'open pages are told');
    // The probe schedule is its own: a live reading doesn't postpone it.
    h.clock.t += INTERVAL;
    await h.usage.tick();
    await sleep(5);
    assert.equal(s.calls.length, 2);
    // History has both sources.
    const hist = await h.usage.history('c1', '1d');
    assert.deepEqual(hist.series.map((x) => x.key), ['session', 'week', 'week_opus']);
    assert.ok(hist.series[0]!.points.length >= 2);
  } finally {
    h.done();
  }
});

test('passive: a Claude with no reading yet gets one; a refused request is exhausted at once; a pool, a stranger and rubbish do nothing', async () => {
  const h = await usageHarness();
  try {
    h.source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
    h.usage.onRateLimit('s1', 'c1', INFO_REJECTED);
    const hr = h.usage.headroom('c1');
    assert.equal(hr.kind, 'plan');
    assert.equal(hr.exhausted, true);
    assert.equal(hr.availableAt, new Date(1791768941 * 1000).toISOString());
    assert.equal((await h.usage.report()).claudes[0]!.state, 'exhausted');

    h.usage.onRateLimit('s1', 'c1', { nothing: 'useful' });
    h.usage.onRateLimit('s1', 'c1', null);
    h.usage.onRateLimit('unknown-session', 'c1', INFO_WARNING);
    h.usage.onRateLimit('s1', 'someone-else', INFO_WARNING);
    assert.equal(h.usage.headroom('c1').exhausted, true, 'unchanged by any of those');

    h.source.list = [claude({ id: 'c9', workspaceId: 'docker/ws9', workspaceName: 'ws9' })];
    h.source.pools.add('docker/ws9');
    h.source.sessions.set('s9', { workspaceId: 'docker/ws9', claudeId: 'c9' });
    h.usage.onRateLimit('s9', 'c9', INFO_WARNING);
    assert.equal(h.usage.headroom('c9').kind, 'unknown', 'a pool session has no plan windows to record');
  } finally {
    h.done();
  }
});

test('onReading: told after a probe that read and after a live reading, not after rubbish; a listener that throws harms nothing (T-105)', async () => {
  const s = scripted(() => planResult([win('session', 10, reset5h, 'Session')]));
  const h = await usageHarness({ probe: s.probe });
  try {
    let n = 0;
    const off = h.usage.onReading(() => n++);
    h.usage.onReading(() => {
      throw new Error('boom');
    });
    await h.usage.tick();
    await sleep(5);
    assert.equal(n, 1, 'the probe');
    h.source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
    h.usage.onRateLimit('s1', 'c1', INFO_WARNING);
    assert.equal(n, 2, 'the live reading');
    h.usage.onRateLimit('s1', 'c1', null);
    assert.equal(n, 2, 'nothing read, nobody told');
    off();
    h.usage.onRateLimit('s1', 'c1', INFO_WARNING);
    assert.equal(n, 2, 'stopped listening');
  } finally {
    h.done();
  }
});

const alertsOf = (log: ClaudeUsageAlert[]) => log.map((a) => `${a.window}:${a.level}`);

test('alerts: once per window, level and period; rising levels alert again; a reset starts a new period', async () => {
  let pct = 50;
  let resetAt = reset5h;
  const s = scripted(() => planResult([win('session', pct, resetAt, 'Session'), win('week', 10, resetWeek, 'Week')]));
  const h = await usageHarness({ probe: s.probe });
  const log: ClaudeUsageAlert[] = [];
  // The threshold alerts only: the script jumps (50 to 79 % in ten minutes), which the projection alert (§20.4, service.insight.test.ts) also notices.
  h.usage.onAlert((a) => a.kind !== 'projection' && log.push(a));
  const probe = async (v: number, dt = INTERVAL) => {
    pct = v;
    h.clock.t += dt;
    await h.usage.tick();
    await sleep(5);
  };
  try {
    await probe(50, 0);
    await probe(79);
    assert.deepEqual(alertsOf(log), [], 'under 80 says nothing');
    await probe(81);
    assert.deepEqual(alertsOf(log), ['session:near']);
    await probe(83);
    await probe(81);
    assert.equal(log.length, 1, 'the same level in the same period is told once');
    await probe(96);
    assert.deepEqual(alertsOf(log), ['session:near', 'session:high']);
    await probe(100);
    assert.deepEqual(alertsOf(log), ['session:near', 'session:high', 'session:exhausted']);
    assert.equal(log[2]!.usedPct, 100);
    assert.equal(log[2]!.claudeName, 'Default');
    assert.equal(log[2]!.workspaceName, 'ws1');
    await probe(97);
    assert.equal(log.length, 3, 'falling back and rising is the same period');
    // The window resets: a new period, and it can alert again.
    resetAt = reset5h + 5 * HOUR;
    await probe(85, 5 * HOUR);
    assert.deepEqual(alertsOf(log).slice(3), ['session:near']);
    assert.notEqual(log[3]!.id, log[0]!.id, 'a new period is a new alert id');
    // A reset time that only differs by rounding is the same period.
    resetAt += 400;
    await probe(97);
    assert.deepEqual(alertsOf(log).slice(4), ['session:high']);
    resetAt += 1000;
    await probe(97);
    assert.equal(log.length, 5);
  } finally {
    h.done();
  }
});

test('alerts: the report lists the last day’s crossings; a restart repeats none; a snooze silences them and nothing is told when it ends', async () => {
  let pct = 96;
  const s = scripted(() => planResult([win('session', pct, reset5h, 'Session')]));
  const h = await usageHarness({ probe: s.probe });
  const log: ClaudeUsageAlert[] = [];
  h.usage.onAlert((a) => log.push(a));
  try {
    await h.usage.tick();
    await sleep(5);
    assert.deepEqual(alertsOf(log), ['session:high']);
    const report = await h.usage.report();
    assert.deepEqual(report.alerts.map((a) => a.id), [`c1|session|high|${reset5h}`]);
    assert.equal(report.alerts[0]!.claudeName, 'Default');
    // Once the window's period is over (its reset time passed) the alert is no longer news.
    const at = h.clock.t;
    h.clock.t = reset5h + MIN;
    assert.deepEqual((await h.usage.report()).alerts, []);
    h.clock.t = at;

    // A portal restart: a new service over the same database tells nothing again.
    const again = new ClaudeUsageMonitor({ store: h.store, source: h.source, now: () => h.clock.t, probe: s.probe, log: () => {} });
    const log2: ClaudeUsageAlert[] = [];
    again.onAlert((a) => log2.push(a));
    h.clock.t += INTERVAL;
    await again.tick();
    await sleep(5);
    assert.deepEqual(log2, []);

    // Snoozed: the next level is not told, the report hides the Claude's alerts, and the row says until when.
    const snoozed = await h.usage.snooze('c1', '1h');
    assert.equal(snoozed.snoozedUntil, new Date(h.clock.t + HOUR).toISOString());
    pct = 100;
    h.clock.t += INTERVAL;
    await h.usage.tick();
    await sleep(5);
    assert.equal(log.length, 1, 'nothing while snoozed');
    assert.deepEqual((await h.usage.report()).alerts, []);
    // After the snooze the old crossing doesn't come back as news.
    h.clock.t += HOUR;
    await h.usage.tick();
    await sleep(5);
    assert.equal(log.length, 1);
    assert.deepEqual((await h.usage.report()).alerts, [], 'the crossing that happened under the snooze stays quiet for good');
    assert.equal((await h.usage.report()).claudes[0]!.snoozedUntil, null);
    // Until the next reset, and ending a snooze early.
    const until = await h.usage.snooze('c1', 'reset');
    assert.equal(until.snoozedUntil, new Date(reset5h).toISOString(), 'the soonest reset of a window that is in the way');
    const off = await h.usage.unsnooze('c1');
    assert.equal(off.snoozedUntil, null);
    await assert.rejects(() => h.usage.snooze('nobody', '1h'), /No such Claude/);
  } finally {
    h.done();
  }
});

test('alerts: a sink that throws does not stop the others or the reading', async () => {
  const s = scripted(() => planResult([win('session', 90, reset5h)]));
  const h = await usageHarness({ probe: s.probe });
  const seen: string[] = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    h.usage.onAlert(() => {
      throw new Error('boom');
    });
    const stop = h.usage.onAlert((a) => seen.push(a.level));
    await h.usage.tick();
    await sleep(5);
    assert.deepEqual(seen, ['near']);
    assert.equal(h.usage.headroom('c1').limiting?.usedPct, 90);
    stop();
  } finally {
    console.error = quiet;
    h.done();
  }
});

test('report: states of each kind of Claude, staleness, and what a pool says', async () => {
  const h = await usageHarness();
  try {
    h.source.list = [
      claude({ id: 'plan' }),
      claude({ id: 'none', workspaceId: 'docker/n', workspaceName: 'n' }),
      claude({ id: 'key', workspaceId: 'docker/k', workspaceName: 'k' }),
      claude({ id: 'pool', workspaceId: 'docker/p', workspaceName: 'p' }),
      claude({ id: 'new', workspaceId: 'docker/new', workspaceName: 'new' }),
      claude({ id: 'asleep', workspaceId: 'docker/z', workspaceName: 'z', running: false }),
    ];
    h.source.pools.add('docker/p');
    const save = (claudeId: string, over: object) => h.store.db!.prepare(`INSERT INTO claude_usage_latest (claude_id, workspace_id, checked_at_ms, last_probe_at_ms, runs_on, plan, windows, source) VALUES (?, 'x', ?, ?, ?, ?, ?, 'probe')`).run(claudeId, (over as { at?: number }).at ?? NOW, NOW, (over as { cred: string }).cred, (over as { plan?: string }).plan ?? null, JSON.stringify((over as { w?: unknown[] }).w ?? []));
    save('plan', { cred: 'plan', plan: 'max', w: [win('session', 41, reset5h, 'Session'), win('week', 63, resetWeek, 'Week')] });
    save('none', { cred: 'none' });
    save('key', { cred: 'key' });
    save('pool', { cred: 'plan', plan: 'max', w: [win('session', 99, reset5h)] }); // old, from before a pool was assigned
    save('asleep', { cred: 'plan', plan: 'pro', w: [win('session', 10, reset5h, 'Session')] });
    const r = await h.usage.report();
    const by = Object.fromEntries(r.claudes.map((c) => [c.claudeId, c]));
    assert.equal(by.plan!.state, 'ok');
    assert.equal(by.plan!.plan, 'max');
    assert.equal(by.plan!.stale, false);
    assert.deepEqual(by.plan!.windows.map((w) => [w.key, w.level, w.resetsAt]), [['session', 'ok', new Date(reset5h).toISOString()], ['week', 'ok', new Date(resetWeek).toISOString()]]);
    assert.equal(by.none!.state, 'signed_out');
    assert.equal(by.key!.state, 'no_limits');
    assert.deepEqual([by.pool!.state, by.pool!.runsOn, by.pool!.windows, by.pool!.plan, by.pool!.checkedAt], ['no_limits', 'pool', [], null, null], 'a pool hides what an old sign-in reading said');
    assert.deepEqual([by.new!.state, by.new!.checkedAt, by.new!.stale, by.new!.windows], ['unknown', null, false, []]);
    assert.equal(by.asleep!.stale, true, 'a stopped workspace’s numbers are old');
    assert.equal(by.asleep!.workspaceRunning, false);
    assert.deepEqual(r.thresholds, { warn: 80, critical: 95 });
    // Three intervals without a reading is old too.
    h.clock.t += 3 * INTERVAL + 1;
    assert.equal((await h.usage.report()).claudes.find((c) => c.claudeId === 'plan')!.stale, true);
    // And when a reset time has passed, the window says so and the Claude doesn't read as full.
    h.clock.t = reset5h + MIN;
    const later = (await h.usage.report()).claudes.find((c) => c.claudeId === 'plan')!;
    assert.deepEqual(later.windows.map((w) => w.level), ['reset', 'ok']);
  } finally {
    h.done();
  }
});

test('headroom: the fullest window, what stops the Claude and when it is back, models blocked, and the kinds without limits', async () => {
  const h = await usageHarness();
  try {
    h.source.list = [claude({ id: 'a' }), claude({ id: 'p', workspaceId: 'docker/p', workspaceName: 'p' })];
    h.source.pools.add('docker/p');
    await h.usage.report(); // lists the Claudes
    const put = (id: string, cred: string, windows: unknown[]) => h.store.db!.prepare(`INSERT OR REPLACE INTO claude_usage_latest (claude_id, workspace_id, checked_at_ms, last_probe_at_ms, runs_on, windows) VALUES (?, 'x', ?, ?, ?, ?)`).run(id, NOW, NOW, cred, JSON.stringify(windows));

    assert.deepEqual(h.usage.headroom('a'), { claudeId: 'a', kind: 'unknown', limiting: null, exhausted: false, availableAt: null, blockedModels: [], checkedAt: null, stale: false });
    put('a', 'plan', [win('session', 41, reset5h, 'Session'), win('week', 63, resetWeek, 'Week'), win('week_opus', 12.5, resetWeek, 'Opus')]);
    const ok = h.usage.headroom('a');
    assert.deepEqual([ok.kind, ok.exhausted, ok.availableAt, ok.blockedModels], ['plan', false, null, []]);
    assert.deepEqual(ok.limiting, { key: 'week', label: 'Week', usedPct: 63, leftPct: 37, resetsAt: new Date(resetWeek).toISOString() });
    assert.equal(ok.checkedAt, new Date(NOW).toISOString());

    // The session is used up: the Claude is out until it resets; Opus alone being out blocks only Opus.
    put('a', 'plan', [win('session', 100, reset5h, 'Session'), win('week', 63, resetWeek, 'Week'), win('week_opus', 100, resetWeek, 'Opus'), win('model:fable', 100, resetWeek, 'Fable')]);
    const out = h.usage.headroom('a');
    assert.equal(out.exhausted, true);
    assert.equal(out.availableAt, new Date(reset5h).toISOString());
    assert.deepEqual(out.blockedModels, ['Opus', 'Fable']);
    assert.equal(out.limiting!.leftPct, 0);
    put('a', 'plan', [win('session', 40, reset5h, 'Session'), win('week_opus', 100, resetWeek, 'Opus')]);
    const opus = h.usage.headroom('a');
    assert.deepEqual([opus.exhausted, opus.blockedModels], [false, ['Opus']], 'the Claude still runs other models');
    // Both session and week used up: back when the later one resets.
    put('a', 'plan', [win('session', 100, reset5h, 'Session'), win('week', 100, resetWeek, 'Week')]);
    assert.equal(h.usage.headroom('a').availableAt, new Date(resetWeek).toISOString());
    // An exhausted window with no reset time: out, and nobody can say until when.
    put('a', 'plan', [win('session', 100, null, 'Session')]);
    assert.deepEqual([h.usage.headroom('a').exhausted, h.usage.headroom('a').availableAt], [true, null]);
    // Windows that reset (old numbers) don't count; with nothing left, it's unknown.
    put('a', 'plan', [win('session', 100, NOW - 1, 'Session')]);
    assert.equal(h.usage.headroom('a').kind, 'unknown');

    put('a', 'key', []);
    assert.equal(h.usage.headroom('a').kind, 'no_limits');
    put('a', 'none', []);
    assert.equal(h.usage.headroom('a').kind, 'signed_out');
    put('p', 'plan', [win('session', 100, reset5h)]);
    assert.deepEqual([h.usage.headroom('p').kind, h.usage.headroom('p').exhausted, h.usage.headroom('p').checkedAt], ['no_limits', false, null], 'a pool');
    assert.equal(h.usage.headroom('nobody').kind, 'unknown');

    // Stale: old, or the workspace stopped.
    put('a', 'plan', [win('session', 10, reset5h)]);
    assert.equal(h.usage.headroom('a').stale, false);
    h.clock.t += 3 * INTERVAL + 1;
    assert.equal(h.usage.headroom('a').stale, true);
    h.clock.t = NOW;
    h.source.list = [claude({ id: 'a', running: false })];
    await h.usage.report();
    assert.equal(h.usage.headroom('a').stale, false, 'the list is cached for a few seconds');
    h.clock.t += 6000;
    await h.usage.report();
    assert.equal(h.usage.headroom('a').stale, true);
  } finally {
    h.done();
  }
});

test('history: ranges, labels, thinning to 200 points, and what is refused', async () => {
  const h = await usageHarness();
  try {
    await h.usage.report();
    const ins = h.store.db!.prepare(`INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, 'c1', 'x', ?, ?, NULL, 'ok', 'probe')`);
    for (let i = 0; i < 1000; i++) ins.run(NOW - 20 * HOUR + i * MIN, 'session', i % 100);
    ins.run(NOW - 2 * 24 * HOUR, 'week', 12);
    h.store.db!.prepare(`INSERT INTO claude_usage_latest (claude_id, workspace_id, windows) VALUES ('c1', 'x', ?)`).run(JSON.stringify([win('session', 1, null, 'Session')]));
    const day = await h.usage.history('c1', '1d');
    assert.equal(day.range, '1d');
    assert.deepEqual(day.series.map((x) => [x.key, x.label]), [['session', 'Session']], 'the week sample is two days old');
    assert.equal(day.series[0]!.points.length, 200);
    assert.equal(day.series[0]!.points[0]!.at, new Date(NOW - 20 * HOUR).toISOString(), 'the first is kept');
    assert.equal(day.series[0]!.points.at(-1)!.at, new Date(NOW - 20 * HOUR + 999 * MIN).toISOString(), 'and the last');
    const week = await h.usage.history('c1', '7d');
    assert.deepEqual(week.series.map((x) => x.key), ['session', 'week']);
    assert.equal(week.series[1]!.label, 'week', 'a window the latest reading no longer has still shows, under its key');
    assert.equal(week.from, new Date(NOW - 7 * 24 * HOUR).toISOString());
    await assert.rejects(() => h.usage.history('c1', '90d'), /Pick 1d/);
    await assert.rejects(() => h.usage.history('nobody', '1d'), /No such Claude/);
  } finally {
    h.done();
  }
});

test('start and stop: timers once, none left; a failing listing is survived', async () => {
  const h = await usageHarness();
  try {
    h.usage.start();
    h.usage.start();
    h.usage.stop();
    h.usage.stop();
    h.source.claudes = async () => Promise.reject(new Error('docker is down'));
    const quiet = console.error;
    console.error = () => {};
    try {
      await h.usage.tick();
      const r = await h.usage.report();
      assert.deepEqual(r.claudes.map((c) => c.claudeId), ['c1'], 'the last list it had');
    } finally {
      console.error = quiet;
    }
    assert.ok(TICK_MS >= 10_000, 'the scheduler wakes rarely');
  } finally {
    h.done();
  }
});

test('trend: the row’s sparkline is the week window’s last 7 days (else the session’s), thinned; none for a pool or without numbers', async () => {
  const s = scripted(() => planResult([win('session', 10, reset5h, 'Session'), win('week', 20, resetWeek, 'Week')]));
  const h = await usageHarness({ probe: s.probe });
  try {
    h.source.list = [claude({ id: 'c1' }), claude({ id: 'c2', workspaceId: 'docker/ws2', workspaceName: 'ws2' }), claude({ id: 'c3', workspaceId: 'docker/ws3', workspaceName: 'ws3' })];
    h.source.pools.add('docker/ws3');
    const put = (id: string, windows: unknown[]) => h.store.db!.prepare(`INSERT OR REPLACE INTO claude_usage_latest (claude_id, workspace_id, checked_at_ms, last_probe_at_ms, runs_on, windows) VALUES (?, 'x', ?, ?, 'plan', ?)`).run(id, NOW, NOW, JSON.stringify(windows));
    const ins = h.store.db!.prepare(`INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, ?, 'x', ?, ?, NULL, 'ok', 'probe')`);
    put('c1', [win('session', 5, reset5h, 'Session'), win('week', 40, resetWeek, 'Week')]);
    for (let i = 0; i < 100; i++) ins.run(NOW - 6 * 24 * HOUR + i * HOUR, 'c1', 'week', i / 2);
    for (let i = 0; i < 100; i++) ins.run(NOW - i * HOUR, 'c1', 'session', 50);
    ins.run(NOW - 8 * 24 * HOUR, 'c1', 'week', 99); // older than 7 days
    put('c2', [win('session', 5, reset5h, 'Session')]);
    ins.run(NOW - HOUR, 'c2', 'session', 7);
    put('c3', [win('session', 5, reset5h, 'Session')]);
    ins.run(NOW - HOUR, 'c3', 'session', 7);
    const r = await h.usage.report();
    const by = Object.fromEntries(r.claudes.map((c) => [c.claudeId, c]));
    assert.equal(by.c1!.trend!.key, 'week');
    assert.equal(by.c1!.trend!.label, 'Week');
    assert.equal(by.c1!.trend!.points.length, 28, 'thinned');
    assert.equal(by.c1!.trend!.points[0]!.usedPct, 0, 'from the first sample in range, not the 8-day-old one');
    assert.equal(by.c2!.trend!.key, 'session', 'no week window: the session');
    assert.deepEqual(by.c2!.trend!.points.map((p) => p.usedPct), [7]);
    assert.equal(by.c3!.trend, null, 'a pool has no plan windows');
    h.store.db!.prepare('DELETE FROM claude_usage_samples').run();
    assert.equal((await h.usage.report()).claudes.find((c) => c.claudeId === 'c1')!.trend, null, 'no samples, no line');
  } finally {
    h.done();
  }
});
