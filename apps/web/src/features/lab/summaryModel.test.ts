import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrewFigure, CrewSummary, CrewSummaryWindow } from '@portal/contracts';
import { fmtRatio, paceCompact, paceSub, SUMMARY_GRID_CLASS, summaryLists, summaryTiles, trendOf } from './summaryModel';

const fig = (value: number | null, basis: CrewFigure['basis'] = 'measured', reason?: CrewFigure['reason']): CrewFigure => ({ value, basis, source: 'a source', reason });
const gone = (reason: CrewFigure['reason'] = 'no_samples'): CrewFigure => fig(null, 'unavailable', reason);

test('the summary grid follows the card width, never the viewport', () => {
  assert.ok(!/(^|\s)(sm|md|lg|xl|2xl):/.test(SUMMARY_GRID_CLASS));
  assert.match(SUMMARY_GRID_CLASS, /@min-\[366px\]:grid-cols-3/);
  assert.match(SUMMARY_GRID_CLASS, /@xl:grid-cols-5/);
});

function win(o: Partial<CrewSummaryWindow> = {}): CrewSummaryWindow {
  return {
    fromMs: 0,
    toMs: 1,
    requestsPerHour: fig(120),
    usdPerHour: fig(2.5, 'estimate'),
    resolved: fig(45),
    wontDo: fig(3),
    resolvedByProgram: [{ program: 'p', title: 'ClaudePilot', count: 45 }],
    perResolvedUsd: fig(0.42, 'estimate'),
    createdPerClosed: fig(2.87),
    createdPerClosedByProgram: [{ program: 'p', title: 'ClaudePilot', created: 158, closed: 55, ratio: fig(2.87) }],
    ...o,
  };
}

function summary(o: { pace?: CrewFigure; unused?: number | null; current?: Partial<CrewSummaryWindow>; previous?: Partial<CrewSummaryWindow> | null } = {}): CrewSummary {
  return {
    pace: { ratio: o.pace ?? fig(0.75), unusedAtResetPct: o.unused === undefined ? 25 : o.unused, weekly: gone('no_source'), claudes: [{ claude: 'a', label: 'one.claude', usedPct: 49, evenPct: 50, ratio: fig(0.98), projectedPct: 98 }] },
    current: win(o.current),
    previous: o.previous === null || o.previous === undefined ? null : win(o.previous),
  };
}
const by = (s: CrewSummary, key: string) => summaryTiles(s).find((t) => t.key === key)!;

test('the ratio reads "0.75 : 1", and unavailable reads as the word', () => {
  assert.equal(fmtRatio(fig(0.75)), '0.75 : 1');
  assert.equal(fmtRatio(fig(1)), '1.00 : 1');
  assert.equal(fmtRatio(gone('windows_just_reset')), 'unavailable');
  assert.equal(fmtRatio(null), 'unavailable');
});

test('five tiles in order: pace, usage, resolved, per cost, created per closed', () => {
  assert.deepEqual(summaryTiles(summary()).map((t) => t.key), ['pace', 'usage', 'resolved', 'perCost', 'createdPerClosed']);
});

test('pace: under 0.9 says what is unused at reset, over 1.1 says it runs out early, between is on pace', () => {
  assert.equal(by(summary({ pace: fig(0.75), unused: 25 }), 'pace').sub, 'about 25 % unused at reset');
  assert.equal(by(summary({ pace: fig(0.75), unused: 25 }), 'pace').state, 'warn');
  assert.equal(by(summary({ pace: fig(1.3) }), 'pace').sub, 'runs out early');
  assert.equal(by(summary({ pace: fig(1.0) }), 'pace').sub, 'on pace');
  assert.equal(by(summary({ pace: fig(1.0) }), 'pace').state, 'ok');
  assert.equal(paceSub(summary({ pace: fig(0.5), unused: null }).pace), 'quota left unused at reset');
});

