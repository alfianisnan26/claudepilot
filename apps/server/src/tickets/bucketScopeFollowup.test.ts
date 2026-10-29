// T-2945 (found by the T-1993 builder): three reads that still named or opened another person's bucket.
// (1) The HTTP sessions list and one session carry `ticketKey` asked with the CALLER's actor, not the portal's; (2) usage by-ticket rows show
// none of a hidden ticket's fields (type, status, done time; nor in done-only or done-by-type), exactly like a ticket that does not exist;
// (3) `ownersOf` fails closed for the bucket type without its resolver, like `can()`: nobody, never the founding user.
// T-3070: (4) lab_summary's ticket rows and (5) metrics_tickets' rows show none of a hidden ticket's fields either.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, platformRef, ticketBucketRef, type Actor } from '@portal/contracts';
import { clearResolvers, ownersOf } from '../authz/seam.js';
import { createChatRoutes } from '../chat/routes.js';
import { liveSession } from '../chat/testkit.js';
import { Lab } from '../lab/index.js';
import { HIDDEN_TICKET_ROW, registerMetricsTools } from '../lab/metricsTools.js';
import { registerLabTools } from '../lab/portalTools.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { registerUsageSpendTools } from '../usagespend/portalTools.js';
import { HOUR, NOW, spendHarness } from '../usagespend/testkit.js';
import { setTicketKeyLookup } from './keys.js';
import { Tickets } from './service.js';
import { ChatTicketSessions } from './sessions.js';
import { FakeSessions, UI } from './testkit.js';

afterEach(() => {
  setTicketKeyLookup(null);
  clearResolvers();
});

const OWNER: Actor = { kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'l1', via: 'ui' };
const ALICE: Actor = { kind: 'user', userId: 'u_alice', loginSessionId: 'l2', via: 'ui' };
/** What the portal installs at boot (tickets/routes.ts): the key as the given actor may see it. */
const installLookup = (tickets: Tickets) => setTicketKeyLookup((id, actor) => tickets.keyOf({ kind: 'ui', actor }, id));

