import { AppError, codeForStatus, isAppError } from '@isnanme/core';
import { CONNECT_PROTOCOL, type ApiErrorBody } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bridgeUpgrade } from './bridge/route.js';
import type { Env } from './env.js';

export interface Healthz {
  ok: true;
  service: 'cp-next-core';
  version: string;
  commit: string;
  /** The Connect protocol the /bridge endpoint will speak (from packages/contracts: proves it bundles for Workers). */
  connectProtocol: number;
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  // The portal's secure headers (apps/server/src/app.ts): no HSTS, and the hashed files under /assets may be loaded cross-origin.
  // The CSP is on what the asset router serves (the shell, from public/_headers, scripts/webAssets.mjs): it governs documents,
  // and nothing the Worker answers is one.
  const appHeaders = secureHeaders({ strictTransportSecurity: false });
  const assetHeaders = secureHeaders({ strictTransportSecurity: false, crossOriginResourcePolicy: 'cross-origin' });
  // A WebSocket upgrade on /bridge is answered by a Durable Object: its 101 is not a page and its headers cannot be changed. Only
  // /bridge skips the headers; an `Upgrade` header anywhere else changes nothing (review of PILOT-1148).
  const bridgeUpgradeReq = (c: Context) => c.req.path === '/bridge' && c.req.header('upgrade')?.toLowerCase() === 'websocket';
  app.use((c, next) => (bridgeUpgradeReq(c) ? next() : c.req.path.startsWith('/assets/') ? assetHeaders(c, next) : appHeaders(c, next)));
  // What the API says is for this session only (the portal's rule): never kept by a shared cache.
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // The hashed build files (PILOT-1148; run_worker_first sends /assets/* here). With the SPA fallback the asset router answers a
  // missing file with the shell (200, text/html); a hashed file is never HTML, so that is the portal's 404: a tab left open across a
  // deploy asks for chunks that are gone, and the shell kept for a year under a script's name would be worse than the miss.
  app.on(['GET', 'HEAD'], '/assets/*', async (c) => {
    const r = await c.env.ASSETS.fetch(c.req.raw);
    if (r.status >= 400 || (r.headers.get('content-type') ?? '').startsWith('text/html')) {
      return c.text('Not found', 404, { 'Cache-Control': 'no-store' });
    }
    const res = new Response(r.body, r);
    res.headers.delete('Content-Security-Policy');
    // Only a file that exists is immutable (a 304 keeps what the browser has).
    if (res.status === 200) res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res;
  });

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'cp-next-core',
      version: c.env.CP_VERSION,
      commit: c.env.CP_COMMIT,
      connectProtocol: CONNECT_PROTOCOL,
    } satisfies Healthz),
  );

  // The cluster bridge's dial-out link (PILOT-1144): checked before the upgrade, then handed to the cluster's BridgeDO.
  app.get('/bridge', (c) => bridgeUpgrade(c.req.raw, c.env));

  // The same bodies as the portal (apps/server/src/app.ts): an unknown path that reaches the Worker (run_worker_first in
  // wrangler.jsonc; every other path is the SPA's) is the authz seam's plain 404.
  app.notFound((c) => c.json(new AppError('NOT_FOUND', 'Not found.').toJSON() satisfies ApiErrorBody, 404));
  app.onError((e, c) => {
    const error = isAppError(e)
      ? e
      : e instanceof HTTPException
        ? new AppError(codeForStatus(e.status), undefined, { status: e.status, cause: e })
        : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    if (error.status >= 500) console.error(e);
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });

  return app;
}
