// T-1967: a ticket moves to another bucket (its old keys stay aliases), buckets merge, and the coordinator moves many at once.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { AppError, isAppError } from '@isnanme/core';
import { TICKET_API, type Actor } from '@portal/contracts';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { registerTicketTools } from './portalTools.js';
import { createTicketRoutes } from './routes.js';
import { Tickets, type TicketAudit } from './service.js';
import { agent, FakeSessions, token, ticketsHarness, UI } from './testkit.js';

afterEach(() => clearResolvers());

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? `${e.code}${e.code === 'NOT_FOUND' ? `:${e.message}` : ''}` : `other:${(e as Error).message}`;
  }
  return 'none';
};
const numbers = (h: { store: { db: unknown } }, bucket: string) =>
  ((h.store.db as import('node:sqlite').DatabaseSync).prepare('SELECT bucket_number AS n FROM tickets WHERE bucket_key = ? ORDER BY bucket_number').all(bucket) as { n: number }[]).map((r) => r.n);

test('a move takes the next number of its new bucket; the old key, T-n, trailers and search still name it; audited; no number reused', async () => {
  const h = await ticketsHarness();
  const audits: TicketAudit[] = [];
  h.tickets.onAudit = (a) => void audits.push(a);
  try {
    h.tickets.create(UI, { summary: 'cp one', bucket: 'CP' });
    const t = h.tickets.create(UI, { summary: 'konf one', bucket: 'KONF' });
    assert.deepEqual([t.id, t.key], ['T-2', 'KONF-1']);
    const moved = h.tickets.update(UI, 'KONF-1', { bucket: 'cp' });
    assert.deepEqual([moved.id, moved.key, moved.bucket], ['T-2', 'CP-2', 'CP']);
    for (const ref of ['KONF-1', 'konf-1', 'CP-2', 'T-2']) assert.equal(h.tickets.get(UI, ref).ticket.id, 'T-2', ref);
    assert.equal(h.tickets.resolve('KONF-1'), 'T-2');
    assert.deepEqual(h.tickets.find({ branch: 'ticket/KONF-1-x', message: 'x\n\nTicket: KONF-1' }), ['T-2']);
    assert.deepEqual(h.tickets.list(UI, { query: 'KONF-1' }).items.map((x) => x.id), ['T-2'], 'search by the old key');
    const e = h.tickets.get(UI, 'T-2').events.at(-1)!;
    assert.deepEqual([e.kind, e.data], ['bucket', { from: 'KONF-1', to: 'CP-2' }]);
    assert.deepEqual(audits.map((a) => [a.kind, a.detail]), [['ticket.bucket_moved', { ticketId: 'T-2', from: 'KONF-1', to: 'CP-2' }]]);
    // KONF's counter never goes back: its next ticket is KONF-2, and KONF-1 still names the moved ticket.
    assert.equal(h.tickets.create(UI, { summary: 'konf two', bucket: 'KONF' }).key, 'KONF-2');
    assert.equal(h.tickets.resolve('KONF-1'), 'T-2');
    // Moving back gives a new number, never the old one (that stays an alias of the same ticket).
    assert.equal(h.tickets.update(UI, 'T-2', { bucket: 'KONF' }).key, 'KONF-3');
    assert.equal(h.tickets.resolve('CP-2'), 'T-2');
    assert.deepEqual(numbers(h, 'CP'), [1]);
    assert.deepEqual(numbers(h, 'KONF'), [2, 3]);
    // The same bucket is no change; an unknown one is not found.
    assert.equal(h.tickets.update(UI, 'T-2', { bucket: 'KONF' }).key, 'KONF-3');
    assert.equal(code(() => h.tickets.update(UI, 'T-2', { bucket: 'NOPE' })), 'NOT_FOUND:No such bucket.');
  } finally {
    h.done();
  }
});

test('agents: only a ticket they may change, only into a bucket of their workspace; a crew hand-off cannot move it', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.createBucket(UI, { key: 'WEB', name: 'Web', defaultWorkspaceId: 'docker/web' });
    h.sessions.add({ workspaceId: 'docker/api', id: 'a1' });
    h.sessions.add({ workspaceId: 'docker/api', id: 'a2' });
    const mine = h.tickets.create(UI, { summary: 'mine', workspaceId: 'docker/api', bucket: 'KONF', assignee: { kind: 'session', sessionId: 'a1' } });
    assert.equal(code(() => h.tickets.update(agent('docker/api', 'a1'), mine.id, { bucket: 'WEB' })), 'NOT_FOUND:No such bucket.');
    assert.equal(code(() => h.tickets.update(agent('docker/api', 'a2'), mine.id, { bucket: 'CP' })), 'FORBIDDEN', 'not its ticket');
    assert.equal(h.tickets.update(agent('docker/api', 'a1'), mine.id, { bucket: 'CP' }).key, 'CP-1');
  } finally {
    h.done();
  }
});

