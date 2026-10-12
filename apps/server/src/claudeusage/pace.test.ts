// Pace and outlook (docs/prd/claude-usage.md §20.2): every expected value below was computed by hand and is written next to the fixture.
// No assertion exists only because the code produced it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageWindow, WindowPace } from '@portal/contracts';
import { nextResetOf, outlookOf, soonestOutlook, soonestReset, windowLengthMs, windowPace, type PaceInput } from './pace.js';
import { windowLevel } from './parse.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-10-12 00:00 UTC. Every fixture counts from here. */
const T0 = Date.UTC(2026, 9, 12, 0, 0, 0);
const at = (h: number, m = 0) => T0 + h * HOUR + m * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

/** A session window that resets at 04:00 (so its five hours began at 23:00 the day before). */
const RESET4 = at(4);
const sample = (ms: number, usedPct: number, resetsAtMs: number | null = RESET4) => ({ atMs: ms, usedPct, resetsAtMs });
const input = (over: Partial<PaceInput> & Pick<PaceInput, 'nowMs'>): PaceInput => ({
  key: 'session',
  usedPct: 20,
  resetsAtMs: RESET4,
  readAtMs: over.nowMs,
  samples: [],
  stale: false,
  ...over,
});
/** The figure's value, or its reason when there is none: reads well in an assertion. */
const v = (f: { value: unknown; reason?: string }) => (f.value === null ? `unavailable:${f.reason}` : f.value);

test('the owner’s example: 10 % then 20 % an hour later, 3 h to the reset of a 5 h window', () => {
  // Hand: speed (20 - 10) / 1 h = 10 points/h (two readings: first to last). Projected 20 + 10 x 3 h = 50 %. ETA 01:00 + 80 / 10 h = 09:00, after the 04:00 reset: under.
  // Even pace: the window began at 23:00, so at 01:00 two of five hours are gone: 40 %; 20 % used is 20 points behind.
  const p = windowPace(input({ nowMs: at(1), usedPct: 20, samples: [sample(at(0), 10), sample(at(1), 20)] }));
  assert.equal(v(p.speed), 10);
  assert.equal(p.speed.basis, 'estimate');
  assert.equal(v(p.projectedPct), 50);
  assert.equal(v(p.etaAt), iso(at(9)));
  assert.equal(v(p.status), 'under');
  assert.equal(v(p.evenPct), 40);
  assert.equal(v(p.aheadPts), -20);
  assert.deepEqual([p.readings, p.spanMin, p.method, p.lowConfidence], [2, 60, 'first_last', true], 'two readings are never enough to alert on');
});

test('three linear readings: 30 points/h, 130 % at the reset, out at 03:00, an hour before it', () => {
  // Hand: (00:00, 10) (00:30, 25) (01:00, 40). Least squares: x = 0, .5, 1 h, mean x .5, mean y 25; Sxy = (-.5)(-15) + 0 + (.5)(15) = 15; Sxx = .5; slope 30.
  // Projected 40 + 30 x 3 h = 130. ETA 01:00 + 60 / 30 h = 03:00 (< 04:00): over. Even pace 40 % = used: 0 points ahead.
  const p = windowPace(input({ nowMs: at(1), usedPct: 40, samples: [sample(at(0), 10), sample(at(0, 30), 25), sample(at(1), 40)] }));
  assert.equal(v(p.speed), 30);
  assert.equal(v(p.projectedPct), 130);
  assert.equal(v(p.etaAt), iso(at(3)));
  assert.equal(v(p.status), 'over');
  assert.equal(v(p.evenPct), 40);
  assert.equal(v(p.aheadPts), 0);
  assert.deepEqual([p.readings, p.spanMin, p.method, p.lowConfidence], [3, 60, 'least_squares', false], 'three readings over at least a tenth of the window (30 min)');
});

