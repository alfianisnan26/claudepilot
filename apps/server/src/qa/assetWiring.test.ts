// T-376 S4: the wiring of the asset middleware in createApp. assetCompress.test.ts builds its own Hono app, so it kept passing when the
// `app.use('/assets/*', assetCompress())` line left app.ts. This goes through createApp and a real file under the built app's /assets/.
// The fixture files are written at run time into apps/web/dist/assets (names unique to this test) and removed after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { Portal } from '../portal.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const app = make(new Portal('24681357', 60_000), stub, stub, stub, stub, stub, stub, stub, { serveWeb: true, poolService: stub, mcp: stub, skills: stub });

const assets = join(config.paths.webDist, 'assets');
const made = !existsSync(assets);
const body = `export const x = ${JSON.stringify('lorem ipsum dolor '.repeat(2000))};\n`;
const files = ['wiring-t376s4.js', 'wiring-t376s4.css'];
mkdirSync(assets, { recursive: true });
for (const f of files) writeFileSync(join(assets, f), body);
after(() => {
  for (const f of files) rmSync(join(assets, f), { force: true });
  if (made) rmSync(config.paths.webDist, { recursive: true, force: true });
});

test('createApp serves a built script and stylesheet gzip-compressed and immutable', async () => {
  for (const f of files) {
    const res = await app.request(`http://localhost:3000/assets/${f}`, { headers: { host: 'localhost:3000', 'Accept-Encoding': 'gzip' } });
    assert.equal(res.status, 200, f);
    assert.equal(res.headers.get('content-encoding'), 'gzip', f);
    assert.match(res.headers.get('cache-control') ?? '', /immutable/, f);
    assert.match(res.headers.get('vary') ?? '', /accept-encoding/i, `${f}: a cache keys the copy by Accept-Encoding`);
    assert.equal(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'), body, f);
  }
});

test('createApp answers a missing built asset with 404, no-store and no content-encoding', async () => {
  const res = await app.request('http://localhost:3000/assets/missing-t376s4.js', { headers: { host: 'localhost:3000', 'Accept-Encoding': 'gzip' } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(res.headers.get('content-encoding'), null);
});