test('bulk moves: the owner only, each on its own, with the new keys; refusals say why and move nothing', async () => {
  const h = await ticketsHarness();
  try {
    const a = h.tickets.create(UI, { summary: 'a', bucket: 'CP' });
    const b = h.tickets.create(UI, { summary: 'b', bucket: 'CP' });
    const c = h.tickets.create(UI, { summary: 'c', bucket: 'PILOT' });
    assert.equal(code(() => h.tickets.moveBuckets(token('t1', 'admin'), [{ id: a.id, bucket: 'PILOT' }])), 'FORBIDDEN');
    h.sessions.add({ workspaceId: 'docker/api', id: 's' });
    assert.equal(code(() => h.tickets.moveBuckets(agent('docker/api', 's'), [{ id: a.id, bucket: 'PILOT' }])), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.moveBuckets(UI, [])), 'VALIDATION_FAILED');
    const r = h.tickets.moveBuckets(UI, [
      { id: 'CP-2', bucket: 'PILOT' },
      { id: 'CP-1', bucket: 'pilot' },
      { id: c.id, bucket: 'PILOT' },
      { id: 'T-99', bucket: 'PILOT' },
      { id: b.id, bucket: 'NOPE' },
    ]);
    assert.deepEqual(r, [
      { id: 'T-2', from: 'CP-2', to: 'PILOT-2', ok: true },
      { id: 'T-1', from: 'CP-1', to: 'PILOT-3', ok: true },
      { id: 'T-3', from: 'PILOT-1', to: 'PILOT-1', ok: true },
      { id: 'T-99', ok: false, error: 'No such ticket.' },
      { id: 'T-2', ok: false, error: 'No such bucket.' },
    ]);
    assert.deepEqual(numbers(h, 'PILOT'), [1, 2, 3]);
    assert.equal(h.tickets.resolve('CP-1'), 'T-1');
    // The route's authz: a bucket the caller may not operate reads as a missing ticket.
    const denied = h.tickets.moveBuckets(UI, [{ id: 'T-1', bucket: 'KONF' }], { allow: (_from, to) => to !== 'KONF' });
    assert.deepEqual(denied, [{ id: 'T-1', ok: false, error: 'No such ticket.' }]);
    assert.equal(h.tickets.get(UI, 'T-1').ticket.bucket, 'PILOT');
  } finally {
    h.done();
  }
});

test('merge CP into PILOT: every ticket in creation order with PILOT’s next numbers, CP’s keys stay aliases, CP is gone, PILOT renamed', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.create(UI, { summary: 'p1', bucket: 'PILOT' });
    const c1 = h.tickets.create(UI, { summary: 'c1', bucket: 'CP' });
    const c2 = h.tickets.create(UI, { summary: 'c2', bucket: 'CP' });
    h.tickets.update(UI, c1.id, { bucket: 'KONF' }); // KONF-1 now, CP-1 an alias
    h.tickets.update(UI, c1.id, { bucket: 'CP' }); // back as CP-3
    assert.equal(code(() => h.tickets.mergeBucket(token('t', 'admin'), 'CP', { into: 'PILOT' })), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.mergeBucket(UI, 'CP', { into: 'CP' })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.mergeBucket(UI, 'CP', { into: 'NOPE' })), 'NOT_FOUND:No such bucket.');
    const r = h.tickets.mergeBucket(UI, 'cp', { into: 'PILOT' });
    // Creation order: c1 (made before c2) first, whatever its number in CP was.
    assert.deepEqual(r.moved, [
      { id: c1.id, from: 'CP-3', to: 'PILOT-2' },
      { id: c2.id, from: 'CP-2', to: 'PILOT-3' },
    ]);
    assert.deepEqual([r.bucket.key, r.bucket.name, r.bucket.description, r.bucket.nextNumber], ['PILOT', 'Pilot', 'ClaudePilot', 4]);
    assert.deepEqual(h.tickets.buckets(UI).map((b) => b.key), ['KONF', 'PILOT', 'TB'], 'CP is deleted');
    for (const [ref, id] of [['CP-1', c1.id], ['CP-3', c1.id], ['KONF-1', c1.id], ['CP-2', c2.id]]) assert.equal(h.tickets.resolve(ref!), id, ref);
    assert.equal(h.tickets.get(UI, 'CP-2').ticket.key, 'PILOT-3');
    assert.equal(h.tickets.get(UI, c2.id).events.at(-1)!.data!.merged, true);
    assert.equal(code(() => h.tickets.create(UI, { summary: 'x', bucket: 'CP' })), 'NOT_FOUND:No such bucket.');
    // A bucket made again under CP counts on after CP's aliases, so CP-1..CP-3 keep naming their tickets.
    assert.equal(h.tickets.createBucket(UI, { key: 'CP', name: 'again' }).nextNumber, 4);
    assert.equal(h.tickets.create(UI, { summary: 'new cp', bucket: 'CP' }).key, 'CP-4');
    assert.equal(h.tickets.resolve('CP-1'), c1.id);
    // Other pairs keep their names unless asked.
    const tb = h.tickets.create(UI, { summary: 'tb', bucket: 'TB' });
    const r2 = h.tickets.mergeBucket(UI, 'TB', { into: 'KONF' });
    assert.deepEqual([r2.bucket.name, r2.moved[0]!.id], ['Konfersi', tb.id]);
  } finally {
    h.done();
  }
});

