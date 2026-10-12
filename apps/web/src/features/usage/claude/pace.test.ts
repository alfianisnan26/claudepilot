import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, unavailableFigure, type ClaudeUsage, type ClaudeUsageWindow, type LimitOutlook, type WindowPace } from '@portal/contracts';
import { aheadText, needsPaceLook, paceRows, projectionRisk, projectionSpan, riskWords } from './pace.js';

// The clock is the ISO string's own time, so wording does not depend on the machine's zone.
const clock = (iso: string) => iso.slice(11, 16);
const NOW = '2026-10-12T05:26:00Z';

// Hand-worked, the same numbers as the server's fixture: Satria's session read 30 %, 50 %, 70 % an hour apart (20 points an hour), 70 % now, resets in
// 2 h: it would stand at 70 + 20 x 2 = 110 % at the reset and reaches 100 % in 30 / 20 h = 1 h 30 m, at 06:56, before the 07:26 reset. An even spend
// would be at 100 x 3 h / 5 h = 60 %, so it is 10 points ahead.
const sessionPace = (over: Partial<WindowPace> = {}): WindowPace => ({
  speed: estimatedFigure(20),
  projectedPct: estimatedFigure(110),
  etaAt: estimatedFigure('2026-10-12T06:56:00Z'),
  status: estimatedFigure('over'),
  evenPct: estimatedFigure(60),
  aheadPts: estimatedFigure(10),
  readings: 3,
  spanMin: 120,
  method: 'least_squares',
  lowConfidence: false,
  ...over,
});
const session = (pace: WindowPace | undefined, over: Partial<ClaudeUsageWindow> = {}): ClaudeUsageWindow => ({ key: 'session', label: 'Session', usedPct: 70, resetsAt: '2026-10-12T07:26:00Z', level: 'ok', pace, ...over });
const week: ClaudeUsageWindow = {
  key: 'week',
  label: 'Week',
  usedPct: 36,
  resetsAt: '2026-10-16T05:26:00Z',
  level: 'ok',
  // 8 points a day = 0.33 an hour: 36 + 8 x 4 = 68 % at the reset, 100 % only after it.
  pace: { ...sessionPace({ status: estimatedFigure('under'), speed: estimatedFigure(0.3), projectedPct: estimatedFigure(68), etaAt: estimatedFigure('2026-10-24T05:26:00Z'), evenPct: estimatedFigure(42.9), aheadPts: estimatedFigure(-6.9) }) },
};
const over: LimitOutlook = { status: estimatedFigure('over'), window: { key: 'session', label: 'Session', usedPct: 70, resetsAt: '2026-10-12T07:26:00Z' }, etaAt: estimatedFigure('2026-10-12T06:56:00Z'), projectedPct: estimatedFigure(110) };
const claude = (over_: Partial<ClaudeUsage> = {}): ClaudeUsage =>
  ({ claudeId: 'c1', claudeName: 'Satria', workspaceId: 'docker/api', workspaceName: 'api', runsOn: 'plan', state: 'ok', plan: 'max', windows: [session(sessionPace()), week], extra: null, checkedAt: NOW, source: 'probe', stale: false, workspaceRunning: true, problem: null, snoozedUntil: null, projectionSnoozedUntil: null, slot: 2, outlook: over, trend: null, ...over_ }) as ClaudeUsage;

test('a Claude estimated to run out before the reset: the window that decides, its time, and the sentence', () => {
  const risk = projectionRisk(claude())!;
  assert.equal(risk.window.key, 'session');
  assert.equal(risk.etaAt, '2026-10-12T06:56:00Z');
  assert.equal(risk.low, false);
  const words = riskWords(risk, clock);
  assert.equal(words.line, 'Session runs out ~06:56 · resets 07:26');
  for (const part of ['20 points an hour', '3 readings', 'not from tokens', '06:56', '110 %', '07:26']) assert.ok(words.tip.includes(part), `${part} in: ${words.tip}`);
});