test('exactly 100 % at the reset is still under: only more than 100 runs out first', () => {
  // Hand: (00:00, 10) (01:00, 40) -> 30 points/h; used 40 at 01:00, 3 h to go: 40 + 90 = 130 is over; one hour to go (reset at 02:00): 40 + 30 = 70.
  // For exactly 100: used 40 at 01:00 with 2 h to the reset (03:00) at 30 points/h: 40 + 60 = 100.
  const p = windowPace(input({ nowMs: at(1), usedPct: 40, resetsAtMs: at(3), samples: [sample(at(0), 10, at(3)), sample(at(1), 40, at(3))] }));
  assert.equal(v(p.projectedPct), 100);
  assert.equal(v(p.status), 'under');
  assert.equal(v(p.etaAt), iso(at(3)), 'it would reach 100 at the reset itself');
});

test('least squares is not first to last: readings at 0 h, 1 h and 3 h of 10, 25 and 40 %', () => {
  // Hand: x = 0, 1, 3 h; mean x 4/3, mean y 25. Sxy = (-4/3)(-15) + (-1/3)(0) + (5/3)(15) = 20 + 0 + 25 = 45; Sxx = 16/9 + 1/9 + 25/9 = 14/3.
  // slope 45 / (14/3) = 135/14 = 9.642857 -> 9.6 (first to last would give 30 / 3 = 10). Projected 40 + 9.642857 x 1 h (reset 04:00) = 49.642857 -> 49.6.
  // ETA 03:00 + 60 / 9.642857 h = 03:00 + 6.2222 h = 09:13:20. Even pace: 4 of 5 hours gone = 80 %, so 40 points behind.
  const p = windowPace(input({ nowMs: at(3), usedPct: 40, samples: [sample(at(0), 10), sample(at(1), 25), sample(at(3), 40)] }));
  assert.equal(v(p.speed), 9.6);
  assert.equal(v(p.projectedPct), 49.6);
  assert.equal(v(p.etaAt), iso(at(9, 13) + 20_000));
  assert.equal(v(p.status), 'under');
  assert.equal(v(p.evenPct), 80);
  assert.equal(v(p.aheadPts), -40);
  assert.equal(p.method, 'least_squares');
  assert.equal(p.lowConfidence, false);
});

test('only the current period counts: readings of the period that just ended are left out', () => {
  // Hand: the old period (reset 23:00) read 80 % at 22:00 and 95 % at 22:50; the new one (reset 04:00) read 0 % at 23:10, 5 % at 23:40 and 10 % at 00:10.
  // Only the new three: x = 0, .5, 1 h of 0, 5, 10: slope 10 points/h (with the old ones the line would fall steeply). Projected 10 + 10 x (3 h 50 m = 3.8333 h) = 48.3.
  // ETA 00:10 + 90 / 10 h = 09:10. Even pace: 1 h 10 m of 5 h = 23.33 % -> 23.3, so 10 - 23.33 = -13.3.
  const old = at(23) - DAY;
  const p = windowPace(
    input({
      nowMs: at(0, 10),
      usedPct: 10,
      samples: [sample(at(22) - DAY, 80, old), sample(at(22, 50) - DAY, 95, old), sample(at(23, 10) - DAY, 0), sample(at(23, 40) - DAY, 5), sample(at(0, 10), 10)],
    }),
  );
  assert.equal(v(p.speed), 10);
  assert.equal(p.readings, 3);
  assert.equal(v(p.projectedPct), 48.3);
  assert.equal(v(p.etaAt), iso(at(9, 10)));
  assert.equal(v(p.evenPct), 23.3);
  assert.equal(v(p.aheadPts), -13.3);
});

test('a reset time a few seconds off is the same period (one source rounds to the second, another to the microsecond)', () => {
  const p = windowPace(input({ nowMs: at(1), usedPct: 20, samples: [sample(at(0), 10, RESET4 + 400), sample(at(1), 20, RESET4 - 400)] }));
  assert.equal(v(p.speed), 10);
});

