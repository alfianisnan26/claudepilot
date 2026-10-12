import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CHAT_MAX_PREVIEW_BYTES, type ChatFile } from '@portal/contracts';
import { blobDir, putBlob } from '../blobs.js';
import { recordFile } from './records.js';
import { blobFileFor, parseRange, serveBlob, textPreview } from './serve.js';
import { cleanup, storeWithSession } from './testkit.js';

after(cleanup);

type Ctx = Awaited<ReturnType<typeof storeWithSession>>;

/** Stores bytes and links them to a session as a file of the given type. */
function add(s: Ctx, bytes: Buffer, file: Partial<ChatFile> & { name: string; mediaType: string }, session = s.sessionId): string {
  const blobId = putBlob(s.store, bytes);
  recordFile(s.store, session, 'download', { blobId, size: bytes.length, preview: 'none', ...file });
  return blobId;
}

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`http://localhost${url}`, { method, headers });
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

test('parseRange: one byte range, a suffix, open-ended; anything else is the whole file; impossible ones are refused', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'an end past the file is the end of the file');
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=50-10', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1', 0), 'unsatisfiable');
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null, 'several ranges: the whole file is a valid answer');
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
  assert.equal(parseRange('bytes=abc-', 1000), null);
});

test('serveBlob: an image is shown inline with a safe header set; the same bytes can be asked for as a download', async () => {
  const s = await storeWithSession();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const id = add(s, png, { name: 'a.png', mediaType: 'image/png', preview: 'image' });
  const file = blobFileFor(s.store, s.sessionId, id);
  const r = serveBlob(get('/x'), file);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('content-disposition'), 'inline');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-length'), String(png.length));
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.ok((await bytes(r)).equals(png));

  const d = serveBlob(get('/x'), file, { download: true });
  assert.equal(d.headers.get('content-type'), 'application/octet-stream');
  assert.equal(d.headers.get('content-disposition'), 'attachment; filename="a.png"');
  s.close();
});

test('serveBlob: only types on the allow-list are inline; HTML, SVG, scripts and anything unknown are downloads whatever they claim', async () => {
  const s = await storeWithSession();
  const cases: [string, string, string][] = [
    ['page.html', 'text/html', '<script>alert(document.domain)</script>'],
    ['logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['app.js', 'text/javascript', 'alert(1)'],
    ['data.xml', 'application/xml', '<x/>'],
    ['notes.txt', 'text/plain', 'hello'],
    ['thing.bin', 'application/octet-stream', 'x'],
    ['evil', 'text/html; charset=utf-7', '+ADw-script+AD4-'],
  ];
  for (const [name, mediaType, text] of cases) {
    const id = add(s, Buffer.from(`${text}`), { name, mediaType: mediaType.split(';')[0]! });
    const r = serveBlob(get('/x'), blobFileFor(s.store, s.sessionId, id));
    assert.equal(r.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename=/, name);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
    await r.arrayBuffer();
  }
  s.close();
});

test('serveBlob: Range for media — a slice with 206, the end, a suffix, an impossible one with 416; HEAD sends no body', async () => {
  const s = await storeWithSession();
  const mp3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))]);
  const id = add(s, mp3, { name: 'voice.mp3', mediaType: 'audio/mpeg', preview: 'audio' });
  const file = blobFileFor(s.store, s.sessionId, id);

  const part = serveBlob(get('/x', { range: 'bytes=10-19' }), file);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${mp3.length}`);
  assert.equal(part.headers.get('content-length'), '10');
  assert.equal(part.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await bytes(part)).equals(mp3.subarray(10, 20)));

  const tail = serveBlob(get('/x', { range: 'bytes=-5' }), file);
  assert.equal(tail.status, 206);
  assert.ok((await bytes(tail)).equals(mp3.subarray(mp3.length - 5)));

  const open = serveBlob(get('/x', { range: `bytes=${mp3.length - 3}-` }), file);
  assert.ok((await bytes(open)).equals(mp3.subarray(mp3.length - 3)));

  const bad = serveBlob(get('/x', { range: `bytes=${mp3.length}-` }), file);
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${mp3.length}`);

  const whole = serveBlob(get('/x'), file);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-disposition'), 'inline; filename="voice.mp3"');
  assert.ok((await bytes(whole)).equals(mp3));

  const head = serveBlob(get('/x', {}, 'HEAD'), file);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(mp3.length));
  assert.equal((await bytes(head)).length, 0);
  s.close();
});

