import assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { acquireLock } from './lock.js';
import { MIGRATIONS, type EncryptedColumn, type Migration } from './migrations.js';
import { generateSecretKey, parseSecretKey } from './secretBox.js';
import { backupDatabase, forgetSecrets, inspectStore, restoreBackup, rotateKey, Store } from './store.js';
import { tempDirectory } from './testTmp.js';

const newKey = () => parseSecretKey(generateSecretKey());
const tempDir = () => tempDirectory('cp-store-');

/** A test-only schema with one sealed column, on top of the real migrations. */
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));
const VAULT: Migration = {
  version: LATEST + 1,
  name: 'test vault',
  up(db) {
    db.exec('CREATE TABLE vault (id TEXT PRIMARY KEY, secret TEXT) STRICT');
  },
};
const VAULT_COLUMNS: EncryptedColumn[] = [{ table: 'vault', column: 'secret', idColumn: 'id' }];
const withVault = [...MIGRATIONS, VAULT];

function putSecret(store: Store, id: string, value: string) {
  const sealed = store.secrets!.seal(value, { table: 'vault', row: id, column: 'secret' });
  store.db!.prepare('INSERT INTO vault (id, secret) VALUES (?, ?)').run(id, sealed);
}
function getSecret(store: Store, id: string) {
  const row = store.db!.prepare('SELECT secret FROM vault WHERE id = ?').get(id) as { secret: string | null };
  return row.secret === null ? null : store.secrets!.open(row.secret, { table: 'vault', row: id, column: 'secret' });
}

test('a new database gets a portal ID, the latest schema and a key check, and is trusted', async () => {
  const dir = tempDir();
  const store = await Store.open({ dataDir: dir, secretKey: newKey() });
  assert.deepEqual(store.trust, { state: 'ok', reasons: [] });
  assert.match(store.portalId!, /^[0-9a-f-]{36}$/);
  assert.equal(store.schemaVersion, store.latestSchemaVersion);
  assert.ok(store.secrets);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  store.close();
});

test('the same key reopens it; the portal ID stays', async () => {
  const dir = tempDir();
  const key = newKey();
  const first = await Store.open({ dataDir: dir, secretKey: key });
  const id = first.portalId;
  first.close();
  const again = await Store.open({ dataDir: dir, secretKey: key });
  assert.equal(again.trust.state, 'ok');
  assert.equal(again.portalId, id);
  again.close();
});

test('a wrong key locks the portal and never replaces the key check', async () => {
  const dir = tempDir();
  const key = newKey();
  (await Store.open({ dataDir: dir, secretKey: key })).close();
  const wrong = await Store.open({ dataDir: dir, secretKey: newKey() });
  assert.equal(wrong.trust.state, 'locked');
  assert.equal(wrong.trust.reasons[0]!.code, 'key-wrong');
  assert.equal(wrong.secrets, null);
  assert.equal(wrong.deliveryAllowed, false);
  wrong.close();
  const right = await Store.open({ dataDir: dir, secretKey: key });
  assert.equal(right.trust.state, 'ok');
  right.close();
});

test('no key locks the portal', async () => {
  const dir = tempDir();
  const store = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal(store.trust.state, 'locked');
  assert.equal(store.trust.reasons[0]!.code, 'key-missing');
  assert.ok(store.writable, 'non-secret data is still usable');
  store.close();
});

test('a database from a newer portal is opened read-only and frozen', async () => {
  const dir = tempDir();
  (await Store.open({ dataDir: dir, secretKey: newKey() })).close();
  const raw = new DatabaseSync(join(dir, 'portal.db'));
  raw.exec('PRAGMA user_version = 9999');
  raw.close();
  const store = await Store.open({ dataDir: dir, secretKey: newKey() });
  assert.equal(store.trust.state, 'frozen');
  assert.equal(store.trust.reasons[0]!.code, 'db-newer');
  assert.equal(store.writable, false);
  assert.ok(store.portalId, 'still readable');
  store.close();
});

test('a file that is not a database freezes the portal instead of starting empty', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'portal.db'), 'definitely not sqlite '.repeat(200));
  const store = await Store.open({ dataDir: dir, secretKey: newKey() });
  assert.equal(store.trust.state, 'frozen');
  assert.equal(store.trust.reasons[0]!.code, 'db-unreadable');
  assert.equal(store.db, null);
  store.close();
});