test('the latest reading counts at its own time when it was not stored (an unchanged percent is kept only every 30 minutes)', () => {
  // Hand: stored (00:00, 10) and (01:00, 20); the reading at 01:40 still says 20 and was not stored. x = 0, 1, 1.6667 h: mean x 0.8889, mean y 16.667;
  // Sxy = (-.8889)(-6.667) + (.1111)(3.333) + (.7778)(3.333) = 5.926 + .3704 + 2.5926 = 8.889; Sxx = .7901 + .01235 + .6049 = 1.4074; slope 6.3158 -> 6.3.
  const p = windowPace(input({ nowMs: at(1, 40), readAtMs: at(1, 40), usedPct: 20, samples: [sample(at(0), 10), sample(at(1), 20)] }));
  assert.equal(p.readings, 3);
  assert.equal(v(p.speed), 6.3);
});

test('one reading: no speed, but the even pace stands on the window alone', () => {
  // Hand: reset 05:00, now 01:00: the window began at 00:00, one of five hours gone = 20 %; 12 % used is 8 points behind.
  const p = windowPace(input({ nowMs: at(1), usedPct: 12, resetsAtMs: at(5), samples: [] }));
  for (const f of [p.speed, p.projectedPct, p.etaAt, p.status]) assert.equal(v(f), 'unavailable:single_sample');
  assert.equal(v(p.evenPct), 20);
  assert.equal(v(p.aheadPts), -8);
  assert.deepEqual([p.readings, p.method, p.lowConfidence], [1, null, true]);
});

test('readings under ten minutes apart say nothing about a rate', () => {
  // Hand: (00:55, 10) and (01:00, 12): five minutes. One point of rounding would read as 24 points/h.
  const p = windowPace(input({ nowMs: at(1), usedPct: 12, samples: [sample(at(0, 55), 10)] }));
  assert.equal(v(p.speed), 'unavailable:short_span');
  assert.equal(v(p.status), 'unavailable:short_span');
  assert.equal(p.spanMin, 5);
  assert.notEqual(v(p.evenPct), 'unavailable:short_span', 'the even pace does not need a span');
});

test('a window that is not filling has speed 0, stays under, and never reaches 100', () => {
  // Hand: 20, 20, 20 % at 00:00, 00:30 and 01:00: the slope is 0. Projected 20 + 0 = 20.
  const p = windowPace(input({ nowMs: at(1), usedPct: 20, samples: [sample(at(0), 20), sample(at(0, 30), 20)] }));
  assert.equal(v(p.speed), 0);
  assert.equal(p.speed.basis, 'estimate');
  assert.equal(v(p.projectedPct), 20);
  assert.equal(v(p.status), 'under');
  assert.equal(v(p.etaAt), 'unavailable:no_growth');
});

test('the same fractional percent every time is zero speed, not a rounding-error fall', () => {
  // 33.3 three times: the mean of three equal fractions can differ from them in the last bit, which must not read as "decreasing".
  const p = windowPace(input({ nowMs: at(1), usedPct: 33.3, samples: [sample(at(0), 33.3), sample(at(0, 20), 33.3), sample(at(0, 40), 33.3)] }));
  assert.equal(v(p.speed), 0);
  assert.equal(v(p.projectedPct), 33.3);
  assert.equal(v(p.status), 'under');
});

test('a percentage that fell inside the period gives no rate', () => {
  // Hand: 30, 28, 27 % at 00:00, 00:30, 01:00. mean y 28.333; Sxy = (-.5)(1.667) + 0 + (.5)(-1.333) = -1.5; Sxx = .5: slope -3 points/h.
  const p = windowPace(input({ nowMs: at(1), usedPct: 27, samples: [sample(at(0), 30), sample(at(0, 30), 28)] }));
  assert.equal(v(p.speed), 'unavailable:decreasing');
  assert.equal(v(p.projectedPct), 'unavailable:decreasing');
  assert.equal(v(p.status), 'unavailable:decreasing');
  assert.equal(p.lowConfidence, true);
});