test('serveBlob: a repeat visit costs nothing (ETag), a PDF keeps its name for a tab, and nobody else’s blob is found', async () => {
  const s = await storeWithSession('A');
  s.chat.create({ id: 'B', workspaceId: 'docker/ws1', cwd: '/home/node', title: 'B', origin: 'ui' });
  const id = add(s, Buffer.from('%PDF-1.4\n%%EOF\n'), { name: 'Q3 report.pdf', mediaType: 'application/pdf', preview: 'pdf' }, 'A');
  const r = serveBlob(get('/x'), blobFileFor(s.store, 'A', id));
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'inline; filename="Q3 report.pdf"');
  assert.equal(r.headers.get('content-security-policy'), null, 'a sandboxed PDF is not shown by the browser’s viewer');
  assert.equal(r.headers.get('etag'), `"${id}"`);
  await r.arrayBuffer();
  const again = serveBlob(get('/x', { 'if-none-match': `"${id}"` }), blobFileFor(s.store, 'A', id));
  assert.equal(again.status, 304);
  assert.equal(blobFileFor(s.store, 'B', id), null, 'chat B does not link it');
  assert.throws(() => serveBlob(get('/x'), null), /No such file/);
  rmSync(join(blobDir(s.store), id));
  assert.equal(blobFileFor(s.store, 'A', id), null, 'gone from disk (retention): not found, not an error page');
  s.close();
});

test('textPreview: secrets are hidden, the start of a long file is cut at a character, and binary has no text preview', async () => {
  const s = await storeWithSession();
  const key = 'sk-ant-api03-' + 'a1B2c3D4e5'.repeat(5);
  const small = add(s, Buffer.from(`# Notes\nANTHROPIC_API_KEY=${key}\nplain line\n`), { name: 'notes.md', mediaType: 'text/markdown', preview: 'text' });
  const p = textPreview(blobFileFor(s.store, s.sessionId, small)!);
  assert.equal(p.truncated, false);
  assert.equal(p.redacted, true);
  assert.ok(!p.text.includes(key) && p.text.includes('plain line'));

  // 1 MB of three-byte characters: the cut falls inside one and is left out, not shown as a replacement mark.
  const long = add(s, Buffer.from('€'.repeat(Math.ceil(CHAT_MAX_PREVIEW_BYTES / 3) + 10)), { name: 'long.txt', mediaType: 'text/plain', preview: 'text' });
  const lp = textPreview(blobFileFor(s.store, s.sessionId, long)!);
  assert.equal(lp.truncated, true);
  assert.ok(!lp.text.includes('\u{fffd}'), 'no replacement character');
  assert.ok(Buffer.byteLength(lp.text) <= CHAT_MAX_PREVIEW_BYTES);
  assert.ok(Buffer.byteLength(lp.text) > CHAT_MAX_PREVIEW_BYTES - 3);

  const utf16 = add(s, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo', 'utf16le')]), { name: 'u16.txt', mediaType: 'text/plain', preview: 'text' });
  assert.equal(textPreview(blobFileFor(s.store, s.sessionId, utf16)!).text, 'héllo');
  const bom = add(s, Buffer.from('\u{feff}a,b\n1,2\n'), { name: 'bom.csv', mediaType: 'text/csv', preview: 'text' });
  assert.equal(textPreview(blobFileFor(s.store, s.sessionId, bom)!).text, 'a,b\n1,2\n');

  // The source of an HTML or SVG file can be read as text (it is only ever shown as text), a PDF or an image can not.
  const html = add(s, Buffer.from('<b>hi</b>'), { name: 'x.html', mediaType: 'text/html', preview: 'html' });
  assert.equal(textPreview(blobFileFor(s.store, s.sessionId, html)!).text, '<b>hi</b>');
  const pdf = add(s, Buffer.from('%PDF-1.4'), { name: 'x.pdf', mediaType: 'application/pdf', preview: 'pdf' });
  assert.throws(() => textPreview(blobFileFor(s.store, s.sessionId, pdf)!), /no text preview/);
  s.close();
});