test('migrating an existing database takes a backup first', async () => {
  const dir = tempDir();
  (await Store.open({ dataDir: dir, secretKey: newKey() })).close();
  const store = await Store.open({ dataDir: dir, secretKey: null, migrations: withVault });
  assert.equal(store.schemaVersion, LATEST + 1);
  const backups = store.listBackups();
  assert.equal(backups.length, 1);
  assert.equal(backups[0]!.kind, 'pre-migrate');
  store.close();
});

test('a migration numbered below one already applied still runs (side-by-side work)', async () => {
  const dir = tempDir();
  const later: Migration = { version: LATEST + 2, name: 'later', up: (db) => db.exec('CREATE TABLE later_t (id INTEGER) STRICT') };
  const earlier: Migration = { version: LATEST + 1, name: 'earlier', up: (db) => db.exec('CREATE TABLE earlier_t (id INTEGER) STRICT') };
  (await Store.open({ dataDir: dir, secretKey: null, migrations: [...MIGRATIONS, later] })).close();
  const store = await Store.open({ dataDir: dir, secretKey: null, migrations: [...MIGRATIONS, earlier, later] });
  assert.equal(store.trust.state === 'frozen' ? store.trust.reasons[0]!.code : 'ok', 'ok');
  assert.ok(store.db!.prepare("SELECT name FROM sqlite_master WHERE name = 'earlier_t'").get(), 'the earlier-numbered migration ran');
  assert.equal(store.schemaVersion, LATEST + 2);
  store.close();
  // And nothing reruns on the next open.
  const again = await Store.open({ dataDir: dir, secretKey: null, migrations: [...MIGRATIONS, earlier, later] });
  assert.equal(again.listBackups().filter((b) => b.kind === 'pre-migrate').length, 1, 'only the one migrating open took a backup');
  again.close();
});

test('migration 720: a destination that hears CI failures hears deploys that wait; one that opted out stays out; twice is once', async () => {
  const dir = tempDir();
  const key = newKey();
  const before = MIGRATIONS.filter((m) => m.version !== 720);
  const first = await Store.open({ dataDir: dir, secretKey: key, migrations: before });
  const at = new Date().toISOString();
  const put = (id: string, kinds: string) =>
    first.db!.prepare("INSERT INTO notify_destinations (id, type, name, kinds, quiet, created_at, updated_at) VALUES (?, 'push', ?, ?, '{}', ?, ?)").run(id, id, kinds, at, at);
  put('d_ci', JSON.stringify(['approval', 'ci_failed', 'quota_low']));
  put('d_no_ci', JSON.stringify(['approval', 'quota_low']));
  put('d_has', JSON.stringify(['ci_failed', 'ci_waiting']));
  put('d_bad', 'not json');
  first.close();
  const kinds = (store: Store, id: string) => (store.db!.prepare('SELECT kinds FROM notify_destinations WHERE id = ?').get(id) as { kinds: string }).kinds;
  const store = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS });
  assert.equal(store.trust.state, 'ok');
  assert.deepEqual(JSON.parse(kinds(store, 'd_ci')), ['approval', 'ci_failed', 'quota_low', 'ci_waiting'], 'added after the list it had');
  assert.deepEqual(JSON.parse(kinds(store, 'd_no_ci')), ['approval', 'quota_low'], 'opted out of CI: left alone');
  assert.deepEqual(JSON.parse(kinds(store, 'd_has')), ['ci_failed', 'ci_waiting'], 'not added twice');
  assert.equal(kinds(store, 'd_bad'), 'not json', 'an unreadable list is not guessed at');
  store.close();
  // The migration is in the applied set now: nothing runs again on the next open, and the lists stay as they are.
  const again = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS });
  assert.deepEqual(JSON.parse(kinds(again, 'd_ci')), ['approval', 'ci_failed', 'quota_low', 'ci_waiting']);
  assert.equal(again.listBackups().filter((b) => b.kind === 'pre-migrate').length, 1);
  again.close();
});