test('a create racing a merge (another thread, another connection) never shares or skips a number', async () => {
  const h = await ticketsHarness();
  try {
    for (let i = 0; i < 60; i++) h.tickets.create(UI, { summary: `cp ${i}`, bucket: 'CP' });
    h.store.db!.exec('PRAGMA busy_timeout = 10000');
    const go = new SharedArrayBuffer(4);
    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.file);
      db.exec('PRAGMA busy_timeout = 10000');
      const ins = db.prepare("INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, bucket_key) VALUES ('task', 'normal', 2, 'open', 'w', 'human', 'ui', 'Admin', 'z', 'z', 'PILOT')");
      const nap = new Int32Array(new SharedArrayBuffer(4));
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.go), 0, 0);
      for (let i = 0; i < 80; i++) (ins.run(), Atomics.wait(nap, 0, 0, 1));
      db.close();
      parentPort.postMessage('done');
    `;
    const w = new Worker(code, { eval: true, workerData: { file: join(h.dataDir, 'portal.db'), go } });
    const ready = new Promise<void>((r) => w.once('message', () => r()));
    const done = new Promise<void>((r, j) => (w.on('message', (m) => m === 'done' && r()), w.once('error', j)));
    await ready;
    Atomics.store(new Int32Array(go), 0, 1);
    Atomics.notify(new Int32Array(go), 0);
    await new Promise((r) => setTimeout(r, 15)); // the worker is inserting now
    const merged = h.tickets.mergeBucket(UI, 'CP', { into: 'PILOT' });
    for (let i = 0; i < 20; i++) (h.tickets.moveBuckets(UI, [{ id: `PILOT-${merged.moved[i]!.to.split('-')[1]}`, bucket: 'KONF' }]), await new Promise((r) => setTimeout(r, 1)));
    await done;
    const pilot = numbers(h, 'PILOT');
    assert.equal(new Set(pilot).size, pilot.length, 'no number twice');
    const next = (h.store.db!.prepare("SELECT next_number AS n FROM ticket_buckets WHERE key = 'PILOT'").get() as { n: number }).n;
    // Every number PILOT handed out is a live ticket or an alias of one moved on: 1..next-1, none skipped.
    const aliases = (h.store.db!.prepare("SELECT bucket_number AS n FROM ticket_key_aliases WHERE bucket_key = 'PILOT'").all() as { n: number }[]).map((r) => r.n);
    assert.deepEqual([...pilot, ...aliases].sort((a, b) => a - b), Array.from({ length: next - 1 }, (_, i) => i + 1));
    assert.equal(pilot.length, 60 + 80 - 20);
    // The worker really wrote on both sides of the merge: some of its numbers come before the merged block, some after.
    const block = merged.moved.map((m) => Number(m.to.split('-')[1]));
    const theirs = (h.store.db!.prepare("SELECT bucket_number AS n FROM tickets WHERE summary = 'w'").all() as { n: number }[]).map((r) => r.n);
    assert.ok(theirs.some((n) => n < Math.min(...block)) && theirs.some((n) => n > Math.max(...block)), 'the create raced the merge');
    assert.deepEqual(numbers(h, 'KONF'), Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    h.done();
  }
});

/* ---------- Routes and the tool ---------- */

function routes(tickets: Tickets, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/tickets', createTicketRoutes(tickets));
  return a;
}
const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: { code: string; message: string } } });

test('routes: PATCH moves, the old key opens it; merge and bulk are the owner’s; another person’s bucket is the same 404', async () => {
  const h = await ticketsHarness();
  try {
    const app = routes(h.tickets);
    for (const k of ['POST /api/tickets/buckets/:key/merge', 'POST /api/tickets/bucket-moves']) assert.ok(declaredPolicies().has(k), k);
    h.tickets.create(UI, { summary: 'k', bucket: 'KONF' });
    const moved = await read(await app.request(TICKET_API.one('KONF-1'), json('PATCH', { bucket: 'CP' })));
    assert.deepEqual([moved.status, moved.body.data.key], [200, 'CP-1']);
    assert.equal((await read(await app.request(TICKET_API.one('KONF-1')))).body.data.ticket.key, 'CP-1', 'the old key still opens it');
    const bulk = await read(await app.request(TICKET_API.bucketMoves, json('POST', { moves: [{ id: 'KONF-1', bucket: 'PILOT' }] })));
    assert.deepEqual(bulk.body.data, [{ id: 'T-1', from: 'CP-1', to: 'PILOT-1', ok: true }]);
    const merge = await read(await app.request(TICKET_API.bucketMerge('PILOT'), json('POST', { into: 'TB' })));
    assert.deepEqual([merge.status, merge.body.data.moved.length, merge.body.data.bucket.key], [200, 1, 'TB']);

    // Another person: the bucket she does not hold, the bulk and the merge are the same 404 as a missing one.
    h.tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    const me = routes(h.tickets, { kind: 'user', userId: 'u_owner', loginSessionId: 'l', via: 'ui' });
    const into = await read(await me.request(TICKET_API.one('T-1'), json('PATCH', { bucket: 'PRIV' })));
    const missing = await read(await me.request(TICKET_API.one('T-1'), json('PATCH', { bucket: 'NONE' })));
    assert.equal(into.status, 404);
    assert.deepEqual(into, missing);
    const alice = routes(h.tickets, { kind: 'user', userId: 'u_alice', loginSessionId: 'l2', via: 'ui' });
    assert.equal((await alice.request(TICKET_API.bucketMoves, json('POST', { moves: [{ id: 'T-1', bucket: 'PRIV' }] }))).status, 404);
    assert.equal((await alice.request(TICKET_API.bucketMerge('PRIV'), json('POST', { into: 'TB' }))).status, 404);
    assert.equal((await me.request(TICKET_API.bucketMerge('PRIV'), json('POST', { into: 'TB' }))).status, 404, 'the owner may not merge a bucket she does not hold');
  } finally {
    h.done();
  }
});

test('tool: ticket_update moves by bucket; ticket_get by the old key; a bucket out of reach is the same not found', async () => {
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  const sessions = new FakeSessions();
  const tickets = new Tickets(mcp.store, sessions, {});
  tickets.start();
  registerTicketTools(tickets, registry);
  try {
    tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Lead' });
    const a = await mcp.agentToken('docker/api', 'sa');
    const call = async (name: string, args: Record<string, unknown> = {}) => (await mcp.call(a.secret, name, args)).result!;
    const made = (await call('ticket_create', { summary: 'mine', bucket: 'KONF' })).structuredContent;
    await call('ticket_claim_next', { id: made.ticket.id });
    const moved = (await call('ticket_update', { id: 'KONF-1', bucket: 'TB' })).structuredContent;
    assert.deepEqual([moved.ticket.id, moved.ticket.key], ['T-1', 'TB-1']);
    assert.equal((await call('ticket_get', { id: 'KONF-1' })).structuredContent.ticket.key, 'TB-1');
    const hidden = await call('ticket_update', { id: 'TB-1', bucket: 'PRIV' });
    const nope = await call('ticket_update', { id: 'TB-1', bucket: 'NOPE' });
    assert.equal(hidden.isError, true);
    assert.deepEqual(hidden.content, nope.content);
  } finally {
    tickets.stop();
    mcp.done();
  }
});
