import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chipCount, compactCount, listWords, plural, shortAgo, shortSpan } from './format.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('a chip shows at most "99+"', () => {
  assert.deepEqual([0, 7, 99, 100, 4000].map(chipCount), ['0', '7', '99', '99+', '99+']);
  assert.equal(chipCount(-3), '0');
});

test('plural words', () => {
  assert.equal(plural(1, 'session'), '1 session');
  assert.equal(plural(0, 'session'), '0 sessions');
  assert.equal(plural(2, 'ticket'), '2 tickets');
  assert.equal(plural(3, 'reply', 'replies'), '3 replies');
});

test('how long ago: now under 45 s, then minutes, hours, days, months', () => {
  assert.equal(shortAgo(ago(20_000), NOW), 'now');
  assert.equal(shortAgo(ago(44_000), NOW), 'now');
  assert.equal(shortAgo(ago(60_000), NOW), '1m');
  assert.equal(shortAgo(ago(7 * 60_000), NOW), '7m');
  assert.equal(shortAgo(ago(3 * 3_600_000), NOW), '3h');
  assert.equal(shortAgo(ago(2 * 86_400_000), NOW), '2d');
  assert.equal(shortAgo(ago(90 * 86_400_000), NOW), '3mo');
  assert.equal(shortAgo(ago(-5000), NOW), 'now', 'a clock a little ahead is not the future');
  assert.equal(shortAgo(null, NOW), '');
  assert.equal(shortAgo('not a date', NOW), '');
});

test('parts joined for a title', () => {
  assert.equal(listWords(['2 approvals', '1 ticket', '1 failed run']), '2 approvals, 1 ticket and 1 failed run');
  assert.equal(listWords(['2 approvals', null, '1 failed run']), '2 approvals and 1 failed run');
  assert.equal(listWords([false, '1 ticket']), '1 ticket');
  assert.equal(listWords([]), '');
});

test('how long something has been going: under a minute, then minutes, hours, days (rounded down)', () => {
  assert.equal(shortSpan(ago(20_000), NOW), '<1m');
  assert.equal(shortSpan(ago(59_000), NOW), '<1m');
  assert.equal(shortSpan(ago(60_000), NOW), '1m');
  assert.equal(shortSpan(ago(119_000), NOW), '1m');
  assert.equal(shortSpan(ago(59 * 60_000), NOW), '59m');
  assert.equal(shortSpan(ago(3 * 3_600_000 + 1000), NOW), '3h');
  assert.equal(shortSpan(ago(50 * 3_600_000), NOW), '2d');
  assert.equal(shortSpan(undefined, NOW), '');
});

test('a count for a narrow place: whole below a thousand, then 1.2k, 15k, 2.4M', () => {
  assert.deepEqual([0, 7, 999, 1000, 1049, 1050, 9999, 10_000, 15_400, 999_999, 1_000_000, 2_400_000].map(compactCount), ['0', '7', '999', '1k', '1k', '1.1k', '10k', '10k', '15k', '1M', '1M', '2.4M']);
  assert.equal(compactCount(-5), '0');
});
