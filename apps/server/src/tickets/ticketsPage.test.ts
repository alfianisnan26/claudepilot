// GET /api/tickets pages (D-58, T-382 S3): `{ items, next }` by keyset on the list's sort key + the ticket number, 25 by default and 100 at most,
// a bad cursor or one made for another filter is a 400, a ticket created during a walk causes no repeat and no skip, a ticket the caller may
// not view is in no page and no cursor names it, and a row carries a cut description (the detail read has the whole text).
// Fixtures are built here, at run time.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, objectRef, TICKET_LIST_TEXT, TICKET_PRIORITIES, ticketRef, type TicketPage } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { peekCursor } from '../store/keyset.js';
import { createTicketRoutes } from './routes.js';
import { ticketsHarness, UI } from './testkit.js';

afterEach(() => clearResolvers());

type H = Awaited<ReturnType<typeof ticketsHarness>>;

const app = (h: H, actor: unknown = 'owner') => {
  const a = new Hono();
  a.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as 404);
  });
  a.use(async (c, next) => {
    if (actor === 'owner') (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
    else if (actor) (c as unknown as { set(k: string, v: unknown): void }).set('actor', actor);
    await next();
  });
  a.route('/', createTicketRoutes(h.tickets));
  return a;
};
const page = async (a: Hono, qs = ''): Promise<TicketPage> => {
  const res = await a.request(`/${qs}`);
  assert.equal(res.status, 200, qs);
  return ((await res.json()) as { data: TicketPage }).data;
};
const q = (cursor: string, rest: string) => `?${rest}${cursor ? `${rest ? '&' : ''}cursor=${encodeURIComponent(cursor)}` : ''}`;
const walk = async (a: Hono, rest: string, between?: (n: number) => void) => {
  const ids: string[] = [];
  let cursor = '';
  for (let n = 0; n < 300; n++) {
    const p = await page(a, q(cursor, rest));
    ids.push(...p.items.map((i) => i.id));
    if (!p.next) return ids;
    cursor = p.next;
    between?.(n);
  }
  throw new Error('the walk did not end');
};

/** `count` tickets of mixed priorities; created and updated stamps come in runs of three equal values, so the number has to break ties. */
function seeded(h: H, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++)
    ids.push(h.tickets.create(UI, { summary: `Ticket ${i}`, priority: TICKET_PRIORITIES[i % TICKET_PRIORITIES.length]! }).id);
  const stamp = (i: number) => `2026-01-01T00:00:${String(Math.floor(i / 3)).padStart(2, '0')}Z`;
  const db = h.store.db!;
  const nums = (db.prepare('SELECT number FROM tickets ORDER BY number').all() as { number: number }[]).map((r) => r.number);
  nums.forEach((n, i) => db.prepare('UPDATE tickets SET created_at = ?, updated_at = ? WHERE number = ?').run(stamp(i), stamp(i), n));
  return ids;
}
const idOf = (n: number) => `T-${n}`;
const inOrder = (h: H, order: string) =>
  (
    h.store.db!.prepare(`SELECT t.number FROM tickets t WHERE t.status NOT IN ('done','wont_do') ORDER BY ${order}`).all() as {
      number: number;
    }[]
  ).map((r) => idOf(r.number));
const PRIORITY_ORDER = 't.priority_rank ASC, t.updated_at DESC, t.number DESC';
const NEWEST_ORDER = 't.created_at DESC, t.number DESC';

test('order: priority, newest and closed-only lists page in the list order, every ticket once; the default page is 25', async () => {
  const h = await ticketsHarness();
  try {
    seeded(h, 14);
    const a = app(h);
    assert.deepEqual(await walk(a, 'limit=3'), inOrder(h, PRIORITY_ORDER));
    assert.deepEqual(await walk(a, 'limit=3&sort=newest'), inOrder(h, NEWEST_ORDER));
    // The same walk agrees with the one-shot list the service answers (the order did not change).
    assert.deepEqual(
      await walk(a, 'limit=100'),
      h.tickets.list(UI, { limit: 100 }).items.map((i) => i.id),
    );
    // Closed only: by closed_at, then number.
    for (const n of [2, 5, 9, 11]) h.tickets.close(UI, idOf(n), { outcome: 'done', summary: 'Done.' });
    h.store.db!.prepare("UPDATE tickets SET closed_at = '2026-02-01T00:00:00Z' WHERE number IN (2, 5, 9)").run();
    h.store.db!.prepare("UPDATE tickets SET closed_at = '2026-03-01T00:00:00Z' WHERE number = 11").run();
    assert.deepEqual(await walk(a, 'limit=1&status=done'), ['T-11', 'T-9', 'T-5', 'T-2']);
    const first = await page(a);
    assert.equal(first.items.length, 10, 'the open ones (4 are closed)');
    assert.equal(first.next, null, 'last page: next is null');
    assert.equal(CURSOR_DEFAULT_LIMIT, 25);
  } finally {
    h.done();
  }
});

