// UI reporter: the vendored SDK and axe-core (scripts/vendor-reporter.sh) are what /reporter/v1 serves, and the embed route serves the web's
// built panel page (apps/web/embed.html -> dist/embed.html) with frame-ancestors = exactly the allowed origin.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { embedCsp, embedHtml, sdkVersion, vendorFile } from './pages.js';
import { STG, reporterHarness } from './testkit.js';

const dirs = [new URL('./vendor/', import.meta.url).pathname];

test('vendor: the real SDK build is vendored with "<version>+<short commit>", and axe-core is pinned', () => {
  assert.match(sdkVersion(dirs), /^\d+\.\d+\.\d+(?:-[\w.]+)?\+[0-9a-f]{7}$/);
  const sdk = vendorFile('reporter.js', dirs)!.bytes.toString('utf8');
  assert.ok(!sdk.includes('PLACEHOLDER'), 'not the placeholder');
  assert.ok(sdk.includes('PilotReporter'), 'defines window.PilotReporter');
  assert.ok(vendorFile('axe.min.js', dirs)!.bytes.length > 100_000, 'axe-core is vendored');
});

test('vendor: reporter.js and axe.js are served as scripts with a short cache', async () => {
  const h = await reporterHarness();
  try {
    for (const p of ['/reporter/v1/reporter.js', '/reporter/v1/axe.js']) {
      const r = await h.call(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    }
  } finally {
    h.done();
  }
});

test('embed: the built panel page is served, its inline scripts hashed, framed only by the requested origin', () => {
  const dist = mkdtempSync(join(tmpdir(), 'reporter-embed-'));
  try {
    assert.match(embedHtml(dist), /not built on this portal yet/, 'placeholder until the web app is built');
    const page = '<!doctype html><html><head><script>window.x=1</script><script type="module" src="/assets/embed-abc.js"></script></head><body><div id="root"></div></body></html>';
    writeFileSync(join(dist, 'embed.html'), page);
    assert.equal(embedHtml(dist), page);
    const csp = embedCsp(page, STG);
    assert.match(csp, /frame-ancestors https:\/\/stg\.konfersi\.com(;|$)/);
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /connect-src 'self'/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
