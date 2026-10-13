import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, HOUR, isTimeZone, offsetMs, periodBounds } from './periods.js';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

test('time zone names: real ones pass, rubbish does not', () => {
  assert.equal(isTimeZone('UTC'), true);
  assert.equal(isTimeZone('Asia/Jakarta'), true);
  assert.equal(isTimeZone('America/New_York'), true);
  assert.equal(isTimeZone('Mars/Base'), false);
  assert.equal(isTimeZone(''), false);
  assert.equal(isTimeZone(12), false);
  assert.equal(isTimeZone('x'.repeat(65)), false);
});

test('the offset: Jakarta is 7 hours ahead all year, New York 5 in winter and 4 in summer (hand-checked)', () => {
  assert.equal(offsetMs('Asia/Jakarta', at(2026, 10, 12)), 7 * HOUR);
  assert.equal(offsetMs('Asia/Jakarta', at(2026, 1, 12)), 7 * HOUR);
  assert.equal(offsetMs('America/New_York', at(2026, 1, 15, 12)), -5 * HOUR);
  assert.equal(offsetMs('America/New_York', at(2026, 7, 15, 12)), -4 * HOUR);
  assert.equal(offsetMs('UTC', at(2026, 7, 15, 12, 0) + 123), 0, 'a time that is not on a whole second is read on its second');
});

test('UTC: the day is midnight to midnight, the month the 1st to the 1st', () => {
  const t = at(2026, 10, 12, 5, 30);
  assert.deepEqual(periodBounds('day', 'UTC', t), { start: at(2026, 10, 12), end: at(2026, 10, 13) });
  assert.deepEqual(periodBounds('month', 'UTC', t), { start: at(2026, 10, 1), end: at(2026, 11, 1) });
  // The first instant of a period belongs to it; the last millisecond of the one before does not.
  assert.deepEqual(periodBounds('day', 'UTC', at(2026, 10, 12)), { start: at(2026, 10, 12), end: at(2026, 10, 13) });
  assert.deepEqual(periodBounds('day', 'UTC', at(2026, 10, 12) - 1), { start: at(2026, 10, 11), end: at(2026, 10, 12) });
  // December rolls into the next year.
  assert.deepEqual(periodBounds('month', 'UTC', at(2026, 12, 31, 23, 59)), { start: at(2026, 12, 1), end: at(2027, 1, 1) });
});

test('Jakarta (UTC+7): 20:00 UTC on the 12th is 03:00 on the 13th there, so the day is 17:00 UTC to 17:00 UTC', () => {
  assert.deepEqual(periodBounds('day', 'Asia/Jakarta', at(2026, 10, 12, 20)), { start: at(2026, 10, 12, 17), end: at(2026, 10, 13, 17) });
  // 18:00 UTC on the 31st is 01:00 on 1 November there: that month starts at 17:00 UTC on the 31st and ends 30 days later.
  assert.deepEqual(periodBounds('month', 'Asia/Jakarta', at(2026, 10, 31, 18)), { start: at(2026, 10, 31, 17), end: at(2026, 11, 30, 17) });
});

test('New York: the day the clocks go forward has 23 hours, the day they go back 25 (US rules for 2026: 8 March and 1 November)', () => {
  // 8 March 2026, 12:00 UTC is 08:00 EDT. The day began at 00:00 EST (05:00 UTC) and ends at 00:00 EDT on the 9th (04:00 UTC).
  const spring = periodBounds('day', 'America/New_York', at(2026, 3, 8, 12));
  assert.deepEqual(spring, { start: at(2026, 3, 8, 5), end: at(2026, 3, 9, 4) });
  assert.equal(spring.end - spring.start, DAY - HOUR);
  // 1 November 2026, 12:00 UTC is 07:00 EST. The day began at 00:00 EDT (04:00 UTC) and ends at 00:00 EST on the 2nd (05:00 UTC).
  const autumn = periodBounds('day', 'America/New_York', at(2026, 11, 1, 12));
  assert.deepEqual(autumn, { start: at(2026, 11, 1, 4), end: at(2026, 11, 2, 5) });
  assert.equal(autumn.end - autumn.start, DAY + HOUR);
  // November as a month: from 00:00 EDT on the 1st (04:00 UTC) to 00:00 EST on 1 December (05:00 UTC).
  assert.deepEqual(periodBounds('month', 'America/New_York', at(2026, 11, 15, 12)), { start: at(2026, 11, 1, 4), end: at(2026, 12, 1, 5) });
  // Just before the spring change, still on the 7th's evening (EST): the day is the 7th.
  assert.deepEqual(periodBounds('day', 'America/New_York', at(2026, 3, 8, 4, 59)), { start: at(2026, 3, 7, 5), end: at(2026, 3, 8, 5) });
});

test('the week starts on Monday at midnight in the zone (2026-10-12 is a Monday, hand-checked)', () => {
  // Wednesday the 14th at 05:30 UTC: Monday the 12th to Monday the 19th.
  assert.deepEqual(periodBounds('week', 'UTC', at(2026, 10, 14, 5, 30)), { start: at(2026, 10, 12), end: at(2026, 10, 19) });
  // Monday's first instant is in its own week; Sunday's last millisecond is in the week before.
  assert.deepEqual(periodBounds('week', 'UTC', at(2026, 10, 12)), { start: at(2026, 10, 12), end: at(2026, 10, 19) });
  assert.deepEqual(periodBounds('week', 'UTC', at(2026, 10, 12) - 1), { start: at(2026, 10, 5), end: at(2026, 10, 12) });
  // Jakarta: 18:00 UTC on Sunday the 11th is 01:00 on Monday the 12th there, so the week began at 17:00 UTC on the 11th.
  assert.deepEqual(periodBounds('week', 'Asia/Jakarta', at(2026, 10, 11, 18)), { start: at(2026, 10, 11, 17), end: at(2026, 10, 18, 17) });
  // A week across the year's end.
  assert.deepEqual(periodBounds('week', 'UTC', at(2027, 1, 1, 12)), { start: at(2026, 12, 28), end: at(2027, 1, 4) });
});
