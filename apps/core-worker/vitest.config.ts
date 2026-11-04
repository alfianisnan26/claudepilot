import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The /bridge tests need a cluster registry (BRIDGE_CLUSTERS), a bridge key pair and a bearer token. They are made here, fresh on every run
// (no key or token-shaped literal in the repository), and reach the tests as extra bindings of the test Worker only.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const raw = spki.subarray(spki.length - 32).toString('base64url');
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
const token = randomBytes(32).toString('base64url');
const node = `nd_${randomBytes(6).toString('hex')}`;
const clusters = { 'test-cluster': { node, publicKey: raw, tokenSha256: createHash('sha256').update(token).digest('hex') } };

// The tests run inside workerd (Miniflare) with the bindings of wrangler.jsonc.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
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