test('what a reading lacks is said, not guessed', () => {
  const base = { nowMs: at(1), samples: [sample(at(0), 10), sample(at(1), 20)] };
  assert.equal(v(windowPace(input({ ...base, usedPct: null })).speed), 'unavailable:no_number');
  assert.equal(v(windowPace(input({ ...base, readAtMs: null })).speed), 'unavailable:no_reading');
  assert.equal(v(windowPace(input({ ...base, resetsAtMs: null })).speed), 'unavailable:no_reset_time');
  assert.equal(v(windowPace(input({ ...base, resetsAtMs: at(1) })).speed), 'unavailable:period_reset', 'the reset time is now');
  assert.equal(v(windowPace(input({ ...base, resetsAtMs: at(0, 30), readAtMs: at(0, 20) })).speed), 'unavailable:period_reset', 'the reset time has passed');
  assert.equal(v(windowPace(input({ ...base, stale: true })).speed), 'unavailable:stale');
  // The clock went back: a reading dated two hours after now.
  assert.equal(v(windowPace(input({ ...base, readAtMs: at(3) })).speed), 'unavailable:clock_skew');
  assert.equal(v(windowPace(input({ nowMs: at(1), usedPct: 20, samples: [sample(at(0), 10), sample(at(2), 30)] })).speed), 'unavailable:clock_skew', 'a stored reading from the future');
  assert.equal(v(windowPace(input({ ...base, usedPct: null })).evenPct), 'unavailable:no_number');
});

test('a window used up: the reading is the answer (measured), the rate is only a bonus', () => {
  // Hand: 80, 90 and 100 % at 00:00, 00:30 and 01:00: slope 20 points/h; the status needs no estimate.
  const p = windowPace(input({ nowMs: at(1), usedPct: 100, samples: [sample(at(0), 80), sample(at(0, 30), 90)] }));
  assert.equal(v(p.status), 'exhausted');
  assert.equal(p.status.basis, 'measured');
  assert.equal(v(p.projectedPct), 100);
  assert.equal(v(p.etaAt), iso(at(1)), 'already there at the reading');
  assert.equal(v(p.speed), 20);
});

test('a week: 5 of 7 days to go, 30 % used, an even spend would be 28.6 %', () => {
  // Hand: the week began 2 days ago: 2/7 = 28.571 % -> 28.6; 30 - 28.571 = 1.43 -> 1.4 points ahead.
  // Two readings 12 h apart, 28 % then 30 %: 2 / 12 = 0.1667 points/h -> 0.2; projected 30 + 0.1667 x 120 h = 50.0; ETA 70 / 0.1667 = 420 h = 17.5 days: after the reset: under.
  const reset = at(0) + 5 * DAY;
  const p = windowPace({
    key: 'week',
    usedPct: 30,
    resetsAtMs: reset,
    readAtMs: at(0),
    nowMs: at(0),
    stale: false,
    samples: [sample(at(0) - 12 * HOUR, 28, reset), sample(at(0), 30, reset)],
  });
  assert.equal(v(p.speed), 0.2);
  assert.equal(v(p.projectedPct), 50);
  assert.equal(v(p.status), 'under');
  assert.equal(v(p.etaAt), iso(at(0) + 420 * HOUR));
  assert.equal(v(p.evenPct), 28.6);
  assert.equal(v(p.aheadPts), 1.4);
});

test('confidence scales with the window: a week needs 16.8 h of readings, a session 30 minutes', () => {
  const reset = at(0) + 5 * DAY;
  const week = (spanH: number) =>
    windowPace({
      key: 'week',
      usedPct: 30,
      resetsAtMs: reset,
      readAtMs: at(0),
      nowMs: at(0),
      stale: false,
      samples: [sample(at(0) - spanH * HOUR, 20, reset), sample(at(0) - (spanH / 2) * HOUR, 25, reset), sample(at(0), 30, reset)],
    });
  assert.equal(week(12).lowConfidence, true, '12 h < a tenth of 7 days (16.8 h)');
  assert.equal(week(20).lowConfidence, false, '20 h >= 16.8 h');
  const session = (spanMin: number) => windowPace(input({ nowMs: at(1), usedPct: 40, samples: [sample(at(1) - spanMin * MIN, 10), sample(at(1) - (spanMin / 2) * MIN, 25)] }));
  assert.equal(session(20).lowConfidence, true, '20 min < a tenth of 5 h (30 min)');
  assert.equal(session(30).lowConfidence, false);
});

