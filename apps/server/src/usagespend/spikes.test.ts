import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpikeSettings } from '@portal/contracts';
import { burstEvidence, burstVerdict, median, MIN_PERIODS, MIN_REQUESTS, outlierEvidence, outlierVerdict, percentile, rateEvidence, rateVerdict, spikeSummary } from './spikes.js';

const CFG: SpikeSettings = { enabled: true, rateFactor: 3, burstRequests: 20, burstWindowMin: 10, outlierFactor: 10, minUsd: 0.5 };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('percentile by nearest rank, and the median (the mean of the two middle values when there is an even number)', () => {
  const ten = [10, 3, 1, 7, 2, 9, 4, 8, 5, 6];
  // Rank = ceil(p x n / 100): p90 of ten values is the 9th smallest, p50 the 5th, p100 the 10th, p0 the first.
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 100), 10);
  assert.equal(percentile(ten, 0), 1);
  assert.equal(percentile([7], 90), 7);
  assert.equal(percentile([], 90), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
  assert.equal(median([]), null);
  assert.deepEqual(ten, [10, 3, 1, 7, 2, 9, 4, 8, 5, 6], 'the input is not reordered');
});

test('rate: 3 x the 90th percentile of the active 15-minute periods, at least $0.50, and at least 8 periods to compare with', () => {
  const periods = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // P90 = 9 (the 9th of ten), so the line is 3 x 9 = $27
  const hit = rateVerdict(30, periods, CFG);
  assert.equal(hit.state, 'hit');
  if (hit.state === 'hit') {
    assert.equal(hit.evidence.baselineUsd, 9);
    near(hit.evidence.factor, 30 / 9);
    assert.equal(hit.evidence.periods, 10);
  }
  assert.equal(rateVerdict(27, periods, CFG).state, 'hit', 'exactly 3 x counts');
  assert.equal(rateVerdict(26.99, periods, CFG).state, 'quiet');
  // Fewer than 8 active periods: there is nothing to compare with, and the verdict says how many there are.
  assert.deepEqual(rateVerdict(100, [1, 2, 3, 4, 5, 6, 7], CFG), { state: 'no_history', have: 7, need: MIN_PERIODS });
  assert.equal(rateVerdict(100, [1, 2, 3, 4, 5, 6, 7, 8], CFG).state, 'hit', 'eight is enough: P90 is the 8th (8), the line 24');
  // Under the money floor nothing is said, whatever the history.
  assert.equal(rateVerdict(0.4, [], CFG).state, 'quiet');
  assert.equal(rateVerdict(0, periods, CFG).state, 'quiet');
  // Eight equal periods of $1: the line is $3.
  const flat = Array<number>(8).fill(1);
  assert.equal(rateVerdict(3, flat, CFG).state, 'hit');
  assert.equal(rateVerdict(2.9, flat, CFG).state, 'quiet');
  // The factor is a setting: at 5 x, $30 against $9 (3.33 x) is quiet.
  assert.equal(rateVerdict(30, periods, { ...CFG, rateFactor: 5 }).state, 'quiet');
});

test('burst: this many finished requests by one session in the window, no matter what they cost', () => {
  assert.deepEqual(burstVerdict(20, CFG), { state: 'hit', evidence: { requests: 20, threshold: 20 } });
  assert.equal(burstVerdict(19, CFG).state, 'quiet');
  assert.equal(burstVerdict(12, { ...CFG, burstRequests: 12 }).state, 'hit');
});

test('outlier: 10 x the median request, at least $0.50, and at least 20 earlier requests to take the median of', () => {
  const history = Array.from({ length: 20 }, (_, i) => (i + 1) / 10); // $0.10 to $2.00: the median is (1.0 + 1.1) / 2 = $1.05, so the line is $10.50
  const hit = outlierVerdict(11, history, CFG);
  assert.equal(hit.state, 'hit');
  if (hit.state === 'hit') {
    near(hit.evidence.medianUsd, 1.05);
    near(hit.evidence.factor, 11 / 1.05);
    assert.equal(hit.evidence.requests, 20);
  }
  assert.equal(outlierVerdict(10.4, history, CFG).state, 'quiet');
  assert.deepEqual(outlierVerdict(11, history.slice(0, 19), CFG), { state: 'no_history', have: 19, need: MIN_REQUESTS });
  assert.equal(outlierVerdict(0.3, history, CFG).state, 'quiet', 'under the floor');
  // Twenty requests of $0.20: the line is $2.00.
  const flat = Array<number>(20).fill(0.2);
  assert.equal(outlierVerdict(2, flat, CFG).state, 'hit');
  assert.equal(outlierVerdict(1.99, flat, CFG).state, 'quiet');
});

test('the evidence says how each number is known, and the summary is one terse line', () => {
  const rate = rateEvidence(30, { baselineUsd: 9, factor: 30 / 9, periods: 10 }, { sessionId: 's1', share: 80 });
  assert.deepEqual(rate, {
    kind: 'rate',
    windowMin: 15,
    spentUsd: { value: 30, basis: 'estimate' },
    baselineUsd: { value: 9, basis: 'estimate' },
    factor: { value: 3.333333, basis: 'estimate' },
    periods: 10,
    topSession: { sessionId: 's1', share: 80 },
  });
  assert.equal(spikeSummary(rate), '$30 in 15 min, 3.3x the usual');
  const burst = burstEvidence(24, 20, 1.5);
  assert.deepEqual(burst, { kind: 'burst', requests: 24, windowMin: 10, threshold: 20, spentUsd: { value: 1.5, basis: 'estimate' } });
  assert.equal(spikeSummary(burst), '24 requests in 10 min (limit 20)');
  const out = outlierEvidence(3.1, { medianUsd: 0.12, factor: 3.1 / 0.12, requests: 143 });
  assert.equal(out.kind === 'outlier' && out.requests, 143);
  assert.equal(spikeSummary(out), 'A $3.10 request, 26x the median');
});
