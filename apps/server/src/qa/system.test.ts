// QA regression: what the Access page is told about the database (/api/admin/system) when it is frozen, locked or fine.
// A database frozen by a failed migration never got as far as its key, so it has no secrets either, but entering a
// key cannot fix it: no Unlock or Set up may be offered for it (they were, next to "Keys locked").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SystemStatus } from '@portal/contracts';
import { createApp } from '../app.js';
import { Portal } from '../portal.js';
import { MIGRATIONS } from '../store/migrations.js';
import { nightlyBackup } from '../store/nightly.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const CODE = '24681357';

async function status(store: Store): Promise<SystemStatus> {
  const portal = new Portal(CODE, 60_000);
  const token = portal.signIn(CODE);
  const app = make(portal, stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
  const res = await app.request('http://localhost:3000/api/admin/system', {
    headers: { host: 'localhost:3000', cookie: `portal_session=${token}` },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { data: SystemStatus }).data;
}

const first = MIGRATIONS.filter((m) => m.version <= 5);
const failing = [
  ...first,
  {
    version: 6,
    name: 'boom',
    up: () => {
      throw new Error('table already exists');
    },
  },
];

test('a failed migration freezes the database without offering key actions, and still names the portal', async () => {
  const dir = tempDirectory('cp-qa-sys-');
  const key = parseSecretKey(generateSecretKey());
  (await Store.open({ dataDir: dir, secretKey: key, migrations: first })).close();
  const store = await Store.open({ dataDir: dir, secretKey: key, migrations: failing });
  const s = await status(store);
  assert.equal(s.trust.state, 'frozen');
  assert.deepEqual(
    s.trust.reasons.map((r) => r.code),
    ['migration-failed'],
  );
  assert.match(s.trust.reasons[0]!.message, /migration 6 \(boom\): table already exists/);
  assert.equal(s.secretKey.canUnlock, false, 'a key cannot fix a failed migration');
  assert.equal(s.secretKey.canSetUp, false);
  assert.equal(s.secretKey.canReset, false);
  assert.equal(s.resumable, false);
  assert.ok(s.portalId, 'the portal id is read even though the migration failed');
  assert.equal(s.schemaVersion, 5);
  store.close();
});

test('a missing or wrong key is still a lock with its key actions', async () => {
  const dir = tempDirectory('cp-qa-sys-');
  const key = parseSecretKey(generateSecretKey());
  (await Store.open({ dataDir: dir, secretKey: key })).close();
  const wrong = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
  const w = await status(wrong);
  assert.equal(w.trust.state, 'locked');
  assert.equal(w.secretKey.canUnlock, true);
  wrong.close();
  const none = await Store.open({ dataDir: dir, secretKey: null });
  assert.equal((await status(none)).secretKey.canUnlock, true);
  none.close();
  const fresh = await Store.open({ dataDir: tempDirectory('cp-qa-sys-'), secretKey: null });
  const f = await status(fresh);
  assert.equal(f.trust.state, 'locked');
  assert.equal(f.secretKey.canSetUp, true, 'a database that never had a key offers Set up');
  fresh.close();
});

test('T-565: the nightly backup is stale when there is none, fresh after one, stale again past 26 hours', async () => {
  const dir = tempDirectory('cp-qa-sys-');
  const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
  assert.deepEqual((await status(store)).nightlyBackup, { lastAt: null, stale: true, count: 0 }, 'no nightly yet: the signal is on');
  const at = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await nightlyBackup({ dataDir: dir, now: () => at });
  const fresh = (await status(store)).nightlyBackup;
  assert.equal(fresh.stale, false, '25 hours old is still fresh');
  assert.equal(fresh.count, 1);
  assert.equal(fresh.lastAt, new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString());
  await nightlyBackup({ dataDir: dir, now: () => new Date(Date.now() - 50 * 60 * 60 * 1000) });
  assert.equal((await status(store)).nightlyBackup.stale, false, 'an older one does not hide the newest');
  store.close();
  const old = tempDirectory('cp-qa-sys-');
  const s2 = await Store.open({ dataDir: old, secretKey: parseSecretKey(generateSecretKey()) });
  await nightlyBackup({ dataDir: old, now: () => new Date(Date.now() - 27 * 60 * 60 * 1000) });
  assert.equal((await status(s2)).nightlyBackup.stale, true, '27 hours old is stale');
  s2.close();
});

test('a healthy database offers nothing', async () => {
  const store = await Store.open({ dataDir: tempDirectory('cp-qa-sys-'), secretKey: parseSecretKey(generateSecretKey()) });
  const s = await status(store);
  assert.equal(s.trust.state, 'ok');
  assert.deepEqual([s.secretKey.canSetUp, s.secretKey.canUnlock, s.secretKey.canReset], [false, false, false]);
  store.close();
});