test('a window Claude Code names itself has no known length: speed yes, even pace no', () => {
  assert.deepEqual(['session', 'week', 'week_opus', 'week_sonnet', 'week_apps', 'week_models', 'model:fable', 'other:surface'].map(windowLengthMs), [5 * HOUR, 7 * DAY, 7 * DAY, 7 * DAY, 7 * DAY, 7 * DAY, 7 * DAY, null]);
  const p = windowPace(input({ key: 'other:surface', nowMs: at(1), usedPct: 20, samples: [sample(at(0), 10), sample(at(1), 20)] }));
  assert.equal(v(p.speed), 10);
  assert.equal(v(p.evenPct), 'unavailable:window_length_unknown');
  assert.equal(v(p.aheadPts), 'unavailable:window_length_unknown');
});

/* ---------- Outlook ---------- */

/** A window as the snapshot shows it: its level at `now`, its pace from the readings. */
function view(key: string, label: string, usedPct: number | null, resetsAtMs: number | null, nowMs: number, samples: ReturnType<typeof sample>[] = []): ClaudeUsageWindow {
  const pace: WindowPace = windowPace({ key, usedPct, resetsAtMs, readAtMs: nowMs, samples, nowMs, stale: false });
  return { key, label, usedPct, resetsAt: resetsAtMs === null ? null : iso(resetsAtMs), level: windowLevel(usedPct, resetsAtMs, nowMs), pace };
}
const NOW = at(1);
const CHECKED = iso(NOW);
/** Out at 03:00, an hour before the 04:00 reset (the three linear readings above). */
const overSession = () => view('session', 'Session', 40, RESET4, NOW, [sample(at(0), 10), sample(at(0, 30), 25), sample(at(1), 40)]);
/** A week at 30 %, 0.2 points/h: under. */
const underWeek = () => {
  const reset = NOW + 5 * DAY;
  return view('week', 'Week', 30, reset, NOW, [sample(NOW - 12 * HOUR, 28, reset), sample(NOW, 30, reset)]);
};

test('outlook: a plan whose session runs out before it resets is over, and names that window and its ETA', () => {
  const o = outlookOf({ runsOn: 'plan', windows: [overSession(), underWeek()], checkedAt: CHECKED });
  assert.equal(v(o.status), 'over');
  assert.equal(o.window?.key, 'session');
  assert.equal(v(o.etaAt), iso(at(3)));
  assert.equal(v(o.projectedPct), 130);
});

test('outlook: of two windows that run out, the earlier ETA decides', () => {
  // Hand: the session runs out at 03:00 (above). The week read 50, 70 and 90 % at 00:00, 00:30 and 01:00: 40 points/h, so it reaches 100 at 01:00 + 10 / 40 h = 01:15.
  const reset = NOW + 2 * DAY;
  const week = view('week', 'Week', 90, reset, NOW, [sample(at(0), 50, reset), sample(at(0, 30), 70, reset), sample(NOW, 90, reset)]);
  const o = outlookOf({ runsOn: 'plan', windows: [overSession(), week], checkedAt: CHECKED });
  assert.equal(o.window?.key, 'week');
  assert.equal(v(o.etaAt), iso(at(1, 15)));
});

test('outlook: under when none runs out, with the fullest window; a model’s own week does not count', () => {
  const opus = view('week_opus', 'Opus', 99, NOW + 3 * DAY, NOW, [sample(at(0), 60, NOW + 3 * DAY), sample(NOW, 99, NOW + 3 * DAY)]);
  const o = outlookOf({ runsOn: 'plan', windows: [view('session', 'Session', 12, RESET4, NOW, [sample(at(0), 12), sample(NOW, 12)]), underWeek(), opus], checkedAt: CHECKED });
  assert.equal(v(o.status), 'under');
  assert.equal(o.window?.key, 'week', '30 % is fuller than 12 %; Opus at 99 % is not a limit that stops the Claude');
});

