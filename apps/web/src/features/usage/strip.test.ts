import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, measuredFigure, unavailableFigure, type LimitOutlook, type NextReset, type SpendRate, type SpendToday } from '@portal/contracts';
import { limitTile, resetTile, speedTile, todayTile } from './strip.js';

// The clock is injected so the wording does not depend on the machine's time zone: "14:10" is the ISO string's own time.
const clock = (iso: string) => iso.slice(11, 16);
const NOW = Date.parse('2026-10-12T12:00:00Z');
const win = (usedPct: number, resetsAt: string | null = '2026-10-12T16:20:00Z') => ({ key: 'session', label: 'Session', usedPct, resetsAt });

test('limit, over: the time until the window is estimated to reach 100 %, counted from now', () => {
  // 62 % used, 14:10 estimated to hit 100 %, resets 16:20 (so it runs out 2 h 10 m from 12:00 and 2 h 10 m before the reset).
  const limit: LimitOutlook = { status: estimatedFigure('over'), window: win(62), etaAt: estimatedFigure('2026-10-12T14:10:00Z'), projectedPct: estimatedFigure(131.4) };
  const t = limitTile(limit, NOW, false, clock);
  assert.equal(t.value, '2 h 10 m');
  assert.equal(t.tone, 'gold');
  assert.equal(t.hint, 'Session · before reset');
  assert.equal(t.estimate, true);
  assert.equal(t.reason, null);
  for (const part of ['62 %', '14:10', '16:20', '131 %', 'not from tokens']) assert.ok(t.note!.includes(part), `${part} in: ${t.note}`);
  // Over every Claude, the Claude that runs out is named.
  assert.equal(limitTile({ ...limit, claudeName: 'Satria' }, NOW, true, clock).hint, 'Satria · Session · before reset');
});

test('limit, under: OK, with where the window is estimated to stand at its reset', () => {
  const limit: LimitOutlook = { status: estimatedFigure('under'), window: win(41), etaAt: estimatedFigure('2026-10-12T20:00:00Z'), projectedPct: estimatedFigure(46.4) };
  const t = limitTile(limit, NOW, false, clock);
  assert.equal(t.value, 'OK');
  assert.equal(t.tone, 'ok');
  assert.equal(t.hint, 'Session · ~46 % at reset');
  assert.ok(t.note!.includes('41 %') && t.note!.includes('46 %') && t.note!.includes('16:20'));
});

test('limit, out: Out until the reset, measured (no estimate)', () => {
  const limit: LimitOutlook = { status: measuredFigure('exhausted'), window: win(100, '2026-10-12T14:20:00Z'), etaAt: unavailableFigure('no_growth'), projectedPct: unavailableFigure('no_growth') };
  const t = limitTile(limit, NOW, false, clock);
  assert.deepEqual([t.value, t.tone, t.hint, t.estimate], ['Out', 'danger', 'Session · until 14:20', false]);
});

test('limit, unavailable: "-" and the server reason, never a number', () => {
  const limit: LimitOutlook = { status: unavailableFigure('no_limits'), window: null, etaAt: unavailableFigure('no_limits'), projectedPct: unavailableFigure('no_limits') };
  const t = limitTile(limit, NOW, false, clock);
  assert.deepEqual([t.value, t.reason, t.estimate, t.note], ['-', 'no_limits', false, null]);
  // A signed-out Claude over all Claudes still says which one.
  assert.equal(limitTile({ ...limit, status: unavailableFigure('signed_out'), claudeName: 'Kresna' }, NOW, true, clock).hint, 'Kresna');
});

test('next reset: a countdown with the window and the clock time beside it', () => {
  const r: NextReset = { at: measuredFigure('2026-10-12T14:20:00Z'), window: { key: 'session', label: 'Session' } };
  assert.deepEqual([resetTile(r, NOW, false, clock).value, resetTile(r, NOW, false, clock).hint], ['2 h 20 m', 'Session · 14:20']);
  assert.equal(resetTile({ ...r, claudeName: 'Kresna' }, NOW, true, clock).hint, 'Kresna · Session · 14:20');
  const none: NextReset = { at: unavailableFigure('no_limits'), window: null };
  assert.deepEqual([resetTile(none, NOW, false, clock).value, resetTile(none, NOW, false, clock).reason], ['-', 'no_limits']);
});

const rate = (window: SpendRate['window'], spanMin: number, cost: number, tokens: number): SpendRate => ({ window, spanMin, requests: 5, costPerMin: estimatedFigure(cost), tokensPerMin: estimatedFigure(tokens), cacheReadPerMin: estimatedFigure(0) });

test('speed: dollars per minute over the last 15 minutes, tokens beneath, today average in the note', () => {
  const t = speedTile(rate('15m', 15, 0.42, 35_000), rate('today', 372, 0.31, 21_000));
  assert.deepEqual([t.value, t.unit, t.hint, t.estimate], ['$0.42', '/min', '35k tok/min', true]);
  assert.ok(t.note!.includes("Today's average: $0.31/min, 21k tok/min over 372 min."), t.note!);
});

test('speed: idle is a real zero, and an unavailable today says why', () => {
  const unavailableToday: SpendRate = { window: 'today', spanMin: 3, requests: 1, costPerMin: unavailableFigure('short_span'), tokensPerMin: unavailableFigure('short_span'), cacheReadPerMin: unavailableFigure('short_span') };
  const t = speedTile(rate('15m', 15, 0, 0), unavailableToday);
  assert.deepEqual([t.value, t.unit, t.hint, t.reason], ['$0', '/min', '0 tok/min', null]);
  assert.ok(t.note!.includes('Readings are too close together for a rate.'));
  const noneNow = speedTile({ ...rate('15m', 15, 0, 0), costPerMin: unavailableFigure('no_requests'), tokensPerMin: unavailableFigure('no_requests') }, unavailableToday);
  assert.deepEqual([noneNow.value, noneNow.unit, noneNow.hint, noneNow.reason], ['-', undefined, '', 'no_requests']);
});

test('today: dollars (est.), the request count and the tokens in the note', () => {
  const today: SpendToday = { from: '2026-10-12T00:00:00Z', costUsd: estimatedFigure(4.2134), tokens: measuredFigure(1_234_567), cacheRead: measuredFigure(9_000_000), requests: measuredFigure(118) };
  const t = todayTile(today);
  assert.deepEqual([t.value, t.hint, t.estimate], ['$4.21', '118 requests', true]);
  assert.ok(t.note!.includes('1.2M') && t.note!.includes('cache reads are not counted'));
  assert.equal(todayTile({ ...today, requests: measuredFigure(1) }).hint, '1 request');
  assert.equal(todayTile({ ...today, costUsd: estimatedFigure(0), requests: measuredFigure(0) }).value, '$0');
});