test('a ticket created between two pages causes no repeat and no skip (both sorts)', async () => {
  for (const sort of ['', '&sort=newest']) {
    const h = await ticketsHarness();
    try {
      seeded(h, 11);
      const original = inOrder(h, sort ? NEWEST_ORDER : PRIORITY_ORDER);
      let made = 0;
      const ids = await walk(app(h), `limit=2${sort}`, () => {
        made++;
        h.tickets.create(UI, { summary: `Late ${made}`, priority: TICKET_PRIORITIES[made % TICKET_PRIORITIES.length]! });
      });
      assert.ok(made >= 3);
      assert.equal(new Set(ids).size, ids.length, `no repeat (${sort || 'priority'})`);
      assert.deepEqual(
        ids.filter((id) => original.includes(id)),
        original,
        `every old ticket, in order, none skipped (${sort || 'priority'})`,
      );
    } finally {
      h.done();
    }
  }
});

test('limit: above 100 is cut to 100, below 1 to 1, junk to the default', async () => {
  const h = await ticketsHarness();
  try {
    for (let i = 0; i < 130; i++) h.tickets.create(UI, { summary: `Bulk ${i}` });
    const a = app(h);
    const big = await page(a, '?limit=1000');
    assert.equal(big.items.length, CURSOR_MAX_LIMIT);
    assert.ok(big.next);
    assert.equal((await page(a, '?limit=0')).items.length, 1);
    assert.equal((await page(a, '?limit=abc')).items.length, CURSOR_DEFAULT_LIMIT);
    assert.equal((await walk(a, 'limit=100')).length, 130);
    assert.equal((await walk(a, 'limit=1000')).length, 130);
  } finally {
    h.done();
  }
});

test('a bad cursor is a 400: garbage, a tampered one, one made for another filter or sort', async () => {
  const h = await ticketsHarness();
  try {
    seeded(h, 9);
    h.tickets.update(UI, 'T-1', { tags: ['alpha'] });
    const a = app(h);
    const next = (await page(a, '?limit=2')).next!;
    assert.ok(next);
    const [body, sig] = next.split('.');
    const flipped = `${body}.${sig!.slice(0, -2)}${sig!.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const cursor of ['garbage', 'a.b', `${body}`, flipped, `${next}.x`]) {
      const res = await a.request(`/?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(res.status, 400, cursor);
    }
    for (const other of [
      'status=open',
      'tag=alpha',
      'assignee=unassigned',
      'workspace=docker%2Fws1',
      'q=Ticket',
      'priority=high',
      'type=task',
      'includeClosed=1',
      'sort=newest',
      'orphan=1',
    ]) {
      const res = await a.request(`/?${other}&cursor=${encodeURIComponent(next)}`);
      assert.equal(res.status, 400, `a cursor of the plain list does not open ${other}`);
    }
    assert.equal((await a.request(`/?cursor=${encodeURIComponent(next)}`)).status, 200, 'the real one still works');
    // Another caller's cursor: an agent of a workspace gets a 400 on the person's cursor.
    const t = h.tickets;
    assert.throws(
      () => t.listPage({ kind: 'agent', tokenId: 'agt_x', label: 'x', workspaceId: 'docker/ws1', sessionId: 'x' }, {}, { cursor: next }),
      /cursor is not valid/,
    );
  } finally {
    h.done();
  }
});

