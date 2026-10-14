// Migrations 790 and 791 (T-259) on a fresh and on an existing database, and the store's policy, trail and report rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { KeepGoingStore } from './store.js';

const tables = (s: Store) => (s.db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'keepgoing_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('migration 790 on a fresh database: the three tables; the store reads and writes them', async () => {
  const store = await Store.open({ dataDir: tempDirectory('cp-kg-'), secretKey: parseSecretKey(generateSecretKey()) });
  assert.deepEqual(tables(store), ['keepgoing_events', 'keepgoing_policies', 'keepgoing_reports']);
  const kg = new KeepGoingStore(store, () => new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(kg.policy('s1'), null);
  const p = kg.setPolicy('s1', 'u_owner', 'ui', { enabled: true });
  assert.deepEqual([p.enabled, p.nudgeAfterMin, p.maxNudgesPerDay, p.maxWakesPerDay, p.prompt, p.nextDueAt], [true, 4, 60, 20, null, null]);
  assert.equal(kg.due('2026-01-01T00:00:00.000Z', 10).length, 1);
  kg.patchState('s1', { nextDueAt: '2026-01-01T00:01:00.000Z', continueOwed: true });
  assert.equal(kg.due('2026-01-01T00:00:30.000Z', 10).length, 0, 'not due before its next look');
  assert.equal(kg.policy('s1')!.continueOwed, true);
  kg.putReport('s1', 'u_owner', 'ended', '2026-01-01T00:00:00.000Z', 'T-9');
  assert.equal(kg.standing('s1').length, 1);
  kg.clearReport('s1', 'ended');
  assert.equal(kg.standing('s1').length, 0);
  kg.putReport('s1', 'u_owner', 'ended', '2026-01-01T01:00:00.000Z', null);
  assert.equal(kg.report('s1', 'ended')!.ticketId, 'T-9', 'a cause that comes back keeps its ticket');
  store.close();
});

test('migrations 790 and 791 on an existing database: the tables appear; a destination that hears failed sessions hears Keep going; twice is once', async () => {
  const dir = tempDirectory('cp-kg-old-');
  const key = generateSecretKey();
  const before = MIGRATIONS.filter((m) => m.version !== 790 && m.version !== 791);
  const first = await Store.open({ dataDir: dir, secretKey: parseSecretKey(key), migrations: before });
  assert.deepEqual(tables(first), []);
  const at = new Date().toISOString();
  const put = (id: string, kinds: string) =>
    first.db!.prepare("INSERT INTO notify_destinations (id, type, name, kinds, quiet, created_at, updated_at) VALUES (?, 'push', ?, ?, '{}', ?, ?)").run(id, id, kinds, at, at);
  put('d_failed', JSON.stringify(['approval', 'session_failed']));
  put('d_quiet', JSON.stringify(['approval']));
  put('d_has', JSON.stringify(['session_failed', 'keepgoing_attention']));
  put('d_bad', 'not json');
  first.close();
  const kinds = (s: Store, id: string) => (s.db!.prepare('SELECT kinds FROM notify_destinations WHERE id = ?').get(id) as { kinds: string }).kinds;
  const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(key), migrations: MIGRATIONS });
  assert.equal(store.trust.state, 'ok');
  assert.deepEqual(tables(store), ['keepgoing_events', 'keepgoing_policies', 'keepgoing_reports']);
  assert.deepEqual(JSON.parse(kinds(store, 'd_failed')), ['approval', 'session_failed', 'keepgoing_attention']);
  assert.deepEqual(JSON.parse(kinds(store, 'd_quiet')), ['approval'], 'opted out of failed sessions: left alone');
  assert.deepEqual(JSON.parse(kinds(store, 'd_has')), ['session_failed', 'keepgoing_attention'], 'not added twice');
  assert.equal(kinds(store, 'd_bad'), 'not json');
  store.close();
  const again = await Store.open({ dataDir: dir, secretKey: parseSecretKey(key), migrations: MIGRATIONS });
  assert.deepEqual(JSON.parse(kinds(again, 'd_failed')), ['approval', 'session_failed', 'keepgoing_attention']);
  again.close();
});
