import type { Env as CoreEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    // `env` of cloudflare:test is the Worker's own bindings, plus the test-only ones vitest.config.ts makes at run time.
    interface Env extends CoreEnv {
      TEST_BRIDGE_CLUSTER: string;
      TEST_BRIDGE_NODE: string;
      TEST_BRIDGE_PRIVATE_KEY: string;
      TEST_BRIDGE_TOKEN: string;
      /** The hashed entry script of the test web build (vitest.config.ts). */
      TEST_WEB_ENTRY: string;
      /** JSON: the headers the portal sends with its shell and with /assets files, from its own code (vitest.config.ts). */
      TEST_PORTAL_SHELL_HEADERS: string;
      TEST_PORTAL_ASSET_HEADERS: string;
    }
  }
  // Vite's import.meta.glob (the source guard reads the Worker's files through it, inside workerd).
  interface ImportMeta {
    glob<T = unknown>(pattern: string | string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, T>;
  }
}

export {};
