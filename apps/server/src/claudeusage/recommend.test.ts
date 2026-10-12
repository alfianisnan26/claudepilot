// The Move recommendation (docs/prd/claude-usage.md §20.5): ranking, reasons, bases, and who is never recommended. Hand-worked expectations.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, measuredFigure, unavailableFigure, type ClaudeUsage, type ClaudeUsageWindow, type LimitOutlook, type PaceStatus } from '@portal/contracts';
import { OVER_PACE_PENALTY, recommendMove, ROOM_PCT } from './recommend.js';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const outlook = (status: PaceStatus | null): LimitOutlook => ({
  status: status === null ? unavailableFigure('single_sample') : status === 'exhausted' ? measuredFigure(status) : estimatedFigure(status),
  window: null,
  etaAt: unavailableFigure('single_sample'),
  projectedPct: unavailableFigure('single_sample'),
});

/** A plan Claude of workspace `ws` with its session at `usedPct`, resetting `resetInH` hours from now. */
function plan(id: string, usedPct: number, resetInH: number, pace: PaceStatus | null = 'under', over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  const window: ClaudeUsageWindow = { key: 'session', label: 'Session', usedPct, resetsAt: iso(NOW + resetInH * HOUR), level: usedPct >= 100 ? 'exhausted' : usedPct >= 95 ? 'high' : usedPct >= 80 ? 'near' : 'ok' };
  return {
    claudeId: id,
    claudeName: id.toUpperCase(),
    workspaceId: 'docker/ws',
    workspaceName: 'ws',
    runsOn: 'plan',
    state: 'ok',
    plan: 'max',
    windows: [window],
    extra: null,
    checkedAt: iso(NOW),
    source: 'probe',
    stale: false,
    workspaceRunning: true,
    problem: null,
    snoozedUntil: null,
    projectionSnoozedUntil: null,
    slot: 0,
    outlook: outlook(pace),
    trend: null,
    ...over,
  };
}
const other = (id: string, runsOn: ClaudeUsage['runsOn'], over: Partial<ClaudeUsage> = {}): ClaudeUsage => plan(id, 0, 1, null, { runsOn, windows: [], ...over });

const ids = (r: ReturnType<typeof recommendMove>) => r.candidates.map((c) => c.claudeId);