test('authz: a ticket the caller may not view is in no page and no cursor names it', async () => {
  const h = await ticketsHarness();
  try {
    seeded(h, 12);
    const all = inOrder(h, PRIORITY_ORDER);
    const mine = new Set(all.filter((_, i) => i % 2 === 0));
    registerResolver({
      type: 'ticket',
      resolve: (id) => ({ ref: ticketRef(id), owner: mine.has(id) ? { kind: 'user', id: 'u_a' } : { kind: 'user', id: 'u_b' } }),
    });
    const them = app(h, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    // T-1098: a ticket is also reached through its bucket; u_a may view the bucket, so only the ticket rule hides rows here.
    registerResolver({ type: 'ticket_bucket', resolve: (id) => ({ ref: objectRef('ticket_bucket', id), owner: { kind: 'user', id: 'u_a' } }) });
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor = '';
    for (let n = 0; n < 20; n++) {
      const p = await page(them, q(cursor, 'limit=2'));
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursors.push(p.next);
      cursor = p.next;
    }
    assert.deepEqual(
      seen,
      all.filter((id) => mine.has(id)),
      'exactly the tickets u_a may view, in order, each once',
    );
    assert.ok(cursors.length > 0);
    for (const c of cursors) {
      const named = peekCursor(c).id as number;
      assert.ok(mine.has(idOf(named)), 'a cursor points at a row that was shown, never at a hidden one');
    }
  } finally {
    h.done();
  }
});

test('rows are summaries: the description and closing summary are cut, the detail has the whole text', async () => {
  const h = await ticketsHarness();
  try {
    const long = `${'x'.repeat(TICKET_LIST_TEXT + 500)}TAILMARK`;
    const big = h.tickets.create(UI, { summary: 'Long one', description: long });
    const small = h.tickets.create(UI, { summary: 'Short one', description: 'A short text.' });
    h.tickets.close(UI, big.id, { outcome: 'done', summary: `${'y'.repeat(TICKET_LIST_TEXT + 100)}CLOSEMARK` });
    const a = app(h);
    const res = await a.request('/?includeClosed=1');
    const raw = await res.text();
    assert.ok(!raw.includes('TAILMARK') && !raw.includes('CLOSEMARK'), 'no row carries the tail of a long text');
    const rows = (JSON.parse(raw) as { data: TicketPage }).data.items;
    const b = rows.find((r) => r.id === big.id)!;
    assert.equal(b.description.length, TICKET_LIST_TEXT);
    assert.equal(b.descriptionCut, true);
    assert.equal(b.closingSummary!.length, TICKET_LIST_TEXT);
    assert.equal(b.closingSummaryCut, true);
    const s = rows.find((r) => r.id === small.id)!;
    assert.equal(s.description, 'A short text.');
    assert.equal(s.descriptionCut, false);
    const d = await a.request(`/${big.id}`);
    const detail = ((await d.json()) as { data: { ticket: { description: string; closingSummary: string } } }).data.ticket;
    assert.equal(detail.description, long, 'the single-ticket GET still gives the whole text');
    assert.ok(detail.closingSummary.endsWith('CLOSEMARK'));
    // A search still finds a word that sits past the cut.
    h.tickets.create(UI, { summary: 'Plain', description: `${'z'.repeat(400)} needlefarpast` });
    assert.equal((await page(a, '?q=needlefarpast')).items.length, 1);
  } finally {
    h.done();
  }
});

test('total and counts ride on the first page only', async () => {
  const h = await ticketsHarness();
  try {
    seeded(h, 5);
    const a = app(h);
    const first = await page(a, '?limit=2');
    assert.equal(first.total, 5);
    assert.equal(first.counts!.byStatus.open, 5);
    const second = await page(a, q(first.next!, 'limit=2'));
    assert.equal(second.total, undefined);
    assert.equal(second.counts, undefined);
  } finally {
    h.done();
  }
});

test('bounded scan: when keep hides everything a request reads at most 10 x limit rows, and paging still reaches the end', async () => {
  const h = await ticketsHarness();
  try {
    seeded(h, 60);
    let calls = 0;
    let cursor: string | undefined;
    let requests = 0;
    for (; requests < 50; requests++) {
      calls = 0;
      const p = h.tickets.listPage(UI, {}, { cursor, limit: 2, keep: () => (calls++, false) });
      assert.ok(calls <= 20, `request ${requests} read ${calls} rows (bound is 20)`);
      assert.equal(p.items.length, 0);
      if (!p.next) break;
      cursor = p.next;
    }
    assert.equal(requests, 2, '60 rows at 20 per request: two cursors, the third request ends');
  } finally {
    h.done();
  }
});

test('bounded scan: a sparse keep still yields every kept row once across the bounded requests', async () => {
  const h = await ticketsHarness();
  try {
    seeded(h, 60);
    const all = inOrder(h, PRIORITY_ORDER);
    const kept = new Set(all.filter((_, i) => i % 25 === 0));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 50; n++) {
      const p = h.tickets.listPage(UI, {}, { cursor, limit: 1, keep: (t) => kept.has(t.id) });
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      assert.equal(typeof peekCursor(p.next).id, 'number');
      cursor = p.next;
    }
    assert.deepEqual(
      seen,
      all.filter((id) => kept.has(id)),
    );
  } finally {
    h.done();
  }
});
