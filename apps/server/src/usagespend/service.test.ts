import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { SpendStore } from './store.js';
import { DAY, HOUR, MIN, NOW, spendHarness } from './testkit.js';

// NOW is 2026-10-12 15:00 UTC (a Monday). `at(h, m, day)` is a UTC clock time in October 2026 (the 12th unless said otherwise).
const at = (h: number, m = 0, day = 12) => Date.UTC(2026, 9, day, h, m);

const fails = async (p: Promise<unknown> | (() => unknown), code: string, status?: number) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    assert.ok(isAppError(e), `an AppError, got ${String(e)}`);
    assert.equal((e as { code: string }).code, code);
    if (status) assert.equal((e as { status: number }).status, status);
    return e as { message: string; details?: Record<string, unknown> };
  }
  return assert.fail('should have been refused');
};

test('a daily budget on a workspace counts its own day and workspace, alerts at 80, 95 and 100 % once each, and starts over the next day', async () => {
  // The spike rules are made very hard to trip, so only the budget speaks.
  const h = await spendHarness({ settings: { 'usage.spikes.rateFactor': 100, 'usage.spikes.outlierFactor': 1000 } });
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.clock.t = at(9);
    const created = await h.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/api' }, period: 'day', limitUsd: 10 });
    assert.match(created.budget.id, /^b_[0-9a-f]{12}$/);
    assert.deepEqual([created.scopeLabel, created.level, created.paused, created.usedUsd, created.usedTokens], ['api', 'ok', false, { value: 0, basis: 'estimate' }, { value: 0, basis: 'measured' }]);
    assert.deepEqual([created.periodStart, created.periodEnd, created.timezone], ['2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z', 'UTC']);

    // History: yesterday $5 (another day), today $3.00 + $4.50 here, and $20 on another workspace. Today here: $7.50 = 75 %.
    h.seed.usage({ atMs: at(23, 0, 11), session: 'S1', costUsd: 5 });
    h.seed.usage({ atMs: at(1), session: 'S1', costUsd: 3 });
    h.seed.usage({ atMs: at(2), session: 'S1', costUsd: 4.5 });
    h.seed.usage({ atMs: at(3), session: 'S9', workspace: 'docker/web', claude: 'c2', costUsd: 20 });
    assert.equal(h.spend.budget(created.budget.id).usedPct.value, 75);

    // 10:00 +$0.60 = $8.10 (81 %): near. 11:00 +$0.30 = 8.40: nothing new. 12:00 +$1.10 = 9.50 (95 %): high. 13:00 +$0.50 = 10.00: used up. 14:00 +$1.00: nothing new.
    for (const [hour, usd] of [[10, 0.6], [11, 0.3], [12, 1.1], [13, 0.5], [14, 1.0]] as const) {
      h.clock.t = at(hour);
      h.seed.turn({ atMs: at(hour), session: 'S1', costUsd: usd });
    }
    assert.deepEqual(h.told.map((a) => (a.kind === 'budget' ? [a.level, a.summary, a.usedPct, a.paused] : null)), [
      ['near', 'api daily: 81 %', 81, false],
      ['high', 'api daily: 95 %', 95, false],
      ['exhausted', 'api daily: used up', 100, false],
    ]);
    assert.equal(h.told[0]!.id, `budget|${created.budget.id}|near|${Date.UTC(2026, 9, 12)}`);
    assert.deepEqual(h.told.map((a) => a.scope), Array(3).fill({ kind: 'workspace', id: 'docker/api', label: 'api' }));
    assert.equal(h.spend.spikes('30d').events.length, 0, 'ordinary small requests are not spikes');

    // The state now: 3 + 4.5 + 0.6 + 0.3 + 1.1 + 0.5 + 1.0 = $11.00 of $10.00, 110 %; alert-only, so not paused.
    const st = h.spend.budget(created.budget.id);
    assert.deepEqual([st.usedUsd.value, st.usedPct.value, st.level, st.paused, st.limiting], [11, 110, 'exhausted', false, 'usd']);
    assert.equal(st.usedPct.basis, 'estimate');
    // The list shows the highest one told in this period.
    assert.deepEqual(h.spend.alerts().map((a) => [a.kind, a.kind === 'budget' ? a.level : null]), [['budget', 'exhausted']]);

    // Everything today: this workspace $11.00 + the other $20; everything this month adds yesterday's $5. Counts are requests (rows).
    const sum = h.spend.summary();
    assert.deepEqual([sum.today.costUsd, sum.today.requests, sum.month.costUsd, sum.month.requests], [31, 8, 36, 9]);
    // 2026-10-12 is a Monday: yesterday's $5 belongs to last week, so this week is today.
    assert.deepEqual([sum.week.costUsd, sum.week.requests], [31, 8]);
    assert.deepEqual(sum.budgets, { total: 1, near: 0, high: 0, exhausted: 1, paused: 0 });

    // The next day it starts over: $2.00 is 20 %, nothing is told, and yesterday's alert is not listed any more.
    h.clock.t = at(1, 0, 13);
    h.seed.turn({ atMs: at(1, 0, 13), session: 'S1', costUsd: 2 });
    assert.equal(h.told.length, 3);
    assert.equal(h.spend.alerts().length, 0);
    assert.equal(h.spend.budget(created.budget.id).usedPct.value, 20);
    // And it can cross again: $6.50 more is $8.50 (85 %).
    h.clock.t = at(2, 0, 13);
    h.seed.turn({ atMs: at(2, 0, 13), session: 'S1', costUsd: 6.5 });
    assert.deepEqual(h.told.slice(3).map((a) => (a.kind === 'budget' ? a.summary : '')), ['api daily: 85 %']);
    assert.ok(h.changes() >= 4, 'open pages were told');
  } finally {
    h.done();
  }
});

test('alert sinks: told once per alert id with its level and scope, a throwing one harms nothing, and the unsubscribe stops it', async () => {
  const h = await spendHarness();
  try {
    const mine: string[] = [];
    const off = h.spend.onAlert((a) => void mine.push(a.id));
    h.spend.onAlert(() => {
      throw new Error('a broken listener');
    });
    h.clock.t = at(12);
    const b = await h.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 10 });
    h.seed.turn({ atMs: at(12), session: 'S', costUsd: 8.5 }); // 85 %: near
    h.seed.turn({ atMs: at(12, 1), session: 'S', costUsd: 0.1 }); // 86 %: nothing new
    h.clock.t = at(12, 2);
    h.seed.turn({ atMs: at(12, 2), session: 'S', costUsd: 1.0 }); // 96 %: high
    const day = Date.UTC(2026, 9, 12);
    assert.deepEqual(mine, [`budget|${b.budget.id}|near|${day}`, `budget|${b.budget.id}|high|${day}`], 'one call per alert id, in order');
    assert.deepEqual(h.told.map((a) => [a.level, a.scope.kind, a.scope.id, a.scope.label]), [['near', 'all', null, 'Everything'], ['high', 'all', null, 'Everything']]);
    assert.equal(h.logs.length, 1, 'the broken listener is logged once, never thrown');
    assert.match(h.logs[0]!, /an alert sink failed: a broken listener/);
    off();
    h.seed.turn({ atMs: at(12, 3), session: 'S', costUsd: 5 }); // used up
    assert.equal(mine.length, 2, 'unsubscribed');
    assert.equal(h.told.length, 3, 'the others still hear');
    // The stored alert is the same object the listeners got: ids are what a page, and a notification, key on.
    assert.deepEqual(h.spend.alerts().map((a) => a.id), [`budget|${b.budget.id}|exhausted|${day}`]);
  } finally {
    h.done();
  }
});

