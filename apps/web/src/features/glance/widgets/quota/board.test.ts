import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutoTransferEvent, AutoTransferSettings, ClaudeUsage, ClaudeUsageWindow } from '@portal/contracts';
import { AUTO_ACTOR, autoLine, quotaBoard } from './board.js';

// Hand-computed: "now" is 2026-10-12T12:00:00Z, thresholds 80 and 95.
const NOW = Date.parse('2026-10-12T12:00:00Z');
const TH = { warn: 80, critical: 95 };
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const win = (key: string, label: string, usedPct: number | null, resetsInH: number | null): ClaudeUsageWindow => ({ key, label, usedPct, resetsAt: resetsInH === null ? null : at(resetsInH), level: 'ok' });
const none = { value: null, basis: 'unavailable', reason: 'no_samples' } as const;

function claude(over: Partial<ClaudeUsage> & { claudeId: string }): ClaudeUsage {
  return {
    claudeName: over.claudeId.toUpperCase(),
    workspaceId: 'w1',
    workspaceName: 'w1',
    runsOn: 'plan',
    state: 'ok',
    plan: 'max',
    windows: [],
    extra: null,
    checkedAt: at(-0.1),
    source: 'probe',
    stale: false,
    workspaceRunning: true,
    problem: null,
    snoozedUntil: null,
    projectionSnoozedUntil: null,
    slot: 0,
    outlook: { status: none, window: null, etaAt: none, projectedPct: none },
    trend: null,
    ...over,
  };
}
const over = (etaInH: number): ClaudeUsage['outlook'] => ({ status: { value: 'over', basis: 'estimate' }, window: null, etaAt: { value: at(etaInH), basis: 'estimate' }, projectedPct: { value: 120, basis: 'estimate' } });

test('the Claude closest to running out comes first: the least left of its fullest window, measured', () => {
  // A: week 70 % -> 30 % left. B: session 90 % -> 10 % left. C: Opus 85 % -> 15 % left (a per-model window counts). D: session 20 %, week 99.6 % -> 0.4 % left.
  const A = claude({ claudeId: 'a', windows: [win('session', 'Session', 10, 3), win('week', 'Week', 70, 50)] });
  const B = claude({ claudeId: 'b', windows: [win('session', 'Session', 90, 1), win('week', 'Week', 40, 50)] });
  const C = claude({ claudeId: 'c', windows: [win('session', 'Session', 5, 4), win('week_opus', 'Opus', 85, 60)] });
  const D = claude({ claudeId: 'd', windows: [win('session', 'Session', 20, 4), win('week', 'Week', 99.6, 10)] });
  const rows = quotaBoard([A, B, C, D], NOW, TH);
  assert.deepEqual(rows.map((r) => r.reading.claude.claudeId), ['d', 'b', 'c', 'a']);
  assert.deepEqual(rows.map((r) => r.reading.leftPct), [0.4, 10, 15, 30]);
  assert.deepEqual(rows.map((r) => r.reading.level), ['critical', 'warn', 'warn', 'ok']);
  // every window is kept, session, week and per model, with its used percent
  assert.deepEqual(rows[2]!.windows.map((w) => [w.label, w.usedPct]), [['Session', 5], ['Opus', 85]]);
});

test('a tie on what is left goes to the one projected to run out sooner (an estimate), then by name; a projection never beats a reading', () => {
  const X = claude({ claudeId: 'x', windows: [win('session', 'Session', 60, 3)], outlook: over(5) });
  const Y = claude({ claudeId: 'y', windows: [win('session', 'Session', 60, 3)], outlook: over(2) });
  const Z = claude({ claudeId: 'z', windows: [win('session', 'Session', 60, 3)] });
  // W has more left (50 %) though it is projected to run out in 1 h: the measured 40 % left of X, Y, Z comes first
  const W = claude({ claudeId: 'w', windows: [win('session', 'Session', 50, 3)], outlook: over(1) });
  assert.deepEqual(quotaBoard([Z, W, X, Y], NOW, TH).map((r) => r.reading.claude.claudeId), ['y', 'x', 'z', 'w']);
});

test('without a number a Claude follows the ones that have one, and a pool or an API key comes last; a used-up Claude is 0 % and first', () => {
  const plan = claude({ claudeId: 'p', windows: [win('session', 'Session', 50, 3)] });
  const unread = claude({ claudeId: 'u', runsOn: 'unknown', state: 'unknown' });
  const out = claude({ claudeId: 's', runsOn: 'none', state: 'signed_out' });
  const pool = claude({ claudeId: 'k', runsOn: 'pool', state: 'no_limits' });
  const spent = claude({ claudeId: 'e', state: 'exhausted', windows: [{ ...win('session', 'Session', 100, 2), level: 'exhausted' }] });
  const rows = quotaBoard([pool, unread, plan, out, spent], NOW, TH);
  assert.deepEqual(rows.map((r) => r.reading.claude.claudeId), ['e', 'p', 's', 'u', 'k']);
  assert.deepEqual(rows.map((r) => r.reading.leftPct), [0, 50, null, null, null]);
  assert.deepEqual(rows.map((r) => r.reading.level), ['critical', 'ok', 'unknown', 'unknown', 'idle']);
  assert.deepEqual(quotaBoard([], NOW, TH), []);
});

test('a window past its reset has no number now, and the Claude is ranked by what is left of the others', () => {
  // the session reset an hour ago (its 97 % is old); the week at 40 % is what counts: 60 % left
  const R = claude({ claudeId: 'r', windows: [win('session', 'Session', 97, -1), win('week', 'Week', 40, 30)] });
  const row = quotaBoard([R], NOW, TH)[0]!;
  assert.equal(row.reading.leftPct, 60);
  assert.deepEqual(row.windows.map((w) => [w.label, w.usedPct, w.reset]), [['Session', null, true], ['Week', 40, false]]);
});

const settings = (mode: AutoTransferSettings['mode'], thresholdPct = 10): AutoTransferSettings => ({ mode, thresholdPct, useProjection: true, minPauseMin: 30, maxPerSessionPerDay: 3, maxPerDay: 10, maxPerDestination: 4, sameModelOnly: true, allowApiKey: false, allowBypass: false, modelFallback: [], keepModelFirst: true, dryRun: false });
const event = (id: number, actor: string, kind: AutoTransferEvent['kind'] = 'moved'): AutoTransferEvent => ({
  id, at: at(-id), userId: 'u_owner', sessionId: 's1', workspaceId: 'w1', kind, mode: 'auto', reason: 'low',
  from: { id: 'c1', name: 'Work' }, to: { id: 'c2', name: 'Home' }, facts: null, handoff: null, handoffId: null, code: null, actor,
});

test('auto move: the mode and threshold in force, and the last move the portal made by itself (a person\'s move is not it)', () => {
  assert.deepEqual(autoLine(settings('auto', 15), [event(1, 'user:u_owner'), event(2, AUTO_ACTOR), event(3, AUTO_ACTOR)]), {
    mode: 'auto',
    thresholdPct: 15,
    last: { at: at(-2), from: 'Work', to: 'Home' },
  });
  assert.deepEqual(autoLine(settings('off'), []), { mode: 'off', thresholdPct: null, last: null });
  assert.equal(autoLine(settings('ask'), [event(1, 'user:u_owner'), event(2, AUTO_ACTOR, 'undone')]).last, null, 'none automatic in the trail');
});
