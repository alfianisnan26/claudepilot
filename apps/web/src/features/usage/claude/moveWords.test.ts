import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, measuredFigure, unavailableFigure, type MoveCandidate, type MoveRecommendation } from '@portal/contracts';
import { candidateOf, moveWords, noneWords, recommendedId } from './moveWords.js';

const clock = (iso: string) => iso.slice(11, 16);
const cand = (over: Partial<MoveCandidate>): MoveCandidate => ({
  claudeId: 'k',
  name: 'Kresna',
  workspaceId: 'docker/api',
  slot: 2,
  rank: 1,
  recommended: true,
  reason: 'room',
  basis: 'measured',
  leftPct: measuredFigure(65),
  window: { key: 'week', label: 'Week' },
  resetsAt: measuredFigure('2026-10-15T09:00:00Z'),
  availableAt: unavailableFigure('no_samples'),
  pace: estimatedFigure('under'),
  stale: false,
  checkedAt: '2026-10-12T05:00:00Z',
  ...over,
});
const advice = (candidates: MoveCandidate[], recommended: string | null, none: MoveRecommendation['none'] = null): MoveRecommendation => ({ now: '2026-10-12T05:00:00Z', workspaceId: 'docker/api', from: 'a', recommended, none, candidates });

test('the recommended Claude says how much room it has and when that resets', () => {
  // 35 % used of the week, so 65 % left; resets Thu 15 Oct 09:00.
  assert.equal(moveWords(cand({}), clock), '65 % left of Week, resets 09:00. The most room of the Claudes that can take this chat.');
});

test('a Claude that would run out at its own pace says so, and that it is an estimate', () => {
  const t = moveWords(cand({ reason: 'over_pace', basis: 'estimate', pace: estimatedFigure('over') }), clock)!;
  assert.ok(t.endsWith('At its current pace it would run out before it resets (an estimate).'), t);
});

test('no plan limits: a pool or a key has nothing to run out of', () => {
  assert.equal(moveWords(cand({ reason: 'no_limits', leftPct: unavailableFigure('no_limits'), window: null, resetsAt: unavailableFigure('no_limits') }), clock), 'No plan limits (a pool or an API key): nothing to run out of, billed per use.');
});

test('only the recommended one has words; a missing figure is not invented', () => {
  assert.equal(moveWords(cand({ recommended: false }), clock), null);
  assert.equal(moveWords(undefined, clock), null);
  assert.equal(moveWords(cand({ leftPct: unavailableFigure('no_reading'), resetsAt: unavailableFigure('no_reset_time'), window: null }), clock), 'Room of its fullest window. The most room of the Claudes that can take this chat.');
});

test('lookups and the one case worth a line', () => {
  const a = advice([cand({}), cand({ claudeId: 'n', recommended: false, rank: 2 })], 'k');
  assert.equal(recommendedId(a), 'k');
  assert.equal(recommendedId(null), null);
  assert.equal(candidateOf(a, 'n')?.rank, 2);
  assert.equal(candidateOf(a, 'zzz'), undefined);
  assert.equal(noneWords('all_tight'), 'Every Claude that can take it has under 20 % left.');
  assert.equal(noneWords('none_ready'), null);
  assert.equal(noneWords('no_other_claude'), null);
  assert.equal(noneWords(null), null);
});
