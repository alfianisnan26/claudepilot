// Org isolation (owner request 2026-11-01): a trigger files its ticket as its OWNER (organizations §6.3: "a trigger runs as its owner with
// can at run time"). Before, a trigger was the portal itself and filed anywhere, so a tag route or a workspace default could put its ticket
// (with an event's untrusted words) into another person's or another org's bucket.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { Caller } from './service.js';
import { ticketsHarness, UI } from './testkit.js';

test('a trigger files only in a bucket its owner may file in; another person’s bucket is “no such bucket”', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.createBucket(UI, { key: 'MINE', name: 'Mine' }, { ownerId: 'u_a' });
    h.tickets.createBucket(UI, { key: 'THEIRS', name: 'Theirs' }, { ownerId: 'u_b' });
    const trigger: Caller = { kind: 'trigger', triggerId: 'tr1', ownerId: 'u_a', label: 'Nightly' };
    const made = h.tickets.create(trigger, { summary: 'from the trigger', bucket: 'MINE' });
    assert.equal(made.bucket, 'MINE');
    assert.throws(
      () => h.tickets.create(trigger, { summary: 'into someone else’s', bucket: 'THEIRS' }),
      (e: unknown) => isAppError(e) && e.code === 'NOT_FOUND',
    );
    const theirs: Caller = { kind: 'trigger', triggerId: 'tr2', ownerId: 'u_b', label: 'Hourly' };
    assert.equal(h.tickets.create(theirs, { summary: 'their own', bucket: 'THEIRS' }).bucket, 'THEIRS');
  } finally {
    h.done();
  }
});
