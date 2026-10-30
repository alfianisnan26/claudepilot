// The portal's loops in one list (owner, 2026-10-18): each run is measured, a throw and a rejected promise count as failures with their message,
// and wrapping changes nothing of what the loop returns or throws.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listLoops, loop } from './loops.js';

test('a run is recorded: when, how long, ok or the failure; sync and async alike', async () => {
  const sync = loop('t.sync', 1000, 'a sync loop');
  assert.equal(sync.wrap(() => 7)(), 7);
  const bad = loop('t.bad', 1000, 'a loop that throws');
  assert.throws(() => bad.wrap(() => { throw new Error('boom'); })(), /boom/);
  const async = loop('t.async', 60_000, 'an async loop');
  await async.wrap(async () => 'x')();
  await assert.rejects(async.wrap(async () => { throw new Error('later'); })() as Promise<unknown>, /later/);
  const byId = Object.fromEntries(listLoops().map((l) => [l.id, l]));
  assert.deepEqual([byId['t.sync']!.runs, byId['t.sync']!.lastOk, byId['t.sync']!.failures], [1, true, 0]);
  assert.deepEqual([byId['t.bad']!.lastOk, byId['t.bad']!.lastError, byId['t.bad']!.failures], [false, 'boom', 1]);
  assert.deepEqual([byId['t.async']!.runs, byId['t.async']!.failures, byId['t.async']!.lastError, byId['t.async']!.everyMs], [2, 1, 'later', 60_000]);
  assert.ok(byId['t.async']!.lastRunAt && byId['t.async']!.lastMs !== null);
});
