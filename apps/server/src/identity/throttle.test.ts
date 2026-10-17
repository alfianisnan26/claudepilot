import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCKOUT_RULES, Throttle, fingerprint, lockMsFor } from './throttle.js';
import { memoryDb } from './testkit.js';

function make() {
  let now = 1_700_000_000_000;
  const db = memoryDb();
  const t = new Throttle(() => db, () => now);
  return { t, db, tick: (ms: number) => (now += ms), now: () => now };
}

test('the per-username lock doubles from 30 s at the 5th failure to the 15-minute ceiling at the 10th (hand-computed, FR20)', () => {
  const rule = LOCKOUT_RULES.user;
  assert.deepEqual([1, 2, 3, 4].map((n) => lockMsFor(rule, n)), [0, 0, 0, 0]);
  assert.deepEqual([5, 6, 7, 8, 9, 10, 11, 20].map((n) => lockMsFor(rule, n) / 1000), [30, 60, 120, 240, 480, 900, 900, 900]);
  assert.equal(lockMsFor(LOCKOUT_RULES.ip, 19), 0);
  assert.equal(lockMsFor(LOCKOUT_RULES.ip, 20) / 60_000, 10);
  assert.equal(lockMsFor(LOCKOUT_RULES.ip, 40) / 60_000, 10, 'per address is flat');
});

test('failures lock after the threshold, the lock is seen without a read, and the next failure after it doubles', () => {
  const { t, tick } = make();
  const key = fingerprint('alice');
  for (let i = 1; i <= 4; i++) assert.equal(t.fail('user', key), 0, `failure ${i} does not lock`);
  assert.equal(t.retryAfter('user', key), 0);
  assert.equal(t.fail('user', key), 30_000, 'the 5th locks for 30 s');
  assert.equal(t.retryAfter('user', key), 30);
  assert.throws(() => t.assertOpen('user', key), (e: { code: string; status: number; details?: { retryAfter: number } }) => e.code === 'LOCKED_OUT' && e.status === 429 && e.details?.retryAfter === 30);
  tick(10_000);
  assert.equal(t.retryAfter('user', key), 20);
  tick(20_000);
  assert.equal(t.retryAfter('user', key), 0, 'the lock has ended');
  assert.equal(t.fail('user', key), 60_000, 'the 6th failure locks for 60 s');
  tick(60_000);
  assert.equal(t.fail('user', key), 120_000);
  tick(120_000);
  assert.equal(t.fail('user', key), 240_000);
  tick(240_000);
  assert.equal(t.fail('user', key), 480_000);
  tick(480_000);
  assert.equal(t.fail('user', key), 900_000, 'the 10th hits the ceiling');
  tick(900_000);
  assert.equal(t.fail('user', key), 900_000, 'and stays there');
});

test('the window restarts at every lock: staying away for the whole window starts over, a success clears everything', () => {
  const { t, tick } = make();
  const key = fingerprint('bob');
  for (let i = 0; i < 5; i++) t.fail('user', key);
  tick(15 * 60_000 + 1);
  assert.equal(t.retryAfter('user', key), 0);
  assert.equal(t.fail('user', key), 0, 'a new window: failure 1 again');
  for (let i = 0; i < 3; i++) t.fail('user', key);
  t.reset('user', key);
  assert.equal(t.fail('user', key), 0, 'after a success the count is 1');
});

test('counters survive a restart (they are rows), and a locked key is remembered in memory until it expires', () => {
  const { t, db, tick, now } = make();
  for (let i = 0; i < 5; i++) t.fail('user', 'k');
  const again = new Throttle(() => db, now);
  assert.equal(again.retryAfter('user', 'k'), 30, 'a fresh instance reads the lock from the table');
  db.prepare('DELETE FROM auth_throttle').run();
  assert.equal(again.retryAfter('user', 'k'), 30, 'the lock is held in memory: no read needed');
  tick(31_000);
  assert.equal(again.retryAfter('user', 'k'), 0);
  assert.equal(t.retryAfter('user', 'k'), 0);
});

test('per address: 20 failures in 10 minutes block for 10 minutes (I2), one name from 30 addresses locks at 5 (I3)', () => {
  const { t } = make();
  for (let i = 1; i <= 19; i++) assert.equal(t.fail('ip', '10.0.0.1'), 0);
  assert.equal(t.fail('ip', '10.0.0.1'), 10 * 60_000);
  assert.equal(t.retryAfter('ip', '10.0.0.1'), 600);
  // The per-name counter does not care which address failed.
  const name = fingerprint('carol');
  let locked = 0;
  for (let i = 0; i < 30; i++) if (t.fail('user', name) > 0) locked = locked || i + 1;
  assert.equal(locked, 5);
});

test('quotas: the (N+1)th event in the window is refused, a miss can count double, the window passes', () => {
  const { t, tick } = make();
  for (let i = 0; i < 5; i++) assert.equal(t.take('register', 'ip1', 5, 3_600_000), true);
  assert.equal(t.take('register', 'ip1', 5, 3_600_000), false, 'the 6th is refused (I7)');
  assert.throws(() => t.assertQuota('register', 'ip1', 5, 3_600_000), (e: { code: string }) => e.code === 'LOCKED_OUT');
  tick(3_600_001);
  assert.equal(t.take('register', 'ip1', 5, 3_600_000), true);
  for (let i = 0; i < 15; i++) assert.equal(t.take('lookup', 'u1', 30, 3_600_000, 2), true, 'fifteen misses count as thirty');
  assert.equal(t.take('lookup', 'u1', 30, 3_600_000), false, 'the 31st lookup is refused (I5)');
});

test('a username is never stored as typed: the key is a fingerprint', () => {
  assert.equal(fingerprint('hunter2 pasted here').length, 32);
  assert.notEqual(fingerprint('a'), fingerprint('b'));
  const { t, db } = make();
  t.fail('user', fingerprint('my secret password'));
  const keys = (db.prepare('SELECT key FROM auth_throttle').all() as { key: string }[]).map((r) => r.key);
  assert.ok(keys.every((k) => /^[0-9a-f]{32}$/.test(k)));
});

test('the sweep removes stale rows only', () => {
  const { t, tick } = make();
  t.fail('user', 'old');
  tick(25 * 60 * 60_000);
  t.fail('user', 'new');
  assert.equal(t.sweep(), 1);
});

test('without a database (Frozen or Locked store) nothing throws and nothing locks', () => {
  const t = new Throttle(() => null);
  assert.equal(t.fail('user', 'x'), 0);
  assert.equal(t.retryAfter('user', 'x'), 0);
  assert.equal(t.take('register', 'x', 1, 1000), true);
  assert.equal(t.sweep(), 0);
});
