import assert from 'node:assert/strict';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { blobDir, putBlob } from '../blobs.js';
import { recordFile } from './records.js';
import { expireFiles, RETENTION_MS, sweepOrphans } from './retention.js';
import { cleanup, storeWithSession } from './testkit.js';

after(cleanup);

const DAY = 24 * 60 * 60_000;

test('expireFiles: a chat idle for 90 days loses its stored files (and only those no other chat links); a recent one keeps them', async () => {
  const s = await storeWithSession('OLD');
  s.chat.create({ id: 'NEW', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'new', origin: 'ui' });
  const shared = putBlob(s.store, Buffer.from('shared bytes'));
  const mine = putBlob(s.store, Buffer.from('only in the old chat'));
  const link = (session: string, blobId: string, name: string) => recordFile(s.store, session, 'download', { blobId, name, mediaType: 'text/plain', size: 5, preview: 'text' });
  link('OLD', shared, 's.txt');
  link('OLD', mine, 'm.txt');
  link('NEW', shared, 's.txt');
  const old = new Date(Date.now() - RETENTION_MS - DAY).toISOString();
  s.store.db!.prepare('UPDATE chat_sessions SET last_activity_at = ? WHERE id = ?').run(old, 'OLD');
  assert.deepEqual(expireFiles(s.store), { chats: 1, blobs: 2 });
  assert.equal(existsSync(join(blobDir(s.store), mine)), false, 'its own file is gone');
  assert.equal(existsSync(join(blobDir(s.store), shared)), true, 'what another chat links stays');
  assert.equal((s.store.db!.prepare("SELECT COUNT(*) AS n FROM chat_files WHERE session_id = 'OLD'").get() as { n: number }).n, 0);
  assert.equal((s.store.db!.prepare("SELECT COUNT(*) AS n FROM chat_files WHERE session_id = 'NEW'").get() as { n: number }).n, 1);
  assert.deepEqual(expireFiles(s.store), { chats: 0, blobs: 0 }, 'nothing more to do');
  s.close();
});

test('expireFiles: a chat that was active a day ago keeps everything', async () => {
  const s = await storeWithSession('A');
  const id = putBlob(s.store, Buffer.from('x'));
  recordFile(s.store, 'A', 'upload', { blobId: id, name: 'x', mediaType: 'text/plain', size: 1, preview: 'text' });
  s.store.db!.prepare('UPDATE chat_sessions SET last_activity_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), 'A');
  assert.deepEqual(expireFiles(s.store), { chats: 0, blobs: 0 });
  assert.equal(existsSync(join(blobDir(s.store), id)), true);
  s.close();
});

test('sweepOrphans: a blob nothing links goes once it is a day old, a linked one and a young one stay; stale temporary files go', async () => {
  const s = await storeWithSession('A');
  const linked = putBlob(s.store, Buffer.from('linked'));
  recordFile(s.store, 'A', 'upload', { blobId: linked, name: 'l', mediaType: 'text/plain', size: 6, preview: 'text' });
  const orphan = putBlob(s.store, Buffer.from('orphan'));
  const young = putBlob(s.store, Buffer.from('young orphan'));
  const dir = blobDir(s.store);
  const old = new Date(Date.now() - 2 * DAY);
  utimesSync(join(dir, orphan), old, old);
  utimesSync(join(dir, linked), old, old);
  writeFileSync(join(dir, '.in-1234.part'), 'half');
  utimesSync(join(dir, '.in-1234.part'), old, old);
  writeFileSync(join(dir, '.in-5678.part'), 'arriving now');
  writeFileSync(join(dir, 'not-a-blob-name.txt'), 'someone else’s file');
  utimesSync(join(dir, 'not-a-blob-name.txt'), old, old);
  assert.equal(sweepOrphans(s.store), 2);
  assert.deepEqual(readdirSync(dir).sort(), [linked, young, '.in-5678.part', 'not-a-blob-name.txt'].sort());
  s.close();
});