test('outlook: a window used up is exhausted (measured), and the one that holds longest decides', () => {
  const week = view('week', 'Week', 100, NOW + 3 * DAY, NOW);
  const session = view('session', 'Session', 100, RESET4, NOW);
  const o = outlookOf({ runsOn: 'plan', windows: [session, week], checkedAt: CHECKED });
  assert.equal(v(o.status), 'exhausted');
  assert.equal(o.status.basis, 'measured');
  assert.equal(o.window?.key, 'week');
  assert.equal(v(o.etaAt), CHECKED);
});

test('outlook: every way there is nothing to say names why', () => {
  const none = (runsOn: 'pool' | 'key' | 'none' | 'unknown') => v(outlookOf({ runsOn, windows: [], checkedAt: null }).status);
  assert.deepEqual(['pool', 'key', 'none', 'unknown'].map((r) => none(r as 'pool')), ['unavailable:no_limits', 'unavailable:no_limits', 'unavailable:signed_out', 'unavailable:no_reading']);
  assert.equal(v(outlookOf({ runsOn: 'plan', windows: [], checkedAt: null }).status), 'unavailable:no_reading');
  assert.equal(v(outlookOf({ runsOn: 'plan', windows: [view('week_opus', 'Opus', 10, NOW + DAY, NOW)], checkedAt: CHECKED }).status), 'unavailable:no_window');
  assert.equal(v(outlookOf({ runsOn: 'plan', windows: [view('session', 'Session', 10, NOW - HOUR, NOW)], checkedAt: CHECKED }).status), 'unavailable:period_reset');
  // A plan with a percent but a single reading: no pace, and the reason of the fullest window.
  const lone = outlookOf({ runsOn: 'plan', windows: [view('session', 'Session', 12, RESET4, NOW)], checkedAt: CHECKED });
  assert.equal(v(lone.status), 'unavailable:single_sample');
  assert.equal(lone.window?.key, 'session');
});

test('next reset: the soonest window that has not reset yet, else why not', () => {
  const windows = [view('week', 'Week', 30, NOW + 3 * DAY, NOW), view('session', 'Session', 12, RESET4, NOW)];
  const n = nextResetOf({ runsOn: 'plan', windows, checkedAt: CHECKED }, NOW);
  assert.equal(v(n.at), iso(RESET4));
  assert.equal(n.at.basis, 'measured');
  assert.equal(n.window?.key, 'session');
  assert.equal(v(nextResetOf({ runsOn: 'plan', windows, checkedAt: CHECKED }, RESET4 + 4 * DAY).at), 'unavailable:period_reset');
  assert.equal(v(nextResetOf({ runsOn: 'key', windows: [], checkedAt: null }, NOW).at), 'unavailable:no_limits');
  assert.equal(v(nextResetOf({ runsOn: 'plan', windows: [view('session', 'Session', 5, null, NOW)], checkedAt: CHECKED }, NOW).at), 'unavailable:no_reset_time');
});

test('several Claudes as one: the soonest to run out, else the fullest under, else an exhausted one', () => {
  const claude = (id: string, windows: ClaudeUsageWindow[]) => ({ id, outlook: outlookOf({ runsOn: 'plan', windows, checkedAt: CHECKED }), nextReset: nextResetOf({ runsOn: 'plan', windows, checkedAt: CHECKED }, NOW) });
  const a = claude('over', [overSession()]);
  const b = claude('under', [underWeek()]);
  const c = claude('out', [view('session', 'Session', 100, RESET4, NOW)]);
  assert.equal(soonestOutlook([b, c, a]).from?.id, 'over');
  assert.equal(soonestOutlook([c, b]).from?.id, 'under', 'an exhausted Claude does not hide one that has room');
  assert.equal(soonestOutlook([c]).from?.id, 'out');
  assert.equal(soonestOutlook([]).from, null);
  assert.equal(v(soonestOutlook([]).outlook.status), 'unavailable:no_reading');
  assert.equal(soonestReset([b, a]).from?.id, 'over', 'the session resets at 04:00, before the week');
});
