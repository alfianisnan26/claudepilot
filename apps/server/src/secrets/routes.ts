// Secrets & env's workspace routes, mounted on `/api/workspaces` (behind the session guard, like every
// other /api route): what a workspace's sets deliver, by name only, and the migration check (FR15). Sets
// themselves use the shared pool routes (`/api/pools/secrets`).

import { AppError, success } from '@isnanme/core';
import type { SecretsMigrationCheck, WorkspaceSecrets } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { PoolService } from '../pools/service.js';
import type { Runtime } from '../workspaces/runtime.js';
import { SecretsKind } from './kind.js';
import { checkHomeCredentials } from './preflight.js';

export interface SecretsRoutesDeps {
  pools: Pick<PoolService, 'kind'>;
  workspaces: { runtimeFor(target: string): Runtime | undefined };
}

export function createSecretsRoutes({ pools, workspaces }: SecretsRoutesDeps): Hono {
  const app = new Hono();
  /** The registered secrets kind; a portal without it has no such routes (404). */
  const kind = (): SecretsKind => {
    const k = pools.kind('secrets');
    if (!(k instanceof SecretsKind)) throw new AppError('NOT_FOUND', 'No such pool type.');
    return k;
  };
  const workspaceId = (c: Context) => `${c.req.param('target')}/${c.req.param('name')}`;

  app.get('/:target/:name/secrets', (c) => c.json(success<WorkspaceSecrets>(kind().workspaceView(workspaceId(c)))));
  // An exec as the workspace user that reports names only; POST, since it runs something in the workspace.
  app.post('/:target/:name/secrets/check', async (c) => {
    kind();
    const access = workspaces.runtimeFor(c.req.param('target') ?? '')?.delivery;
    const findings = access ? await checkHomeCredentials(access, c.req.param('name') ?? '') : null;
    return c.json(success<SecretsMigrationCheck>({ findings, checkedAt: new Date().toISOString() }));
  });
  return app;
}
