import { AppError } from '@isnanme/core';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// PILOT-1148: the SPA as static assets (wrangler.jsonc `assets`, scripts/webAssets.mjs, src/app.ts), against the test web build of
// vitest.config.ts. The expected headers are what the portal sends today, computed from its own code there.
// SELF calls the Worker directly, past the asset router: what the router serves is fetched here through the ASSETS binding (the same
// asset worker, with not_found_handling and _headers), and which path goes where (run_worker_first) is test-node/router.test.mjs.
const base = 'https://core.test';
const shellHeaders = JSON.parse(env.TEST_PORTAL_SHELL_HEADERS) as Record<string, string>;
const assetHeaders = JSON.parse(env.TEST_PORTAL_ASSET_HEADERS) as Record<string, string>;
const notFound = new AppError('NOT_FOUND', 'Not found.').toJSON();

function expectHeaders(res: Response, want: Record<string, string>, label: string) {
  for (const [k, v] of Object.entries(want)) expect(res.headers.get(k), `${label}: ${k}`).toBe(v);
  expect(res.headers.get('strict-transport-security'), `${label}: no HSTS, like the portal`).toBeNull();
}

describe('the SPA', () => {
  it('the test build carries the portal’s CSP with the inline theme script’s hash (the comparison below means something)', () => {
    expect(shellHeaders['content-security-policy']).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(shellHeaders['x-frame-options']).toBe('SAMEORIGIN');
  });

  for (const [label, init] of [
    ['a navigation', { headers: { 'Sec-Fetch-Mode': 'navigate' } }],
    ['a plain fetch', {}],
  ] as const) {
    it(`/ and a deep link are the shell, with the portal’s headers and no-cache (${label})`, async () => {
      for (const path of ['/', '/admin/sessions', '/admin/sessions/abc?new=1', '/nope']) {
        const res = await env.ASSETS.fetch(`${base}${path}`, init);
        expect(res.status, path).toBe(200);
        expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
        const html = await res.text();
        expect(html, path).toContain('<div id="root"></div>');
        expect(html, path).toContain(env.TEST_WEB_ENTRY);
        expectHeaders(res, shellHeaders, path);
        expect(res.headers.get('cache-control'), path).toBe('no-cache');
      }
    });
  }

  it('the service worker and the manifest are served at the root with no-cache (scope / on any host)', async () => {
    const sw = await env.ASSETS.fetch(`${base}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toMatch(/javascript/);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expectHeaders(sw, shellHeaders, '/sw.js');
    const manifest = await env.ASSETS.fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
    expect(await manifest.json()).toMatchObject({ id: '/', start_url: '/', scope: '/' });
  });

  it('a hashed file is immutable, with the portal’s /assets headers and no CSP', async () => {
    const res = await SELF.fetch(`${base}${env.TEST_WEB_ENTRY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toBe('console.log("app");');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expectHeaders(res, assetHeaders, env.TEST_WEB_ENTRY);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('a missing hashed file is a 404 that is not kept, never the shell', async () => {
    for (const path of ['/assets/index-gone0000.js', '/assets/style-gone.css', '/assets/']) {
      const res = await SELF.fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(await res.text(), path).toBe('Not found');
    }
  });

  it('the Worker answers /api, /mcp, /bridge and /connect with its plain 404 and the portal’s secure headers', async () => {
    for (const path of ['/api/x', '/api/workspaces/a/b', '/mcp', '/mcp/x', '/bridge', '/connect/enroll']) {
      const res = await SELF.fetch(`${base}${path}`, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toMatch(/^application\/json/);
      expect(await res.json(), path).toEqual(notFound);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
    const api = await SELF.fetch(`${base}/api/x`);
    expect(api.headers.get('cache-control')).toBe('no-store');
    await api.body?.cancel();
    const health = await SELF.fetch(`${base}/healthz`, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'cp-next-core' });
  });

  it('an `Upgrade: websocket` header off /bridge keeps the secure headers: only /bridge skips them (review of PILOT-1148)', async () => {
    const upgrade = { headers: { upgrade: 'websocket', connection: 'Upgrade' } };
    for (const path of ['/api/x', '/healthz', '/nope-worker-path']) {
      const res = await SELF.fetch(`${base}${path}`, upgrade);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('x-frame-options'), path).toBe('SAMEORIGIN');
      await res.body?.cancel();
    }
    const asset = await SELF.fetch(`${base}${env.TEST_WEB_ENTRY}`, upgrade);
    expectHeaders(asset, assetHeaders, `${env.TEST_WEB_ENTRY} with Upgrade`);
    await asset.body?.cancel();
  });
});
