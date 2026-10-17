import assert from 'node:assert/strict';
import { closeSync, openSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, type Migration } from './migrations.js';
import { compareCounts, gunzipBackup, listNightly, nightlyBackup, nightlyDir, nightlyStatus, restoreAny, restoreDrill, rowCounts, toKeep } from './nightly.js';
import { generateSecretKey, parseSecretKey } from './secretBox.js';
import { Store } from './store.js';
import { tempDirectory } from './testTmp.js';

const newKey = () => parseSecretKey(generateSecretKey());
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));
const NOTES: Migration = { version: LATEST + 1, name: 'test notes', up: (db) => db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT) STRICT') };
const withNotes = [...MIGRATIONS, NOTES];

async function filled(rows: number) {
  const dir = tempDirectory('cp-nightly-');
  const key = newKey();
  const store = await Store.open({ dataDir: dir, secretKey: key, migrations: withNotes });
  const put = store.db!.prepare('INSERT INTO notes (body) VALUES (?)');
  for (let i = 0; i < rows; i++) put.run(`note ${i} ${'x'.repeat(200)}`);
  store.db!.prepare("INSERT INTO portal_meta (key, value) VALUES ('t565', 'marker')").run();
  return { dir, key, store };
}

test('the nightly backup is an online, checked, gzipped copy, mode 0600, with no work files left', async () => {
  const { dir, store } = await filled(500);
  // Another connection keeps writing while the backup runs: the copy must still be consistent.
  const writer = new DatabaseSync(store.path, { timeout: 5000 });
  const put = writer.prepare('INSERT INTO notes (body) VALUES (?)');
  let writes = 0;
  const busy = setInterval(() => {
    put.run(`during ${writes++}`);
  }, 1);
  try {
    const { file, bytes, removed } = await nightlyBackup({ dataDir: dir });
    assert.match(file, /portal-\d{8}T\d{6}Z-nightly\.db\.gz$/);
    assert.deepEqual(removed, []);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(nightlyDir(dir)).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(nightlyDir(dir)), [file.split('/').pop()], 'only the finished file; no .db or .part left');
    const plain = await gunzipBackup(file, join(tempDirectory('cp-nightly-'), 'x.db'));
    assert.ok(bytes < statSync(plain).size / 2, `gzipped (${bytes} of ${statSync(plain).size} bytes)`);
    const db = new DatabaseSync(plain, { readOnly: true });
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]), ['ok']);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete', 'one self-contained file');
    assert.ok((db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n >= 500);
    db.close();
  } finally {
    clearInterval(busy);
    writer.close();
    store.close();
  }
});

test('a damaged source database is refused: no nightly file is written, so a bad copy never goes off-site', async () => {
  const { dir, store } = await filled(500);
  const path = store.path;
  store.close(); // checkpoints the WAL into portal.db
  // The backup API copies pages without reading them, so a damaged b-tree page reaches the copy. Garble the type byte of the
  // last pages: the notes rows, inserted last, live there.
  const fd = openSync(path, 'r+');
  try {
    const pages = statSync(path).size / 4096;
    for (let p = pages - 10; p < pages; p++) writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, p * 4096);
  } finally {
    closeSync(fd);
  }
  await assert.rejects(nightlyBackup({ dataDir: dir }), /failed its integrity check/);
  assert.deepEqual(readdirSync(nightlyDir(dir)), [], 'neither the finished file nor a work file is left');
  assert.equal(nightlyStatus({ dataDir: dir }).stale, true, 'so the 26-hour signal stays on');
});