test('ranked by percent left of the fullest window, less 20 points for a Claude whose pace runs out before its reset', () => {
  // Hand: a 40 % used -> 60 left, under: score 60. b 10 % used -> 90 left but over pace: 90 - 20 = 70. c 50 % used, 50 left, under: 50.
  // Order b (70), a (60), c (50). A Claude with 90 left that runs out first still has more room than one with 60.
  const r = recommendMove([plan('a', 40, 3), plan('b', 10, 3, 'over'), plan('c', 50, 3)], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(ids(r), ['b', 'a', 'c']);
  assert.deepEqual(r.candidates.map((c) => [c.rank, c.recommended, c.reason, c.basis, c.leftPct.value]), [[1, true, 'over_pace', 'estimate', 90], [2, false, 'room', 'measured', 60], [3, false, 'room', 'measured', 50]]);
  assert.equal(r.recommended, 'b');
  assert.equal(r.none, null);
  assert.equal(OVER_PACE_PENALTY, 20);
  assert.equal(ROOM_PCT, 20);
});

test('the penalty can change the order: 70 left and over pace ranks below 60 left and under', () => {
  // Hand: 70 - 20 = 50 < 60.
  const r = recommendMove([plan('over', 30, 3, 'over'), plan('calm', 40, 3)], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(ids(r), ['calm', 'over']);
});

test('on equal scores the sooner reset comes first; then the name', () => {
  const r = recommendMove([plan('late', 40, 4), plan('soon', 40, 1), plan('also', 40, 1)], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(ids(r), ['also', 'soon', 'late']);
});

test('a pool or an API key ranks after Claudes with room and before those nearly out; it is not a plan, so its figures say why they are missing', () => {
  const r = recommendMove([plan('tight', 90, 2), other('pool', 'pool'), plan('roomy', 20, 2), other('key', 'key')], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(ids(r), ['roomy', 'key', 'pool', 'tight']);
  const key = r.candidates.find((c) => c.claudeId === 'key')!;
  assert.deepEqual([key.reason, key.basis, key.leftPct.reason, key.resetsAt.reason, key.rank], ['no_limits', 'measured', 'no_limits', 'no_limits', 2]);
  assert.equal(r.candidates.find((c) => c.claudeId === 'tight')!.reason, 'tight');
  assert.equal(r.recommended, 'roomy');
});

test('under 20 % left is tight, and a tight Claude is never recommended: when every ranked one is tight, nothing is', () => {
  // Hand: 85 used = 15 left < 20.
  const r = recommendMove([plan('t1', 85, 2), plan('t2', 96, 2)], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(r.candidates.map((c) => [c.claudeId, c.rank, c.reason, c.recommended]), [['t1', 1, 'tight', false], ['t2', 2, 'tight', false]]);
  assert.deepEqual([r.recommended, r.none], [null, 'all_tight']);
  // Exactly 20 left is room.
  assert.equal(recommendMove([plan('edge', 80, 2)], { workspaceId: 'docker/ws', nowMs: NOW }).candidates[0]!.reason, 'room');
});

test('exhausted, unknown and signed-out Claudes are listed without a rank and never recommended, each with its own reason', () => {
  const out = plan('out', 100, 2, 'exhausted');
  const out2 = plan('out2', 100, 1, 'exhausted');
  const r = recommendMove(
    [other('signed', 'none'), other('fresh', 'unknown'), out, out2, plan('ok', 30, 2)],
    { workspaceId: 'docker/ws', nowMs: NOW },
  );
  // Order: ranked first, then exhausted by when they return (out2 in 1 h before out in 2 h), unknown, signed out.
  assert.deepEqual(ids(r), ['ok', 'out2', 'out', 'fresh', 'signed']);
  const by = new Map(r.candidates.map((c) => [c.claudeId, c]));
  assert.deepEqual([by.get('out2')!.rank, by.get('out2')!.reason, by.get('out2')!.availableAt.value, by.get('out2')!.availableAt.basis], [null, 'exhausted', iso(NOW + HOUR), 'measured']);
  assert.deepEqual([by.get('fresh')!.reason, by.get('fresh')!.basis, by.get('fresh')!.leftPct.reason], ['unknown', 'unavailable', 'no_reading']);
  assert.deepEqual([by.get('signed')!.reason, by.get('signed')!.basis, by.get('signed')!.leftPct.reason], ['signed_out', 'unavailable', 'signed_out']);
  assert.equal(r.recommended, 'ok');
  for (const id of ['out', 'out2', 'fresh', 'signed']) assert.equal(by.get(id)!.recommended, false);
});

test('nothing can take the chat now: none_ready; only the Claude it leaves: no_other_claude; another workspace’s Claudes are not candidates', () => {
  const none = recommendMove([plan('out', 100, 2, 'exhausted'), other('signed', 'none')], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual([none.recommended, none.none], [null, 'none_ready']);
  const alone = recommendMove([plan('me', 10, 2)], { workspaceId: 'docker/ws', from: 'me', nowMs: NOW });
  assert.deepEqual([alone.candidates.length, alone.recommended, alone.none, alone.from], [0, null, 'no_other_claude', 'me']);
  const elsewhere = recommendMove([plan('x', 10, 2, 'under', { workspaceId: 'docker/other' }), plan('y', 20, 2)], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(ids(elsewhere), ['y']);
  assert.equal(elsewhere.workspaceId, 'docker/ws');
});

test('a reading that is old still ranks but says so; the order follows what was read, and the basis stays measured', () => {
  const r = recommendMove([plan('old', 10, 3, 'under', { stale: true, checkedAt: iso(NOW - 3 * HOUR) }), plan('new', 30, 3)], { workspaceId: 'docker/ws', nowMs: NOW });
  assert.deepEqual(ids(r), ['old', 'new']);
  assert.deepEqual([r.candidates[0]!.stale, r.candidates[0]!.basis, r.candidates[0]!.checkedAt], [true, 'measured', iso(NOW - 3 * HOUR)]);
});

test('the window it judged by is named, and a pace that could not be worked out is said so rather than guessed', () => {
  const r = recommendMove([plan('a', 40, 3, null)], { workspaceId: 'docker/ws', nowMs: NOW });
  const c = r.candidates[0]!;
  assert.deepEqual(c.window, { key: 'session', label: 'Session' });
  assert.equal(c.resetsAt.value, iso(NOW + 3 * HOUR));
  assert.deepEqual([c.pace.value, c.pace.reason], [null, 'single_sample']);
  assert.equal(c.reason, 'room', 'no pace is no penalty: only what was read counts');
});
