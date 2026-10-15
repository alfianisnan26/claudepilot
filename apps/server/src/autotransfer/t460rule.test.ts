// T-460: the one projection rule `autoMoveLeaves` (decide.ts): which Claudes auto move would leave. The spawn picker (chat/agents.test.ts) and
// the supervisor (`GET /api/autotransfer/leaving`, t460supervisor.test.ts) use it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsage, ClaudeUsageWindow } from '@portal/contracts';
import { autoMoveLeaves } from './decide.js';
import { T0, at, usage, win } from './testkit.js';

/** The Event lead's Claude at 22 % left, projected to 143 % at the reset, out of quota within the hour (T-460). */
const projectedOut = (id: string): ClaudeUsage => {
  const f = (value: number | string, basis = 'estimate') => ({ value, basis });
  const w = {
    ...win('session', 78, at(180)),
    pace: { speed: f(1), projectedPct: f(143), etaAt: f(at(60)), status: f('over'), evenPct: f(40), aheadPts: f(30), readings: 6, spanMin: 60, method: 'least_squares', lowConfidence: false },
  } as ClaudeUsageWindow;
  return usage(id, id, [w]);
};

test('T-460: autoMoveLeaves, the one projection rule: at the threshold, exhausted, or projected out within the horizon; not otherwise', () => {
  const now = T0;
  assert.equal(autoMoveLeaves(usage('a', 'a', [win('session', 92)]), null, now), true, '8 % left: at or under the threshold');
  assert.equal(autoMoveLeaves(usage('a', 'a', [win('session', 100)]), null, now), true, 'exhausted');
  assert.equal(autoMoveLeaves(usage('a', 'a', [win('session', 50)]), null, now), false, 'room');
  assert.equal(autoMoveLeaves(projectedOut('a'), null, now), true, '22 % left but projected out within the hour: auto move leaves it');
  const off = { thresholdPct: 10, useProjection: false, respectPace: true, paceMinPct: 90 };
  assert.equal(autoMoveLeaves(projectedOut('a'), null, now, off), false, 'with the projection rule off it stays');
  assert.equal(autoMoveLeaves(usage('a', 'a', [win('session', 80)]), null, now, { ...off, thresholdPct: 25 }), true, 'a higher threshold counts');
  assert.equal(autoMoveLeaves(usage('a', 'a', []), null, now), false, 'no reading: not a Claude auto move leaves');
});
