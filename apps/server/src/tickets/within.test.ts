// The org context of the ticket numbers (owner request 2026-11-01, metrics per org): `within` (the bucket keys an org context keeps, picked by
// authz/orgScope.ts `bucketsInScope`) narrows the list, its `total` and its `counts` alike, so the Home card's "open" and "needs you" are the
// context's own; an empty `within` (an org the caller is not in) counts nothing; no `within` is today's behaviour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ticketsHarness, UI } from './testkit.js';

async function threeBuckets() {
  const h = await ticketsHarness();
  h.tickets.createBucket(UI, { key: 'ORG', name: 'Org' });
  h.tickets.createBucket(UI, { key: 'OWN', name: 'Own' });
  h.tickets.create(UI, { summary: 'org one', bucket: 'ORG' });
  h.tickets.create(UI, { summary: 'org two', bucket: 'ORG' });
  h.tickets.create(UI, { summary: 'own one', bucket: 'OWN' });
  return h;
}

test('listPage: within narrows the items, the total and the counts; empty counts nothing; absent is everything', async () => {
  const h = await threeBuckets();
  try {
    const all = h.tickets.listPage(UI, {});
    assert.equal(all.total, 3);
    assert.equal(all.counts!.total, 3);

    const org = h.tickets.listPage(UI, {}, { within: ['ORG'] });
    assert.deepEqual(org.items.map((t) => t.summary).sort(), ['org one', 'org two']);
    assert.equal(org.total, 2);
    assert.equal(org.counts!.total, 2);
    assert.equal(org.counts!.byStatus.open, 2);
    assert.deepEqual(org.counts!.byBucket, { ORG: 2 });

    const own = h.tickets.listPage(UI, {}, { within: ['OWN'] });
    assert.deepEqual(own.items.map((t) => t.summary), ['own one']);
    assert.equal(own.total, 1);
    assert.equal(own.counts!.total, 1);

    const none = h.tickets.listPage(UI, {}, { within: [] });
    assert.deepEqual(none.items, []);
    assert.equal(none.total, 0);
    assert.equal(none.counts!.total, 0);
    assert.equal(none.counts!.needsYou, 0);
  } finally {
    h.done();
  }
});

test('list and counts take within too (the glance’s tickets block); bucketKeys names every bucket a ticket can be in', async () => {
  const h = await threeBuckets();
  try {
    assert.equal(h.tickets.list(UI, {}).total, 3);
    assert.equal(h.tickets.list(UI, {}, ['ORG']).total, 2);
    assert.equal(h.tickets.list(UI, {}, []).total, 0);
    assert.equal(h.tickets.counts(UI, ['OWN']).total, 1);
    const keys = h.tickets.bucketKeys();
    for (const k of ['ORG', 'OWN']) assert.ok(keys.includes(k), `${k} is a bucket key`);
  } finally {
    h.done();
  }
});
