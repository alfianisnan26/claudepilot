// Multi-assignment pools: the pool pages' routes (`/api/pools/*`) and a workspace's pools
// (`/api/workspaces/:target/:name/pools*`). No auth middleware here: the owner mounts both under
// guarded groups, as it does every other /api route.

import { AppError, success } from '@isnanme/core';
import type {
  AssignPoolRequest,
  DuplicatePoolRequest,
  PoolPreviewRequest,
  PoolRequest,
  PoolRolloutRequest,
  SetWorkspacePoolsRequest,
  WorkspacePools,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { Reconciler } from '../delivery/reconciler.js';
import { deliveryState } from '../workspaces/view.js';
import type { MultiPoolType } from './kinds.js';
import type { PoolService } from './service.js';

export interface PoolRoutesDeps {
  service: PoolService;
  /** For each workspace's delivery status. */
  reconciler: Reconciler;
}

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** For requests whose body is optional: none, or not JSON, means no fields. */
async function optionalBody<T>(c: Context): Promise<Partial<T>> {
  const value: unknown = await c.req.json().catch(() => null);
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
}

/** `/api/pools`: pools of each registered type, their revisions, rollouts, bulk assignment and previews. */
export function createPoolRoutes({ service }: Pick<PoolRoutesDeps, 'service'>): Hono {
  const app = new Hono();
  /** The URL's type, which must be registered (any other is a 404). */
  const type = (c: Context): MultiPoolType => {
    const t = c.req.param('type') ?? '';
    service.kind(t);
    return t as MultiPoolType;
  };
  /** The URL's pool, which must be of the URL's type. */
  const pool = (c: Context): string => {
    const t = type(c);
    const id = c.req.param('id') ?? '';
    if (service.typeOf(id) !== t) throw new AppError('NOT_FOUND', 'That pool no longer exists.');
    return id;
  };
  const revision = (c: Context): number => {
    const n = Number(c.req.param('rev'));
    if (!Number.isInteger(n) || n < 1) throw new AppError('BAD_REQUEST', 'Revisions are numbered from 1.');
    return n;
  };

  app.get('/', (c) => c.json(success({ types: service.types() })));
  app.get('/:type', (c) => c.json(success(service.list(type(c)))));
  app.post('/:type', async (c) => c.json(success(service.create(type(c), await body<PoolRequest>(c))), 201));
  // "Preview files" for a pool not saved yet.
  app.post('/:type/preview', async (c) => c.json(success(service.preview(type(c), null, await optionalBody<PoolPreviewRequest>(c)))));
  app.get('/:type/:id', (c) => c.json(success(service.get(pool(c)))));
  app.put('/:type/:id', async (c) => c.json(success(service.update(pool(c), await body<PoolRequest>(c)))));
  app.delete('/:type/:id', (c) => {
    service.delete(pool(c));
    return c.json(success({ ok: true }));
  });
  app.post('/:type/:id/duplicate', async (c) => {
    const id = pool(c);
    const { name } = await body<DuplicatePoolRequest>(c);
    return c.json(success(service.duplicate(id, name)), 201);
  });
  app.post('/:type/:id/revisions/:rev/approve', (c) => c.json(success(service.approve(pool(c), revision(c)))));
  app.post('/:type/:id/revisions/:rev/current', (c) => c.json(success(service.makeCurrent(pool(c), revision(c)))));
  app.post('/:type/:id/rollout', async (c) => {
    const id = pool(c);
    const req = await body<PoolRolloutRequest>(c);
    if (typeof req.paused !== 'boolean') throw new AppError('VALIDATION_FAILED', '`paused` must be true or false.');
    return c.json(success(req.paused ? service.pauseRollout(id, req.reason) : service.resumeRollout(id)));
  });
  app.post('/:type/:id/assign', async (c) => {
    const id = pool(c);
    const { workspaceIds } = await body<AssignPoolRequest>(c);
    return c.json(success(service.assignToMany(id, workspaceIds)));
  });
  app.post('/:type/:id/preview', async (c) => {
    const id = pool(c);
    return c.json(success(service.preview(type(c), id, await optionalBody<PoolPreviewRequest>(c))));
  });
  return app;
}

/** Mounted on `/api/workspaces`: a workspace's pools of every registered type, and changing one type's list. */
export function createWorkspacePoolRoutes({ service, reconciler }: PoolRoutesDeps): Hono {
  const app = new Hono();
  const workspaceId = (c: Context) => `${c.req.param('target')}/${c.req.param('name')}`;

  app.get('/:target/:name/pools', (c) => {
    const id = workspaceId(c);
    const all = service.assignmentsFor(id);
    const delivery = deliveryState(reconciler, id);
    const view: WorkspacePools = {
      workspaceId: id,
      types: service.types().map((type) => ({ type, assignments: all.filter((a) => a.type === type) })),
      delivery: delivery && { ...delivery, checkedAt: reconciler.row(id)?.checked_at ?? null },
    };
    return c.json(success(view));
  });
  app.put('/:target/:name/pools/:type', async (c) => {
    const type = c.req.param('type');
    service.kind(type);
    const { items } = await body<SetWorkspacePoolsRequest>(c);
    return c.json(success(service.setAssignments(workspaceId(c), type, items)));
  });
  return app;
}
