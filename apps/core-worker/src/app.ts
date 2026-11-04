import { AppError, codeForStatus, isAppError } from '@isnanme/core';
import { CONNECT_PROTOCOL, type ApiErrorBody } from '@portal/contracts';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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

  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'cp-next-core', version: c.env.CP_VERSION, commit: c.env.CP_COMMIT, connectProtocol: CONNECT_PROTOCOL } satisfies Healthz),
  );

  // The same bodies as the portal (apps/server/src/app.ts): an unknown path is the authz seam's plain 404.
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
