import { createApp } from '/workspaces/claudepilot/apps/server/src/app.ts';
import { Portal } from '/workspaces/claudepilot/apps/server/src/portal.ts';
import { Hono } from '/workspaces/claudepilot/node_modules/hono/dist/index.js';
const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => Hono;
const portal = new Portal('24681357', 60_000);
// browser.routes() must return a Hono app for ws.route('/', ...)
const browser = { routes: () => new Hono(), attach: () => {} };
const app = make(portal, stub, stub, stub, stub, stub, stub, stub, {
  serveWeb: false, poolService: stub, mcp: stub, skills: stub, personas: stub, settings: stub, secrets: stub, portalMcp: stub,
  tickets: stub, ci: stub, knowledge: stub, browser, claudeUsage: stub, usageSpend: stub, repos: stub, glance: stub,
});
const seen = new Set<string>();
const rows: string[] = [];
for (const r of app.routes) {
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  rows.push(key);
}
console.log(rows.length, 'registered (method path), incl. ALL middleware');
for (const r of rows) console.log(r);