test('a token limit counts input + output + cache writes, not cache reads; the fuller of the two limits decides', async () => {
  const h = await spendHarness();
  try {
    h.clock.t = at(12);
    const b = await h.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 100, limitTokens: 1000 });
    // 100 input + 200 output + 300 cache writes = 600 tokens (the 5,000 cache reads are not counted): 60 % of the tokens; $2 is 2 % of the dollars.
    h.seed.usage({ atMs: at(11), session: 'S1', costUsd: 2, input: 100, output: 200, cacheWrite: 300, cacheRead: 5000 });
    const st = h.spend.budget(b.budget.id);
    assert.deepEqual([st.usedTokens, st.usedUsd.value, st.limiting, st.usedPct, st.level], [{ value: 600, basis: 'measured' }, 2, 'tokens', { value: 60, basis: 'measured' }, 'ok']);
    // 300 more input tokens is 900 of 1,000: 90 %, near, told with the percent of the tokens.
    h.clock.t = at(13);
    h.seed.turn({ atMs: at(13), session: 'S1', costUsd: 0.1, input: 300 });
    assert.deepEqual(h.told.map((a) => (a.kind === 'budget' ? a.summary : '')), ['Everything daily: 90 %']);
  } finally {
    h.done();
  }
});

test('a snooze makes a crossing quiet: nothing is told then, nor later for a level already crossed, and a higher level is told once it ends', async () => {
  const h = await spendHarness();
  try {
    h.clock.t = at(15);
    const b = await h.spend.createBudget({ name: 'All', scope: { kind: 'all' }, period: 'day', limitUsd: 10 });
    const snoozed = h.spend.snoozeBudget(b.budget.id, '4h');
    assert.equal(snoozed.snoozedUntil, new Date(at(19)).toISOString());
    h.clock.t = at(15, 30);
    h.seed.turn({ atMs: at(15, 30), session: 'S1', costUsd: 9 }); // 90 %: near, while snoozed
    assert.equal(h.told.length, 0);
    assert.equal(h.spend.alerts().length, 0, 'a quiet crossing is never shown');
    // After the snooze: 95 % is a higher level than the quiet near, so it is told. (Near is not told late.)
    h.clock.t = at(20);
    h.seed.turn({ atMs: at(20), session: 'S1', costUsd: 0.5 });
    assert.deepEqual(h.told.map((a) => (a.kind === 'budget' ? [a.budgetName, a.level, a.summary] : null)), [['All', 'high', 'All: 95 %']]);
    assert.equal(h.spend.budget(b.budget.id).snoozedUntil, null);
    // "Until it resets" is the end of the period; ending a snooze clears it.
    assert.equal(h.spend.snoozeBudget(b.budget.id, 'reset').snoozedUntil, '2026-10-13T00:00:00.000Z');
    assert.equal(h.spend.unsnoozeBudget(b.budget.id).snoozedUntil, null);
    await fails(() => h.spend.snoozeBudget(b.budget.id, 'forever'), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.snoozeBudget('b_nope', '1h'), 'NOT_FOUND', 404);
  } finally {
    h.done();
  }
});

test('a budget that pauses refuses new messages for its scope once used up, and only then; alert-only budgets never do', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.seed.claude('c2', 'docker/api', 'Satria');
    h.clock.t = at(9);
    const b = await h.spend.createBudget({ scope: { kind: 'claude', id: 'c1' }, period: 'day', limitUsd: 5, mode: 'pause' });
    const ask = (claudeId: string | null, workspaceId = 'docker/api') => h.spend.gate({ sessionId: 'S1', workspaceId, claudeId });
    h.clock.t = at(10);
    h.seed.turn({ atMs: at(10), session: 'S1', costUsd: 3 });
    assert.equal(ask('c1'), null, '60 %: nothing refused');
    h.clock.t = at(11);
    h.seed.turn({ atMs: at(11), session: 'S1', costUsd: 2 });
    // Used up: $5.00 of $5.00. A Claude the budget does not count, and a running turn's end, are unaffected; the next message is refused.
    const e = await fails(() => {
      const err = ask('c1');
      if (err) throw err;
    }, 'USAGE_BUDGET', 409);
    assert.match(e.message, /used up \(\$5\.00 of \$5\.00, estimated\)/);
    assert.match(e.message, /13 Oct 2026/);
    assert.match(e.message, /\(UTC\)/);
    assert.match(e.message, /Usage › Budgets/);
    assert.equal(e.details?.budgetId, b.budget.id);
    assert.equal(ask('c2'), null, 'another Claude');
    assert.equal(h.spend.budget(b.budget.id).paused, true);
    assert.deepEqual(h.told.map((a) => (a.kind === 'budget' ? [a.level, a.paused, a.summary] : null)), [['exhausted', true, 'Kresna · api daily: used up · paused']]);
    // Raising it, or setting it to alerts only, or switching it off, lets messages through; the period ending does too.
    await h.spend.updateBudget(b.budget.id, { limitUsd: 6 });
    assert.equal(ask('c1'), null);
    await h.spend.updateBudget(b.budget.id, { limitUsd: 5 });
    assert.ok(ask('c1'));
    await h.spend.updateBudget(b.budget.id, { mode: 'alert' });
    assert.equal(ask('c1'), null);
    await h.spend.updateBudget(b.budget.id, { mode: 'pause', enabled: false });
    assert.equal(ask('c1'), null);
    await h.spend.updateBudget(b.budget.id, { enabled: true });
    assert.ok(ask('c1'));
    h.clock.t = at(0, 5, 13);
    assert.equal(ask('c1'), null, 'a new day');
    // A pausing budget can't be snoozed, and making one pause clears a snooze it had.
    await fails(() => h.spend.snoozeBudget(b.budget.id, '1h'), 'CONFLICT', 409);
    const quiet = await h.spend.createBudget({ scope: { kind: 'all' }, period: 'month', limitUsd: 50 });
    h.spend.snoozeBudget(quiet.budget.id, '1h');
    assert.equal((await h.spend.updateBudget(quiet.budget.id, { mode: 'pause' })).snoozedUntil, null);
  } finally {
    h.done();
  }
});

test('days are counted on the portal’s clock: Jakarta’s day starts at 17:00 UTC, and a name nobody knows means UTC', async () => {
  const h = await spendHarness({ settings: { 'usage.timezone': 'Asia/Jakarta' } });
  try {
    h.clock.t = at(20); // 03:00 on the 13th in Jakarta
    const b = await h.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 10 });
    assert.deepEqual([b.periodStart, b.periodEnd, b.timezone], ['2026-10-12T17:00:00.000Z', '2026-10-13T17:00:00.000Z', 'Asia/Jakarta']);
    h.seed.usage({ atMs: at(16, 59), session: 'S1', costUsd: 4 }); // the 12th in Jakarta
    h.seed.usage({ atMs: at(17, 0), session: 'S1', costUsd: 1.5 }); // the 13th: the first instant counts
    assert.equal(h.spend.budget(b.budget.id).usedUsd.value, 1.5);
    h.values['usage.timezone'] = 'Mars/Base';
    const utc = h.spend.budget(b.budget.id);
    assert.deepEqual([utc.timezone, utc.periodStart, utc.usedUsd.value], ['UTC', '2026-10-12T00:00:00.000Z', 5.5]);
  } finally {
    h.done();
  }
});