function chatApp(controller: Parameters<typeof createChatRoutes>[0], actor: Actor) {
  const a = new Hono<{ Variables: { actor: Actor } }>();
  a.use(async (c, next) => {
    c.set('actor', actor);
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/chat/sessions', createChatRoutes(controller));
  return a;
}

test('(1) GET /api/chat/sessions and /:id: the ticket key is the caller’s; a hidden bucket’s key is null like a gone ticket’s', async () => {
  const s = await liveSession();
  const tickets = new Tickets(s.store, new ChatTicketSessions(s.controller));
  // As index.ts wires it: the controller's own key is the portal's (system), for sockets and tools.
  s.controller.ticketResolve = (id) => tickets.resolve({ kind: 'system' }, id);
  s.controller.ticketKeyOf = (id) => tickets.keyOf({ kind: 'system' }, id);
  try {
    tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    const mine = tickets.create(UI, { summary: 'mine', bucket: 'CP', workspaceId: 'docker/ws1' });
    const theirs = tickets.create(UI, { summary: 'hers', bucket: 'PRIV', workspaceId: 'docker/ws1' });
    installLookup(tickets);
    const onMine = await s.controller.create({ workspaceId: 'docker/ws1', ticketId: mine.id });
    s.controller.setTicket(s.id, theirs.id);
    assert.equal(s.controller.get(s.id)!.ticketKey, 'PRIV-1', 'the portal’s own decoration still knows it (the leak this closes)');

    const owner = chatApp(s.controller, OWNER);
    const list = (await (await owner.request('/api/chat/sessions?limit=100')).json()) as { data: { items: { id: string; ticketId: string | null; ticketKey?: string | null }[] } };
    const row = (id: string) => list.data.items.find((x) => x.id === id)!;
    // Allowed: the owner's own bucket shows its key.
    assert.equal(row(onMine.id).ticketKey, 'CP-1');
    // Denied: the session is the owner's to see, its ticket's bucket is Alice's: no key, the same null as a ticket that is gone.
    assert.equal(row(s.id).ticketKey, null);
    assert.ok(!JSON.stringify(list).includes('PRIV'), 'nothing names the bucket');
    const one = (await (await owner.request(`/api/chat/sessions/${s.id}`)).json()) as { data: { ticketKey?: string | null } };
    assert.equal(one.data.ticketKey, null);

    // Alice asking for the same session: her own bucket's key, and not the owner's.
    const alice = chatApp(s.controller, ALICE);
    const hers = (await (await alice.request(`/api/chat/sessions/${s.id}`)).json()) as { data: { ticketKey?: string | null } };
    assert.equal(hers.data.ticketKey, 'PRIV-1');
    const notHers = (await (await alice.request(`/api/chat/sessions/${onMine.id}`)).json()) as { data: { ticketKey?: string | null } };
    assert.equal(notHers.data.ticketKey, null);
    await s.controller.end(onMine.id).catch(() => undefined);
  } finally {
    await s.done();
  }
});

test('(2) usage_attribution by ticket: a hidden ticket shows no type, status or done time, and is out of done-only, like a missing one', async () => {
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  const h = await spendHarness();
  const tickets = new Tickets(h.store, new FakeSessions());
  try {
    registerUsageSpendTools(h.spend, registry);
    tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    const mine = tickets.create(UI, { summary: 'mine', bucket: 'CP', type: 'bug' });
    const theirs = tickets.create(UI, { summary: 'hers', bucket: 'PRIV', type: 'feature' });
    // Both closed as done an hour ago, inside the window.
    const closed = new Date(NOW - HOUR).toISOString();
    for (const id of [mine.id, theirs.id]) h.db.prepare("UPDATE tickets SET status = 'done', closed_at = ? WHERE number = ?").run(closed, Number(id.slice(2)));
    installLookup(tickets);
    h.seed.session('A', { ticketId: mine.id });
    h.seed.session('B', { ticketId: theirs.id });
    h.seed.session('C', { ticketId: 'T-404' }); // a ticket that does not exist
    for (const s of ['A', 'B', 'C']) h.seed.usage({ atMs: NOW - 2 * HOUR, session: s, costUsd: 1 });

    const t = mcp.token('read'); // the owner's admin token: it may not view Alice's bucket
    const res = (await mcp.call(t.secret, 'usage_attribution', { by: 'ticket', range: '1d', full: true })).result!.structuredContent as any;
    const row = (k: string) => res.rows.find((x: any) => x.key === k);
    // Allowed: the owner's ticket with its key, type, status and done time.
    assert.deepEqual([row(mine.id).ticket.key, row(mine.id).ticket.type, row(mine.id).ticket.status, !!row(mine.id).ticket.done_at], ['CP-1', 'bug', 'done', true]);
    // Denied: Alice's ticket reads exactly like T-404 (its dollars stay, as a missing ticket's do): no key, type, status or done time.
    const shape = (r: any) => ({ ...r.ticket, id: '?' });
    assert.deepEqual(shape(row(theirs.id)), shape(row('T-404')));
    assert.deepEqual([row(theirs.id).ticket.type, row(theirs.id).ticket.status, row(theirs.id).ticket.done_at, 'key' in row(theirs.id).ticket], [null, null, null, false]);
    assert.deepEqual(res.done_by_type.map((x: any) => [x.type, x.tickets]), [['bug', 1]], 'the hidden ticket’s type is not counted');

    const done = (await mcp.call(t.secret, 'usage_attribution', { by: 'ticket', range: '1d', done: true })).result!.structuredContent as any;
    assert.deepEqual(done.rows.map((x: any) => x.key), [mine.id], 'done-only leaves the hidden ticket out, like a missing one');
    assert.ok(!JSON.stringify([res, done]).includes('feature'), 'nothing of the hidden ticket is shown');

    // The portal's own report (no caller check, the lab and the UI owner) is unchanged.
    assert.equal(h.spend.attribution({ by: 'ticket', range: '1d' }).rows.find((x) => x.key === theirs.id)!.ticket!.type, 'feature');
  } finally {
    h.done();
    mcp.done();
  }
});

/** T-3070: a spend store with Alice's PRIV bucket, the owner's ticket (bug) and Alice's (feature), both closed done an hour ago, the lookup installed. */
async function labSetup() {
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  const h = await spendHarness();
  const lab = new Lab({ store: h.store, now: () => NOW, settings: { get: () => undefined } });
  const tickets = new Tickets(h.store, new FakeSessions());
  registerLabTools(lab, registry);
  registerMetricsTools(lab, registry);
  tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
  const mine = tickets.create(UI, { summary: 'mine', bucket: 'CP', type: 'bug' });
  const theirs = tickets.create(UI, { summary: 'hers', bucket: 'PRIV', type: 'feature' });
  const closed = new Date(NOW - HOUR).toISOString();
  for (const id of [mine.id, theirs.id]) h.db.prepare("UPDATE tickets SET status = 'done', closed_at = ? WHERE number = ?").run(closed, Number(id.slice(2)));
  installLookup(tickets);
  return { mcp, h, lab, mine, theirs, t: mcp.token('read'), done: () => (lab.close(), h.done(), mcp.done()) };
}

test('(4, T-3070) lab_summary tickets: a hidden ticket shows no key, type, status or done time, exactly like a ticket that does not exist', async () => {
  const s = await labSetup();
  try {
    s.h.seed.session('A', { ticketId: s.mine.id });
    s.h.seed.session('B', { ticketId: s.theirs.id });
    s.h.seed.session('C', { ticketId: 'T-404' }); // a ticket that does not exist
    for (const id of ['A', 'B', 'C']) s.h.seed.usage({ atMs: NOW - 2 * HOUR, session: id, costUsd: 1 });
    for (const full of [false, true]) {
      const res = (await s.mcp.call(s.t.secret, 'lab_summary', { full })).result!.structuredContent as any;
      const row = (k: string) => res.tickets.find((x: any) => x.ticket === k);
      // Allowed: the owner's ticket with its key, type, status and done time.
      assert.deepEqual([row(s.mine.id).ticket_key, row(s.mine.id).type, row(s.mine.id).status, !!row(s.mine.id).done_at], ['CP-1', 'bug', 'done', true], `full ${full}`);
      // Denied: Alice's ticket shows none of its fields.
      assert.deepEqual([row(s.theirs.id).type, row(s.theirs.id).status, row(s.theirs.id).done_at, 'ticket_key' in row(s.theirs.id)], [null, null, null, false], `full ${full}`);
      // Same shape: its row is the missing ticket's row but for the id (its dollars stay, as a missing ticket's do).
      assert.deepEqual({ ...row(s.theirs.id), ticket: '?' }, { ...row('T-404'), ticket: '?' }, `full ${full}`);
      assert.ok(!JSON.stringify(res).includes('feature') && !JSON.stringify(res).includes('PRIV'), `full ${full}: nothing of the hidden ticket`);
    }
    // The lab's own read (no caller: the owner's screen) is unchanged.
    assert.equal(s.lab.summary().tickets!.find((x) => x.ticket === s.theirs.id)!.type, 'feature');
  } finally {
    s.done();
  }
});

test('(5, T-3070) metrics_tickets: a hidden ticket’s row has every field null, its id too, in place; a filter by its type names nothing', async () => {
  const s = await labSetup();
  try {
    const res = (await s.mcp.call(s.t.secret, 'metrics_tickets', { window: '24h' })).result!.structuredContent as any;
    assert.equal(res.total, 2);
    const visible = res.rows.find((r: any) => r.ticket === s.mine.id);
    // Allowed: the owner's ticket with its key and fields.
    assert.deepEqual([visible.ticket_key, visible.type, visible.status, typeof visible.closed], ['CP-1', 'bug', 'done', 'string']);
    // Denied: Alice's row is there (the count is the flow figure's) but says nothing: not its id, type, status, close time or hours.
    const hidden = res.rows.filter((r: any) => r !== visible);
    assert.deepEqual(hidden, [HIDDEN_TICKET_ROW]);
    // Same shape: the fields of a visible row (but the key, which a hidden ticket never has), each null.
    const { ticket_key: _k, ...fields } = visible;
    assert.deepEqual(Object.keys(hidden[0]).sort(), Object.keys(fields).sort());
    assert.ok(Object.values(hidden[0]).every((v) => v === null));
    assert.ok(!JSON.stringify(res).includes(s.theirs.id) && !JSON.stringify(res).includes('PRIV'), 'nothing names the hidden ticket');
    // A filter by the hidden ticket's type does not name it either (its id there would tell its type).
    const byType = (await s.mcp.call(s.t.secret, 'metrics_tickets', { window: '24h', group_by: 'type', group: 'feature' })).result!.structuredContent as any;
    assert.deepEqual(byType.rows, [HIDDEN_TICKET_ROW]);
    // The lab's own rows (the owner's screen) are unchanged.
    assert.equal(s.lab.metrics.tickets('all', '24h', {})!.rows.find((r) => r.ticket === s.theirs.id)!.type, 'feature');
  } finally {
    s.done();
  }
});

test('(3) ownersOf fails closed for a ticket bucket without its resolver: nobody, the same as a bucket that does not exist', async () => {
  const h = await spendHarness();
  try {
    const tickets = new Tickets(h.store, new FakeSessions());
    tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    // Allowed: with the resolver, the bucket's owner.
    assert.deepEqual(ownersOf(ticketBucketRef('PRIV')), ['u_alice']);
    const missing = ownersOf(ticketBucketRef('NOPE'));
    assert.deepEqual(missing, [], 'a bucket that does not exist has no owner');

    clearResolvers();
    // Denied: no resolver is never "the founding user owns it".
    assert.deepEqual(ownersOf(ticketBucketRef('PRIV')), missing);
    assert.deepEqual(ownersOf(ticketBucketRef('CP')), []);
    // A type with no ownership rule keeps the single-owner answer (notifications about the portal reach the owner).
    assert.deepEqual(ownersOf(platformRef('notifications')), [FOUNDING_USER_ID]);
  } finally {
    h.done();
  }
});
