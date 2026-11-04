import type { Env as CoreEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    // `env` of cloudflare:test is the Worker's own bindings.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends CoreEnv {}
  }
  // Vite's import.meta.glob (the source guard reads the Worker's files through it, inside workerd).
  interface ImportMeta {
    glob<T = unknown>(pattern: string | string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, T>;
  }
}

export {};
