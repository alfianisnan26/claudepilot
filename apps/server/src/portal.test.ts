import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Portal } from './portal.js';
import { sessionStore } from './store/sessions.js';
import { Store } from './store/store.js';

const CODE = '00000000';
const open = (dir: string) => Store.open({ dataDir: dir, secretKey: null });
/** A portal started on the database in `dir`, as after a restart. */
async function start(dir: string, ttlMs = 60_000) {
  const store = await open(dir);
  const portal = new Portal(CODE, ttlMs);
  portal.useStore(sessionStore(store));
  return { store, portal };
}

test('sign-ins survive a restart, and sign-outs and code changes do too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-sessions-'));
  const first = await start(dir);
  const mine = first.portal.signIn(CODE);
  const other = first.portal.signIn(CODE);
  const leaving = first.portal.signIn(CODE);
  first.portal.signOut(leaving);
  first.store.close();

  const second = await start(dir);
  assert.ok(second.portal.session(mine), 'still signed in after a restart');
  assert.ok(second.portal.session(other));
  assert.equal(second.portal.session(leaving), undefined, 'signed out stays signed out');
  second.portal.rotate(mine);
  second.store.close();

  const third = await start(dir);
  assert.ok(third.portal.session(mine), 'whoever changed the code stays signed in');
  assert.equal(third.portal.session(other), undefined, 'a new code signs everyone else out');
  third.store.close();
});

test('the database keeps only token hashes, and expired sign-ins are not restored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-sessions-'));
  const first = await start(dir, 50);
  const token = first.portal.signIn(CODE);
  const rows = first.store.db!.prepare('SELECT * FROM web_sessions').all() as Record<string, string>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!Object.values(rows[0]!).includes(token), 'no column holds the token itself');
  first.store.close();

  await new Promise((r) => setTimeout(r, 80));
  const second = await start(dir, 50);
  assert.equal(second.portal.session(token), undefined);
  assert.equal((second.store.db!.prepare('SELECT count(*) AS n FROM web_sessions').get() as { n: number }).n, 0, 'expired rows are cleaned up');
  second.store.close();
});