test('low confidence says "may", and says no alert is sent', () => {
  const risk = projectionRisk(claude({ windows: [session(sessionPace({ lowConfidence: true, readings: 2 })), week] }))!;
  assert.equal(risk.low, true);
  const words = riskWords(risk, clock);
  assert.equal(words.line, 'Session may run out ~06:56 · resets 07:26');
  assert.ok(words.tip.includes('no alert is sent'));
});

test('no risk: under quota, out already, no plan, or an outlook with no number', () => {
  const under: LimitOutlook = { ...over, status: estimatedFigure('under') };
  assert.equal(projectionRisk(claude({ outlook: under })), null);
  assert.equal(projectionRisk(claude({ state: 'exhausted', outlook: { ...over, status: estimatedFigure('exhausted') as never } })), null);
  assert.equal(projectionRisk(claude({ runsOn: 'key' })), null);
  assert.equal(projectionRisk(claude({ outlook: { ...over, status: unavailableFigure('no_limits') } })), null);
  // the outlook names a window the Claude no longer lists, or one whose etaAt is unknown
  assert.equal(projectionRisk(claude({ windows: [week] })), null);
  assert.equal(projectionRisk(claude({ windows: [session(sessionPace({ etaAt: unavailableFigure('no_growth') })), week] })), null);
});

test('the tab badge counts a confident risk, not a low-confidence one, and not one that is snoozed', () => {
  assert.equal(needsPaceLook(claude()), true);
  assert.equal(needsPaceLook(claude({ windows: [session(sessionPace({ lowConfidence: true })), week] })), false);
  assert.equal(needsPaceLook(claude({ snoozedUntil: '2026-10-12T08:00:00Z' })), false);
  assert.equal(needsPaceLook(claude({ projectionSnoozedUntil: '2026-10-12T08:00:00Z' })), false);
  assert.equal(needsPaceLook(claude({ outlook: { ...over, status: estimatedFigure('under') } })), false);
});

test('bar projection: the used part, the estimated rest capped at the end, an even-pace mark', () => {
  // 70 % used, 110 % projected: the rest runs to the end of the bar and it is over; even pace is at 60 %.
  assert.deepEqual(projectionSpan(session(sessionPace())), { from: 70, to: 100, over: true, even: 60, low: false });
  // Week: 36 used, 68 projected: the estimated rest stops at 68, not over.
  assert.deepEqual(projectionSpan(week), { from: 36, to: 68, over: false, even: 42.9, low: false });
  // Nothing to draw without a pace, a percent, or after the reset (the number is old).
  assert.equal(projectionSpan(session(undefined)), null);
  assert.equal(projectionSpan(session(sessionPace(), { usedPct: null })), null);
  assert.equal(projectionSpan(session(sessionPace(), { level: 'reset' })), null);
  assert.equal(projectionSpan(session(sessionPace({ projectedPct: unavailableFigure('single_sample') }))), null);
});

test('pace rows: a time after the reset reads "after reset", unavailable stays unavailable', () => {
  const rows = paceRows(claude(), clock);
  assert.deepEqual(rows.map((r) => [r.key, r.outAt.text, r.low, r.readings]), [['session', '06:56', false, 3], ['week', 'after reset', false, 3]]);
  const none = paceRows(claude({ windows: [session(sessionPace({ etaAt: unavailableFigure('no_growth'), status: unavailableFigure('no_growth') }))] }), clock);
  assert.equal(none[0]!.outAt.text, '-');
  assert.equal(paceRows({ windows: [session(undefined)] }, clock).length, 0);
});

test('ahead of an even spend: signed whole points', () => {
  assert.equal(aheadText(10), '+10 pts');
  assert.equal(aheadText(-6.9), '-7 pts');
  assert.equal(aheadText(0.2), '0 pts'); // rounds to nothing
  assert.equal(aheadText(0), '0 pts');
});
