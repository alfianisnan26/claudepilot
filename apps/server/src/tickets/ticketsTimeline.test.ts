// T-119 S1b: GET /api/tickets/timeline. The tickets whose life overlaps a window, each with its flow computed from the stored events; a window
// bounded by the granularity (400 that names the limit); 25 rows by default, 100 at most, by keyset on the number; a ticket the caller may not
// view is in no page and no cursor names it; an agent sees its workspace and the shared queue only. Time is the harness clock: no real clock.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, TICKET_TIMELINE_LIMITS, ticketRef, type TicketTimeline } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { peekCursor } from '../store/keyset.js';
import { createTicketRoutes } from './routes.js';
import { agent, ticketsHarness, UI } from './testkit.js';
import { WAITING_TAG } from './ticketFlow.js';

afterEach(() => clearResolvers());

const T0 = Date.parse('2026-10-18T00:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A harness whose clock is `clock.at`, set by the test. */
async function clocked() {
  const clock = { at: T0 };
  const h = await ticketsHarness({ now: () => new Date(clock.at) });
  return { h, clock };
}
type H = Awaited<ReturnType<typeof clocked>>['h'];

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
const get = async (a: Hono, qs: string): Promise<TicketTimeline> => {
  const res = await a.request(`/timeline${qs}`);
  assert.equal(res.status, 200, qs);
  return ((await res.json()) as { data: TicketTimeline }).data;
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : String(e);
  }
  return 'none';
};
const window = (fromMin: number, toMin: number, rest = '') => `?from=${encodeURIComponent(iso(T0 + fromMin * MIN))}&to=${encodeURIComponent(iso(T0 + toMin * MIN))}${rest}`;
const brief = (t: TicketTimeline, id: string) => t.items.find((i) => i.id === id)!.flow.spans.map((s) => `${s.state}@${(Date.parse(s.start) - T0) / MIN}${s.end === null ? '..' : `-${(Date.parse(s.end) - T0) / MIN}`}`);

test('a ticket’s flow comes from its stored events: open, working, closed; and one that is still open runs to now', async () => {
  const { h, clock } = await clocked();
  try {
    const a1 = h.tickets.create(UI, { summary: 'Alpha' });
    clock.at = T0 + 10 * MIN;
    h.tickets.update(UI, a1.id, { status: 'in_progress' });
    clock.at = T0 + 20 * MIN;
    const b = h.tickets.create(UI, { summary: 'Beta' });
    clock.at = T0 + 60 * MIN;
    h.tickets.close(UI, a1.id, { outcome: 'done', summary: 'Done.' });
    clock.at = T0 + 90 * MIN;
    const t = await get(app(h), window(-5, 100));
    assert.deepEqual(t.items.map((i) => i.id), [a1.id, b.id]);
    assert.deepEqual(brief(t, a1.id), ['open@0-10', 'in_progress@10-60', 'done@60-60']);
    assert.deepEqual(brief(t, b.id), ['open@20..']);
    assert.equal(t.items[1]!.flow.spans[0]!.durationMs, 70 * MIN, 'an open span runs to the harness clock');
    assert.deepEqual([t.granularity, t.now, t.items[0]!.summary, t.items[0]!.status], ['hour', iso(T0 + 90 * MIN), 'Alpha', 'done']);
  } finally {
    h.done();
  }
});

test('the window picks the tickets whose life overlaps it: created before the end, not closed before the start; a reopened one is back in', async () => {
  const { h, clock } = await clocked();
  try {
    const early = h.tickets.create(UI, { summary: 'closed before' });
    clock.at = T0 + 5 * MIN;
    h.tickets.close(UI, early.id, { outcome: 'done', summary: 'Done.' });
    clock.at = T0 + 30 * MIN;
    const inside = h.tickets.create(UI, { summary: 'inside' });
    clock.at = T0 + 200 * MIN;
    const late = h.tickets.create(UI, { summary: 'created after' });
    const reopened = h.tickets.create(UI, { summary: 'reopened' });
    clock.at = T0 + 220 * MIN;
    h.tickets.close(UI, reopened.id, { outcome: 'done', summary: 'Done.' });
    clock.at = T0 + 230 * MIN;
    h.tickets.update(UI, reopened.id, { status: 'open' });
    clock.at = T0 + 300 * MIN;
    const ids = (t: TicketTimeline) => t.items.map((i) => i.id);
    const a = app(h);
    assert.deepEqual(ids(await get(a, window(10, 100))), [inside.id], 'the one closed at 5 and the ones created after 100 are out');
    assert.deepEqual(ids(await get(a, window(0, 100))), [early.id, inside.id]);
    assert.deepEqual(ids(await get(a, window(250, 280))), [inside.id, late.id, reopened.id], 'open tickets overlap any later window');
    // Reopened: it was closed at 220, so a window inside 220..230 holds it too, and its flow ends open again.
    const t = await get(a, window(190, 280));
    assert.deepEqual(brief(t, reopened.id), ['open@200-220', 'done@220-220', 'open@230..']);
  } finally {
    h.done();
  }
});

