import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { contentSecurityPolicy } from '../server/src/csp.js';
import { prepareAssets, secureHeadersOf } from './scripts/webAssets.mjs';

// The /bridge tests need a cluster registry (BRIDGE_CLUSTERS), a bridge key pair and a bearer token. They are made here, fresh on every run
// (no key or token-shaped literal in the repository), and reach the tests as extra bindings of the test Worker only.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const raw = spki.subarray(spki.length - 32).toString('base64url');
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
const token = randomBytes(32).toString('base64url');
const node = `nd_${randomBytes(6).toString('hex')}`;
const clusters = { 'test-cluster': { node, publicKey: raw, tokenSha256: createHash('sha256').update(token).digest('hex') } };

// The SPA (PILOT-1148): a small web build (an inline theme script like the real one, a hashed entry, the worker and the manifest),
// made into an assets directory by the deploy's own step (scripts/webAssets.mjs). The headers the portal sends today are computed
// here from its own code (apps/server/src/csp.ts and its hono secureHeaders options in app.ts), so test/assets.test.ts fails when
// the served headers drift from them.
const web = mkdtempSync(join(tmpdir(), 'cp-core-web-'));
const assetsDir = join(web, 'out');
const entry = `/assets/index-${randomBytes(4).toString('hex')}.js`;
mkdirSync(join(web, 'dist', 'assets'), { recursive: true });
writeFileSync(
  join(web, 'dist', 'index.html'),
  `<!doctype html><html><head><script>document.documentElement.dataset.theme='dark'</script><link rel="manifest" href="/manifest.webmanifest" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
);
writeFileSync(join(web, 'dist', entry), 'console.log("app");');
writeFileSync(join(web, 'dist', 'sw.js'), 'self.addEventListener("fetch", () => {});');
writeFileSync(join(web, 'dist', 'manifest.webmanifest'), JSON.stringify({ name: 'pilot', id: '/', start_url: '/', scope: '/' }));
await prepareAssets(join(web, 'dist'), assetsDir);
const portalShellHeaders = await secureHeadersOf({
  strictTransportSecurity: false,
  contentSecurityPolicy: contentSecurityPolicy(join(web, 'dist', 'index.html')),
});
const portalAssetHeaders = await secureHeadersOf({ strictTransportSecurity: false, crossOriginResourcePolicy: 'cross-origin' });

// The tests run inside workerd (Miniflare) with the bindings of wrangler.jsonc; the assets directory is the one made above.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        assets: { directory: assetsDir },
        bindings: {
          TEST_WEB_ENTRY: entry,
          TEST_PORTAL_SHELL_HEADERS: JSON.stringify(portalShellHeaders),
          TEST_PORTAL_ASSET_HEADERS: JSON.stringify(portalAssetHeaders),
          BRIDGE_CLUSTERS: JSON.stringify(clusters),
          TEST_BRIDGE_CLUSTER: 'test-cluster',
          TEST_BRIDGE_NODE: node,
          TEST_BRIDGE_PRIVATE_KEY: pkcs8,
          TEST_BRIDGE_TOKEN: token,
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
