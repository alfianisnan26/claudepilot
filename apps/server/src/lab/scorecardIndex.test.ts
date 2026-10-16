// T-739 B: migration 383 (the partial index on tool results) applies to a fresh database and to one at the previous version, twice is once,
// and the scorecard's two tool-result queries use it (EXPLAIN QUERY PLAN names the index and never scans chat_events).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../store/migrations.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { loadToolResults, toolResultCountSql, toolResultErrorSql } from './scorecardData.js';

const INDEX = 'chat_events_result_at';
const indexSql = (db: DatabaseSync) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX) as { sql: string } | undefined)?.sql;
const dir = () => tempDirectory('cp-t739-');
const T0 = Date.UTC(2026, 9, 1);
const iso = (ms: number) => new Date(ms).toISOString();

function seed(db: DatabaseSync) {
  const now = iso(T0);
  db.prepare("INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at) VALUES ('s1', 'docker/api', ?, ?, ?)").run(now, now, now);
  const ins = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)');
  ins.run('s1', 1, iso(T0 - 1), 'tool_result', '{"isError":1}'); // before the window
  ins.run('s1', 2, iso(T0), 'tool_result', '{"isError":0}'); // at from: included
  ins.run('s1', 3, iso(T0 + 1000), 'tool_result', '{"isError":1,"toolName":"Bash","text":"permission denied"}');
  ins.run('s1', 4, iso(T0 + 2000), 'assistant', '{}'); // another kind
  ins.run('s1', 5, iso(T0 + 5000), 'tool_result', '{"isError":1}'); // at to: excluded
}

test('migration 383: a fresh database has the partial index', async () => {
  const store = await Store.open({ dataDir: dir(), secretKey: null, migrations: MIGRATIONS });
  try {
    const sql = indexSql(store.db!);
    assert.ok(sql, 'the index exists');
    assert.match(sql!, /\(session_id, at\)/);
    assert.match(sql!, /WHERE kind = 'tool_result'/);
  } finally {
    store.close();
  }
});

test('migration 383: a database at the previous version gets the index, keeps its rows, and the migration is idempotent', async () => {
  const d = dir();
  const old = await Store.open({ dataDir: d, secretKey: null, migrations: MIGRATIONS.filter((m) => m.version !== 383) });
  seed(old.db!);
  assert.equal(indexSql(old.db!), undefined, 'the previous version has no such index');
  old.close();
  const store = await Store.open({ dataDir: d, secretKey: null, migrations: MIGRATIONS });
  try {
    assert.ok(indexSql(store.db!));
    assert.equal((store.db!.prepare('SELECT COUNT(*) AS n FROM chat_events').get() as { n: number }).n, 5);
    // Running its body again changes nothing and does not throw.
    MIGRATIONS.find((m) => m.version === 383)!.up(store.db!);
    assert.equal((store.db!.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(INDEX) as { n: number }).n, 1);
  } finally {
    store.close();
  }
});

test('the scorecard tool-result queries use the index and never scan chat_events (the literal kind must stay)', async () => {
  const store = await Store.open({ dataDir: dir(), secretKey: null, migrations: MIGRATIONS });
  try {
    const db = store.db!;
    for (const [name, sql] of [['count', toolResultCountSql('(?)')], ['errors', toolResultErrorSql('(?)')]] as const) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('s1', iso(T0), iso(T0 + 5000)) as { detail: string }[]).map((r) => r.detail).join(' | ');
      assert.match(plan, new RegExp(INDEX), `${name}: ${plan}`);
      assert.doesNotMatch(plan, /SCAN chat_events/, `${name}: ${plan}`);
    }
    const count = (db.prepare(`EXPLAIN QUERY PLAN ${toolResultCountSql('(?)')}`).all('s1', iso(T0), iso(T0 + 5000)) as { detail: string }[]).map((r) => r.detail).join(' ');
    assert.match(count, /COVERING INDEX chat_events_result_at/);
  } finally {
    store.close();
  }
});

test('loadToolResults through the index: the window is [from, to), only tool results, only isError = 1 are errors', async () => {
  const store = await Store.open({ dataDir: dir(), secretKey: null, migrations: MIGRATIONS });
  try {
    seed(store.db!);
    const r = loadToolResults(store.db!, T0, T0 + 5000, new Set(['s1']));
    assert.deepEqual(r, [{ sessionId: 's1', total: 2, denied: 1, portal: 0, failed: 0 }]);
  } finally {
    store.close();
  }
});
