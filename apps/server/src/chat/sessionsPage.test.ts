// GET /api/chat/sessions pages (D-58, T-382 S2): `{ items, next }` by keyset on last activity + id, 25 by default and 100 at most, a bad or foreign
// cursor is a 400, a session started during a walk causes no repeat and no skip, and a session the caller may not view never shows up in a
// page nor in a cursor. Fixtures are built here, at run time.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, type ChatSession, type CursorPage } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers } from '../authz/seam.js';
import { peekCursor } from '../store/keyset.js';
import { registerChatAuthz } from './authz.js';
import { createChatRoutes } from './routes.js';
import { liveSession, until, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const app = (s: Live, actor: unknown = 'owner') => {
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
  a.route('/', createChatRoutes(s.controller));
  return a;
};
const page = async (a: Hono, qs = ''): Promise<CursorPage<ChatSession>> => {
  const res = await a.request(`/${qs}`);
  assert.equal(res.status, 200, qs);
  return ((await res.json()) as { data: CursorPage<ChatSession> }).data;
};
const walk = async (a: Hono, limit: number, between?: (n: number) => Promise<void>) => {
  const ids: string[] = [];
  let cursor = '';
  for (let n = 0; n < 200; n++) {
    const p = await page(a, `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    ids.push(...p.items.map((i) => i.id));
    if (!p.next) return ids;
    cursor = p.next;
    await between?.(n);
  }
  throw new Error('the walk did not end');
};

/** `count` sessions in all (the first is the live one); activity stamps come in runs of three equal values, so the id has to break ties. */
async function seeded(count: number): Promise<Live> {
  const s = await liveSession();
  for (let i = 1; i < count; i++) {
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === i + 1);
  }
  const ids = (s.store.db!.prepare('SELECT id FROM chat_sessions ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  ids.forEach((id, i) =>
    s.store
      .db!.prepare('UPDATE chat_sessions SET last_activity_at = ? WHERE id = ?')
      .run(`2026-01-01T00:00:${String(Math.floor(i / 3)).padStart(2, '0')}Z`, id),
  );
  return s;
}
const everything = (s: Live) =>
  (s.store.db!.prepare('SELECT id FROM chat_sessions ORDER BY last_activity_at DESC, id DESC').all() as { id: string }[]).map((r) => r.id);

test('order: newest activity first, ties by id, every session once; the default page is 25', async () => {
  const s = await seeded(8);
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const a = app(s);
    assert.deepEqual(await walk(a, 3), everything(s));
    const first = await page(a);
    assert.equal(first.items.length, 8);
    assert.equal(first.next, null, 'last page: next is null');
    assert.equal(CURSOR_DEFAULT_LIMIT, 25);
    const two = await page(a, '?limit=2');
    assert.equal(two.items.length, 2);
    assert.ok(two.next, 'more follow');
  } finally {
    await s.done();
  }
});

test('a session started between two pages causes no repeat and no skip', async () => {
  const s = await seeded(9);
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const original = everything(s);
    let started = 0;
    const ids = await walk(app(s), 2, async () => {
      started++;
      await s.controller.create({ workspaceId: 'docker/ws1' });
      await until(() => s.ws.tails.length === 9 + started);
    });
    assert.ok(started >= 3);
    assert.equal(new Set(ids).size, ids.length, 'no repeat');
    assert.deepEqual(
      ids.filter((id) => original.includes(id)),
      original,
      'every old session, in order, none skipped',
    );
  } finally {
    await s.done();
  }
});

test('limit: above 100 is cut to 100, below 1 to 1, junk to the default', async () => {
  const s = await seeded(2);
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const db = s.store.db!;
    const cols = (db.prepare('PRAGMA table_info(chat_sessions)').all() as { name: string }[]).map((c) => c.name);
    const pick = cols.map((c) => (c === 'id' ? "'bulk-' || n" : c)).join(', ');
    db.exec(
      `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 130) INSERT INTO chat_sessions (${cols.join(', ')}) SELECT ${pick} FROM chat_sessions, g WHERE chat_sessions.id = '${s.id}'`,
    );
    const a = app(s);
    const big = await page(a, '?limit=1000');
    assert.equal(big.items.length, CURSOR_MAX_LIMIT);
    assert.ok(big.next);
    assert.equal((await page(a, '?limit=0')).items.length, 1);
    assert.equal((await page(a, '?limit=abc')).items.length, CURSOR_DEFAULT_LIMIT);
    assert.equal((await walk(a, 100)).length, 132);
  } finally {
    await s.done();
  }
});

test('a bad cursor is a 400: garbage, a tampered one, one from another list', async () => {
  const s = await seeded(5);
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const a = app(s);
    const next = (await page(a, '?limit=2')).next!;
    const [body, sig] = next.split('.');
    const flipped = `${body}.${sig!.slice(0, -2)}${sig!.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const cursor of ['garbage', 'a.b', `${body}`, flipped, `${next}.x`]) {
      const res = await a.request(`/?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(res.status, 400, cursor);
    }
    const other = await a.request(`/?parentId=${s.id}&cursor=${encodeURIComponent(next)}`);
    assert.equal(other.status, 400, 'a cursor of the whole list does not open the children list');
    assert.equal((await a.request(`/?cursor=${encodeURIComponent(next)}`)).status, 200, 'the real one still works');
  } finally {
    await s.done();
  }
});

test('bounded scan: when keep hides everything a request reads at most 10 x limit rows, and paging still reaches the end', async () => {
  const s = await seeded(25);
  try {
    let calls = 0;
    let cursor: string | undefined;
    let requests = 0;
    for (; requests < 50; requests++) {
      calls = 0;
      const p = s.controller.listPage({}, { cursor, limit: 1, keep: () => (calls++, false) });
      assert.ok(calls <= 10, `request ${requests} read ${calls} rows (bound is 10)`);
      assert.equal(p.items.length, 0);
      if (!p.next) break;
      cursor = p.next;
    }
    assert.equal(requests, 2, '25 rows at 10 per request: two cursors, the third request ends');
  } finally {
    await s.done();
  }
});

test('bounded scan: a sparse keep still yields every kept row once across the bounded requests', async () => {
  const s = await seeded(25);
  try {
    const all = everything(s);
    const kept = new Set(all.filter((_, i) => i % 12 === 0));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 50; n++) {
      const p = s.controller.listPage({}, { cursor, limit: 1, keep: (x) => kept.has(x.id) });
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursor = p.next;
    }
    assert.deepEqual(
      seen,
      all.filter((id) => kept.has(id)),
    );
  } finally {
    await s.done();
  }
});

test('authz: a session the caller may not view is in no page and no cursor names it', async () => {
  const s = await seeded(10);
  try {
    const all = everything(s);
    const mine = new Set(all.filter((_, i) => i % 2 === 0));
    registerChatAuthz((id) => {
      const f = s.controller.sessionFacts(id);
      return f ? { ...f, ownerId: mine.has(id) ? 'u_a' : null } : null;
    });
    const them = app(s, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor = '';
    for (let n = 0; n < 20; n++) {
      const p = await page(them, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursors.push(p.next);
      cursor = p.next;
    }
    assert.deepEqual(
      seen,
      all.filter((id) => mine.has(id)),
      'exactly the sessions u_a may view, in order, each once',
    );
    assert.ok(cursors.length > 0);
    for (const c of cursors) {
      const named = peekCursor(c).id as string;
      assert.ok(mine.has(named), 'a cursor points at a row that was shown, never at a hidden one');
    }
  } finally {
    await s.done();
  }
});
