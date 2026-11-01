import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from './migrations.js';
import { cachedStatement } from './stmtCache.js';
import { Store } from './store.js';
import { tempDirectory } from './testTmp.js';

test('cachedStatement prepares a statement once per database and SQL text, and follows a schema change', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a')");
  const a = cachedStatement(db, 'SELECT v FROM t WHERE id = ?');
  assert.equal(cachedStatement(db, 'SELECT v FROM t WHERE id = ?'), a, 'the same statement the second time');
  assert.notEqual(cachedStatement(db, 'SELECT id FROM t'), a, 'another text is another statement');
  const other = new DatabaseSync(':memory:');
  other.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('b')");
  assert.equal((cachedStatement(other, 'SELECT v FROM t WHERE id = ?').get(1) as { v: string }).v, 'b', 'per database');
  db.exec('ALTER TABLE t ADD COLUMN w TEXT');
  assert.equal((cachedStatement(db, 'SELECT v FROM t WHERE id = ?').get(1) as { v: string }).v, 'a', 'still answers after a schema change');
  db.close();
  other.close();
});

test('migration 920: the scorecard continuation lookups and the newest runs page read through an index, not the whole table', async () => {
  const store = await Store.open({ dataDir: tempDirectory('cp-perf-'), secretKey: null, migrations: MIGRATIONS });
  const plan = (sql: string) =>
    (store.db!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');
  assert.match(
    plan(
      "SELECT session_id AS id FROM chat_audit WHERE kind = 'session.continued' AND session_id IS NOT NULL AND json_extract(detail, '$.from') IN ('a', 'b')",
    ),
    /USING INDEX chat_audit_continued_from/,
  );
  assert.match(
    plan("SELECT session_id, detail FROM chat_audit WHERE kind = 'session.continued' AND session_id IN ('a', 'b') ORDER BY id"),
    /chat_audit_session_kind \(session_id=\? AND kind=\?\)/,
  );
  const runs = plan('SELECT * FROM ci_runs ORDER BY created_at DESC, id DESC LIMIT 51');
  assert.match(runs, /ci_runs_newest/);
  assert.doesNotMatch(runs, /TEMP B-TREE/, 'no sort of the whole table');
  store.close();
});