test('budgets: made, changed, removed; a changed limit starts its alerts over; bad ones are refused with the field', async () => {
  const h = await spendHarness({ workspaceExists: (id) => id !== 'docker/ghost' });
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.clock.t = at(12);
    h.seed.usage({ atMs: at(11), session: 'S1', costUsd: 9 });
    const a = await h.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/api' }, period: 'day', limitUsd: 10 });
    // Made when already at 90 %: it says so now.
    assert.deepEqual(h.told.map((x) => (x.kind === 'budget' ? x.summary : '')), ['api daily: 90 %']);
    assert.equal(h.spend.alerts().length, 1);
    // Raising the limit starts its alerts over: 9 of 20 is 45 %, and 17 of 20 (85 %) is told as new.
    const raised = await h.spend.updateBudget(a.budget.id, { limitUsd: 20, name: 'Api' });
    assert.deepEqual([raised.budget.limitUsd, raised.budget.name, raised.usedPct.value, raised.level], [20, 'Api', 45, 'ok']);
    assert.equal(h.spend.alerts().length, 0);
    h.clock.t = at(13);
    h.seed.turn({ atMs: at(13), session: 'S1', costUsd: 8 });
    assert.deepEqual(h.told.slice(1).map((x) => (x.kind === 'budget' ? x.summary : '')), ['Api: 85 %']);
    // Renaming alone does not repeat an alert.
    await h.spend.updateBudget(a.budget.id, { name: 'API' });
    assert.equal(h.told.length, 2);

    const second = await h.spend.createBudget({ scope: { kind: 'claude', id: 'c1' }, period: 'month', limitTokens: 5_000_000 });
    assert.deepEqual([second.scopeLabel, second.budget.mode, second.limiting], ['Kresna · api', 'alert', 'tokens']);
    assert.deepEqual(h.spend.budgets().budgets.map((s) => s.budget.id), [a.budget.id, second.budget.id]);
    assert.deepEqual(h.spend.budgets().thresholds, { warn: 80, critical: 95 });

    // Refusals name the field. Nothing is stored for them.
    const ghost = await fails(() => h.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/ghost' }, period: 'day', limitUsd: 1 }), 'VALIDATION_FAILED', 422);
    assert.ok(ghost.details && 'scope' in ghost.details);
    await fails(() => h.spend.createBudget({ scope: { kind: 'claude', id: 'nobody' }, period: 'day', limitUsd: 1 }), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.createBudget({ scope: { kind: 'all' }, period: 'day' }), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.updateBudget(a.budget.id, { period: 'week' }), 'VALIDATION_FAILED', 422);
    assert.equal(h.spend.budgets().budgets.length, 2);

    assert.deepEqual(h.spend.deleteBudget(second.budget.id), { id: second.budget.id });
    await fails(() => h.spend.deleteBudget(second.budget.id), 'NOT_FOUND', 404);
    await fails(() => h.spend.updateBudget(second.budget.id, { limitUsd: 2 }), 'NOT_FOUND', 404);
    assert.throws(() => h.spend.budget(second.budget.id), /No such budget/);
    assert.equal(h.spend.budgets().budgets.length, 1);
  } finally {
    h.done();
  }
});

test('at most 50 budgets', async () => {
  const h = await spendHarness();
  try {
    for (let i = 0; i < 50; i++) await h.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 1 + i });
    await fails(() => h.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 99 }), 'CONFLICT', 409);
  } finally {
    h.done();
  }
});

test('burst: 20 finished requests by one session in 10 minutes is one event, then quiet for an hour; a snooze records the next one without an alert', async () => {
  const h = await spendHarness();
  try {
    const turn = (i: number, atMs: number) => {
      h.clock.t = atMs;
      h.seed.turn({ atMs, session: 'S', costUsd: 0.02 });
      return i;
    };
    // 19 requests 30 seconds apart: nothing. The 20th, 9.5 minutes after the first, is the burst (20 in the window, the limit being 20).
    const t0 = at(10, 0);
    for (let i = 0; i < 19; i++) turn(i, t0 + i * 30_000);
    assert.equal(h.spend.spikes('1d').events.length, 0);
    turn(19, t0 + 19 * 30_000);
    const [first] = h.spend.spikes('1d').events;
    assert.deepEqual(
      [first!.kind, first!.sessionId, first!.alerted, first!.heuristic, first!.subject, first!.summary, first!.workspaceName],
      ['burst', 'S', true, true, 'S', '20 requests in 10 min (limit 20)', 'api'],
    );
    assert.deepEqual(first!.evidence, { kind: 'burst', requests: 20, windowMin: 10, threshold: 20, spentUsd: { value: 0.4, basis: 'estimate' } });
    assert.deepEqual(h.told.map((a) => (a.kind === 'spike' ? [a.spikeKind, a.sessionId, a.heuristic, a.summary] : null)), [['burst', 'S', true, '20 requests in 10 min (limit 20)']]);
    // The alert names what it is about (a session, for a loop), carries a stable id and a level, and nothing secret: ids, numbers and one line.
    assert.deepEqual(h.told[0], {
      kind: 'spike',
      id: `spike|${first!.id}`,
      at: new Date(t0 + 19 * 30_000).toISOString(),
      level: 'near',
      scope: { kind: 'session', id: 'S', label: null },
      owner: 'u_owner',
      summary: '20 requests in 10 min (limit 20)',
      spikeId: first!.id,
      spikeKind: 'burst',
      sessionId: 'S',
      rootSessionId: 'S',
      claudeId: 'c1',
      workspaceId: 'docker/api',
      heuristic: true,
    });
    // The 21st, 30 seconds later, is still inside the hour: no second event.
    turn(20, t0 + 20 * 30_000);
    assert.equal(h.spend.spikes('1d').events.length, 1);

    // Snoozed for the session: an hour later another burst is recorded, but nothing is told and it is not in the alerts.
    h.clock.t = t0 + 70 * MIN;
    const snoozed = h.spend.snoozeSpikes('S', '1h');
    assert.equal(snoozed.events[0]!.snoozedUntil, new Date(t0 + 130 * MIN).toISOString());
    const t1 = t0 + 75 * MIN;
    for (let i = 0; i < 20; i++) turn(i, t1 + i * 10_000);
    const events = h.spend.spikes('1d').events;
    assert.deepEqual(events.map((e) => [e.kind, e.alerted]), [['burst', false], ['burst', true]], 'newest first');
    assert.equal(h.told.length, 1, 'no second alert');
    assert.equal(h.spend.alerts().length, 0, 'the earlier alert is hidden while its session is snoozed');
    // Ending the snooze lists the first event again (its alert was told); the second was never alerted.
    h.spend.unsnoozeSpikes('S');
    assert.deepEqual(h.spend.alerts().map((a) => (a.kind === 'spike' ? [a.spikeKind, a.summary] : null)), [['burst', '20 requests in 10 min (limit 20)']]);
  } finally {
    h.done();
  }
});

test('a request far above the median, and a quarter hour far above the usual, are both found, each with its evidence', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    // History for the Claude over the days before: 20 requests of $0.10, $0.20 ... $2.00, one an hour apart (so each is its own active
    // 15-minute period). Their median is (1.00 + 1.10) / 2 = $1.05; their 90th percentile (the 18th of 20) is $1.80.
    for (let i = 1; i <= 20; i++) h.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i / 10 });
    h.clock.t = NOW;
    h.seed.session('S', { claudeId: 'c1', title: 'Big one' });
    h.seed.turn({ atMs: NOW, session: 'S', costUsd: 11 });
    // $11 against a median of $1.05 is 10.48 x (the line is 10 x); against the 90th percentile $1.80 it is 6.11 x (the line is 3 x).
    const events = h.spend.spikes('1d').events;
    assert.deepEqual(events.map((e) => e.kind), ['rate', 'outlier'], 'newest first: the rate rule ran last');
    const [rate, outlier] = events as [(typeof events)[number], (typeof events)[number]];
    assert.deepEqual(rate.evidence, {
      kind: 'rate',
      windowMin: 15,
      spentUsd: { value: 11, basis: 'estimate' },
      baselineUsd: { value: 1.8, basis: 'estimate' },
      factor: { value: 6.111111, basis: 'estimate' },
      periods: 20,
      topSession: { sessionId: 'S', share: 100 },
    });
    assert.deepEqual([rate.subject, rate.sessionId, rate.sessionTitle, rate.claudeName, rate.summary], ['c1', 'S', 'Big one', 'Kresna', '$11 in 15 min, 6.1x the usual']);
    assert.deepEqual(outlier.evidence, {
      kind: 'outlier',
      costUsd: { value: 11, basis: 'estimate' },
      medianUsd: { value: 1.05, basis: 'estimate' },
      factor: { value: 10.47619, basis: 'estimate' },
      requests: 20,
    });
    assert.deepEqual([outlier.subject, outlier.summary], ['S', 'A $11 request, 10x the median']);
    assert.deepEqual(h.told.map((a) => (a.kind === 'spike' ? a.spikeKind : null)), ['outlier', 'rate']);
    assert.deepEqual(h.told.map((a) => a.scope), [{ kind: 'session', id: 'S', label: null }, { kind: 'claude', id: 'c1', label: 'Kresna' }], 'a rate spike is about a Claude, a single request about a session');
    assert.deepEqual(h.told.map((a) => a.id), [`spike|${outlier.id}`, `spike|${rate.id}`]);
    // A second big request a minute later: the rate rule is in its half hour, the outlier rule in its five minutes.
    h.clock.t = NOW + MIN;
    h.seed.turn({ atMs: NOW + MIN, session: 'S', costUsd: 11 });
    assert.equal(h.spend.spikes('1d').events.length, 2);
  } finally {
    h.done();
  }
});

