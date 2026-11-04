import type { Env as CoreEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    // `env` of cloudflare:test is the Worker's own bindings, plus the test-only ones vitest.config.ts makes at run time.
    interface Env extends CoreEnv {
      TEST_BRIDGE_CLUSTER: string;
      TEST_BRIDGE_NODE: string;
      TEST_BRIDGE_PRIVATE_KEY: string;
      TEST_BRIDGE_TOKEN: string;
    }
  }
  // Vite's import.meta.glob (the source guard reads the Worker's files through it, inside workerd).
  interface ImportMeta {
    glob<T = unknown>(pattern: string | string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, T>;
  }
}

export {};
