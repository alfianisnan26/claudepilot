import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CronError, cronProblem, nextRuns, parseCron, startOfLocalDay } from './cron.js';

const iso = (ms: number[]) => ms.map((x) => new Date(x).toISOString().replace(':00.000Z', 'Z'));
const runs = (expr: string, tz: string, after: string, n: number) => iso(nextRuns(expr, tz, Date.parse(after), n));

// docs/prd/triggers.md §10: every line of the table, worked out by the brute-force reference over Intl (scratchpad/pn-spike/cron-ref.mjs).
describe('cron: the §10 table, line for line', () => {
  it('30 2 * * * America/New_York: 02:30 does not exist on 2026-03-08, fires at 03:00 EDT right after the gap', () => {
    assert.deepEqual(runs('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z', 3), ['2026-03-08T07:00Z', '2026-03-09T06:30Z', '2026-03-10T06:30Z']);
  });
  it('30 1 * * * America/New_York: 01:30 happens twice on 2026-11-01, fires once at the first (EDT)', () => {
    assert.deepEqual(runs('30 1 * * *', 'America/New_York', '2026-10-31T12:00:00Z', 3), ['2026-11-01T05:30Z', '2026-11-02T06:30Z', '2026-11-03T06:30Z']);
  });
  it('0 9 * * 1-5 Asia/Jakarta (UTC+7, no clock changes)', () => {
    assert.deepEqual(runs('0 9 * * 1-5', 'Asia/Jakarta', '2026-10-12T00:00:00Z', 4), ['2026-10-12T02:00Z', '2026-10-13T02:00Z', '2026-10-14T02:00Z', '2026-10-15T02:00Z']);
  });
  it('0 0 13 * 5 UTC: the 13th OR any Friday (POSIX)', () => {
    assert.deepEqual(runs('0 0 13 * 5', 'UTC', '2026-10-12T00:00:00Z', 6), [
      '2026-10-13T00:00Z',
      '2026-10-16T00:00Z',
      '2026-10-23T00:00Z',
      '2026-10-30T00:00Z',
      '2026-11-06T00:00Z',
      '2026-11-13T00:00Z',
    ]);
  });
  it('15 2 * * * Australia/Lord_Howe: a 30 minute change, 02:15 does not exist on 2026-10-04', () => {
    assert.deepEqual(runs('15 2 * * *', 'Australia/Lord_Howe', '2026-10-03T00:00:00Z', 3), ['2026-10-03T15:30Z', '2026-10-04T15:15Z', '2026-10-05T15:15Z']);
  });
  it('*/30 0-3 * * * Europe/London: 01:00 to 02:00 happens twice on 2026-10-25, each wall time fires once', () => {
    assert.deepEqual(runs('*/30 0-3 * * *', 'Europe/London', '2026-10-24T23:00:00Z', 8), [
      '2026-10-24T23:30Z',
      '2026-10-25T00:00Z',
      '2026-10-25T00:30Z',
      '2026-10-25T02:00Z',
      '2026-10-25T02:30Z',
      '2026-10-25T03:00Z',
      '2026-10-25T03:30Z',
      '2026-10-26T00:00Z',
    ]);
  });
  it('*/15 9,17 1,15 * * UTC: steps and lists', () => {
    assert.deepEqual(runs('*/15 9,17 1,15 * *', 'UTC', '2026-10-12T00:00:00Z', 5), ['2026-10-15T09:00Z', '2026-10-15T09:15Z', '2026-10-15T09:30Z', '2026-10-15T09:45Z', '2026-10-15T17:00Z']);
  });
});

describe('cron: grammar', () => {
  it('7 is Sunday, and names in any case', () => {
    // 2026-10-18 is a Sunday.
    assert.deepEqual(runs('0 12 * * 7', 'UTC', '2026-10-12T00:00:00Z', 1), ['2026-10-18T12:00Z']);
    assert.deepEqual(runs('0 12 * * sun', 'UTC', '2026-10-12T00:00:00Z', 1), ['2026-10-18T12:00Z']);
    assert.deepEqual(runs('0 12 1 dec *', 'UTC', '2026-10-12T00:00:00Z', 1), ['2026-12-01T12:00Z']);
    assert.deepEqual(parseCron('0 0 * * MON-FRI').dow.values, [1, 2, 3, 4, 5]);
    assert.deepEqual(parseCron('0 0 * * 5-7').dow.values, [0, 5, 6]);
  });
  it('steps: a-b/n and a/n', () => {
    assert.deepEqual(parseCron('10-30/10 * * * *').minute.values, [10, 20, 30]);
    assert.deepEqual(parseCron('50/5 * * * *').minute.values, [50, 55]);
    assert.deepEqual(parseCron('*/20 * * * *').minute.values, [0, 20, 40]);
  });
  it('a restricted day of month with a * weekday is AND (only the day of month counts)', () => {
    assert.deepEqual(runs('0 0 13 * *', 'UTC', '2026-10-12T00:00:00Z', 2), ['2026-10-13T00:00Z', '2026-11-13T00:00Z']);
    // */2 in the weekday field starts with * : still unrestricted for the OR rule (Vixie's reading).
    assert.deepEqual(runs('0 0 13 * */2', 'UTC', '2026-10-12T00:00:00Z', 1), ['2026-10-13T00:00Z']);
  });
  it('refuses what is not supported, with a message', () => {
    for (const bad of ['0 0 * * * *', '@hourly', '0 0 L * *', '0 0 15W * *', '0 0 * * 5#2', '0 0 ? * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '5-1 * * * *', '*/0 * * * *', '* * *', 'a b c d e', '1,,2 * * * *'])
      assert.throws(() => parseCron(bad), CronError, bad);
  });
  it('a schedule that never fires and an unknown zone are problems at save', () => {
    assert.equal(cronProblem('0 0 31 2 *', 'UTC'), 'That schedule never fires.');
    assert.equal(cronProblem('0 0 * * *', 'Mars/Olympus'), 'Pick a known time zone.');
    assert.equal(cronProblem('0 0 * * *', 'Asia/Jakarta'), null);
    assert.match(cronProblem('0 0 * * * *', 'UTC')!, /seconds/);
  });
  it('29 February is found years ahead', () => {
    assert.deepEqual(runs('0 0 29 2 *', 'UTC', '2026-10-12T00:00:00Z', 1), ['2028-02-29T00:00Z']);
  });
  it('a late tick: the next time is computed from now, so missed times never burst', () => {
    // Every 5 minutes; the portal looks 17 minutes late: the next is the one after now, not the three it missed.
    assert.deepEqual(runs('*/5 * * * *', 'UTC', '2026-10-12T10:17:00Z', 1), ['2026-10-12T10:20Z']);
  });
  it('the start of a local day', () => {
    assert.equal(new Date(startOfLocalDay('Asia/Jakarta', Date.parse('2026-10-12T20:00:00Z'))).toISOString(), '2026-10-12T17:00:00.000Z');
    assert.equal(new Date(startOfLocalDay('UTC', Date.parse('2026-10-12T20:00:00Z'))).toISOString(), '2026-10-12T00:00:00.000Z');
  });
});