test('a row marked suspect (T-610: a running total booked as one request) is in no sum, no baseline and no spike, and stays in the table', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    for (let i = 1; i <= 20; i++) h.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i / 10 });
    h.clock.t = NOW;
    h.seed.session('S', { claudeId: 'c1', title: 'Big one' });
    // A $96.31 "request" that was a carried total, marked suspect: the row is written, the module is told, and nothing trips.
    h.seed.usage({ atMs: NOW, session: 'S', costUsd: 96.31, kind: 'suspect' });
    h.spend.onTurn({ sessionId: 'S', workspaceId: 'docker/api', claudeId: 'c1', atMs: NOW }, [{ costUsd: 0 }]);
    assert.equal(h.spend.spikes('1d').events.length, 0);
    assert.equal(h.spend.attribution({ by: 'session', range: '1d' }).totals.costUsd, 0, 'attribution leaves it out');
    const spendStore = new SpendStore(h.store);
    assert.equal(spendStore.requestCosts('c1', NOW - 3 * DAY, NOW + MIN).length, 20, 'and so does the baseline of requests');
    assert.equal(spendStore.usageRows(NOW - DAY, NOW + MIN).length, 0, 'and the rows the scorecard reads');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM chat_usage WHERE kind = ?').get('suspect') as { n: number }).n, 1, 'the row is kept as evidence');
  } finally {
    h.done();
  }
});

// T-312: the orchestrator's chain split on 2026-10-13 (attribution.test.ts has the same ids): O1 fe3df8bc -> O2 fdb140be -> O3 5c9fcb5f.
const chainId = (prefix: string) => `${prefix}-0000-4000-8000-${prefix}0000`;
const [O1, O2, O3, K1] = [chainId('fe3df8bc'), chainId('fdb140be'), chainId('5c9fcb5f'), chainId('541948a5')];

test('a chat continued as new rows is one spike subject under its first row: a loop across the rows, one snooze for all of them (T-312)', async () => {
  const h = await spendHarness();
  try {
    h.seed.session(O1, { claudeId: 'c1', title: 'Orchestrator' });
    h.seed.session(O2, { claudeId: 'c1', title: 'Orchestrator', continuedFrom: O1 });
    h.seed.session(O3, { claudeId: 'c1', title: 'Orchestrator', continuedFrom: O2 });
    const turn = (session: string, atMs: number) => {
      h.clock.t = atMs;
      h.seed.turn({ atMs, session, costUsd: 0.02 });
    };
    // A loop of 20 requests 30 seconds apart, 10 in O2, then the chat is continued and 10 more in O3: 20 in 9.5 minutes, the limit being 20.
    // Per row it is 10 and 10, under the limit: without the chain nothing is said.
    const t0 = at(10, 0);
    for (let i = 0; i < 20; i++) turn(i < 10 ? O2 : O3, t0 + i * 30_000);
    const events = h.spend.spikes('1d').events;
    assert.deepEqual(
      events.map((e) => [e.kind, e.subject, e.sessionId, e.evidence.kind === 'burst' ? e.evidence.requests : null]),
      [['burst', O1, O3, 20]],
      'one event, under the first row; it names the row it happened in',
    );
    assert.deepEqual(h.told.map((a) => (a.kind === 'spike' ? [a.sessionId, a.rootSessionId, a.scope.id] : null)), [[O3, O1, O3]]);
    // Snoozed under the first row: an hour later a loop in O3 alone is recorded, under O1, without an alert.
    h.clock.t = t0 + 70 * MIN;
    h.spend.snoozeSpikes(O1, '1h');
    for (let i = 0; i < 20; i++) turn(O3, t0 + 75 * MIN + i * 10_000);
    assert.deepEqual(h.spend.spikes('1d').events.map((e) => [e.subject, e.alerted]), [[O1, false], [O1, true]]);
    assert.equal(h.told.length, 1, 'the snooze of the chain mutes its later row');
  } finally {
    h.done();
  }
});

test('a rate spike names the chat that spent most of it, its continued rows summed under the first one (T-312)', async () => {
  // The request rule out of the way; the rate baseline as above: 20 hourly requests of $0.10 to $2.00, P90 $1.80, so the line is $5.40.
  const h = await spendHarness({ settings: { 'usage.spikes.outlierFactor': 1000 } });
  try {
    for (let i = 1; i <= 20; i++) h.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i / 10 });
    h.seed.session(O1, { claudeId: 'c1', title: 'Orchestrator' });
    h.seed.session(O2, { claudeId: 'c1', title: 'Orchestrator', continuedFrom: O1 });
    h.seed.session(O3, { claudeId: 'c1', title: 'Orchestrator', continuedFrom: O2 });
    h.seed.session(K1, { claudeId: 'c1', title: 'Konfersi' });
    // In the last 15 minutes: O2 $3, Konfersi $4, O3 $3 = $10. No row has half of it (40 % at most); the orchestrator's chain has 60 %.
    h.seed.usage({ atMs: NOW - 2 * MIN, session: O2, costUsd: 3 });
    h.seed.usage({ atMs: NOW - 90_000, session: K1, costUsd: 4 });
    h.clock.t = NOW;
    h.seed.turn({ atMs: NOW, session: O3, costUsd: 3 });
    const [e] = h.spend.spikes('1d').events;
    assert.equal(e!.kind, 'rate');
    assert.deepEqual(e!.evidence.kind === 'rate' ? e!.evidence.topSession : 'not rate', { sessionId: O1, share: 60 });
    assert.deepEqual([e!.subject, e!.sessionId, e!.sessionTitle], ['c1', O1, 'Orchestrator']);
    assert.deepEqual(h.told.map((a) => (a.kind === 'spike' ? [a.scope.kind, a.sessionId, a.rootSessionId] : null)), [['claude', O1, O1]]);
  } finally {
    h.done();
  }
});

