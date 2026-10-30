// T-1993 (batch QA of T-1857): the reads that took no actor now ask the bucket rule. (1) The ticket key other modules put on their rows (CI runs,
// trigger runs, the lab, usage, sessions) names a bucket only to a caller who may view it; (2) brief, resolve, keyOf, the bumped chips and the
// glance's ticket count leave a hidden ticket out exactly like a missing one; (3) without its resolver the bucket rule fails closed; (4) FR39:
// a ticket filed without a bucket never lands in one the caller may not file in.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, TICKET_API, ticketBucketRef, type Actor } from '@portal/contracts';
import { can, clearResolvers, resolverFor, visible } from '../authz/seam.js';
import { glanceSources } from '../glance/authz.js';
import { ticketKeyField, ticketKeyOf } from './keys.js';
import { createTicketRoutes } from './routes.js';
import type { Caller } from './service.js';
import { agent, ticketsHarness, UI } from './testkit.js';

afterEach(() => clearResolvers());

const OWNER: Actor = { kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'l1', via: 'ui' };
const ALICE: Actor = { kind: 'user', userId: 'u_alice', loginSessionId: 'l2', via: 'ui' };
/** The owner's agent, as `actorOfPrincipal` gives it for a per-session token (what ci_runs_list, lab_summary and usage_* pass). */
const OWNER_AGENT: Actor = { kind: 'agent', userId: FOUNDING_USER_ID, tokenId: 'agt_sa', sessionId: 'sa', workspaceId: 'docker/api' };
const person = (actor: Actor): Caller => ({ kind: 'ui', actor });

function routes(tickets: Parameters<typeof createTicketRoutes>[0], actor: Actor) {
  const a = new Hono<{ Variables: { actor: Actor } }>();
  a.use(async (c, next) => {
    c.set('actor', actor);
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/tickets', createTicketRoutes(tickets));
  return a;
}
const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: { code: string; message: string } } });
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return isAppError(e) ? `${e.code}: ${e.message}` : String(e);
  }
};

/** A portal with one ticket of the owner (CP-1) and one in Alice's bucket (PRIV-1). */
async function twoBuckets(opts: Parameters<typeof ticketsHarness>[0] = {}) {
  const h = await ticketsHarness(opts);
  h.tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
  const mine = h.tickets.create(UI, { summary: 'mine', bucket: 'CP', workspaceId: 'docker/api' });
  const theirs = h.tickets.create(UI, { summary: 'hers: a secret plan', bucket: 'PRIV', workspaceId: 'docker/api' });
  return { h, mine, theirs };
}

test('(1) the key on another module’s row names a bucket only to a caller who may view it; a hidden one is like a missing one', async () => {
  const { h, mine, theirs } = await twoBuckets();
  try {
    routes(h.tickets, OWNER); // installs the lookup, as the portal does at boot
    assert.equal(ticketKeyOf(mine.id, OWNER), 'CP-1');
    assert.deepEqual(ticketKeyField(mine.id, OWNER_AGENT), { ticket_key: 'CP-1' }, 'the owner’s agent (a CI run, a lab or usage row)');
    for (const actor of [OWNER, OWNER_AGENT]) {
      assert.deepEqual(ticketKeyField(theirs.id, actor), {}, `${actor.kind}: no key of Alice’s bucket`);
      assert.deepEqual(ticketKeyField(theirs.id, actor), ticketKeyField('T-404', actor), 'the same as a ticket that does not exist');
      assert.equal(ticketKeyOf(theirs.id, actor), null);
    }
    // Alice sees her own key and not the owner's.
    assert.equal(ticketKeyOf(theirs.id, ALICE), 'PRIV-1');
    assert.deepEqual(ticketKeyField(mine.id, ALICE), {});
    assert.deepEqual(ticketKeyField(null, OWNER), {});
  } finally {
    h.done();
  }
});