test('migration 712: every workspace the portal knew gets a stable id, the runtime name is left to the runtime, and what is not a workspace id is skipped', async () => {
  const dir = tempDir();
  const first = await Store.open({ dataDir: dir, secretKey: null, migrations: MIGRATIONS.filter((m) => m.version !== 712) });
  for (const id of ['kubernetes/kohi-event', 'docker/api', 'not-a-workspace', 'x/../y']) first.db!.prepare('INSERT INTO workspace_delivery (workspace_id) VALUES (?)').run(id);
  first.close();
  const store = await Store.open({ dataDir: dir, secretKey: null, migrations: MIGRATIONS });
  try {
    const rows = store.db!.prepare('SELECT id, target, name, legacy_id, runtime_name, removed_at FROM workspace_identities ORDER BY legacy_id').all() as Record<string, string | null>[];
    assert.deepEqual(rows.map((r) => [r.legacy_id, r.target, r.name, r.runtime_name, r.removed_at]), [
      ['docker/api', 'docker', 'api', null, null],
      ['kubernetes/kohi-event', 'kubernetes', 'kohi-event', null, null],
    ]);
    for (const r of rows) assert.match(r.id!, /^ws_[0-9a-f]{12}$/);
    assert.notEqual(rows[0]!.id, rows[1]!.id);
    // One live holder per alias: the database refuses a second.
    assert.throws(() => store.db!.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, 'docker', 'api', 'docker/api', 'now')").run(`ws_${'1'.repeat(12)}`));
  } finally {
    store.close();
  }
});

test('migration 773 (T-294): a session gets the agent it runs as; every session from before runs as none', async () => {
  const dir = tempDir();
  const key = newKey();
  const first = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS.filter((m) => m.version !== 773) });
  const at = new Date().toISOString();
  first.db!.prepare("INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at) VALUES ('old', 'docker/api', ?, ?, ?)").run(at, at, at);
  first.close();
  const store = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS });
  try {
    assert.equal(store.trust.state, 'ok');
    assert.deepEqual(store.db!.prepare("SELECT id, agent FROM chat_sessions").all().map((r) => ({ ...r })), [{ id: 'old', agent: null }]);
    store.db!.prepare("UPDATE chat_sessions SET agent = 'implementer' WHERE id = 'old'").run();
    assert.equal((store.db!.prepare("SELECT agent FROM chat_sessions WHERE id = 'old'").get() as { agent: string }).agent, 'implementer');
  } finally {
    store.close();
  }
});

test('migration 775 (T-294): a worker keeps what it reports to its lead; every session from before reads null (idle), nothing else goes in', async () => {
  const dir = tempDir();
  const key = newKey();
  const first = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS.filter((m) => m.version !== 775) });
  const at = new Date().toISOString();
  first.db!.prepare("INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at) VALUES ('old', 'docker/api', ?, ?, ?)").run(at, at, at);
  first.close();
  const store = await Store.open({ dataDir: dir, secretKey: key, migrations: MIGRATIONS });
  try {
    assert.equal(store.trust.state, 'ok');
    assert.deepEqual(store.db!.prepare('SELECT id, report FROM chat_sessions').all().map((r) => ({ ...r })), [{ id: 'old', report: null }]);
    store.db!.prepare("UPDATE chat_sessions SET report = 'end' WHERE id = 'old'").run();
    assert.equal((store.db!.prepare("SELECT report FROM chat_sessions WHERE id = 'old'").get() as { report: string }).report, 'end');
    assert.throws(() => store.db!.prepare("UPDATE chat_sessions SET report = 'loud' WHERE id = 'old'").run(), /CHECK constraint/);
  } finally {
    store.close();
  }
});

test('a failing migration rolls back and freezes the portal', async () => {
  const dir = tempDir();
  (await Store.open({ dataDir: dir, secretKey: newKey() })).close();
  const broken: Migration = { version: LATEST + 1, name: 'broken', up: (db) => db.exec('CREATE TABLE nope (') };
  const store = await Store.open({ dataDir: dir, secretKey: null, migrations: [...MIGRATIONS, broken] });
  assert.equal(store.trust.state, 'frozen');
  assert.equal(store.trust.reasons[0]!.code, 'migration-failed');
  assert.equal(store.schemaVersion, LATEST);
  store.close();
});

test('daily backups run once a day and keep the last 7', async () => {
  const dir = tempDir();
  let now = new Date('2026-10-01T00:00:00Z');
  const store = await Store.open({ dataDir: dir, secretKey: newKey(), now: () => now });
  for (let day = 0; day < 10; day++) {
    now = new Date(Date.UTC(2026, 9, 1 + day, 3));
    assert.ok(await store.backupIfDue(), `day ${day} backs up`);
    assert.equal(await store.backupIfDue(), null, 'not twice a day');
  }
  const daily = store.listBackups().filter((b) => b.kind === 'daily');
  assert.equal(daily.length, 7);
  assert.equal(daily[0]!.at.toISOString(), '2026-10-10T03:00:00.000Z');
  assert.equal(statSync(daily[0]!.file).mode & 0o777, 0o600);
  store.close();
});