test('just under the lines nothing is said, and with too little history nothing can be: no events, never a guess', async () => {
  // Rate: ten active periods of $1 to $10 (P90 = $9, so the line is $27) and the request rule out of the way.
  const under = await spendHarness({ settings: { 'usage.spikes.outlierFactor': 1000 } });
  try {
    for (let i = 1; i <= 10; i++) under.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i });
    under.clock.t = NOW;
    under.seed.turn({ atMs: NOW, session: 'S', costUsd: 26.5 });
    assert.equal(under.spend.spikes('1d').events.length, 0, '$26.50 is under the $27 line');
  } finally {
    under.done();
  }
  const over = await spendHarness({ settings: { 'usage.spikes.outlierFactor': 1000 } });
  try {
    for (let i = 1; i <= 10; i++) over.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i });
    over.clock.t = NOW;
    over.seed.turn({ atMs: NOW, session: 'S', costUsd: 30 });
    const [e] = over.spend.spikes('1d').events;
    assert.equal(e!.kind, 'rate');
    assert.deepEqual([e!.evidence.kind === 'rate' && e!.evidence.baselineUsd.value, e!.evidence.kind === 'rate' && e!.evidence.factor.value], [9, 3.333333]);
  } finally {
    over.done();
  }
  // Seven earlier active periods is not enough for a baseline, and 19 earlier requests is not enough for a median.
  const thin = await spendHarness();
  try {
    for (let i = 1; i <= 7; i++) thin.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i });
    thin.clock.t = NOW;
    thin.seed.turn({ atMs: NOW, session: 'S', costUsd: 500 });
    assert.equal(thin.spend.spikes('1d').events.length, 0);
  } finally {
    thin.done();
  }
  // Switched off in Settings: nothing is looked for.
  const off = await spendHarness({ settings: { 'usage.spikes.enabled': false } });
  try {
    for (let i = 1; i <= 20; i++) off.seed.usage({ atMs: NOW - 2 * DAY + i * HOUR, session: 'OLD', costUsd: i / 10 });
    off.clock.t = NOW;
    off.seed.turn({ atMs: NOW, session: 'S', costUsd: 11 });
    assert.equal(off.spend.spikes('1d').events.length, 0);
    assert.equal(off.spend.spikes('1d').settings.enabled, false);
  } finally {
    off.done();
  }
});

test('the spike report: ranges, the thresholds in force, bad input; events older than a range are left out', async () => {
  const h = await spendHarness({ settings: { 'usage.spikes.burstRequests': 3, 'usage.spikes.rateFactor': 100 } });
  try {
    for (let i = 0; i < 3; i++) h.seed.turn({ atMs: NOW - 2 * DAY + i * MIN, session: 'S', costUsd: 0.01 });
    h.clock.t = NOW;
    for (let i = 0; i < 3; i++) h.seed.turn({ atMs: NOW - 3 * MIN + i * MIN, session: 'T', costUsd: 0.01 });
    assert.deepEqual(h.spend.spikes('1d').events.map((e) => e.subject), ['T']);
    assert.deepEqual(h.spend.spikes('7d').events.map((e) => e.subject), ['T', 'S']);
    assert.deepEqual(h.spend.spikes('30d').settings, { enabled: true, rateFactor: 100, burstRequests: 3, burstWindowMin: 10, outlierFactor: 10, minUsd: 0.5 });
    assert.equal(h.spend.spikes().range, '7d', 'a week by default');
    await fails(() => h.spend.spikes('1y'), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.snoozeSpikes('', '1h'), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.snoozeSpikes('S', 'forever'), 'VALIDATION_FAILED', 422);
    // Settings out of range fall back to their defaults rather than disabling a rule.
    h.values['usage.spikes.burstRequests'] = 1;
    assert.equal(h.spend.spikes('1d').settings.burstRequests, 20);
  } finally {
    h.done();
  }
});

test('persona: recorded when a process starts and only when it changed; nothing is recorded when it cannot be told', async () => {
  let assigned: { id: string; name: string; revision: number } | null = { id: 'p1', name: 'Dev', revision: 3 };
  let boom = false;
  const h = await spendHarness({
    personaOf: () => {
      if (boom) throw new Error('pools unavailable');
      return assigned;
    },
  });
  try {
    const launch = (atMs: number) => {
      h.clock.t = atMs;
      h.spend.onLaunch({ sessionId: 'S', workspaceId: 'docker/api' });
    };
    launch(at(9));
    launch(at(10)); // the same persona again: no new row
    assigned = { id: 'p2', name: 'Ops', revision: 1 };
    launch(at(11));
    assigned = { id: 'p2', name: 'Ops renamed', revision: 2 }; // a new revision or name of the same persona is not a change of persona
    launch(at(12));
    assigned = null;
    launch(at(13));
    boom = true;
    launch(at(14)); // can't tell: nothing is recorded, not "none"
    assert.deepEqual(h.store.db!.prepare('SELECT at_ms, persona_id, persona_name, revision FROM usage_persona WHERE session_id = ? ORDER BY at_ms').all('S').map((r) => ({ ...r })), [
      { at_ms: at(9), persona_id: 'p1', persona_name: 'Dev', revision: 3 },
      { at_ms: at(11), persona_id: 'p2', persona_name: 'Ops', revision: 1 },
      { at_ms: at(13), persona_id: null, persona_name: null, revision: null },
    ]);
    assert.equal(h.logs.length, 0, 'a throwing persona lookup is expected and quiet');
  } finally {
    h.done();
  }
  // Without a persona module wired, nothing is ever recorded.
  const bare = await spendHarness();
  try {
    bare.spend.onLaunch({ sessionId: 'S', workspaceId: 'docker/api' });
    assert.equal((bare.store.db!.prepare('SELECT COUNT(*) AS n FROM usage_persona').get() as { n: number }).n, 0);
  } finally {
    bare.done();
  }
});

