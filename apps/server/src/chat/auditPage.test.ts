// GET /api/chat/audit pages (D-58, T-382 S4): `{ items, next }` by keyset on the entry id, 25 by default and 100 at most, a bad cursor or one made
// for another filter or another caller is a 400, an entry written during a walk causes no repeat and no skip, and an entry about a session the
// caller may not view is in no page and no cursor names it. Fixtures are built here, at run time.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, type ChatAuditEntry, type CursorPage } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers } from '../authz/seam.js';
import { peekCursor } from '../store/keyset.js';
import { registerChatAuthz } from './authz.js';
import { Reauth } from './reauth.js';
import { createChatMetaRoutes } from './routes.js';
import { ChatStore } from './store.js';
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
  a.route('/', createChatMetaRoutes(s.controller, new Reauth({ session: () => undefined, matches: () => false })));
  return a;
};
const page = async (a: Hono, qs = ''): Promise<CursorPage<ChatAuditEntry>> => {
  const res = await a.request(`/audit${qs}`);
  assert.equal(res.status, 200, qs);
  return ((await res.json()) as { data: CursorPage<ChatAuditEntry> }).data;
};
const walk = async (a: Hono, qs: string, limit: number, between?: (n: number) => void) => {
  const ids: number[] = [];
  let cursor = '';
  for (let n = 0; n < 200; n++) {
    const p = await page(a, `?${qs}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    ids.push(...p.items.map((i) => i.id));
    if (!p.next) return ids;
    cursor = p.next;
    between?.(n);
  }
  throw new Error('the walk did not end');
};
const write = (s: Live, n: number, o: { kind?: string; sessionId?: string | null } = {}) => {
  const chat = new ChatStore(s.store);
  for (let i = 0; i < n; i++) chat.addAudit({ severity: 'info', kind: o.kind ?? 'test.page', sessionId: o.sessionId ?? null, actor: 'portal', detail: { i } });
};
const all = (s: Live, kind = 'test.page') => (s.store.db!.prepare('SELECT id FROM chat_audit WHERE kind = ? ORDER BY id DESC').all(kind) as { id: number }[]).map((r) => r.id);

test('order: newest first, every entry once; the default page is 25', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    write(s, 30);
    const a = app(s);
    assert.deepEqual(await walk(a, 'kind=test.page', 7), all(s));
    assert.equal(CURSOR_DEFAULT_LIMIT, 25);
    const first = await page(a, '?kind=test.page');
    assert.equal(first.items.length, CURSOR_DEFAULT_LIMIT);
    assert.ok(first.next);
    assert.equal((await page(a, '?kind=test.page&limit=40')).next, null, 'last page: next is null');
  } finally {
    await s.done();
  }
});

test('an entry written between two pages causes no repeat and no skip', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    write(s, 12);
    const original = all(s);
    let wrote = 0;
    const ids = await walk(app(s), 'kind=test.page', 3, () => {
      wrote++;
      write(s, 2);
    });
    assert.ok(wrote >= 3);
    assert.equal(new Set(ids).size, ids.length, 'no repeat');
    assert.deepEqual(ids.filter((id) => original.includes(id)), original, 'every old entry, in order, none skipped');
  } finally {
    await s.done();
  }
});

test('limit: above 100 is cut to 100, below 1 to 1, junk to the default', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    write(s, 130);
    const a = app(s);
    const big = await page(a, '?kind=test.page&limit=1000');
    assert.equal(big.items.length, CURSOR_MAX_LIMIT);
    assert.ok(big.next);
    assert.equal((await page(a, '?kind=test.page&limit=0')).items.length, 1);
    assert.equal((await page(a, '?kind=test.page&limit=abc')).items.length, CURSOR_DEFAULT_LIMIT);
    assert.equal((await walk(a, 'kind=test.page', 100)).length, 130);
  } finally {
    await s.done();
  }
});

test('a bad cursor is a 400: garbage, a tampered one, one from another filter, one from another caller', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    write(s, 6);
    const a = app(s);
    const next = (await page(a, '?kind=test.page&limit=2')).next!;
    const [body, sig] = next.split('.');
    const flipped = `${body}.${sig!.slice(0, -2)}${sig!.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const cursor of ['garbage', 'a.b', `${body}`, flipped, `${next}.x`]) {
      assert.equal((await a.request(`/audit?kind=test.page&cursor=${encodeURIComponent(cursor)}`)).status, 400, cursor);
    }
    assert.equal((await a.request(`/audit?kind=other&cursor=${encodeURIComponent(next)}`)).status, 400, 'a cursor of one kind does not open another');
    assert.equal((await a.request(`/audit?cursor=${encodeURIComponent(next)}`)).status, 400, 'nor the unfiltered trail');
    const u = app(s, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    assert.equal((await u.request(`/audit?kind=test.page&cursor=${encodeURIComponent(next)}`)).status, 400, 'a cursor is the caller’s own');
    assert.equal((await a.request(`/audit?kind=test.page&cursor=${encodeURIComponent(next)}`)).status, 200, 'the real one still works');
  } finally {
    await s.done();
  }
});

test('authz: an entry about a session the caller may not view is in no page and no cursor names it', async () => {
  const s = await liveSession();
  try {
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === 2);
    const ids = (s.store.db!.prepare('SELECT id FROM chat_sessions ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    const [mine, theirs] = ids as [string, string];
    registerChatAuthz((id) => {
      const f = s.controller.sessionFacts(id);
      return f ? { ...f, ownerId: id === mine ? 'u_a' : null } : null;
    });
    for (let i = 0; i < 8; i++) write(s, 1, { sessionId: i % 2 ? mine : theirs });
    write(s, 1, { sessionId: null });
    const rows = s.store.db!.prepare('SELECT id, session_id FROM chat_audit WHERE kind = ? ORDER BY id DESC').all('test.page') as { id: number; session_id: string | null }[];
    const want = rows.filter((r) => r.session_id !== theirs).map((r) => r.id);
    const them = app(s, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    const seen: number[] = [];
    const cursors: string[] = [];
    let cursor = '';
    for (let n = 0; n < 20; n++) {
      const p = await page(them, `?kind=test.page&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const e of p.items) assert.notEqual(e.sessionId, theirs);
      seen.push(...p.items.map((i) => i.id));
      if (!p.next) break;
      cursors.push(p.next);
      cursor = p.next;
    }
    assert.deepEqual(seen, want, 'exactly the entries u_a may see, in order, each once');
    assert.ok(cursors.length > 0);
    const shown = new Set(want);
    for (const c of cursors) {
      const named = peekCursor(c).id as number;
      assert.ok(shown.has(named), 'a cursor points at an entry that was shown, never at a hidden one');
    }
  } finally {
    await s.done();
  }
});