test('retention keeps the newest of the last 7 days and of the last 4 weeks', () => {
  // Daily backups at 02:17 UTC from 2026-08-16 to Wednesday 2026-10-14 (Monday is 2026-10-12).
  const end = Date.UTC(2026, 9, 14, 2, 17);
  const list = Array.from({ length: 60 }, (_, i) => ({ at: new Date(end - i * 24 * 60 * 60 * 1000) }));
  const kept = [...toKeep(list)].map((b) => b.at.toISOString().slice(0, 10)).sort();
  assert.deepEqual(kept, ['2026-09-27', '2026-10-04', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  // Two in one day: only the newer counts as that day's.
  const twice = [{ at: new Date(end) }, { at: new Date(end - 60_000) }];
  assert.deepEqual([...toKeep(twice)], [twice[0]]);
  // Gaps: a day without a backup does not use up a slot, so a backup two months old still counts as one of the last 7.
  const sparse = [0, 14, 28, 42, 56].map((d) => ({ at: new Date(end - d * 24 * 60 * 60 * 1000) }));
  assert.equal(toKeep(sparse).size, 5);
  assert.equal(toKeep(sparse, { daily: 1, weekly: 2 }).size, 2, 'the newest day and the two newest weeks overlap on the newest backup');
});

test('nightly backups over 30 days prune to the retention on disk', async () => {
  const { dir, store } = await filled(5);
  const end = Date.UTC(2026, 9, 14, 2, 17);
  try {
    for (let i = 29; i >= 0; i--) await nightlyBackup({ dataDir: dir, now: () => new Date(end - i * 24 * 60 * 60 * 1000) });
  } finally {
    store.close();
  }
  const days = listNightly(nightlyDir(dir)).map((b) => b.at.toISOString().slice(0, 10)).sort();
  assert.deepEqual(days, ['2026-09-27', '2026-10-04', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  // A file that is not a nightly backup is never touched.
  writeFileSync(join(nightlyDir(dir), 'keep-me.txt'), 'x');
  assert.ok(readdirSync(nightlyDir(dir)).includes('keep-me.txt'));
});

test('restore drill: a nightly restores into a scratch folder, timed, with every row count equal to the live database', async (t) => {
  const { dir, key, store } = await filled(5000);
  let live: Record<string, number>;
  let file: string;
  try {
    file = (await nightlyBackup({ dataDir: dir })).file;
    live = rowCounts(store.path);
  } finally {
    store.close();
  }
  const scratch = tempDirectory('cp-drill-');
  const r = await restoreDrill({ file, secretKey: key, scratchDir: scratch, migrations: withNotes });
  t.diagnostic(`restore drill: ${r.tables} tables, ${r.rows} rows restored in ${r.ms.toFixed(1)} ms`);
  assert.deepEqual(r.mismatches, [], 'every table matches the backup');
  assert.deepEqual(rowCounts(join(scratch, 'portal.db')), live, 'and the backup matches the live database it was taken from');
  assert.equal(live.notes, 5000);
  assert.ok(r.ms > 0 && r.ms < 60_000, `time to restore is measured (${r.ms} ms)`);
  // The restored copy is a working portal database: it opens with the key and starts Frozen, as a restore should.
  const restored = await Store.open({ dataDir: scratch, secretKey: key, migrations: withNotes });
  assert.equal(restored.trust.state, 'frozen');
  assert.deepEqual(restored.trust.reasons.map((x) => x.code), ['restored']);
  restored.close();
  // The live data dir is untouched by a drill.
  assert.equal(listNightly(nightlyDir(dir)).length, 1);
  assert.ok(!readdirSync(join(dir, 'backups')).some((n) => n.includes('replaced')), 'the drill never replaced the live database');
});

test('the drill reports a lost row, a lost table and an extra table', () => {
  assert.deepEqual(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 }), []);
  assert.deepEqual(compareCounts({ a: 1, b: 2, c: 0 }, { a: 0, b: 2, d: 3 }), [
    { table: 'a', backup: 1, restored: 0 },
    { table: 'c', backup: 0, restored: null },
    { table: 'd', backup: null, restored: 3 },
  ]);
});

test('rowCounts leaves out the frozen marker a restore adds, and nothing else', async () => {
  const { store } = await filled(3);
  const before = rowCounts(store.path);
  store.db!.prepare("INSERT INTO portal_meta (key, value) VALUES ('frozen', '{}')").run();
  assert.deepEqual(rowCounts(store.path), before);
  store.db!.prepare("INSERT INTO portal_meta (key, value) VALUES ('other', 'x')").run();
  assert.equal(rowCounts(store.path).portal_meta, before.portal_meta! + 1);
  store.close();
});

test('the drill refuses a backup the key does not open, and a damaged file', async () => {
  const { dir, store } = await filled(10);
  const { file } = await nightlyBackup({ dataDir: dir });
  store.close();
  await assert.rejects(restoreDrill({ file, secretKey: newKey(), migrations: withNotes }), /don't open with PORTAL_SECRET_KEY/);
  const broken = join(tempDirectory('cp-nightly-'), 'portal-20261014T021700Z-nightly.db.gz');
  writeFileSync(broken, 'not gzip');
  await assert.rejects(restoreDrill({ file: broken, secretKey: newKey(), migrations: withNotes }));
});

test('portal restore takes a .db.gz: the data comes back, the replaced database is kept, the portal starts Frozen', async () => {
  const { dir, key, store } = await filled(50);
  const { file } = await nightlyBackup({ dataDir: dir });
  store.db!.exec('DELETE FROM notes');
  store.close();
  const { replaced } = await restoreAny({ dataDir: dir, file, secretKey: key, migrations: withNotes });
  assert.ok(replaced && statSync(replaced).size > 0);
  assert.ok(!readdirSync(join(dir, 'backups')).some((n) => n.startsWith('.restore-')), 'the unzipped work file is gone');
  const back = await Store.open({ dataDir: dir, secretKey: key, migrations: withNotes });
  assert.equal((back.db!.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n, 50);
  assert.equal(back.trust.state, 'frozen');
  back.close();
});

test('the 26-hour signal', async () => {
  const { dir, store } = await filled(1);
  store.close();
  const at = new Date('2026-10-14T02:17:00Z');
  assert.deepEqual(nightlyStatus({ dataDir: dir, now: at }), { lastAt: null, stale: true, count: 0 });
  await nightlyBackup({ dataDir: dir, now: () => at });
  const after = (h: number) => nightlyStatus({ dataDir: dir, now: new Date(at.getTime() + h * 60 * 60 * 1000) });
  assert.deepEqual(after(1), { lastAt: at.toISOString(), stale: false, count: 1 });
  assert.equal(after(26).stale, false, 'exactly 26 h is not yet stale');
  assert.equal(after(26.01).stale, true);
});