test('attribution from the database: children roll up into their parent, even after the child is deleted; a request without a Claude counts under the Default one', async () => {
  const h = await spendHarness({ personaName: (id) => (id === 'p1' ? 'Dev (now)' : null) });
  try {
    h.seed.claude('d1', 'docker/api', 'Default', ''); // the workspace's Default Claude
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.seed.claude('c2', 'docker/web', 'Satria');
    h.seed.session('S1', { workspaceId: 'docker/api', claudeId: 'd1', ticketId: 'T-1', title: 'Parent' });
    h.seed.session('S2', { workspaceId: 'docker/api', claudeId: 'c1', parentId: 'S1', title: 'Child' });
    h.seed.session('S3', { workspaceId: 'docker/web', claudeId: 'c2', title: 'Solo' });
    h.clock.t = NOW;
    // The window (1d): S1 $1.00 (recorded without a Claude, as before Claudes) and $0.50 (on Default), S2 $2.00 (a turn the module was told of, so
    // its title and parent are kept), S3 $4.00. And $9.00 two days ago, outside the window.
    h.seed.usage({ atMs: NOW - 2 * HOUR, session: 'S1', claude: '', costUsd: 1, input: 100 });
    h.seed.usage({ atMs: NOW - HOUR, session: 'S1', claude: 'd1', costUsd: 0.5, input: 50 });
    h.seed.turn({ atMs: NOW - 90 * MIN, session: 'S2', claude: 'c1', costUsd: 2, input: 200 });
    h.seed.usage({ atMs: NOW - 30 * MIN, session: 'S3', workspace: 'docker/web', claude: 'c2', costUsd: 4, input: 400 });
    h.seed.usage({ atMs: NOW - 2 * DAY, session: 'S1', claude: 'd1', costUsd: 9 });

    const run = () => h.spend.attribution({ by: 'session', range: '1d' });
    const tree = run();
    assert.deepEqual(tree.totals, { costUsd: 7.5, input: 750, output: 0, cacheRead: 0, cacheWrite: 0, requests: 4, agents: 0 });
    assert.deepEqual(tree.rows.map((r) => [r.key, r.label, r.session!.depth, r.own.costUsd, r.total.costUsd]), [
      ['S3', 'Solo', 0, 4, 4],
      ['S1', 'Parent', 0, 1.5, 3.5],
      ['S2', 'Child', 1, 2, 2],
    ]);
    assert.deepEqual([tree.from, tree.to, tree.range, tree.coverage], [new Date(NOW - DAY).toISOString(), new Date(NOW).toISOString(), '1d', { value: 100, basis: 'estimate' }]);

    // Delete the child: its requests stay, its title and parent were kept, so the parent still holds its cost.
    h.seed.deleteSession('S2');
    const after = run();
    assert.deepEqual(after.rows.map((r) => [r.key, r.total.costUsd, r.session!.exists, r.session!.title, r.session!.parentId]), [
      ['S3', 4, true, 'Solo', null],
      ['S1', 3.5, true, 'Parent', null],
      ['S2', 2, false, 'Child', 'S1'],
    ]);

    // By Claude: S1's request with no Claude is under the workspace's Default (d1), whose name is "Default": d1 $1.50, c1 $2.00, c2 $4.00.
    const byClaude = h.spend.attribution({ by: 'claude', range: '1d' });
    assert.deepEqual(byClaude.rows.map((r) => [r.key, r.label, r.total.costUsd]), [
      ['c2', 'Satria', 4],
      ['c1', 'Kresna', 2],
      ['d1', 'Default', 1.5],
    ]);
    // By ticket: S1 has T-1 and so does its (deleted) child by inheritance: $3.50; S3 has none: $4.00.
    assert.deepEqual(h.spend.attribution({ by: 'ticket', range: '1d' }).rows.map((r) => [r.key, r.state, r.total.costUsd]), [
      ['T-1', 'known', 3.5],
      ['', 'none', 4],
    ]);
    assert.deepEqual(h.spend.attribution({ by: 'workspace', range: '1d' }).rows.map((r) => [r.label, r.total.costUsd]), [['web', 4], ['api', 3.5]]);

    // Filters: one Claude (the Default one, counting the request recorded without one), one workspace, one session's tree (nothing above it).
    assert.equal(h.spend.attribution({ by: 'session', range: '1d', claudeId: 'd1' }).totals.costUsd, 1.5);
    assert.equal(h.spend.attribution({ by: 'session', range: '1d', workspaceId: 'docker/web' }).totals.costUsd, 4);
    const own = h.spend.attribution({ by: 'session', range: '1d', sessionId: 'S1' });
    assert.deepEqual(own.rows.map((r) => [r.key, r.session!.depth, r.total.costUsd]), [['S1', 0, 3.5], ['S2', 1, 2]]);
    assert.equal(own.totals.costUsd, 3.5);

    // Persona: recorded for S1 only (from 3 hours ago, "Dev"); everything else was not recorded, and the coverage says how much that is.
    h.store.db!.prepare('INSERT INTO usage_persona (session_id, at_ms, persona_id, persona_name, revision) VALUES (?, ?, ?, ?, ?)').run('S1', NOW - 3 * HOUR, 'p1', 'Dev', 1);
    const personas = h.spend.attribution({ by: 'persona', range: '1d' });
    assert.deepEqual(personas.rows.map((r) => [r.key, r.label, r.state, r.total.costUsd, r.reason ?? null]), [
      ['p1', 'Dev (now)', 'known', 1.5, null],
      ['', 'Not recorded', 'unknown', 6, 'not_recorded'],
    ]);
    assert.equal(personas.coverage.value, 20, '1.50 of 7.50');

    // A shorter range leaves the older requests out: the last hour holds S1's $0.50 and S3's $4.00.
    assert.equal(h.spend.attribution({ by: 'workspace', range: '1h' }).totals.costUsd, 4.5);
    await fails(() => h.spend.attribution({ by: 'team' }), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.attribution({ range: '1y' }), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.attribution({ limit: 0 }), 'VALIDATION_FAILED', 422);
    await fails(() => h.spend.attribution({ limit: 201 }), 'VALIDATION_FAILED', 422);
    assert.equal(h.spend.attribution({}).by, 'session', 'a session tree over 7 days by default');
  } finally {
    h.done();
  }
});

test('attribution from the database follows continued_from: a chat split over rows is one unit under its first row, even one with no request in the window (T-312)', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    // A (ticket T-7) ended and was continued by B, B by C; C started a worker WK. A's only request is two days old, outside the 1d window.
    h.seed.session('A', { claudeId: 'c1', ticketId: 'T-7', title: 'Orchestrator' });
    h.seed.session('B', { claudeId: 'c1', title: 'Orchestrator', continuedFrom: 'A' });
    h.seed.session('C', { claudeId: 'c1', title: 'Orchestrator', continuedFrom: 'B' });
    h.seed.session('WK', { claudeId: 'c1', title: 'Worker', parentId: 'C' });
    h.clock.t = NOW;
    h.seed.usage({ atMs: NOW - 2 * DAY, session: 'A', costUsd: 9 });
    h.seed.usage({ atMs: NOW - 3 * HOUR, session: 'B', costUsd: 1 });
    h.seed.usage({ atMs: NOW - 2 * HOUR, session: 'C', costUsd: 2 });
    h.seed.usage({ atMs: NOW - HOUR, session: 'WK', costUsd: 0.5 });

    const tree = h.spend.attribution({ by: 'session', range: '1d' });
    assert.deepEqual(tree.rows.map((r) => [r.key, r.session!.depth, r.own.costUsd, r.total.costUsd, r.session!.continuedFrom]), [
      ['A', 0, 0, 3.5, null],
      ['C', 1, 2, 2.5, 'B'],
      ['WK', 2, 0.5, 0.5, null],
      ['B', 1, 1, 1, 'A'],
    ]);
    assert.equal(tree.totals.costUsd, 3.5);
    assert.deepEqual(h.spend.attribution({ by: 'ticket', range: '1d' }).rows.map((r) => [r.key, r.total.costUsd]), [['T-7', 3.5]], 'the chain’s ticket, not "No ticket"');

    // A session's own view starts at itself: nothing it continues is shown above it.
    const own = h.spend.attribution({ by: 'session', range: '1d', sessionId: 'C' });
    assert.deepEqual(own.rows.map((r) => [r.key, r.session!.depth, r.total.costUsd]), [['C', 0, 2.5], ['WK', 1, 0.5]]);
  } finally {
    h.done();
  }
});

test('a session’s title and links are kept from its latest request', async () => {
  const h = await spendHarness();
  try {
    h.seed.session('S1', { title: 'First', ticketId: 'T-5' });
    h.clock.t = NOW;
    h.seed.turn({ atMs: NOW - HOUR, session: 'S1', costUsd: 1 });
    h.store.db!.prepare("UPDATE chat_sessions SET title = 'Renamed', ticket_id = 'T-6' WHERE id = 'S1'").run();
    h.seed.turn({ atMs: NOW - MIN, session: 'S1', costUsd: 1 });
    assert.deepEqual({ ...h.store.db!.prepare('SELECT title, ticket_id, first_at_ms, last_at_ms FROM usage_sessions WHERE session_id = ?').get('S1') }, { title: 'Renamed', ticket_id: 'T-6', first_at_ms: NOW - HOUR, last_at_ms: NOW - MIN });
  } finally {
    h.done();
  }
});

test('the module never throws into the chat: a failure is logged once, and a store that cannot save records nothing', async () => {
  const h = await spendHarness();
  try {
    h.spend.onTurn({ sessionId: 'S', workspaceId: 'docker/api', claudeId: 'c1', atMs: NOW }, null as never);
    h.spend.onTurn({ sessionId: 'S', workspaceId: 'docker/api', claudeId: 'c1', atMs: NOW }, null as never);
    assert.equal(h.logs.length, 1, 'once');
    assert.match(h.logs[0]!, /a recorded request failed/);
    assert.equal(h.spend.gate({ sessionId: 'S', workspaceId: 'docker/api', claudeId: 'c1' }), null, 'no budget, no refusal');
  } finally {
    h.done();
  }
  const closed = await spendHarness();
  closed.store.close();
  closed.spend.onTurn({ sessionId: 'S', workspaceId: 'docker/api', claudeId: 'c1', atMs: NOW }, [{ costUsd: 1 }]);
  closed.spend.onLaunch({ sessionId: 'S', workspaceId: 'docker/api' });
  assert.equal(closed.spend.gate({ sessionId: 'S', workspaceId: 'docker/api', claudeId: 'c1' }), null);
  assert.deepEqual(closed.spend.budgets().budgets, [], 'a store that cannot be read reads as nothing');
  await fails(() => closed.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 1 }), 'SERVICE_UNAVAILABLE', 503);
  closed.done();
});

