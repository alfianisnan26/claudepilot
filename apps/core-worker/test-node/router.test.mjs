// PILOT-1148: the asset router in front of the Worker, run by wrangler (workerd) the way `wrangler dev` runs it, with wrangler.jsonc's
// assets settings and a small web build made by the deploy's own step (scripts/webAssets.mjs): which path is the SPA's and which the
// Worker's (run_worker_first, navigation or not), and the headers on each. vitest's SELF calls the Worker directly, past the router,
// so this part is checked here. It starts a workerd: run it in the cluster, `npm run test:router -w @portal/core-worker`.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { cspDirectives, prepareAssets, secureHeadersOf } from '../scripts/webAssets.mjs';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the asset router in front of cp-next-core (wrangler dev)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cp-core-router-'));
  const entry = `/assets/index-${randomBytes(4).toString('hex')}.js`;
  const indexHtml = `<!doctype html><html><head><script>document.documentElement.dataset.theme='dark'</script></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
  let worker;
  let base;
  let shell;

  before(async () => {
    mkdirSync(join(tmp, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'index.html'), indexHtml);
    writeFileSync(join(tmp, 'dist', entry), 'console.log("app");');
    writeFileSync(join(tmp, 'dist', 'sw.js'), 'self.addEventListener("fetch", () => {});');
    await prepareAssets(join(tmp, 'dist'), join(tmp, 'public'));
    shell = await secureHeadersOf({ strictTransportSecurity: false, contentSecurityPolicy: cspDirectives(indexHtml) });
    // wrangler.jsonc as it is, with the Worker's source and the assets directory pointed at by absolute path.
    const src = readFileSync(join(WORKER_DIR, 'wrangler.jsonc'), 'utf8');
    const config = src
      .replace('"main": "src/index.ts"', `"main": ${JSON.stringify(join(WORKER_DIR, 'src/index.ts'))}`)
      .replace('"directory": "./public"', `"directory": ${JSON.stringify(join(tmp, 'public'))}`);
    assert.notEqual(config.indexOf(join(tmp, 'public')), -1, 'the assets directory was replaced');
    assert.notEqual(config.indexOf(join(WORKER_DIR, 'src/index.ts')), -1, 'main was replaced');
    writeFileSync(join(tmp, 'wrangler.jsonc'), config);
    worker = await unstable_startWorker({
      config: join(tmp, 'wrangler.jsonc'),
      dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false },
    });
    await worker.ready;
    base = `http://${(await worker.url).host}`;
  });

  after(async () => {
    await worker?.dispose();
  });

  const navigate = { headers: { 'Sec-Fetch-Mode': 'navigate' } };

  test('/ and client-side routes are the shell, navigation or not, with the secure headers, the CSP and no-cache', async () => {
    for (const path of ['/', '/admin/sessions', '/admin/sessions/abc?new=1', '/settings/pools/x']) {
      for (const init of [navigate, {}]) {
        const res = await fetch(`${base}${path}`, init);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get('content-type') ?? '', /^text\/html/, path);
        assert.match(await res.text(), /<div id="root"><\/div>/, path);
        for (const [k, v] of Object.entries(shell)) assert.equal(res.headers.get(k), v, `${path}: ${k}`);
        assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self' 'sha256-/, path);
        assert.equal(res.headers.get('cache-control'), 'no-cache', path);
        assert.equal(res.headers.get('strict-transport-security'), null, path);
      }
    }
  });

  test('sw.js is served at the root with no-cache', async () => {
    const res = await fetch(`${base}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    await res.body?.cancel();
  });

  test('a hashed file is immutable without a CSP; a missing one is a 404 no-store, never the shell', async () => {
    const hit = await fetch(`${base}${entry}`);
    assert.equal(hit.status, 200);
    assert.equal(await hit.text(), 'console.log("app");');
    assert.equal(hit.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(hit.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(hit.headers.get('content-security-policy'), null);
    for (const init of [navigate, {}]) {
      const miss = await fetch(`${base}/assets/index-gone0000.js`, init);
      assert.equal(miss.status, 404);
      assert.equal(miss.headers.get('cache-control'), 'no-store');
      assert.equal(await miss.text(), 'Not found');
    }
  });

  test('/api/*, /mcp, /bridge, /connect/* reach the Worker, never the SPA, even as a navigation; /healthz too', async () => {
    for (const path of ['/api/x', '/api/workspaces/a/b', '/mcp', '/mcp/x', '/bridge', '/connect/enroll']) {
      for (const init of [navigate, {}]) {
        const res = await fetch(`${base}${path}`, init);
        assert.equal(res.status, 404, path);
        assert.match(res.headers.get('content-type') ?? '', /^application\/json/, path);
        assert.match(await res.text(), /"NOT_FOUND"/, path);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      }
    }
    const health = await fetch(`${base}/healthz`, navigate);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'cp-next-core');
  });
});
