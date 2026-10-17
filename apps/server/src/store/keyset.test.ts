import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT } from '@portal/contracts';
import { clampLimit, cursorAfter, keysetPage, peekCursor, type KeysetSpec } from './keyset.js';

const spec: KeysetSpec = { scope: 'test.rows', table: 'rows', sortCol: 'at', idCol: 'id' };
type Row = { id: number; at: string; tag: string };

function open(count: number) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tag TEXT NOT NULL) STRICT; CREATE INDEX rows_at ON rows (at)',
  );
  const add = (at: string, tag: string) => Number(db.prepare('INSERT INTO rows (at, tag) VALUES (?, ?)').run(at, tag).lastInsertRowid);
  // Runs of equal sort keys that straddle every page boundary: the id is what keeps the order total.
  for (let i = 0; i < count; i++) add(`2026-01-01T00:00:${String(Math.floor(i / 7)).padStart(2, '0')}Z`, `r${i}`);
  return { db, add };
}

function walk(db: DatabaseSync, limit: number, between?: (page: number) => void, s: KeysetSpec = spec) {
  const seen: number[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = keysetPage<Row>(db, s, { cursor, limit });
    seen.push(...r.rows.map((x) => x.id));
    if (!r.next) return seen;
    cursor = r.next;
    between?.(page);
  }
  throw new Error('the walk did not end');
}

test('walk: every row once, newest first, with ties on the sort key; rows inserted during the walk cause no duplicate and no skip', () => {
  const { db, add } = open(60);
  const original = db
    .prepare('SELECT id FROM rows ORDER BY at DESC, id DESC')
    .all()
    .map((r) => Number(r.id));
  // New rows are newest, so they sort before the cursor: the walk must not see them again nor lose an old one.
  const seen = walk(db, 8, (page) => {
    add(`2027-01-01T00:00:${String(page).padStart(2, '0')}Z`, `new${page}`);
  });
  assert.deepEqual(seen, original);
  assert.equal(new Set(seen).size, seen.length);
});

test('walk: a row removed during the walk leaves the rest in place', () => {
  const { db } = open(30);
  const all = db
    .prepare('SELECT id FROM rows ORDER BY at DESC, id DESC')
    .all()
    .map((r) => Number(r.id));
  const seen = walk(db, 5, (page) => {
    if (page === 1) db.prepare('DELETE FROM rows WHERE id = ?').run(all[5]!); // the last row of page 1 (already seen)
  });
  assert.deepEqual(seen, all);
});

test('walk: ascending order and a fixed filter', () => {
  const { db } = open(20);
  const s: KeysetSpec = { ...spec, dir: 'asc', where: 'id % 2 = ?', params: [0] };
  const seen = walk(db, 3, undefined, s);
  assert.deepEqual(seen, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test('clamp: no limit is 25, a huge limit is 100, zero, negative and junk fall back to a safe page', () => {
  assert.equal(clampLimit(undefined), CURSOR_DEFAULT_LIMIT);
  assert.equal(clampLimit('abc'), CURSOR_DEFAULT_LIMIT);
  assert.equal(clampLimit(''), CURSOR_DEFAULT_LIMIT);
  assert.equal(clampLimit('1000000'), CURSOR_MAX_LIMIT);
  assert.equal(clampLimit(101), 100);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  const { db } = open(300);
  assert.equal(keysetPage<Row>(db, spec, {}).rows.length, 25);
  const huge = keysetPage<Row>(db, spec, { limit: 999999 });
  assert.equal(huge.rows.length, 100);
  assert.ok(huge.next, 'there is more after the clamped page');
});

test('a bad cursor is a 400: garbage, a forged body, a tampered signature and a cursor from another list', () => {
  const { db } = open(30);
  const good = keysetPage<Row>(db, spec, { limit: 5 }).next!;
  const [body] = good.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ s: spec.scope, k: '9999', i: 1 })).toString('base64url');
  const other = keysetPage<Row>(db, { ...spec, scope: 'test.other' }, { limit: 5 }).next!;
  for (const cursor of [
    'garbage',
    'a.b',
    `${body}.`,
    `${forgedBody}.${good.split('.')[1]}`,
    `${body}.${'x'.repeat(43)}`,
    other,
    `${good}.extra`,
  ]) {
    assert.throws(
      () => keysetPage<Row>(db, spec, { cursor }),
      (e) => isAppError(e) && e.status === 400 && e.code === 'BAD_REQUEST',
      cursor,
    );
  }
  // The good one still works.
  assert.equal(keysetPage<Row>(db, spec, { cursor: good, limit: 5 }).rows.length, 5);
});

test('a cursor is sealed: its body does not show the sort key or the id, and two cursors for one row differ', () => {
  const sealedA = cursorAfter('test.rows', '2026-01-01T00:00:00Z', 'secret-row-id');
  const sealedB = cursorAfter('test.rows', '2026-01-01T00:00:00Z', 'secret-row-id');
  assert.notEqual(sealedA, sealedB);
  const body = Buffer.from(sealedA.split('.')[0]!, 'base64url').toString('latin1');
  assert.ok(!body.includes('secret-row-id') && !body.includes('2026-01-01'), 'the body is not readable');
  assert.deepEqual(peekCursor(sealedA), { scope: 'test.rows', sort: '2026-01-01T00:00:00Z', id: 'secret-row-id' });
});

test('an unsafe identifier is refused before any SQL is built', () => {
  const { db } = open(1);
  assert.throws(() => keysetPage(db, { ...spec, table: 'rows; DROP TABLE rows' }, {}), /unsafe identifier/);
});
