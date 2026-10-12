// The multi-user seam (PLAN-10; docs/prd/claude-usage.md §20.14): a user sees the usage of the Claudes they may use, and the Move recommendation lists
// only those. Until users exist the owner may use everything, and the seam is absent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_ACTOR } from './actor.js';
import { claude, HOUR, NOW, planResult, seedClaude, seedUsage, usageHarness, win } from './fixtures.js';

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alice may use c1 only; the owner everything. */
const canUse = (actor: string, claudeId: string) => actor === OWNER_ACTOR || (actor === 'u_alice' && claudeId === 'c1');

async function rig(canUseClaude?: (a: string, c: string) => boolean) {
  const h = await usageHarness({ canUseClaude, probe: (async (c: { id: string }) => planResult([win('session', c.id === 'c1' ? 40 : 10, NOW + 4 * HOUR, 'Session')])) as never });
  h.source.list = [claude({ id: 'c1' }), claude({ id: 'c2', name: 'Satria' })];
  seedClaude(h.store, 'c1', 'docker/ws1', 'Default');
  seedClaude(h.store, 'c2', 'docker/ws1', 'Satria', 'claudes/0123456789abcdef');
  // Two requests on each Claude, five minutes ago.
  seedUsage(h.store, [
    { at: NOW - 5 * MIN, claude: 'c1', input: 100, cost: 1 },
    { at: NOW - 6 * MIN, claude: '', input: 100, cost: 1 },
    { at: NOW - 7 * MIN, claude: 'c2', input: 500, cost: 5 },
    { at: NOW - 8 * MIN, claude: 'c2', input: 500, cost: 5 },
  ]);
  // One probe per workspace at a time: c1 now, c2 ten minutes later.
  for (const t of [NOW, NOW + 10 * MIN]) {
    h.clock.t = t;
    await h.usage.tick();
    await sleep(5);
  }
  return h;
}

test('without the seam the owner and anyone see everything; the actor defaults to the owner', async () => {
  const h = await rig();
  try {
    assert.deepEqual((await h.usage.report()).claudes.map((c) => c.claudeId), ['c1', 'c2']);
    assert.deepEqual((await h.usage.report({ actorId: 'u_anyone' })).claudes.map((c) => c.claudeId), ['c1', 'c2']);
    assert.equal(h.usage.requestsReport('1d').totals.requests, 4);
    assert.equal(OWNER_ACTOR, 'u_owner');
  } finally {
    h.done();
  }
});

test('a user sees the usage of the Claudes they may use: the snapshot, the report, the strip, the export and the recommendation', async () => {
  const h = await rig(canUse);
  try {
    // The owner is unchanged.
    assert.deepEqual((await h.usage.report()).claudes.map((c) => c.claudeId), ['c1', 'c2']);
    assert.equal(h.usage.requestsReport('1d').totals.costUsd, 12);
    // Alice: c1 only. Its two requests ($1 each, one of them recorded without a Claude, which is Default's = c1).
    assert.deepEqual((await h.usage.report({ actorId: 'u_alice' })).claudes.map((c) => c.claudeId), ['c1']);
    const r = h.usage.requestsReport('1d', { actorId: 'u_alice' });
    assert.deepEqual([r.totals.requests, r.totals.costUsd, r.byClaude.map((c) => c.claudeId), r.claudes.map((c) => c.key)], [2, 2, ['c1'], ['c1']]);
    const s = await h.usage.summary({ actorId: 'u_alice' });
    assert.deepEqual([s.claudes.map((c) => c.claudeId), s.today.costUsd.value, s.today.requests.value], [['c1'], 2, 2]);
    assert.equal((await h.usage.summary()).today.costUsd.value, 12);
    const csv = (await h.usage.exportFile({ what: 'requests', format: 'csv', range: '1d' }, 'u_alice')).body.trimEnd().split('\r\n');
    assert.equal(csv.length, 2, 'the header and the one row c1 had in that bucket');
    const quota = JSON.parse((await h.usage.exportFile({ what: 'quota', format: 'json', range: '1d' }, 'u_alice')).body) as { claudeId: string }[];
    assert.deepEqual(quota.map((x) => x.claudeId), ['c1']);
    // The Move recommendation lists only the Claudes the asking user may use: Alice, leaving nothing, sees c1 and not c2.
    assert.deepEqual((await h.usage.recommend('docker/ws1', null, 'u_alice')).candidates.map((c) => c.claudeId), ['c1']);
    assert.deepEqual((await h.usage.recommend('docker/ws1', null)).candidates.map((c) => c.claudeId).sort(), ['c1', 'c2']);
    // Moving away from c1: for Alice there is nobody else; for the owner, c2.
    assert.deepEqual([(await h.usage.recommendFrom('c1', 'u_alice')).none, (await h.usage.recommendFrom('c1')).recommended], ['no_other_claude', 'c2']);
  } finally {
    h.done();
  }
});

test('a seam that throws hides rather than leaks', async () => {
  const h = await rig(() => {
    throw new Error('boom');
  });
  try {
    assert.deepEqual((await h.usage.report()).claudes, []);
    assert.equal(h.usage.requestsReport('1d').totals.requests, 0);
    assert.deepEqual((await h.usage.recommend('docker/ws1')).candidates, []);
  } finally {
    h.done();
  }
});