test('a budget on a Default Claude counts the requests recorded without a Claude, and a session recorded without one is gated by it', async () => {
  const h = await spendHarness();
  try {
    h.seed.claude('d1', 'docker/api', 'Default', '');
    h.clock.t = at(9);
    const b = await h.spend.createBudget({ scope: { kind: 'claude', id: 'd1' }, period: 'day', limitUsd: 2, mode: 'pause' });
    assert.equal(b.scopeLabel, 'Default · api');
    h.clock.t = at(10);
    h.seed.turn({ atMs: at(10), session: 'S1', claude: '', costUsd: 2 }); // recorded before Claudes existed: no Claude id
    assert.equal(h.spend.budget(b.budget.id).usedUsd.value, 2);
    assert.ok(h.spend.gate({ sessionId: 'S1', workspaceId: 'docker/api', claudeId: null }), 'a legacy session has no Claude id: it is the Default one');
    assert.ok(h.spend.gate({ sessionId: 'S1', workspaceId: 'docker/api', claudeId: '' }));
    assert.equal(h.spend.gate({ sessionId: 'S7', workspaceId: 'docker/web', claudeId: null }), null, 'another workspace’s Default Claude is another Claude');
    // A workspace whose Default Claude is gone: its requests are under "default:<workspace>", which a budget can name too.
    const orphan = await h.spend.createBudget({ scope: { kind: 'claude', id: 'default:docker/web' }, period: 'day', limitUsd: 1 });
    h.seed.usage({ atMs: at(10, 30), session: 'S7', workspace: 'docker/web', claude: '', costUsd: 0.5 });
    h.clock.t = at(11);
    assert.deepEqual([orphan.scopeLabel, h.spend.budget(orphan.budget.id).usedUsd.value], ['Default · web', 0.5]);
  } finally {
    h.done();
  }
});

test('migration 180 keeps the sessions that already have requests, with their links, so they survive a delete from the start', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ub-mig-'));
  try {
    const key = parseSecretKey(generateSecretKey());
    const before = await Store.open({ dataDir, secretKey: key, migrations: MIGRATIONS.filter((m) => m.version < 180) });
    const db = before.db!;
    const t = new Date(NOW).toISOString();
    const session = db.prepare('INSERT INTO chat_sessions (id, workspace_id, title, state_since, created_at, last_activity_at, claude_id, parent_id, ticket_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    session.run('P', 'docker/api', 'Parent', t, t, t, 'c1', null, 'T-1');
    session.run('K', 'docker/api', 'Kid', t, t, t, 'c1', 'P', null);
    session.run('Q', 'docker/api', 'Quiet', t, t, t, 'c1', null, null); // no requests: not kept
    const usage = db.prepare('INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, cost_usd, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    usage.run(t, NOW - 2 * HOUR, 'K', 'docker/api', 'c1', 'm', 1, 1);
    usage.run(t, NOW - HOUR, 'K', 'docker/api', 'c1', 'm', 1, 1);
    usage.run(t, NOW - HOUR, 'P', 'docker/api', 'c1', 'm', 1, 1);
    usage.run(t, NOW - 3 * HOUR, 'GONE', 'docker/api', 'c1', 'm', 1, 1); // its session was deleted before: nothing to keep
    before.close();
    const after = await Store.open({ dataDir, secretKey: key });
    const kept = after.db!.prepare('SELECT session_id, parent_id, ticket_id, title, first_at_ms, last_at_ms FROM usage_sessions ORDER BY session_id').all().map((r) => ({ ...r }));
    assert.deepEqual(kept, [
      { session_id: 'K', parent_id: 'P', ticket_id: null, title: 'Kid', first_at_ms: NOW - 2 * HOUR, last_at_ms: NOW - HOUR },
      { session_id: 'P', parent_id: null, ticket_id: 'T-1', title: 'Parent', first_at_ms: NOW - HOUR, last_at_ms: NOW - HOUR },
    ]);
    after.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a budget has an owner, its alert carries it and where it is about, and what a person changes is audited with who and how', async () => {
  const h = await spendHarness({ settings: { 'usage.spikes.burstRequests': 3 } });
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.clock.t = at(9);
    const alice = { actorId: 'u_alice', via: 'ui' };
    const b = await h.spend.createBudget({ scope: { kind: 'claude', id: 'c1' }, period: 'day', limitUsd: 10 }, alice);
    assert.equal(b.budget.createdBy, 'u_alice');
    const mine = await h.spend.createBudget({ scope: { kind: 'all' }, period: 'month', limitUsd: 100 });
    assert.equal(mine.budget.createdBy, 'u_owner', 'the single owner is the default');

    // $9 of $10 on c1: the alert is for alice, and names the workspace and the Claude it is about, for routing.
    h.clock.t = at(10);
    h.seed.turn({ atMs: at(10), session: 'S1', costUsd: 9 });
    const [a] = h.told;
    assert.deepEqual(a && a.kind === 'budget' ? [a.owner, a.workspaceId, a.scope, a.budgetId] : null, ['u_alice', 'docker/api', { kind: 'claude', id: 'c1', label: 'Kresna · api' }, b.budget.id]);
    assert.deepEqual(h.spend.alerts().map((x) => x.owner), ['u_alice']);
    // A budget on everything has no workspace; a workspace's own budget names it.
    assert.equal(h.spend.budgets().budgets.length, 2);

    // A loop is a spike: its alert and its event say who they are for (today the owner) and where.
    for (let i = 0; i < 3; i++) h.seed.turn({ atMs: at(11) + i * 10_000, session: 'S2', costUsd: 0.01 });
    const spike = h.told.find((x) => x.kind === 'spike');
    assert.deepEqual(spike && spike.kind === 'spike' ? [spike.owner, spike.workspaceId, spike.claudeId, spike.scope] : null, ['u_owner', 'docker/api', 'c1', { kind: 'session', id: 'S2', label: null }]);
    assert.equal(h.spend.spikes('1d').events[0]!.owner, 'u_owner');

    // Changes keep their creator and are audited: who, how, what was done. Newest first.
    const bob = { actorId: 'u_bob', via: 'portal-mcp:t1' };
    await h.spend.updateBudget(b.budget.id, { limitUsd: 20 }, bob);
    assert.equal(h.spend.budget(b.budget.id).budget.createdBy, 'u_alice', 'an update does not change who made it');
    h.spend.snoozeBudget(b.budget.id, '1h', alice);
    h.spend.unsnoozeBudget(b.budget.id, alice);
    h.spend.deleteBudget(mine.budget.id);
    h.spend.snoozeSpikes('S2', '1h');
    h.spend.unsnoozeSpikes('S2', alice);
    assert.deepEqual(h.spend.audit().map((e) => [e.actor, e.via, e.action, e.objectKind, e.summary]), [
      ['u_alice', 'ui', 'spike.unsnooze', 'spike_subject', 'spike alerts for S2 no longer snoozed'],
      ['u_owner', 'ui', 'spike.snooze', 'spike_subject', 'spike alerts for S2 snoozed for 1h'],
      ['u_owner', 'ui', 'budget.delete', 'budget', 'monthly budget for Everything, $100'],
      ['u_alice', 'ui', 'budget.unsnooze', 'budget', 'snooze ended: daily budget for Kresna · api, $20'],
      ['u_alice', 'ui', 'budget.snooze', 'budget', 'snoozed for 1h: daily budget for Kresna · api, $20'],
      ['u_bob', 'portal-mcp:t1', 'budget.update', 'budget', 'daily budget for Kresna · api, $20'],
      ['u_owner', 'ui', 'budget.create', 'budget', 'monthly budget for Everything, $100'],
      ['u_alice', 'ui', 'budget.create', 'budget', 'daily budget for Kresna · api, $10'],
    ]);
    assert.equal(h.spend.audit(2).length, 2);
    assert.ok(h.spend.audit()[0]!.at.startsWith('2026-10-12T'), 'with its time');
    assert.throws(() => h.spend.audit(0), /whole number from 1 to 200/);
    assert.throws(() => h.spend.audit(201), /whole number from 1 to 200/);
    assert.ok(!/\$\d+\.\d|used/.test(JSON.stringify(h.spend.audit())), 'no usage amounts, only what was set and done');
  } finally {
    h.done();
  }
});

test('the visibility seam: nobody is narrowed by default; a rule narrows attribution, the summary, budgets, spikes and alerts for its actor and leaves the owner whole', async () => {
  // The guest sees workspace docker/api only, and not the session HIDDEN, and no budgets.
  const rule = (actor: string, o: { kind: string; id: string }) =>
    actor === 'u_owner' || (actor === 'u_guest' && ((o.kind === 'workspace' && o.id === 'docker/api') || (o.kind === 'session' && o.id !== 'HIDDEN')));
  const h = await spendHarness({ settings: { 'usage.spikes.burstRequests': 3 }, visible: rule as never });
  const open = await spendHarness({ settings: { 'usage.spikes.burstRequests': 3 } });
  try {
    for (const x of [h, open]) {
      x.clock.t = NOW;
      x.seed.usage({ atMs: NOW - 3 * HOUR, session: 'S1', costUsd: 3 }); // docker/api, visible
      x.seed.usage({ atMs: NOW - 2 * HOUR, session: 'HIDDEN', costUsd: 1.5 }); // docker/api but a hidden session
      x.seed.usage({ atMs: NOW - HOUR, session: 'S2', workspace: 'docker/web', claude: 'c2', costUsd: 5 }); // another workspace
      for (let i = 0; i < 3; i++) x.seed.turn({ atMs: NOW - 5 * MIN + i * MIN, session: 'S1', costUsd: 0.01 }); // a loop in S1
      for (let i = 0; i < 3; i++) x.seed.turn({ atMs: NOW - 5 * MIN + i * MIN, session: 'S2', workspace: 'docker/web', claude: 'c2', costUsd: 0.01 }); // and one in S2
      await x.spend.createBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 5 });
    }
    // The owner sees all of it; so does anyone when no rule is installed.
    assert.equal(h.spend.attribution({ by: 'workspace', range: '1d' }, 'u_owner').totals.costUsd, 9.56);
    assert.equal(open.spend.attribution({ by: 'workspace', range: '1d' }, 'u_guest').totals.costUsd, 9.56, 'default-allow');
    // The guest sees what their workspace and session rules let through: S1's $3.00 and its loop's $0.03, not HIDDEN's $1.50 nor docker/web.
    const g = h.spend.attribution({ by: 'workspace', range: '1d' }, 'u_guest');
    assert.deepEqual([g.totals.costUsd, g.totals.requests, g.rows.map((r) => [r.key, r.total.costUsd])], [3.03, 4, [['docker/api', 3.03]]]);
    assert.deepEqual(h.spend.attribution({ by: 'session', range: '1d' }, 'u_guest').rows.map((r) => r.key), ['S1']);
    const sum = h.spend.summary('u_guest');
    assert.deepEqual([sum.today.costUsd, sum.today.requests, sum.month.costUsd, sum.budgets.total, sum.spikes24h], [3.03, 4, 3.03, 0, 1]);
    assert.equal(h.spend.summary('u_owner').today.costUsd, 9.56);
    // Budgets: the rule shows the guest none, so reading, changing and removing one is "no such budget".
    const id = h.spend.budgets('u_owner').budgets[0]!.budget.id;
    assert.deepEqual([h.spend.budgets('u_owner').budgets.length, h.spend.budgets('u_guest').budgets.length], [1, 0]);
    assert.throws(() => h.spend.budget(id, 'u_guest'), /No such budget/);
    await assert.rejects(h.spend.updateBudget(id, { limitUsd: 9 }, { actorId: 'u_guest', via: 'ui' }), /No such budget/);
    assert.throws(() => h.spend.deleteBudget(id, { actorId: 'u_guest', via: 'ui' }), /No such budget/);
    assert.throws(() => h.spend.snoozeBudget(id, '1h', { actorId: 'u_guest', via: 'ui' }), /No such budget/);
    assert.equal(h.spend.budget(id, 'u_owner').budget.id, id);
    // Spikes and alerts: the guest hears of S1's loop only; the owner of both.
    assert.deepEqual(h.spend.spikes('1d', 'u_guest').events.map((e) => e.subject), ['S1']);
    assert.deepEqual(h.spend.spikes('1d', 'u_owner').events.map((e) => e.subject).sort(), ['S1', 'S2']);
    assert.deepEqual(h.spend.alerts('u_guest').map((a) => a.kind), ['spike']);
    assert.deepEqual(h.spend.alerts('u_owner').map((a) => a.kind).sort(), ['budget', 'spike', 'spike']);
    assert.deepEqual(h.spend.spikesOf('S1', '1d', 'u_guest').map((e) => e.subject), ['S1']);
  } finally {
    h.done();
    open.done();
  }
  // A rule that fails hides rather than shows.
  const broken = await spendHarness({
    visible: () => {
      throw new Error('the rule broke');
    },
  });
  try {
    broken.clock.t = NOW;
    broken.seed.usage({ atMs: NOW - HOUR, session: 'S1', costUsd: 3 });
    assert.equal(broken.spend.attribution({ by: 'workspace', range: '1d' }, 'u_owner').totals.requests, 0);
    assert.equal(broken.spend.summary('u_owner').today.requests, 0);
  } finally {
    broken.done();
  }
});