test('(2) brief, resolve and keyOf: a hidden ticket is null like a missing one; the portal’s own reads (system) still see it', async () => {
  const { h, mine, theirs } = await twoBuckets();
  try {
    const me = person(OWNER);
    for (const ref of [theirs.id, theirs.key!]) {
      assert.equal(h.tickets.brief(me, ref), null, ref);
      assert.equal(h.tickets.resolve(me, ref), null, ref);
      assert.equal(h.tickets.keyOf(me, ref), null, ref);
    }
    assert.equal(h.tickets.brief(me, mine.key!)!.summary, 'mine');
    assert.equal(h.tickets.resolve(me, 'CP-1'), mine.id);
    assert.equal(h.tickets.keyOf(me, mine.id), 'CP-1');
    // Alice: her own, not the owner's.
    assert.equal(h.tickets.brief(person(ALICE), theirs.id)!.key, 'PRIV-1');
    assert.equal(h.tickets.brief(person(ALICE), mine.id), null);
    // The portal's bookkeeping (CI, keep going, the chat controller's ticket link) asks as system and sees every ticket.
    const system: Caller = { kind: 'system' };
    assert.equal(h.tickets.brief(system, theirs.id)!.key, 'PRIV-1');
    assert.equal(h.tickets.resolve(system, 'PRIV-1'), theirs.id);
    assert.equal(h.tickets.keyOf(system, theirs.id), 'PRIV-1');
    assert.equal(h.tickets.exists(theirs.id), true);

    // GET /:id/brief: the same 404 and text as a missing ticket, whichever form names it; the person's own ticket is 200.
    const app = routes(h.tickets, OWNER);
    const missing = await read(await app.request(TICKET_API.brief('PRIV-99')));
    assert.deepEqual(missing, { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such ticket.' } } });
    assert.deepEqual(await read(await app.request(TICKET_API.brief(theirs.id))), missing, 'byte for byte a missing ticket (no summary)');
    assert.deepEqual(await read(await app.request(TICKET_API.brief(theirs.key!))), missing);
    const ok = await read(await app.request(TICKET_API.brief(mine.id)));
    assert.deepEqual([ok.status, ok.body.data.key, ok.body.data.summary], [200, 'CP-1', 'mine']);
  } finally {
    h.done();
  }
});

test('(2) GET /api/tickets/bumped leaves out a ticket of a bucket the person may not view', async () => {
  const { h, mine, theirs } = await twoBuckets();
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    await h.tickets.bump(UI, mine.id, { sessionId: 'sa', mode: 'ask' });
    await h.tickets.bump(UI, theirs.id, { sessionId: 'sa', mode: 'ask' });
    const res = await read(await routes(h.tickets, OWNER).request(TICKET_API.bumped('sa')));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((b: { ticketId: string }) => b.ticketId), [mine.id], 'Alice’s ticket (and its summary) is not shown');
    assert.ok(!JSON.stringify(res.body).includes('secret plan'));
    // The service: each person sees the bumps of their own buckets only.
    assert.deepEqual(h.tickets.bumpedInto(person(ALICE), 'sa').map((b) => b.ticketId), [theirs.id]);
    assert.deepEqual(h.tickets.bumpedInto(UI, 'sa').map((b) => b.ticketId).sort(), [mine.id, theirs.id].sort(), 'a route that checked itself (no actor) sees both');
  } finally {
    h.done();
  }
});

test('(2) the glance’s tickets: a hidden bucket is out of the items and of the count', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    h.tickets.create(UI, { summary: 'for me', bucket: 'CP', assignee: { kind: 'user', name: 'Owner' } });
    h.tickets.create(UI, { summary: 'for Alice', bucket: 'PRIV', assignee: { kind: 'user', name: 'Alice' } });
    const sources = glanceSources({ chat: { list: () => [], openRequests: () => [], runningTasks: () => [] } as never, tickets: h.tickets, ci: { list: () => ({ items: [] }) } as never });
    const seen = sources.tickets(OWNER);
    assert.deepEqual(seen.items.map((t) => t.key), ['CP-1']);
    assert.equal(seen.count, 1, 'the count does not include the hidden ticket');
  } finally {
    h.done();
  }
});