test('restore swaps in a backup, keeps the replaced database, and starts frozen until resumed', async () => {
  const dir = tempDir();
  const key = newKey();
  const store = await Store.open({ dataDir: dir, secretKey: key, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  putSecret(store, 'one', 'first value');
  const backupFile = await store.backup('manual');
  putSecret(store, 'two', 'added after the backup');
  store.close();

  const { replaced } = await restoreBackup({ dataDir: dir, file: backupFile, secretKey: key, migrations: withVault });
  assert.ok(replaced && existsSync(replaced));
  for (const f of [backupFile, replaced]) {
    assert.equal(existsSync(`${f}-wal`), false, 'backups are single files');
    assert.equal(existsSync(`${f}-shm`), false);
  }

  const restored = await Store.open({ dataDir: dir, secretKey: key, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  assert.equal(restored.trust.state, 'frozen');
  assert.equal(restored.trust.reasons[0]!.code, 'restored');
  assert.equal(getSecret(restored, 'one'), 'first value');
  assert.equal(restored.db!.prepare("SELECT count(*) AS n FROM vault WHERE id = 'two'").get()!.n, 0);
  assert.equal(restored.resume(), true);
  assert.equal(restored.trust.state, 'ok');
  restored.close();

  const reopened = await Store.open({ dataDir: dir, secretKey: key, migrations: withVault });
  assert.equal(reopened.trust.state, 'ok', 'resume persists');
  reopened.close();
});

test('restore refuses a backup that the current key cannot open', async () => {
  const dir = tempDir();
  const store = await Store.open({ dataDir: dir, secretKey: newKey() });
  const backupFile = await store.backup('manual');
  store.close();
  await assert.rejects(restoreBackup({ dataDir: dir, file: backupFile, secretKey: newKey() }), /key the backup was made with/);
});

test('offline commands refuse to run while a portal holds the lock', async () => {
  const dir = tempDir();
  const key = newKey();
  const store = await Store.open({ dataDir: dir, secretKey: key });
  const backupFile = await store.backup('manual');
  store.close();
  const release = await acquireLock(dir);
  try {
    await assert.rejects(restoreBackup({ dataDir: dir, file: backupFile, secretKey: key }), /running/);
    await assert.rejects(rotateKey({ dataDir: dir, oldKey: key, newKey: newKey() }), /running/);
  } finally {
    release();
  }
});

test('rotate-key re-seals every secret under the new key', async () => {
  const dir = tempDir();
  const oldKey = newKey();
  const store = await Store.open({ dataDir: dir, secretKey: oldKey, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  putSecret(store, 'a', 'alpha');
  putSecret(store, 'b', 'beta');
  store.close();

  const next = newKey();
  const { resealed } = await rotateKey({ dataDir: dir, oldKey, newKey: next, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  assert.equal(resealed, 2);

  const old = await Store.open({ dataDir: dir, secretKey: oldKey, migrations: withVault });
  assert.equal(old.trust.reasons[0]!.code, 'key-wrong');
  old.close();
  const rotated = await Store.open({ dataDir: dir, secretKey: next, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  assert.equal(rotated.trust.state, 'ok');
  assert.equal(getSecret(rotated, 'a'), 'alpha');
  assert.equal(getSecret(rotated, 'b'), 'beta');
  rotated.close();
});

test('forget-secrets clears sealed values and adopts the new key, keeping everything else', async () => {
  const dir = tempDir();
  const lost = newKey();
  const store = await Store.open({ dataDir: dir, secretKey: lost, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  putSecret(store, 'a', 'alpha');
  const portalId = store.portalId;
  store.close();

  const fresh = newKey();
  const { cleared } = await forgetSecrets({ dataDir: dir, newKey: fresh, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  assert.equal(cleared, 1);

  const after = await Store.open({ dataDir: dir, secretKey: fresh, migrations: withVault, encryptedColumns: VAULT_COLUMNS });
  assert.equal(after.trust.state, 'ok');
  assert.equal(after.portalId, portalId);
  assert.equal(getSecret(after, 'a'), null, 'the row stays, its secret is gone');
  after.close();

  await assert.rejects(forgetSecrets({ dataDir: dir, newKey: fresh, migrations: withVault, encryptedColumns: VAULT_COLUMNS }), /already opens/);
});

test('an unusable configured key is reported as such, not as missing', async () => {
  const store = await Store.open({ dataDir: tempDir(), secretKey: null, keyError: 'PORTAL_SECRET_KEY must be 32 random bytes.' });
  assert.equal(store.trust.state, 'locked');
  assert.deepEqual(store.trust.reasons[0], { code: 'key-wrong', message: 'PORTAL_SECRET_KEY must be 32 random bytes.' });
  store.close();
});

test('freeze and resume: only an admin freeze or a restore can be resumed', async () => {
  const dir = tempDir();
  const store = await Store.open({ dataDir: dir, secretKey: newKey() });
  store.freeze('frozen-by-admin', 'Paused for maintenance.');
  assert.equal(store.trust.state, 'frozen');
  assert.equal(store.resumable, true);
  assert.equal(store.resume(), true);
  store.close();

  const locked = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal(locked.resumable, false, 'a missing key is not something Resume can fix');
  assert.equal(locked.resume(), false);
  locked.close();
});

test('inspectStore reads state without writing, and backupDatabase works next to a running store', async () => {
  const dir = tempDir();
  const key = newKey();
  const store = await Store.open({ dataDir: dir, secretKey: key });
  const before = statSync(store.path).mtimeMs;
  const seen = inspectStore({ dataDir: dir, secretKey: key });
  assert.equal(seen.key, 'opens');
  assert.equal(seen.portalId, store.portalId);
  assert.equal(inspectStore({ dataDir: dir, secretKey: newKey() }).key, 'wrong');
  assert.equal(inspectStore({ dataDir: dir, secretKey: null }).key, 'no-key');
  const file = await backupDatabase({ dataDir: dir });
  assert.ok(existsSync(file));
  assert.equal(statSync(store.path).mtimeMs, before, 'the database file was not written');
  store.close();
  assert.equal(inspectStore({ dataDir: tempDir(), secretKey: key }).exists, false);
});

test('the lock creates a data dir that does not exist yet', async () => {
  const dir = join(tempDir(), 'not', 'yet');
  const release = await acquireLock(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.ok(existsSync(join(dir, 'portal.lock')));
  release();
  assert.equal(existsSync(join(dir, 'portal.lock')), false);
});

test('the panel can set up a key once, and unlock only with that key', async () => {
  const dir = tempDir();
  const store = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal(store.trust.reasons[0]!.code, 'key-missing');
  assert.equal(store.hasKeyCheck, false);
  const key = newKey();
  store.setUpKey(key);
  assert.equal(store.trust.state, 'ok');
  assert.equal(store.keySource, 'panel');
  assert.throws(() => store.setUpKey(newKey()), /already has a key/);
  store.close();

  const restarted = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal(restarted.trust.state, 'locked', 'a panel key is not remembered by the database');
  assert.throws(() => restarted.unlock(newKey()), /doesn't open this database/);
  restarted.unlock(key);
  assert.equal(restarted.trust.state, 'ok');
  assert.ok(restarted.secrets);
  restarted.close();
});

test('a lost key can be replaced only while nothing was ever encrypted with it', async () => {
  const dir = tempDir();
  const store = await Store.open({ dataDir: dir, secretKey: null });
  store.setUpKey(newKey());
  store.close();

  // Restarted without the key, nothing stored yet: starting over loses nothing.
  const lost = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal(lost.sealedCount, 0);
  const replacement = newKey();
  lost.resetKey(replacement);
  assert.equal(lost.trust.state, 'ok');
  assert.throws(() => lost.resetKey(newKey()), /unlocked/);
  lost.db!.prepare("INSERT INTO accounts (id, endpoint_id, name, secret, fingerprint, masked, created_at, updated_at) VALUES ('a1', 'anthropic', 'one', ?, 'fp', 'm', 'now', 'now')").run(
    lost.secrets!.seal('sk-test-value', { table: 'accounts', row: 'a1', column: 'secret' }),
  );
  lost.close();

  // Once a secret is stored, only the right key gets past Locked.
  const guarded = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal(guarded.sealedCount, 1);
  assert.throws(() => guarded.resetKey(newKey()), /Secrets are stored/);
  guarded.unlock(replacement);
  assert.equal(guarded.secrets!.open(guarded.db!.prepare("SELECT secret FROM accounts WHERE id = 'a1'").get()!.secret as string, { table: 'accounts', row: 'a1', column: 'secret' }), 'sk-test-value');
  guarded.close();
});
