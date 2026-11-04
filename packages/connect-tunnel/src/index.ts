// @portal/connect-tunnel (PILOT-1169): the Connect tunnel's multiplexer, its streams and the stream-open lines (docs/prd/targets-connect.md
// §9), shared by the portal (apps/server), the agent bundle (apps/server/src/connect/agent) and the Cloudflare Worker (apps/core-worker).
// Node built-ins and the contract only: workerd runs it under `nodejs_compat` (docs/prd/cf-bridge.md, "G6 finding").
// `memory.ts` (an in-memory socket pair) is test support: import it by its subpath, `@portal/connect-tunnel/memory`.
export * from './errors.js';
export * from './frame.js';
export * from './lines.js';
export * from './mux.js';
export * from './open.js';
