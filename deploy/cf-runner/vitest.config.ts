import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        // The pool's bundled workerd (1.20260815) is older than wrangler.test.jsonc's compatibility_date.
        compatibilityDate: '2026-08-15',
        bindings: { JOBRUN_KEYS: JSON.stringify({ kohilabs: 'a'.repeat(64) }) } },
    }),
  ],
});
