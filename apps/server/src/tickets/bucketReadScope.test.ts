// T-1857: a ticket in a bucket the caller may not view is the same "No such ticket." on every read path, for agents, admin tokens and
// people alike, and lists, totals, counts and tags leave it out. The owner, whose buckets they all are, still sees everything.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { TICKET_API, type Actor } from '@portal/contracts';
import { clearResolvers } from '../authz/seam.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { registerTicketTools } from './portalTools.js';
import { createTicketRoutes } from './routes.js';
import { Tickets } from './service.js';
import { FakeSessions, UI } from './testkit.js';

afterEach(() => clearResolvers());

type Out = { structuredContent?: any; isError?: boolean; content?: { text: string }[] };

async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const sessions = new FakeSessions();
  const tickets = new Tickets(h.store, sessions, {});
  tickets.start();
  registerTicketTools(tickets, registry);
  const app = (actor?: Actor) => {
    const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
    a.use(async (c, next) => {
      if (actor) c.set('actor', actor);
      else (c.set('token', 'signed-in'), (c as unknown as { set(k: string, v: unknown): void }).set('actor', { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui' }));
      await next();
    });
    a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
    a.route('/api/tickets', createTicketRoutes(tickets));
    return a;
  };
  return { h, tickets, sessions, app, done: () => (tickets.stop(), h.done()) };
}

const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: `l-${userId}`, via: 'ui' });
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: { code: string; message: string } } });

/** One ticket in another person's bucket (shared queue, so only the bucket hides it) and one in the owner's. */
function seed(tickets: Tickets) {
  tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
  const hidden = tickets.create(UI, { summary: 'hers', bucket: 'PRIV', tags: ['secretish'] });
  const shown = tickets.create(UI, { summary: 'mine', bucket: 'CP', tags: ['shared'] });
  return { hidden, shown };
}

for (const who of ['agent', 'admin token'] as const) {
  test(`tools (${who}): a ticket in a bucket it may not view is the same not found as a missing one, and no list or count has it`, async () => {
    const r = await rig();
    try {
      const { hidden, shown } = seed(r.tickets);
      r.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Lead' });
      const secret = who === 'agent' ? (await r.h.agentToken('docker/api', 'sa')).secret : r.h.token('admin').secret;
      const extra = who === 'agent' ? {} : { session_id: 'sa' };
      const call = async (name: string, args: Record<string, unknown> = {}): Promise<Out> => (await r.h.call(secret, name, args)).result!;

      const missing = await call('ticket_get', { id: 'T-99' });
      assert.equal(missing.isError, true);
      assert.match(missing.content![0]!.text, /No such ticket/);
      for (const id of [hidden.id, hidden.key!]) assert.deepEqual((await call('ticket_get', { id })).content, missing.content, `ticket_get ${id}`);
      assert.deepEqual((await call('ticket_get', { id: hidden.id, full: true })).content, missing.content, 'ticket_get full');
      // Every tool that names a ticket: the same text as for a ticket that does not exist.
      const byId: [string, Record<string, unknown>][] = [
        ['ticket_comment', { text: 'x' }],
        ['ticket_update', { priority: 'high' }],
        ['ticket_close', { summary: 'x' }],
        ['ticket_attach', { name: 'a.txt', text: 'x' }],
        ['ticket_attachment_get', { attachment_id: 1 }],
        ['ticket_verdict', {}],
      ];
      for (const [name, args] of byId) {
        const gone = await call(name, { id: 'T-99', ...args, ...extra });
        const hid = await call(name, { id: hidden.key!, ...args, ...extra });
        assert.equal(hid.isError, true, name);
        assert.deepEqual(hid.content, gone.content, name);
      }
      const claimed = await call('ticket_claim_next', { id: hidden.key!, ...extra });
      assert.equal(claimed.structuredContent.ticket, null, 'not claimable by id');

      const list = (await call('ticket_list', { include_closed: true })).structuredContent;
      assert.deepEqual(list.tickets.map((t: { id: string }) => t.id), [shown.id]);
      assert.equal(list.total, 1);
      assert.equal(Object.values(list.counts.by_status as Record<string, number>).reduce((a, b) => a + b, 0), 1, 'the counts leave it out');
      assert.equal(list.counts.unassigned, 1);
      assert.match(list.summary, /^1 tickets; 1 open/);
      assert.equal((await call('ticket_list', { query: hidden.key! })).structuredContent.total, 0, 'a search by its key finds nothing');
      assert.equal((await call('ticket_list', { query: 'hers' })).structuredContent.total, 0, 'nor by its text');
      const timeline = (await call('ticket_timeline', {})).structuredContent;
      assert.deepEqual(timeline.tickets.map((t: { id: string }) => t.id), [shown.id]);
      // The queue claims the visible one, never the hidden one.
      assert.equal((await call('ticket_claim_next', extra)).structuredContent.ticket.id, shown.id);
      assert.equal((await call('ticket_claim_next', extra)).structuredContent.ticket, null);
      assert.equal(r.tickets.get(UI, hidden.id).ticket.assignee, null, 'the hidden ticket was never touched');
    } finally {
      r.done();
    }
  });
}

