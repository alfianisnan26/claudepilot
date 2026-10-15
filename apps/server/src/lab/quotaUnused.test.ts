// T-547: the scorecard's "quota left unused at reset" read from the usage samples table.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadQuotaUnused } from './quotaUnused.js';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const MIN = 60_000;

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE claude_usage_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, claude_id TEXT NOT NULL, workspace_id TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL, resets_at_ms INTEGER, level TEXT NOT NULL, source TEXT NOT NULL)');
  return d;
}
function add(d: DatabaseSync, claude: string, win: string, atMs: number, used: number | null, resetsAtMs: number | null): void {
  d.prepare('INSERT INTO claude_usage_samples (at_ms, claude_id, workspace_id, win, used_pct, resets_at_ms, level, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(atMs, claude, 'w', win, used, resetsAtMs, 'ok', 'probe');
}

test('loadQuotaUnused: per Claude and window, from the last reading just before each reset; unavailable when none is close', () => {
  const d = db();
  const reset = NOW - 120 * MIN;
  add(d, 'c1', 'session', reset - 10 * MIN, 72, reset);
  add(d, 'c1', 'session', reset - 200 * MIN, 30, reset);
  add(d, 'c2', 'session', reset - 90 * MIN, 10, reset); // 90 min before: not "just before"
  add(d, 'c1', 'week', NOW - 5 * MIN, 40, NOW + 1000 * MIN); // not finished
  add(d, 'c3', 'session', reset - 5 * MIN, null, reset); // no percent: not a reading
  const rows = loadQuotaUnused(d, NOW, NOW - 24 * 60 * MIN);
  assert.equal(rows.length, 2);
  const c1 = rows.find((r) => r.claudeId === 'c1')!;
  assert.equal(c1.unusedPct.value, 28);
  assert.equal(c1.window, 'session');
  assert.equal(c1.resetAt, new Date(reset).toISOString());
  assert.equal(c1.readingAt, new Date(reset - 10 * MIN).toISOString());
  const c2 = rows.find((r) => r.claudeId === 'c2')!;
  assert.equal(c2.unusedPct.value, null);
  assert.equal(c2.unusedPct.basis, 'unavailable');
  assert.equal(c2.readingAt, null);
});

test('loadQuotaUnused: no database or no table is an empty list, not a guess', () => {
  assert.deepEqual(loadQuotaUnused(null, NOW, 0), []);
  assert.deepEqual(loadQuotaUnused(new DatabaseSync(':memory:'), NOW, 0), []);
});