test('waiting for a person shows as a span from the tag, and a marker', async () => {
  const { h, clock } = await clocked();
  try {
    const t1 = h.tickets.create(UI, { summary: 'Needs you' });
    clock.at = T0 + 15 * MIN;
    h.tickets.update(UI, t1.id, { tags: [WAITING_TAG] });
    clock.at = T0 + 45 * MIN;
    h.tickets.update(UI, t1.id, { tags: [] });
    clock.at = T0 + 60 * MIN;
    const t = await get(app(h), window(-5, 70));
    assert.deepEqual(brief(t, t1.id), ['open@0-15', 'waiting@15-45', 'open@45..']);
    assert.ok(t.items[0]!.flow.markers.some((m) => m.kind === 'waiting'));
  } finally {
    h.done();
  }
});

test('guards: the window is bounded by the granularity, and every bad parameter is a 400 that says what to use', async () => {
  const { h, clock } = await clocked();
  try {
    h.tickets.create(UI, { summary: 'One' });
    clock.at = T0 + 3 * DAY;
    const a = app(h);
    const ask = (q: Record<string, unknown>) => code(() => h.tickets.timeline(UI, q));
    // At the limit: allowed. One millisecond over: refused.
    for (const g of ['minute', 'hour', 'day'] as const) {
      const max = TICKET_TIMELINE_LIMITS[g].maxWindowMs;
      assert.equal(ask({ granularity: g, from: iso(T0 + 3 * DAY - max), to: iso(T0 + 3 * DAY) }), 'none', `${g} at the limit`);
      assert.equal(ask({ granularity: g, from: iso(T0 + 3 * DAY - max - 1), to: iso(T0 + 3 * DAY) }), 'VALIDATION_FAILED', `${g} over the limit`);
    }
    // The route: a minute scale over a week is refused with the reason, a coarser scale over the same window is fine.
    const week = `from=${encodeURIComponent(iso(T0 - 4 * DAY))}&to=${encodeURIComponent(iso(T0 + 3 * DAY))}`;
    const refused = await a.request(`/timeline?granularity=minute&${week}`);
    assert.ok(refused.status >= 400 && refused.status < 500);
    const body = JSON.stringify(await refused.json());
    assert.match(body, /too long for the minute scale/);
    assert.match(body, /24 hours/);
    assert.equal((await a.request(`/timeline?granularity=hour&${week}`)).status, 200);
    // Bad parameters.
    assert.equal(ask({ granularity: 'week' }), 'VALIDATION_FAILED');
    assert.equal(ask({ granularity: 5 }), 'VALIDATION_FAILED');
    assert.equal(ask({ from: 'yesterday' }), 'VALIDATION_FAILED');
    assert.equal(ask({ to: 12345 }), 'VALIDATION_FAILED');
    assert.equal(ask({ from: iso(T0 + 2 * DAY), to: iso(T0 + 2 * DAY) }), 'VALIDATION_FAILED', 'from must be before to');
    assert.equal(ask({ from: iso(T0 + 2 * DAY), to: iso(T0) }), 'VALIDATION_FAILED');
    // Defaults: hour, to = now, from = the default window before it; a cursor of another window is refused.
    const d = await get(a, '');
    assert.deepEqual([d.granularity, d.to, d.from], ['hour', iso(T0 + 3 * DAY), iso(T0 + 3 * DAY - TICKET_TIMELINE_LIMITS.hour.defaultWindowMs)]);
    assert.equal((await get(a, '?granularity=day')).from, iso(T0 + 3 * DAY - TICKET_TIMELINE_LIMITS.day.defaultWindowMs));
  } finally {
    h.done();
  }
});

