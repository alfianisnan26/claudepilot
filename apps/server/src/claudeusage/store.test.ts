import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Store } from '../store/store.js';
import { windowLevel } from './parse.js';
import { KEEP_ALL_MS, KEEP_MS, UsageStore, type LatestRow } from './store.js';
import { HOUR, MIN, NOW, usageHarness, win } from './fixtures.js';

const DAY = 24 * HOUR;
const reset = NOW + 4 * HOUR;

const row = (over: Partial<LatestRow> = {}): LatestRow => ({
  claudeId: 'c1',
  workspaceId: 'docker/ws1',
  checkedAtMs: NOW,
  lastProbeAtMs: NOW,
  runsOn: 'plan',
  plan: 'max',
  windows: [win('session', 41, reset, 'Session')],
  extra: { enabled: true, usedPct: 25, limit: 5000, used: 1250, currency: 'USD' },
  source: 'probe',
  problem: null,
  fails: 0,
  snoozedUntilMs: null,
  alerted: { session: { level: 'near', resetsAtMs: reset, atMs: NOW } },
  ...over,
});

test('the latest row round-trips, is replaced in place, and a damaged one reads as empty rather than throwing', async () => {
  const h = await usageHarness();
  try {
    const s = new UsageStore(h.store);
    assert.equal(s.latest('c1'), null);
    s.saveLatest(row());
    assert.deepEqual(s.latest('c1'), row());
    s.saveLatest(row({ plan: 'pro', windows: [], extra: null, problem: 'timeout', fails: 3, snoozedUntilMs: NOW + HOUR }));
    assert.equal(s.allLatest().length, 1, 'one row per Claude');
    assert.deepEqual([s.latest('c1')!.plan, s.latest('c1')!.windows, s.latest('c1')!.extra, s.latest('c1')!.problem, s.latest('c1')!.fails], ['pro', [], null, 'timeout', 3]);
    h.store.db!.prepare(`UPDATE claude_usage_latest SET windows = 'not json', alerted = '[1]', extra = '{', runs_on = 'weird', problem = 'weird', source = 'weird'`).run();
    const bad = s.latest('c1')!;
    assert.deepEqual([bad.windows, bad.alerted, bad.extra, bad.runsOn, bad.problem, bad.source], [[], {}, null, 'unknown', null, null]);
  } finally {
    h.done();
  }
});

test('samples: an unchanged window under 30 minutes old adds nothing, a change or an old one does', async () => {
  const h = await usageHarness();
  try {
    const s = new UsageStore(h.store);
    const w = [win('session', 41, reset), win('week', 63, reset + DAY)];
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW, w, 'probe'), 2);
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW + 10 * MIN, w, 'probe'), 0, 'same numbers, 10 minutes later');
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW + 20 * MIN, [win('session', 42, reset), win('week', 63, reset + DAY)], 'live'), 1, 'only the one that moved');
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW + 25 * MIN, [win('week', 63, reset + 5 * HOUR)], 'probe'), 1, 'a new reset time is a change');
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW + 56 * MIN, [win('week', 63, reset + 5 * HOUR)], 'probe'), 1, 'the same, but the last is 31 minutes old: a heartbeat');
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW + 40 * MIN, [win('model:x', null, null)], 'probe'), 1, 'a window with no number is kept as it is');
    assert.equal(s.addSamples('c1', 'docker/ws1', NOW + 41 * MIN, [win('model:x', null, null)], 'probe'), 0);
    assert.equal(s.addSamples('c2', 'docker/ws1', NOW + 41 * MIN, w, 'probe'), 2, 'another Claude has its own last row');
    const levels = h.store.db!.prepare('SELECT level FROM claude_usage_samples WHERE claude_id = ? ORDER BY id LIMIT 1').get('c1') as { level: string };
    assert.equal(levels.level, windowLevel(41, reset, NOW), 'a sample records its level');
  } finally {
    h.done();
  }
});

