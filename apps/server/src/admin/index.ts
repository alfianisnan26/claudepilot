// The Admin console (docs/prd/organizations.md §6.11, slice 4): the host split (./host.ts), its own sessions (./sessions.ts), its routes and
// UI bundle (./routes.ts), declared in ./authz.ts. app.ts installs `adminHostMiddleware` as its FIRST middleware; index.ts refuses sockets on
// the admin host (`routeAdminHostUpgrades`).

import { AppError } from '@isnanme/core';
import type { MiddlewareHandler } from 'hono';
import type { AdminHostGate } from './host.js';

export { ADMIN_ROUTE_POLICIES, assertDeclared, declareAdminPolicies } from './authz.js';
export { AdminHostGate, isAdminPath, normalizeAdminHost, routeAdminHostUpgrades } from './host.js';
export { createAdminApp, type AdminConsoleDeps, type AdminEnv } from './routes.js';
export { AdminSessions } from './sessions.js';

/** The console's app as the middleware calls it (a Hono app). */
export interface ConsoleApp {
  fetch(req: Request, env?: unknown): Response | Promise<Response>;
}

/**
 * The first middleware of the main app: a request for the admin host goes to the console's own app (`console()`, built once the app's services
 * exist), and nothing of the main portal runs for it; the console's paths on any other host are the same 404 as an unknown /api route.
 */
export function adminHostMiddleware(gate: AdminHostGate, console: () => ConsoleApp | null): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.raw.headers;
    // The node server builds the URL from the Host header, so the URL's host stands in when a Request carries none (tests, fetch()).
    const headers = { get: (n: string) => (n === 'host' ? (h.get('host') ?? new URL(c.req.url).host) : h.get(n)) };
    const where = gate.classify(headers, c.req.path);
    if (where === 'admin') {
      const app = console();
      if (!app) throw new AppError('NOT_FOUND');
      return app.fetch(c.req.raw, c.env);
    }
    if (where === 'blocked') throw new AppError('NOT_FOUND');
    await next();
  };
}