test('a ticket cap with a cursor: 25 by default, 100 at most, every ticket once in number order; a bad or foreign cursor is a 400', async () => {
  const { h } = await clocked();
  try {
    for (let i = 0; i < 130; i++) h.tickets.create(UI, { summary: `Bulk ${i}` });
    const a = app(h);
    const q = (rest: string) => window(-5, 5, rest);
    const first = await get(a, q(''));
    assert.equal(first.items.length, CURSOR_DEFAULT_LIMIT);
    assert.equal((await get(a, q('&limit=1000'))).items.length, CURSOR_MAX_LIMIT);
    assert.equal((await get(a, q('&limit=0'))).items.length, 1);
    assert.equal((await get(a, q('&limit=junk'))).items.length, CURSOR_DEFAULT_LIMIT);
    const ids: string[] = [];
    let cursor = '';
    for (let n = 0; n < 60; n++) {
      const p = await get(a, q(`&limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      ids.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursor = p.next;
    }
    assert.deepEqual(ids, Array.from({ length: 130 }, (_, i) => `T-${i + 1}`), 'every ticket once, in number order');
    const next = first.next!;
    assert.ok(next);
    for (const bad of ['garbage', 'a.b', `${next}.x`]) assert.equal((await a.request(`/timeline${q(`&cursor=${encodeURIComponent(bad)}`)}`)).status, 400, bad);
    assert.equal((await a.request(`/timeline${window(-5, 6, `&cursor=${encodeURIComponent(next)}`)}`)).status, 400, 'a cursor of another window');
    assert.equal((await a.request(`/timeline${q(`&granularity=day&cursor=${encodeURIComponent(next)}`)}`)).status, 400, 'a cursor of another scale');
    // A plain list cursor is not a timeline cursor either.
    const listNext = (((await (await a.request('/?limit=2')).json()) as { data: { next: string } }).data.next);
    assert.equal((await a.request(`/timeline${q(`&cursor=${encodeURIComponent(listNext)}`)}`)).status, 400);
    assert.equal((await a.request(`/timeline${q(`&cursor=${encodeURIComponent(next)}`)}`)).status, 200, 'the real one works');
  } finally {
    h.done();
  }
});

test('authz: a ticket the caller may not view is in no page and no cursor names it', async () => {
  const { h } = await clocked();
  try {
    for (let i = 0; i < 12; i++) h.tickets.create(UI, { summary: `T ${i}` });
    const mine = new Set(Array.from({ length: 12 }, (_, i) => `T-${i + 1}`).filter((_, i) => i % 2 === 0));
    registerResolver({
      type: 'ticket',
      resolve: (id) => ({ ref: ticketRef(id), owner: mine.has(id) ? { kind: 'user', id: 'u_a' } : { kind: 'user', id: 'u_b' } }),
    });
    const them = app(h, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor = '';
    for (let n = 0; n < 20; n++) {
      const p = await get(them, window(-5, 5, `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursors.push(p.next);
      cursor = p.next;
    }
    assert.deepEqual(seen, [...mine], 'exactly the tickets u_a may view, in order, each once');
    assert.ok(cursors.length > 0);
    for (const c of cursors) assert.ok(mine.has(`T-${peekCursor(c).id as number}`), 'a cursor rests on a row that was shown');
    // The whole body of what u_a gets names no hidden ticket.
    const raw = await (await them.request(`/timeline${window(-5, 5, '&limit=100')}`)).text();
    for (let n = 1; n <= 12; n++) if (!mine.has(`T-${n}`)) assert.ok(!raw.includes(`"T-${n}"`), `T-${n} is not in the answer`);
  } finally {
    h.done();
  }
});

test('an agent sees its workspace’s tickets and the shared queue, never another workspace’s; an admin token sees all', async () => {
  const { h } = await clocked();
  try {
    h.sessions.add({ workspaceId: 'docker/api', id: 'sa' });
    h.tickets.create(UI, { summary: 'shared' });
    h.tickets.create(UI, { summary: 'mine', workspaceId: 'docker/api' });
    const theirs = h.tickets.create(UI, { summary: 'theirs, secret plans', workspaceId: 'docker/web' });
    h.tickets.comment(UI, theirs.id, 'a comment nobody else should read');
    const me = agent('docker/api', 'sa');
    const w = { from: iso(T0 - 5 * MIN), to: iso(T0 + 5 * MIN) };
    const mineSeen = h.tickets.timeline(me, w);
    assert.deepEqual(mineSeen.items.map((i) => i.summary), ['shared', 'mine']);
    const raw = JSON.stringify(mineSeen);
    assert.ok(!raw.includes('secret plans') && !raw.includes('nobody else should read') && !raw.includes(theirs.id), 'nothing of the other workspace is in it');
    assert.equal(h.tickets.timeline(agent('docker/web', 'sw'), w).items.length, 2, 'the web agent sees shared and its own');
    assert.equal(h.tickets.timeline({ kind: 'token', tokenId: 'ptk_s', label: 'x', scope: 'read' }, w).items.length, 3, 'an admin token sees all');
    // An agent’s cursor is not the person’s.
    for (let i = 0; i < 4; i++) h.tickets.create(UI, { summary: `more ${i}` });
    const next = h.tickets.timeline(UI, w, { limit: 2 }).next!;
    assert.ok(next);
    assert.equal(code(() => h.tickets.timeline(me, w, { cursor: next })), 'BAD_REQUEST');
  } finally {
    h.done();
  }
});