test('history: oldest first, only what is in range, windows with no number left out', async () => {
  const h = await usageHarness();
  try {
    const s = new UsageStore(h.store);
    s.addSamples('c1', 'w', NOW - 3 * DAY, [win('session', 10, reset)], 'probe');
    s.addSamples('c1', 'w', NOW - HOUR, [win('session', 30, reset), win('model:x', null, null)], 'probe');
    s.addSamples('c1', 'w', NOW, [win('session', 40, reset)], 'live');
    s.addSamples('c2', 'w', NOW, [win('session', 99, reset)], 'probe');
    assert.deepEqual(s.history('c1', NOW - DAY).map((r) => [r.win, r.usedPct]), [['session', 30], ['session', 40]]);
    assert.equal(s.history('c1', NOW - 7 * DAY).length, 3);
    assert.deepEqual(s.history('nobody', 0), []);
  } finally {
    h.done();
  }
});

test('retention: everything for two days, then one a window an hour, nothing after thirty days; Claudes that are gone go', async () => {
  const h = await usageHarness();
  try {
    const s = new UsageStore(h.store);
    const hourStart = Math.floor((NOW - 3 * DAY) / HOUR) * HOUR;
    for (let m = 0; m < 60; m += 10) s.addSamples('c1', 'w', hourStart + m * MIN, [win('session', m, null)], 'probe'); // six in one old hour
    s.addSamples('c1', 'w', hourStart + 90 * MIN, [win('session', 77, null)], 'probe'); // the next hour
    s.addSamples('c1', 'w', NOW - 40 * DAY, [win('session', 5, null)], 'probe'); // too old
    for (let m = 0; m < 60; m += 10) s.addSamples('c1', 'w', NOW - HOUR + m * MIN, [win('session', 50 + m, null)], 'probe'); // recent: all kept
    s.addSamples('gone', 'w', NOW, [win('session', 1, null)], 'probe');
    s.saveLatest(row({ claudeId: 'gone' }));
    s.saveLatest(row());

    s.prune(NOW);
    const old = h.store.db!.prepare('SELECT used_pct FROM claude_usage_samples WHERE claude_id = ? AND at_ms < ? ORDER BY at_ms').all('c1', NOW - KEEP_ALL_MS) as { used_pct: number }[];
    assert.deepEqual(old.map((r) => r.used_pct), [50, 77], 'the last of each old hour');
    assert.equal(s.history('c1', NOW - KEEP_MS - DAY).some((r) => r.usedPct === 5), false, 'nothing past thirty days');
    assert.equal(s.history('c1', NOW - 2 * HOUR).length, 6, 'the recent ones stay');
    assert.equal(s.history('gone', 0).length, 1, 'without a list of Claudes, nobody is gone');

    s.prune(NOW, new Set(['c1']));
    assert.deepEqual(s.history('gone', 0), []);
    assert.equal(s.latest('gone'), null);
    assert.ok(s.latest('c1'));
    s.prune(NOW, new Set());
    assert.ok(s.latest('c1'), 'an empty list (a listing that failed) removes nothing');
  } finally {
    h.done();
  }
});

test('a store that is unusable reads as nothing and writes nothing', () => {
  const noTables = new DatabaseSync(':memory:');
  const over = (db: DatabaseSync | null, writable: boolean) => new UsageStore({ db, writable, deliveryAllowed: writable } as unknown as Store);
  for (const s of [over(noTables, true), over(null, false)]) {
    assert.equal(s.latest('c1'), null);
    assert.deepEqual(s.allLatest(), []);
    assert.deepEqual(s.history('c1', 0), []);
    assert.deepEqual(s.counts(), { samples: 0, latest: 0 });
  }
  const readOnly = over(noTables, false);
  assert.equal(readOnly.addSamples('c1', 'w', NOW, [win('session', 1, null)], 'probe'), 0);
  assert.doesNotThrow(() => readOnly.saveLatest(row()));
  assert.doesNotThrow(() => readOnly.prune(NOW));
});