test('side questions (chat PRD §20): a `kind = side` row is in the attribution totals and shown apart as `side`; told through onSideUsage, it trips a budget right then', async () => {
  const h = await spendHarness({ settings: { 'usage.spikes.rateFactor': 100, 'usage.spikes.outlierFactor': 1000 } });
  try {
    h.seed.claude('c1', 'docker/api', 'Kresna');
    h.seed.session('S1');
    h.clock.t = at(9);
    const created = await h.spend.createBudget({ scope: { kind: 'workspace', id: 'docker/api' }, period: 'day', limitUsd: 10 });
    h.seed.usage({ atMs: at(1), session: 'S1', costUsd: 7.5 });
    // A btw of $1.00 at 10:00: the row is written by the btw store, then the controller's onSideUsage (wired to onTurn like onUsage) tells the module.
    h.clock.t = at(10);
    h.seed.usage({ atMs: at(10), session: 'S1', costUsd: 1, input: 40, output: 20, kind: 'side' });
    h.spend.onTurn({ sessionId: 'S1', workspaceId: 'docker/api', claudeId: 'c1', atMs: at(10) }, [{ costUsd: 1 }]);
    assert.deepEqual(h.told.map((a) => (a.kind === 'budget' ? [a.level, a.usedPct] : null)), [['near', 85]], 'the budget heard the side question, not the next turn');
    assert.equal(h.spend.budget(created.budget.id).usedPct.value, 85);
    const report = h.spend.attribution({ by: 'session', range: '1d' });
    assert.deepEqual([report.totals.costUsd, report.totals.requests], [8.5, 2], 'the side question is a request in the total');
    assert.deepEqual(report.side, { costUsd: 1, input: 40, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1, agents: 0 });
    assert.deepEqual([report.rows[0]!.key, report.rows[0]!.total.costUsd], ['S1', 8.5], 'and inside its session’s row');
    assert.deepEqual(h.spend.attribution({ by: 'workspace', range: '1d', workspaceId: 'docker/web' }).side.requests, 0);
  } finally {
    h.done();
  }
});
