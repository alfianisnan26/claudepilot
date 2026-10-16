// The built app's text files are gzip-compressed (T-376 S3): the main bundle was 1.27 MB on the wire, uncompressed, on a first open. Images,
// fonts and streams stay as they are. Fixtures are built here, at run time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { assetCompress } from './jsonCompress.js';

const big = `export const x = ${JSON.stringify('lorem ipsum dolor '.repeat(2000))};\n`;

function app() {
  const a = new Hono();
  a.use('/assets/*', assetCompress());
  a.get('/assets/index-abc.js', (c) => c.body(big, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  a.get('/assets/index-abc.css', (c) => c.body(big, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  a.get('/assets/logo.png', (c) => c.body(big, 200, { 'Content-Type': 'image/png' }));
  a.get('/assets/font.woff2', (c) => c.body(big, 200, { 'Content-Type': 'font/woff2' }));
  return a;
}

test('a script and a stylesheet are gzip-compressed when the client accepts gzip', async () => {
  for (const path of ['/assets/index-abc.js', '/assets/index-abc.css']) {
    const res = await app().request(path, { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-encoding'), 'gzip', path);
    const raw = Buffer.from(await res.arrayBuffer());
    assert.equal(gunzipSync(raw).toString('utf8'), big, path);
    assert.ok(raw.length * 5 < big.length, `${path}: ${raw.length} of ${big.length} bytes`);
  }
});

test('no Accept-Encoding: the file as it was', async () => {
  const res = await app().request('/assets/index-abc.js');
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal(await res.text(), big);
});

test('an image and a font are never recompressed', async () => {
  for (const path of ['/assets/logo.png', '/assets/font.woff2']) {
    const res = await app().request(path, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), null, path);
    assert.equal(await res.text(), big, path);
  }
});
