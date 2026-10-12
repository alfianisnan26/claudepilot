// Secrets & env's admin routes, mounted on `/api/secrets` behind the session guard: rotate a secret, the tracker,
// a secret's versions and revoking one (FR16 to FR18). Values are write-only: only `rotate` takes one, and nothing
// here ever returns one.

import { success } from '@isnanme/core';
import type { SecretRevokeRequest, SecretRotateRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { SecretRotations } from './rotation.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  const value: unknown = await c.req.json().catch(() => null);
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
}

export function createSecretsAdminRoutes(rotations: () => SecretRotations): Hono {
  const app = new Hono();
  app.post('/:poolId/entries/:entryId/rotate', async (c) => c.json(success(rotations().rotate(c.req.param('poolId') ?? '', c.req.param('entryId') ?? '', await body<SecretRotateRequest>(c))), 201));
  app.get('/:poolId/rotations', (c) => c.json(success(rotations().list(c.req.param('poolId') ?? ''))));
  app.get('/:poolId/entries/:entryId/versions', (c) => c.json(success(rotations().versions(c.req.param('poolId') ?? '', c.req.param('entryId') ?? ''))));
  app.post('/:poolId/values/:valueId/revoke', async (c) => c.json(success(rotations().revoke(c.req.param('poolId') ?? '', c.req.param('valueId') ?? '', (await body<SecretRevokeRequest>(c)).reason))));
  return app;
}
