// GET /api/lab/slices as a cursor page (D-58, T-382 S4): order, no duplicate or skip with an insert between pages, the cap, a 400 on a bad cursor,
// on a cursor reused with another filter or by another caller, and rows the caller may not read never shown. The routes run over a stand-in
// Lab whose `views` honours the session, role and since filters like the real one, so many slices need no tape.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import type { Actor, LabSlicePage, LabSliceView } from '@portal/contracts';
import { clearResolvers } from '../authz/seam.js';
import type { Lab, ViewFilter } from './index.js';
import { createLabRoutes } from './routes.js';

const T0 = Date.UTC(2026, 9, 14);

function view(session: string, n: number, startMs: number | null, role = 'implementer'): LabSliceView {
  return {
    sessionId: session,
    sliceId: `toolu_${String(n).padStart(4, '0')}`,
    kind: 'agent',
    ticket: 'T-1',
    role,
    startMs,
    outcome: 'unknown',
    arms: {},
  } as unknown as LabSliceView;
}

function standIn(rows: LabSliceView[]): Lab {
  return {
    views: (f: ViewFilter = {}) =>
      rows.filter(
        (v) =>
          (!f.sessionId || v.sessionId === f.sessionId) &&
          (!f.role || v.role === f.role) &&
          (f.fromMs === undefined || (v.startMs ?? 0) >= f.fromMs),
      ),
  } as unknown as Lab;
}

function app(lab: Lab, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) =>
    isAppError(e) ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500),
  );
  a.route('/api/lab', createLabRoutes(lab));
  return a;
}

type Api = ReturnType<typeof app>;
async function page(a: Api, qs: string): Promise<{ status: number; data: LabSlicePage }> {
  const res = await a.request(`/api/lab/slices${qs}`);
  return { status: res.status, data: ((await res.json()) as { data: LabSlicePage }).data };
}
const ids = (p: LabSlicePage) => p.items.map((v) => v.sliceId);
const agentOf = (sessionId: string) => ({ kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId, workspaceId: 'docker/api' }) as Actor;

const many = (count: number, session = 's1', role = 'implementer') =>
  Array.from({ length: count }, (_, i) => view(session, i, T0 + i * 1000, role));

test('slices page: newest first, 25 by default with total on the first page only, then the rest', async () => {
  const a = app(standIn(many(30)));
  const p1 = await page(a, '');
  assert.equal(p1.status, 200);
  assert.deepEqual([p1.data.items.length, p1.data.total, typeof p1.data.next], [25, 30, 'string']);
  assert.equal(p1.data.items[0]!.sliceId, 'toolu_0029', 'the newest start first');
  const p2 = await page(a, `?cursor=${encodeURIComponent(p1.data.next!)}`);
  assert.deepEqual([p2.data.items.length, p2.data.next, p2.data.total], [5, null, undefined]);
  assert.equal(new Set([...ids(p1.data), ...ids(p2.data)]).size, 30);
});

test('slices page: a slice inserted between pages is neither a duplicate nor a skip', async () => {
  const rows = many(10);
  const a = app(standIn(rows));
  const seen: string[] = [];
  const p1 = await page(a, '?limit=4');
  seen.push(...ids(p1.data));
  rows.push(view('s1', 99, T0 + 999_000)); // newer than everything: sorts before page 1, must not shift page 2
  rows.push(view('s1', 98, T0 + 1)); // older than the cursor: arrives on a later page
  let next = p1.data.next;
  while (next) {
    const p = await page(a, `?limit=4&cursor=${encodeURIComponent(next)}`);
    seen.push(...ids(p.data));
    next = p.data.next;
  }
  assert.equal(new Set(seen).size, seen.length, 'no duplicate');
  const expected = many(10)
    .map((v) => v.sliceId)
    .concat('toolu_0098');
  for (const id of expected) assert.ok(seen.includes(id), `${id} not skipped`);
  assert.ok(!seen.includes('toolu_0099'), 'a newer slice belongs to the first page, not a later one');
});

test('slices page: rows with the same start keep a stable order by id', async () => {
  const a = app(standIn(Array.from({ length: 6 }, (_, i) => view('s1', i, T0))));
  const seen: string[] = [];
  let next: string | null | undefined;
  do {
    const p = await page(a, `?limit=2${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
    seen.push(...ids(p.data));
    next = p.data.next;
  } while (next);
  assert.deepEqual(seen, ['toolu_0000', 'toolu_0001', 'toolu_0002', 'toolu_0003', 'toolu_0004', 'toolu_0005']);
});

test('slices page: the cap is 100, a limit under 1 is 1 and a non-number falls back to the default', async () => {
  const a = app(standIn(many(130)));
  assert.equal((await page(a, '?limit=1000')).data.items.length, 100);
  assert.equal((await page(a, '?limit=0')).data.items.length, 1);
  assert.equal((await page(a, '?limit=abc')).data.items.length, 25);
  assert.equal((await page(a, '?limit=3')).data.items.length, 3);
});

test('slices page: a bad cursor, one from another filter, an unfiltered one and one from another caller are all a 400', async () => {
  const rows = [...many(30), ...many(30, 's2', 'qa')];
  const owner = app(standIn(rows));
  const p1 = await page(owner, '?role=implementer&limit=5');
  const cur = encodeURIComponent(p1.data.next!);
  assert.equal((await page(owner, '?role=implementer&limit=5&cursor=' + cur)).status, 200);
  assert.equal((await page(owner, '?cursor=not-a-cursor')).status, 400);
  assert.equal((await page(owner, `?role=qa&cursor=${cur}`)).status, 400, 'another filter value');
  assert.equal((await page(owner, `?cursor=${cur}`)).status, 400, 'the filter dropped');
  assert.equal((await page(owner, `?role=implementer&since=${T0}&cursor=${cur}`)).status, 400, 'a filter added');
  const agent = app(standIn(rows), agentOf('s1'));
  const a1 = await page(agent, '?limit=5');
  assert.equal((await page(owner, `?cursor=${encodeURIComponent(a1.data.next!)}`)).status, 400, 'an agent cursor on the owner');
  assert.equal((await page(agent, `?cursor=${cur}`)).status, 400, 'the owner cursor on an agent');
});

test('slices page: an agent sees its own session only, never a row of another one, and no cursor names one', async () => {
  clearResolvers();
  const rows = [...many(8, 's1'), ...many(8, 's2')];
  const agent = app(standIn(rows), agentOf('s1'));
  const seen: string[] = [];
  let next: string | null | undefined;
  do {
    const p = await page(agent, `?limit=3${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
    assert.equal(p.status, 200);
    for (const v of p.data.items) assert.equal(v.sessionId, 's1');
    seen.push(...ids(p.data));
    next = p.data.next;
  } while (next);
  assert.equal(seen.length, 8);
  assert.equal((await agent.request('/api/lab/slices?session=s2')).status, 404);
  const bob = app(standIn(rows), { kind: 'user', userId: 'u_bob', loginSessionId: 'x', via: 'ui' } as Actor);
  assert.equal((await bob.request('/api/lab/slices')).status, 404, 'a user without the usage area sees nothing');
});
