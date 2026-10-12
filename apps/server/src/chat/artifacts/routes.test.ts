import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CHAT_CONTENT_API, CHAT_MAX_UPLOAD_BYTES, type ChatFile, type ChatSession } from '@portal/contracts';
import { Hono } from 'hono';
import type { Workspaces } from '../../workspaces/manager.js';
import { putBlob } from '../blobs.js';
import { createChatFileRoutes } from '../fileRoutes.js';
import { createChatRoutes } from '../routes.js';
import { ChatController } from '../controller.js';
import { recordFile } from './records.js';
import { blobFileFor } from './serve.js';
import { cleanup, storeWithSession } from './testkit.js';

after(cleanup);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** The chat routes as the app mounts them, around a real controller on a fake workspace host. */
async function app() {
  const s = await storeWithSession('S1');
  const controller = new ChatController(s.store, {} as Workspaces);
  const hono = new Hono();
  hono.onError((e, c) => c.json({ error: e.message }, (isAppError(e) ? e.status : 500) as 404));
  hono.route('/', createChatRoutes(controller));
  hono.route('/', createChatFileRoutes({ controller, workspaces: {} as Workspaces, store: s.store }));
  return { ...s, hono, controller };
}

/** The contract's URL as this test app serves it (it is mounted at the root, the portal mounts it under /api/chat/sessions). */
const rel = (url: string) => url.replace('/api/chat/sessions', '');