test('pace unavailable with the reason, never a number', () => {
  const t = by(summary({ pace: gone('windows_just_reset') }), 'pace');
  assert.equal(t.value, 'unavailable');
  assert.equal(t.state, 'unavailable');
  assert.equal(t.sub, 'the quota windows just reset');
  assert.match(t.tip, /Unavailable: the quota windows just reset/);
  assert.equal(by(summary({ pace: gone('no_claude') }), 'pace').sub, 'no Claude is signed in and readable');
});

test('created per closed with none closed is unavailable, not a division by zero', () => {
  const t = by(summary({ current: { createdPerClosed: gone('no_samples') } }), 'createdPerClosed');
  assert.equal(t.value, 'unavailable');
  assert.equal(t.sub, 'nothing to divide by in this window');
});

test('created per closed: "2.87 : 1"; under 1 the backlog shrinks', () => {
  assert.equal(by(summary(), 'createdPerClosed').value, '2.87 : 1');
  assert.equal(by(summary(), 'createdPerClosed').sub, 'backlog grows');
  assert.equal(by(summary({ current: { createdPerClosed: fig(0.5) } }), 'createdPerClosed').sub, 'backlog shrinks');
});

test('up or down against the window before, with what it was', () => {
  const s = summary({ current: { resolved: fig(45), perResolvedUsd: fig(0.3, 'estimate'), requestsPerHour: fig(120) }, previous: { resolved: fig(30), perResolvedUsd: fig(0.5, 'estimate'), requestsPerHour: fig(120) } });
  assert.deepEqual([by(s, 'resolved').trend, by(s, 'resolved').was], ['up', '30']);
  assert.equal(by(s, 'perCost').trend, 'down');
  assert.equal(by(s, 'usage').trend, 'same');
});

test('no previous window, or an unavailable side, gives no trend and no "was"', () => {
  assert.equal(by(summary(), 'resolved').trend, null);
  assert.equal(by(summary(), 'resolved').was, null);
  const s = summary({ current: { perResolvedUsd: gone() }, previous: {} });
  assert.equal(by(s, 'perCost').trend, null);
  assert.equal(trendOf(fig(1), gone()), null);
  assert.equal(by(summary({ previous: {} }), 'pace').trend, null);
});

test('every tile names its source and basis', () => {
  for (const t of summaryTiles(summary())) {
    assert.match(t.tip, /Source: a source/);
    assert.match(t.basis, /MEASURED|ESTIMATE|UNAVAILABLE/);
  }
  assert.equal(by(summary(), 'perCost').basis, 'ESTIMATE');
});

test('usage without dollars shows requests only and says why', () => {
  const t = by(summary({ current: { usdPerHour: gone('no_source') } }), 'usage');
  assert.equal(t.sub, null);
  assert.match(t.tip, /Dollars: unavailable, the portal has no table for it/);
});

test('lists: each Claude, resolved and created per closed per program, weekly unavailable with the reason', () => {
  const l = summaryLists(summary());
  assert.deepEqual(l.map((x) => x.title), ['Pace by Claude', 'Weekly pace', 'Resolved by program', 'Created : closed by program']);
  assert.equal(l[0]!.rows[0], 'one.claude: 0.98 : 1 (49 % used, 50 % even)');
  assert.equal(l[1]!.rows[0], 'unavailable: the portal has no table for it');
  assert.equal(l[2]!.rows[0], 'ClaudePilot: 45');
  assert.equal(l[3]!.rows[0], 'ClaudePilot: 158 created, 55 closed, 2.87');
});

test('the chip: "0.75" with a warn dot; unavailable is "-" and unknown; at most five characters', () => {
  const c = paceCompact(summary(), false);
  assert.deepEqual([c.value, c.level], ['0.75', 'warn']);
  assert.ok((c.value ?? '').length <= 5);
  assert.equal(paceCompact(summary({ pace: fig(1) }), false).level, 'ok');
  const u = paceCompact(summary({ pace: gone('windows_just_reset') }), false);
  assert.deepEqual([u.value, u.level], ['-', 'unknown']);
  assert.match(u.title, /unavailable/);
  assert.match(paceCompact(null, true).title, /could not be read/);
});