test('(3) the bucket rule fails closed without its resolver; the tickets service registers it itself', async () => {
  const { h, mine } = await twoBuckets();
  try {
    assert.ok(resolverFor('ticket_bucket'), 'made by the service, before any route or tool');
    assert.equal(can(OWNER, 'view', ticketBucketRef('CP')).allow, true);
    const missing = can(OWNER, 'view', ticketBucketRef('NOPE'));
    assert.equal(missing.allow, false);

    clearResolvers();
    // No resolver: the owner is NOT given every bucket (the single-owner fallback); the answer is a missing bucket's.
    assert.deepEqual(can(OWNER, 'view', ticketBucketRef('CP')), missing);
    assert.deepEqual(visible(OWNER, 'ticket_bucket', ['CP', 'PRIV'], (k) => k), []);
    // The service's reads with an actor follow it: nothing, not everything.
    assert.equal(h.tickets.list(person(OWNER), { includeClosed: true }).items.length, 0);
    assert.equal(h.tickets.brief(person(OWNER), mine.id), null);
    assert.match(code(() => h.tickets.get(person(OWNER), mine.id)), /^NOT_FOUND: No such ticket\./);
    // The portal itself is not a person: its own reads are unchanged.
    assert.equal(h.tickets.brief({ kind: 'system' }, mine.id)!.key, 'CP-1');
  } finally {
    h.done();
  }
});

test('(4) FR39: a ticket filed without a bucket never lands in one the caller may not file in', async () => {
  const h = await ticketsHarness({ bucketRoutes: () => 'SEC: secret' });
  try {
    // Alice's buckets: one is the default bucket of the agent's workspace, one a tag rule points to.
    h.tickets.createBucket(UI, { key: 'PRIV', name: 'Private', defaultWorkspaceId: 'docker/api' }, { ownerId: 'u_alice' });
    h.tickets.createBucket(UI, { key: 'SEC', name: 'Secret' }, { ownerId: 'u_alice' });
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    const a = agent('docker/api', 'sa');

    const byWorkspace = h.tickets.create(a, { summary: 'from the workspace' });
    assert.equal(byWorkspace.bucket, 'PILOT', 'the workspace’s bucket is Alice’s: skipped, the default');
    const byTag = h.tickets.create(a, { summary: 'tagged', tags: ['secret'] });
    assert.equal(byTag.bucket, 'PILOT', 'the tag rule points to Alice’s bucket: it decides nothing');
    // The same through the route, for a person: the workspace bucket is skipped too.
    const viaRoute = await read(await routes(h.tickets, OWNER).request(TICKET_API.list, json('POST', { summary: 'by a person', workspaceId: 'docker/api' })));
    assert.deepEqual([viaRoute.status, viaRoute.body.data.bucket], [201, 'PILOT']);

    // Alice's own agent in the same workspace: her workspace bucket is chosen; with no bucket she may file in, the create is refused as not
    // found (never the owner's PILOT), and nothing is filed.
    const agentOf = (userId: string, workspaceId: string, sessionId: string): Caller => ({
      kind: 'agent',
      tokenId: `agt_${sessionId}`,
      label: `session ${sessionId} in ${workspaceId}`,
      workspaceId,
      sessionId,
      actor: { kind: 'agent', userId, tokenId: `agt_${sessionId}`, sessionId, workspaceId },
    });
    assert.equal(h.tickets.create(agentOf('u_alice', 'docker/api', 'sa'), { summary: 'hers' }).bucket, 'PRIV');
    const bob = agentOf('u_bob', 'docker/web', 'sb');
    h.sessions.add({ id: 'sb', workspaceId: 'docker/web' });
    const before = h.tickets.list(UI, { includeClosed: true }).total;
    assert.equal(code(() => h.tickets.create(bob, { summary: 'nowhere to go' })), code(() => h.tickets.create(bob, { summary: 'x', bucket: 'NOPE' })));
    assert.match(code(() => h.tickets.create(bob, { summary: 'nowhere to go' })), /No such bucket/);
    assert.equal(h.tickets.list(UI, { includeClosed: true }).total, before, 'nothing was filed');
  } finally {
    h.done();
  }
});