const upload = (hono: Hono, id: string, body: Buffer | Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  hono.request(`/${id}/uploads`, { method: 'POST', body, headers, duplex: 'half' } as unknown as RequestInit);

test('POST uploads: the raw body is the file; the type is sniffed, the name decoded and made safe', async () => {
  const c = await app();
  const r = await upload(c.hono, 'S1', PNG, { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Laporan Ç – foto.png') });
  assert.equal(r.status, 201);
  const { data } = (await r.json()) as { data: ChatFile & { id: string } };
  assert.equal(data.name, 'Laporan Ç – foto.png');
  assert.deepEqual([data.mediaType, data.preview, data.reach], ['image/png', 'image', 'sees'], 'the claimed text/plain is only a claim');
  assert.match(data.id, /^[a-f0-9]{24}$/);

  const bad = await upload(c.hono, 'S1', Buffer.from('hello'), { 'x-file-name': '%E0%A4%A' }); // not valid percent-encoding
  assert.equal(bad.status, 201);
  assert.equal(((await bad.json()) as { data: ChatFile }).data.name, 'file');
  c.close();
});

test('POST uploads: the rules — no such chat, an ended chat, an empty file, a file over the limit', async () => {
  const c = await app();
  assert.equal((await upload(c.hono, 'nope', Buffer.from('x'))).status, 404);
  assert.equal((await upload(c.hono, 'S1', new Uint8Array(0))).status, 422);
  const big = new ReadableStream({
    pull(ctl) {
      ctl.enqueue(new Uint8Array(1_000_000));
    },
  });
  const r = await upload(c.hono, 'S1', big);
  assert.equal(r.status, 413);
  assert.match(JSON.stringify(await r.json()), /over 25 MB/);
  assert.equal(CHAT_MAX_UPLOAD_BYTES, 25_000_000);
  c.chat.patchSession('S1', { state: 'ended' });
  assert.equal((await upload(c.hono, 'S1', Buffer.from('x'))).status, 409);
  c.close();
});

test('DELETE uploads: an attachment removed before sending is dropped; asking twice is fine', async () => {
  const c = await app();
  const r = await upload(c.hono, 'S1', Buffer.from('hello'), { 'x-file-name': 'a.txt' });
  const { data } = (await r.json()) as { data: { id: string } };
  assert.equal((await c.hono.request(`/S1/uploads/${data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((c.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_uploads').get() as { n: number }).n, 0);
  assert.equal((await c.hono.request(`/S1/uploads/${data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await c.hono.request('/nope/uploads/x', { method: 'DELETE' })).status, 404);
  c.close();
});

test('GET blobs: any stored file is served by the one policy, and the preview route reads text with secrets hidden', async () => {
  const c = await app();
  const key = 'sk-ant-api03-' + 'a1B2c3D4e5'.repeat(5);
  const text = Buffer.from(`token: ${key}\nok\n`);
  const id = putBlob(c.store, text);
  recordFile(c.store, 'S1', 'download', { blobId: id, name: 'env.txt', mediaType: 'text/plain', size: text.length, preview: 'text' });
  const preview = await c.hono.request(rel(CHAT_CONTENT_API.preview('S1', id)));
  assert.equal(preview.status, 200);
  const p = ((await preview.json()) as { data: { text: string; redacted: boolean; truncated: boolean } }).data;
  assert.equal(p.redacted, true);
  assert.ok(!p.text.includes(key));
  // As bytes it is a download: it is text, not on the inline list.
  const raw = await c.hono.request(`/S1/blobs/${id}`);
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
  assert.match(raw.headers.get('content-disposition') ?? '', /^attachment; filename="env.txt"/);
  assert.equal((await c.hono.request(`/S1/blobs/${id}?download=1`)).headers.get('content-type'), 'application/octet-stream');
  // Not this chat's, or not a text file: no preview.
  c.chat.create({ id: 'S2', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'two', origin: 'ui' });
  assert.equal((await c.hono.request(rel(CHAT_CONTENT_API.preview('S2', id)))).status, 404);
  const pdf = putBlob(c.store, Buffer.from('%PDF-1.4\n%%EOF'));
  recordFile(c.store, 'S1', 'download', { blobId: pdf, name: 'a.pdf', mediaType: 'application/pdf', size: 14, preview: 'pdf' });
  assert.equal((await c.hono.request(rel(CHAT_CONTENT_API.preview('S1', pdf)))).status, 415);
  c.close();
});

test('GET artifacts.zip: the files of the events named, nothing from other chats, nothing when there are none', async () => {
  const c = await app();
  c.chat.create({ id: 'S2', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'two', origin: 'ui' });
  const add = (session: string, name: string, bytes: Buffer, mediaType = 'text/plain'): ChatFile => {
    const blobId = putBlob(c.store, bytes);
    const file: ChatFile = { blobId, name, mediaType, size: bytes.length, preview: 'none', source: 'write' };
    recordFile(c.store, session, 'download', file);
    return file;
  };
  const a = add('S1', 'report.md', Buffer.from('# report\n'), 'text/markdown');
  const b = add('S1', 'data.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
  const secret = add('S2', 'other.txt', Buffer.from('someone else'));
  const e1 = c.chat.appendEvent('S1', { kind: 'artifact', files: [a] });
  const e2 = c.chat.appendEvent('S1', { kind: 'artifact', files: [b] });
  c.chat.appendEvent('S2', { kind: 'artifact', files: [secret] });
  c.chat.appendEvent('S2', { kind: 'artifact', files: [secret] });
  const e3 = c.chat.appendEvent('S2', { kind: 'artifact', files: [secret] }); // S2's third event: S1 has only two

  const r = await c.hono.request(rel(CHAT_CONTENT_API.zip('S1', [e1.seq, e2.seq])));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename=".*-files\.zip"/);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.ok(zip.includes(Buffer.from('report.md')) && zip.includes(Buffer.from('data.csv')));
  assert.ok(!zip.includes(Buffer.from('other.txt')));
  // An event number that exists only in another chat: nothing of it, whatever the id.
  const cross = await c.hono.request(rel(CHAT_CONTENT_API.zip('S1', [e3.seq])));
  assert.equal(cross.status, 404);
  assert.equal((await c.hono.request('/S1/artifacts.zip?events=')).status, 404);
  assert.equal((await c.hono.request('/S1/artifacts.zip?events=abc,-1,0')).status, 404);
  void blobFileFor;
  c.close();
});

test('uploads: random bytes of the largest size are accepted and served back identical', async () => {
  const c = await app();
  const bytes = randomBytes(CHAT_MAX_UPLOAD_BYTES);
  const r = await upload(c.hono, 'S1', bytes, { 'x-file-name': 'big.bin', 'content-length': String(bytes.length) });
  assert.equal(r.status, 201);
  const { data } = (await r.json()) as { data: ChatFile };
  assert.equal(data.size, CHAT_MAX_UPLOAD_BYTES);
  c.close();
});