test('routes: a second person reads only their own bucket; total, counts and tags leave the rest out; the owner sees all of theirs', async () => {
  const r = await rig();
  try {
    const { hidden, shown } = seed(r.tickets);
    const page = async (actor: Actor | undefined) => (await read(await r.app(actor).request(`${TICKET_API.list}?includeClosed=1`))).body.data;

    const owner = await page(person('u_owner'));
    assert.deepEqual(owner.items.map((t: { id: string }) => t.id), [shown.id]);
    assert.equal(owner.total, 1);
    assert.equal(owner.counts.total, 1);
    assert.deepEqual(owner.counts.byBucket, { CP: 1 });
    const ownerTags = (await read(await r.app(person('u_owner')).request(`${TICKET_API.list}/tags`))).body.data.map((t: { tag: string }) => t.tag);
    assert.deepEqual(ownerTags, ['shared']);

    // Her bucket's ticket counts for her and opens for her; the owner's does neither. (Her list rows also pass `view` on each ticket, which
    // the single-owner layer gives the founding user only, so the rows themselves stay empty until multi-user.)
    const alice = await page(person('u_alice'));
    assert.equal(alice.total, 1);
    assert.deepEqual(alice.counts.byBucket, { PRIV: 1 });
    assert.equal((await r.app(person('u_alice')).request(TICKET_API.one(hidden.key!))).status, 200);
    assert.equal((await r.app(person('u_alice')).request(TICKET_API.one(shown.id))).status, 404);

    const bob = await page(person('u_bob'));
    assert.deepEqual([bob.items.length, bob.total, bob.counts.total, bob.counts.unassigned], [0, 0, 0, 0], 'nobody else’s tickets, nor their numbers');
    const missing = await read(await r.app(person('u_bob')).request(TICKET_API.one('T-99')));
    for (const t of [hidden, shown]) for (const ref of [t.id, t.key!]) assert.deepEqual(await read(await r.app(person('u_bob')).request(TICKET_API.one(ref))), missing, ref);
    assert.equal((await r.app(person('u_bob')).request(`${TICKET_API.list}?bucket=PRIV`)).status, 404);
  } finally {
    r.done();
  }
});

test('a General Manager token is its person: another person’s manager reads none of the owner’s tickets, the owner’s reads them', async () => {
  const r = await rig();
  try {
    const { shown } = seed(r.tickets);
    r.h.alive.add('gm1');
    r.h.alive.add('gm2');
    const alice = r.h.module.managers.mint({ userId: 'u_alice', sessionId: 'gm1' })!;
    const owner = r.h.module.managers.mint({ userId: 'u_owner', sessionId: 'gm2' })!;
    const call = async (t: { secret: string }, name: string, args: Record<string, unknown>): Promise<Out> => (await r.h.call(t.secret, name, args)).result!;
    const missing = await call(alice, 'ticket_get', { id: 'T-99' });
    assert.deepEqual((await call(alice, 'ticket_get', { id: shown.key! })).content, missing.content);
    assert.equal((await call(alice, 'ticket_list', {})).structuredContent.total, 1, 'only her own bucket’s ticket');
    assert.equal((await call(owner, 'ticket_get', { id: shown.key! })).structuredContent.ticket.id, shown.id);
    assert.equal((await call(owner, 'ticket_list', {})).structuredContent.total, 1, 'the owner’s manager: the owner’s buckets');
  } finally {
    r.done();
  }
});

test('the owner: every bucket is theirs, so every ticket, count and claim is as before', async () => {
  const r = await rig();
  try {
    r.tickets.createBucket(UI, { key: 'OPS', name: 'Ops' });
    const a = r.tickets.create(UI, { summary: 'one', bucket: 'OPS' });
    const b = r.tickets.create(UI, { summary: 'two', bucket: 'CP' });
    const data = (await read(await r.app().request(`${TICKET_API.list}?includeClosed=1`))).body.data;
    assert.deepEqual(data.items.map((t: { id: string }) => t.id).sort(), [a.id, b.id].sort());
    assert.deepEqual([data.total, data.counts.total], [2, 2]);
    r.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Lead' });
    const agent = (await r.h.agentToken('docker/api', 'sa')).secret;
    const list = (await r.h.call(agent, 'ticket_list', {})).result!.structuredContent;
    assert.equal(list.total, 2);
    assert.equal((await r.h.call(agent, 'ticket_get', { id: a.key! })).result!.structuredContent.ticket.id, a.id);
  } finally {
    r.done();
  }
});
