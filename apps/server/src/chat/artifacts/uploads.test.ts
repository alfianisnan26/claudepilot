import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CHAT_MAX_UPLOAD_BYTES } from '@portal/contracts';
import { blobDir } from '../blobs.js';
import { MAX_PENDING_UPLOADS, UPLOAD_TTL_MS } from './quota.js';
import { consumeUploads, discardUpload, receiveUpload, sweepUploads, takeUploads, uploadName } from './uploads.js';
import { sniff } from './sniff.js';
import { cleanup, storeWithSession } from './testkit.js';

after(cleanup);

/** A request body of these chunks, like the one a browser sends. */
const body = (...chunks: Buffer[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new Uint8Array(ch));
      c.close();
    },
  });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const files = (dir: string) => readdirSync(blobDir({ dataDir: dir } as never));

test('receiveUpload: a PNG is stored by its hash, sniffed, sized from its header and waits under an id', async () => {
  const s = await storeWithSession();
  const up = await receiveUpload(s.store, s.sessionId, { body: body(PNG.subarray(0, 20), PNG.subarray(20)), name: 'Screenshot 2026-10-12.PNG', declaredSize: PNG.length });
  assert.equal(up.blobId, sha(PNG));
  assert.deepEqual([up.mediaType, up.preview, up.reach, up.width, up.height, up.size], ['image/png', 'image', 'sees', 1, 1, PNG.length]);
  assert.equal(up.name, 'Screenshot 2026-10-12.PNG');
  assert.match(up.id, /^[a-f0-9]{24}$/);
  assert.ok(readFileSync(join(blobDir(s.store), up.blobId)).equals(PNG));
  assert.equal(statSync(join(blobDir(s.store), up.blobId)).mode & 0o777, 0o600);
  assert.deepEqual(files(s.dataDir), [up.blobId], 'no temporary file is left');
  assert.deepEqual(
    takeUploads(s.store, s.sessionId, [up.id]).map((u) => u.blobId),
    [up.blobId],
  );
  s.close();
});

test('receiveUpload: what the sender claims never decides the type; a missing extension is added from the bytes; the name is made safe', async () => {
  const s = await storeWithSession();
  const html = await receiveUpload(s.store, s.sessionId, { body: body(Buffer.from('<script>alert(1)</script>')), name: 'photo.png', declaredSize: null });
  assert.equal(html.mediaType, 'text/plain', 'a .png that is not an image is not served as one');
  assert.equal(html.preview, 'text');
  const pasted = await receiveUpload(s.store, s.sessionId, { body: body(PNG), name: 'blob', declaredSize: null });
  assert.equal(pasted.name, 'blob.png');
  const hostile = await receiveUpload(s.store, s.sessionId, { body: body(Buffer.from('x')), name: '../../etc/pass\u{202e}wd\u{0}.txt', declaredSize: null });
  assert.equal(hostile.name, 'passwd.txt');
  const nameless = await receiveUpload(s.store, s.sessionId, { body: body(Buffer.from('x')), name: null, declaredSize: null });
  assert.equal(nameless.name, 'file');
  assert.equal(uploadName('clip', sniff(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x00'), 'clip', 12)), 'clip.mp3');
  s.close();
});

test('receiveUpload: empty, over the limit (announced or not), and interrupted uploads leave nothing behind', async () => {
  const s = await storeWithSession();
  await assert.rejects(receiveUpload(s.store, s.sessionId, { body: body(), name: 'empty.txt', declaredSize: 0 }), /empty/);
  await assert.rejects(receiveUpload(s.store, s.sessionId, { body: null, name: 'x', declaredSize: null }), /request body/);
  // Announced too large: refused up front, before anything is written.
  await assert.rejects(receiveUpload(s.store, s.sessionId, { body: new ReadableStream({ pull() {} }), name: 'big.bin', declaredSize: CHAT_MAX_UPLOAD_BYTES + 1 }), /over 25 MB/);
  assert.deepEqual(readdirSync(blobDir(s.store)), [], 'no temporary file was even started');
  // Not announced (chunked): stopped while streaming, the temporary file removed.
  const chunk = Buffer.alloc(1_000_000, 7);
  const many = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(chunk));
    },
  });
  await assert.rejects(receiveUpload(s.store, s.sessionId, { body: many, name: 'big.bin', declaredSize: null }), /over 25 MB/);
  // The connection drops half way.
  const dropped = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(chunk.subarray(0, 1000)));
      c.error(new Error('socket hang up'));
    },
  });
  await assert.rejects(receiveUpload(s.store, s.sessionId, { body: dropped, name: 'x.bin', declaredSize: null }), /interrupted/);
  assert.deepEqual(files(s.dataDir), [], 'nothing was kept');
  assert.equal((s.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_uploads').get() as { n: number }).n, 0);
  s.close();
});

