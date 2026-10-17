// GET /api/ci/runs pages (D-58, T-382 S4): `{ items, next }` by keyset on creation time + id, 25 by default and 100 at most, a bad cursor or one
// made for another filter or caller is a 400, a run started during a walk causes no repeat and no skip, a run the caller may not view is in no
// page, no cursor and no count, and `total` / `active` ride on the first page only. Rows are cloned from one real run at run time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, type Actor, type CiRunPage } from '@portal/contracts';
import { Hono } from 'hono';
import { peekCursor } from '../store/keyset.js';
import { registerCiAuthz } from './authz.js';
import { createCiRoutes } from './routes.js';
import { harness, remote, WS, type H } from './testkit.js';

const user = (id: string): Actor => ({ kind: 'user', userId: id, loginSessionId: 'l1', via: 'ui' });
const ACTORS: Record<string, Actor> = { a: user('u_a'), b: user('u_b') };
const OTHER_WS = 'docker/other';

async function build() {
  const h = await harness();
  const routes = createCiRoutes(h.svc);
  // After createCiRoutes: it registers the default resolver (the founding user) itself.
  registerCiAuthz(h.svc, (ws) => (ws === WS ? 'u_a' : 'u_owner'));
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', async (c, next) => {
    const who = c.req.header('x-as');
    if (who) c.set('actor', ACTORS[who]!);
    await next();
  });
  app.route('/api/ci', routes);
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', (e as Error).message);
    return c.json(err.toJSON(), err.status as 500);
  });
  const get = (as: string, qs = '') => app.request(`http://x/api/ci/runs${qs}`, { headers: { 'x-as': as } });
  const page = async (as: string, qs = ''): Promise<CiRunPage> => {
    const res = await get(as, qs);
    assert.equal(res.status, 200, qs);
    return ((await res.json()) as { data: CiRunPage }).data;
  };
  const walk = async (as: string, qs: string, limit: number, between?: (n: number) => void) => {
    const ids: string[] = [];
    let cursor = '';
    for (let n = 0; n < 200; n++) {
      const p = await page(as, `?${qs}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      ids.push(...p.items.map((i) => i.id));
      if (!p.next) return ids;
      cursor = p.next;
      between?.(n);
    }
    throw new Error('the walk did not end');
  };
  return { h, get, page, walk };
}

/** One real run, then `count` copies of its row (ids `bulk-<n>`), created in runs of three equal stamps so the id has to break ties. */
async function seed(h: H, count: number, opts: { workspace?: (n: number) => string } = {}) {
  const repo = await remote(h);
  const first = await h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main' });
  const db = h.store.db!;
  const cols = (db.prepare('PRAGMA table_info(ci_runs)').all() as { name: string }[]).map((c) => c.name);
  const insert = db.prepare(`INSERT INTO ci_runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const base = db.prepare('SELECT * FROM ci_runs WHERE id = ?').get(first.id) as Record<string, unknown>;
  const add = (n: number, createdAt?: string) => {
    const row: Record<string, unknown> = {
      ...base,
      id: `bulk-${String(n).padStart(4, '0')}`,
      number: 1000 + n,
      event_id: null,
      status: n % 2 ? 'failed' : 'passed',
      created_at:
        createdAt ?? `2026-01-01T00:${String(Math.floor(n / 3) % 60).padStart(2, '0')}:${String(Math.floor(n / 180)).padStart(2, '0')}Z`,
      workspace_id: opts.workspace ? opts.workspace(n) : base.workspace_id,
    };
    insert.run(...cols.map((c) => (row[c] ?? null) as never));
  };
  for (let n = 0; n < count; n++) add(n);
  return { first: first.id, add };
}
const bulk = (h: H, where = '1 = 1') =>
  (
    h.store.db!.prepare(`SELECT id FROM ci_runs WHERE id LIKE 'bulk-%' AND ${where} ORDER BY created_at DESC, id DESC`).all() as {
      id: string;
    }[]
  ).map((r) => r.id);

test('order: newest first, ties by id, every run once; the default page is 25; total and active on page 1 only', async () => {
  const t = await build();
  try {
    await seed(t.h, 30);
    assert.deepEqual(
      (await t.walk('a', 'status=passed,failed', 7)).filter((id) => id.startsWith('bulk-')),
      bulk(t.h),
    );
    assert.equal(CURSOR_DEFAULT_LIMIT, 25);
    const first = await t.page('a');
    assert.equal(first.items.length, CURSOR_DEFAULT_LIMIT);
    assert.ok(first.next);
    assert.equal(first.total, 31, 'every run the caller may view');
    assert.equal(typeof first.active, 'number');
    const second = await t.page('a', `?cursor=${encodeURIComponent(first.next!)}`);
    assert.equal(second.total, undefined, 'later pages carry no counts');
    assert.equal(second.next, null, 'last page: next is null');
  } finally {
    t.h.done();
  }
});

test('a run started between two pages causes no repeat and no skip', async () => {
  const t = await build();
  try {
    const { add } = await seed(t.h, 12);
    const original = bulk(t.h);
    let wrote = 0;
    const ids = await t.walk('a', 'status=passed,failed', 3, () => {
      // a new run, newer than everything: it joins the head of the list, behind the walk, and pushes every row down by one
      add(100 + wrote++, `2030-01-01T00:00:${String(wrote).padStart(2, '0')}Z`);
    });
    assert.ok(wrote >= 3);
    assert.equal(new Set(ids).size, ids.length, 'no repeat');
    assert.deepEqual(
      ids.filter((id) => original.includes(id)),
      original,
      'every old run, in order, none skipped',
    );
  } finally {
    t.h.done();
  }
});

test('limit: above 100 is cut to 100, below 1 to 1, junk to the default', async () => {
  const t = await build();
  try {
    await seed(t.h, 130);
    const big = await t.page('a', '?limit=1000');
    assert.equal(big.items.length, CURSOR_MAX_LIMIT);
    assert.ok(big.next);
    assert.equal((await t.page('a', '?limit=0')).items.length, 1);
    assert.equal((await t.page('a', '?limit=abc')).items.length, CURSOR_DEFAULT_LIMIT);
    assert.equal((await t.walk('a', 'status=passed,failed', 100)).filter((id) => id.startsWith('bulk-')).length, 130);
  } finally {
    t.h.done();
  }
});

test('a bad cursor is a 400: garbage, a tampered one, one from another filter, one from another caller', async () => {
  const t = await build();
  try {
    await seed(t.h, 8);
    const next = (await t.page('a', '?status=failed&limit=2')).next!;
    const [body, sig] = next.split('.');
    const flipped = `${body}.${sig!.slice(0, -2)}${sig!.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const cursor of ['garbage', 'a.b', `${body}`, flipped, `${next}.x`]) {
      assert.equal((await t.get('a', `?status=failed&cursor=${encodeURIComponent(cursor)}`)).status, 400, cursor);
    }
    assert.equal(
      (await t.get('a', `?status=passed&cursor=${encodeURIComponent(next)}`)).status,
      400,
      'a cursor of the failed runs does not open the passed ones',
    );
    assert.equal((await t.get('a', `?cursor=${encodeURIComponent(next)}`)).status, 400, 'nor the unfiltered list');
    assert.equal((await t.get('b', `?status=failed&cursor=${encodeURIComponent(next)}`)).status, 400, 'a cursor is the caller’s own');
    assert.equal((await t.get('a', `?status=failed&cursor=${encodeURIComponent(next)}`)).status, 200, 'the real one still works');
  } finally {
    t.h.done();
  }
});

test('authz: a run the caller may not view is in no page, no count and no cursor', async () => {
  const t = await build();
  try {
    await seed(t.h, 12, { workspace: (n) => (n % 3 === 0 ? OTHER_WS : WS) });
    const mine = new Set(bulk(t.h, `workspace_id = '${WS}'`));
    const hidden = new Set(bulk(t.h, `workspace_id = '${OTHER_WS}'`));
    assert.ok(hidden.size > 0);
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor = '';
    let counts: [number | undefined, number | undefined] = [undefined, undefined];
    for (let n = 0; n < 40; n++) {
      const p = await t.page('a', `?status=passed,failed&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (n === 0) counts = [p.total, p.active];
      for (const r of p.items) assert.ok(!hidden.has(r.id), `${r.id} is not A's`);
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursors.push(p.next);
      cursor = p.next;
    }
    assert.deepEqual(
      seen.filter((id) => id.startsWith('bulk-')),
      bulk(t.h, `workspace_id = '${WS}'`),
      'exactly A’s runs, in order, each once',
    );
    assert.equal(counts[0], seen.length, 'the total counts only what A may view');
    assert.ok(cursors.length > 0);
    for (const c of cursors) {
      const named = peekCursor(c).id as string;
      assert.ok(!hidden.has(named), 'a cursor points at a run that was shown, never at a hidden one');
    }
    assert.equal(mine.size + hidden.size, 12);
    const b = await t.page('b');
    assert.deepEqual([b.items.length, b.total, b.active], [0, 0, 0], 'B sees nothing and counts nothing');
  } finally {
    t.h.done();
  }
});
