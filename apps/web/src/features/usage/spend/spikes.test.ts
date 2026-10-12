import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, unavailableFigure, type SpikeSettings } from '@portal/contracts';
import { evidenceText, sensitivityText } from './spikes.js';

// The seeded fixture's three events, worded: a burst of 24 requests in 10 minutes over a limit of 20 costing $1.92; a rate of $0.50 in 15 minutes against a usual
// $0.10 (5x) from 12 active periods, all of it one session; an outlier request of $1.20 against a $0.30 median (4x) over 11 requests.
test('a burst names the requests, the window, the limit and the dollars', () => {
  const t = evidenceText({ kind: 'burst', requests: 24, windowMin: 10, threshold: 20, spentUsd: estimatedFigure(1.92) });
  assert.equal(t, '24 finished requests in 10 minutes by one session; the limit is 20. They cost $1.92. Dollars are estimates.');
});

test('a rate names the spend, the usual and how it is known, and the top session', () => {
  const t = evidenceText({ kind: 'rate', windowMin: 15, spentUsd: estimatedFigure(0.5), baselineUsd: estimatedFigure(0.1), factor: estimatedFigure(5), periods: 12, topSession: { sessionId: 'uus-1', share: 100 } });
  assert.equal(t, '$0.50 in the last 15 minutes, against a usual $0.10 (the 90th percentile of 12 active 15-minute periods in the 7 days before): 5x. 100 % of it was one session. Dollars are estimates.');
  const none = evidenceText({ kind: 'rate', windowMin: 15, spentUsd: estimatedFigure(0.5), baselineUsd: estimatedFigure(0.1), factor: estimatedFigure(5), periods: 12, topSession: null });
  assert.ok(!none.includes('one session'));
});

test('an outlier names the request, the median and how many requests it stands on', () => {
  const t = evidenceText({ kind: 'outlier', costUsd: estimatedFigure(1.2), medianUsd: estimatedFigure(0.3), factor: estimatedFigure(4), requests: 11 });
  // Worded as the portal words the line above it: two decimals under $10.
  assert.equal(t, 'One $1.20 request, 4x the median of $0.30 over 11 requests in the 7 days before. Dollars are estimates.');
});

test('a comparison that cannot be made says why, never a number', () => {
  const outlier = evidenceText({ kind: 'outlier', costUsd: estimatedFigure(1.2), medianUsd: unavailableFigure('no_history'), factor: unavailableFigure('no_history'), requests: 0 });
  assert.equal(outlier, 'One $1.20 request. Nothing to compare it with: Too little earlier use to compare with. Dollars are estimates.');
  const rate = evidenceText({ kind: 'rate', windowMin: 15, spentUsd: estimatedFigure(0.5), baselineUsd: unavailableFigure('no_history'), factor: unavailableFigure('no_history'), periods: 0, topSession: null });
  assert.equal(rate, '$0.50 in the last 15 minutes. Nothing to compare it with: Too little earlier use to compare with. Dollars are estimates.');
});

test('the sensitivity is spelled from the settings in force', () => {
  const s: SpikeSettings = { enabled: true, rateFactor: 3, burstRequests: 20, burstWindowMin: 10, outlierFactor: 10, minUsd: 0.5 };
  const t = sensitivityText(s);
  for (const part of ['3x the usual', '20 requests in 10 minutes', '10x the median', '$0.50', 'never act']) assert.ok(t.includes(part), `${part} in: ${t}`);
  assert.equal(sensitivityText({ ...s, enabled: false }), 'Spike detection is off in Settings.');
});