test('receiveUpload: exactly the limit is fine', async () => {
  const s = await storeWithSession();
  const chunk = Buffer.alloc(1_000_000, 1);
  const up = await receiveUpload(s.store, s.sessionId, { body: body(...Array.from({ length: 25 }, () => chunk)), name: 'exact.bin', declaredSize: CHAT_MAX_UPLOAD_BYTES });
  assert.equal(up.size, CHAT_MAX_UPLOAD_BYTES);
  assert.equal(up.reach, 'path');
  s.close();
});

test('uploads: only this chat’s, only once waiting; removing one deletes its blob unless something else links it', async () => {
  const s = await storeWithSession('A');
  s.chat.create({ id: 'B', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'B', origin: 'ui' });
  const a = await receiveUpload(s.store, 'A', { body: body(Buffer.from('hello')), name: 'a.txt', declaredSize: 5 });
  assert.throws(() => takeUploads(s.store, 'B', [a.id]), /no longer there/, 'another chat can not use it');
  assert.throws(() => takeUploads(s.store, 'A', ['nope']), /no longer there/);
  assert.throws(() => takeUploads(s.store, 'A', ['../x']), /no longer there/);
  // The same bytes uploaded again by chat B share the file; discarding A's keeps B's.
  const b = await receiveUpload(s.store, 'B', { body: body(Buffer.from('hello')), name: 'b.txt', declaredSize: 5 });
  assert.equal(a.blobId, b.blobId);
  assert.equal(discardUpload(s.store, 'A', a.id), true);
  assert.equal(existsSync(join(blobDir(s.store), a.blobId)), true, 'chat B still waits on it');
  assert.equal(discardUpload(s.store, 'A', a.id), false, 'already gone');
  assert.equal(discardUpload(s.store, 'A', b.id), false, 'not A’s');
  assert.equal(discardUpload(s.store, 'B', b.id), true);
  assert.equal(existsSync(join(blobDir(s.store), a.blobId)), false, 'nothing links it any more');
  s.close();
});

test('uploads: consumed ones are spent, stale ones are swept, and a chat can only wait on so many', async () => {
  const s = await storeWithSession();
  const one = await receiveUpload(s.store, s.sessionId, { body: body(Buffer.from('one')), name: 'one.txt', declaredSize: 3 });
  consumeUploads(s.store, s.sessionId, [one.id]);
  assert.throws(() => takeUploads(s.store, s.sessionId, [one.id]), /no longer there/);

  const old = await receiveUpload(s.store, s.sessionId, { body: body(Buffer.from('old')), name: 'old.txt', declaredSize: 3 });
  assert.equal(sweepUploads(s.store, Date.now() + UPLOAD_TTL_MS - 60_000), 0, 'not yet');
  assert.equal(sweepUploads(s.store, Date.now() + UPLOAD_TTL_MS + 60_000), 1);
  assert.throws(() => takeUploads(s.store, s.sessionId, [old.id]), /no longer there/);
  assert.equal(existsSync(join(blobDir(s.store), old.blobId)), false, 'its blob went with it');

  for (let i = 0; i < MAX_PENDING_UPLOADS; i++) await receiveUpload(s.store, s.sessionId, { body: body(Buffer.from(`file ${i}`)), name: `f${i}.txt`, declaredSize: null });
  await assert.rejects(receiveUpload(s.store, s.sessionId, { body: body(Buffer.from('one more')), name: 'x.txt', declaredSize: null }), /Too many files are waiting/);
  s.close();
});

test('uploads: a chat’s files are capped (the room is checked against what is stored)', async () => {
  process.env.PORTAL_CHAT_SESSION_QUOTA_MB = '1';
  try {
    const s = await storeWithSession();
    await receiveUpload(s.store, s.sessionId, { body: body(Buffer.alloc(600_000, 1)), name: 'a.bin', declaredSize: 600_000 });
    await assert.rejects(receiveUpload(s.store, s.sessionId, { body: body(Buffer.alloc(600_000, 2)), name: 'b.bin', declaredSize: 600_000 }), /This chat's files are full \(1 MB\)/);
    // An announced size that was a lie is caught by what arrived.
    await assert.rejects(receiveUpload(s.store, s.sessionId, { body: body(Buffer.alloc(600_000, 3)), name: 'c.bin', declaredSize: 10 }), /files are full/);
    assert.equal(readdirSync(blobDir(s.store)).length, 1, 'the refused ones left no file');
    s.close();
  } finally {
    delete process.env.PORTAL_CHAT_SESSION_QUOTA_MB;
  }
});
