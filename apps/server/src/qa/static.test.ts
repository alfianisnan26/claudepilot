// QA regression (QA-021): a missing script or stylesheet is a 404, never the app shell, and never cached as immutable.
// A tab left open across a deploy still asks for the old hashed chunks; the shell served for them (200, text/html, cached
// for a year) made the dynamic import fail with a MIME error and blanked the whole page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { Portal } from '../portal.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const app = make(new Portal('24681357', 60_000), stub, stub, stub, stub, stub, stub, stub, { serveWeb: true, poolService: stub, mcp: stub, skills: stub });
const get = (path: string) => app.request(`http://localhost:3000${path}`, { headers: { host: 'localhost:3000' } });

test('a file that is not there is a 404 with no long-lived cache header', async () => {
  for (const path of ['/assets/SessionPage-OLDHASH.js', '/assets/index-OLD.css', '/assets/x.js.map', '/assets/anything', '/favicon-missing.svg', '/icon-999.png', '/missing.webmanifest', '/vendor/lib.mjs']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable|max-age=31536000/, path);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /html/, `${path} must not get the app shell`);
  }
});

test('client-side routes still get a page and API misses stay JSON', async () => {
  const api = await get('/api/nothing-here');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type') ?? '', /json/);
  // Routes have no file extension, so they are not caught by the 404 rule (the shell itself comes from the built app).
  for (const path of ['/admin/workspaces', '/admin/sessions/7c9e6679-7425-40de-944b-e07fc1f90ae7', '/admin/pools/mcp/catalog/abc-123', '/login']) {
    const res = await get(path);
    assert.notEqual(res.headers.get('cache-control'), 'no-store', path);
    assert.ok(res.status === 200 || res.status === 404, `${path} -> ${res.status} (404 only when there is no built app)`);
  }
});

test('the built files allow cross-origin use (the reporter panel framed on a COEP require-corp site); the rest stays same-origin', async () => {
  assert.equal((await get('/assets/embed-HASH.js')).headers.get('cross-origin-resource-policy'), 'cross-origin');
  for (const path of ['/api/nothing-here', '/login', '/admin/workspaces']) assert.equal((await get(path)).headers.get('cross-origin-resource-policy'), 'same-origin', path);
});
