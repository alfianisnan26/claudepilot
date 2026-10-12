// CI: the portal UI's routes (`/api/ci`, CI_API). A person is signed in, so every call is the person's. No auth middleware
// here: app.ts mounts this under a guarded group, as it does every /api route.

import { AppError, success } from '@isnanme/core';
import {
  CI_STATUSES,
  type ConnectCiRepoRequest,
  type CreateCiRepoRequest,
  type MergeCiRequest,
  type StartCiRunRequest,
  type UpdateCiRepoRequest,
  type ValidateCiRequest,
  type CiStatus,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { CiService } from './service.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

const int = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) ? n : undefined;
};

export function createCiRoutes(ci: CiService): Hono {
  const app = new Hono();
  const id = (c: Context) => c.req.param('id') ?? '';

  app.get('/runs', async (c) => {
    const q = c.req.query();
    const status = q.status
      ? q.status.split(',').map((s) => {
          if (!(CI_STATUSES as readonly string[]).includes(s)) throw new AppError('VALIDATION_FAILED', `Unknown status “${s.slice(0, 20)}”.`, { details: { status: `Use: ${CI_STATUSES.join(', ')}.` } });
          return s as CiStatus;
        })
      : undefined;
    return c.json(success(await ci.runs({ workspace: q.workspace || undefined, repo: q.repo || undefined, pipeline: q.pipeline || undefined, branch: q.branch || undefined, status, ticket: q.ticket || undefined, session: q.session || undefined, before: q.before || undefined, limit: int(q.limit) })));
  });
  app.post('/runs', async (c) => c.json(success(await ci.startRun(await body<StartCiRunRequest>(c))), 201));
  app.get('/runs/:id', async (c) => c.json(success(await ci.show(id(c)))));
  app.get('/runs/:id/log', async (c) => c.json(success(await ci.log(id(c), c.req.query('job'), c.req.query('step'), c.req.query('offset')))));
  app.post('/runs/:id/cancel', async (c) => c.json(success(await ci.cancel(id(c)))));
  app.post('/runs/:id/rerun', async (c) => c.json(success(await ci.rerun(id(c))), 201));

  app.get('/repos', async (c) => c.json(success(await ci.repos(c.req.query('workspace') || undefined))));
  app.post('/repos', async (c) => c.json(success(await ci.createRepo(await body<CreateCiRepoRequest>(c))), 201));
  app.patch('/repos/:id', async (c) => c.json(success(await ci.updateRepo(id(c), await body<UpdateCiRepoRequest>(c)))));
  app.delete('/repos/:id', async (c) => {
    await ci.deleteRepo(id(c));
    return c.json(success({ ok: true }));
  });
  app.post('/repos/:id/connect', async (c) => c.json(success(await ci.connectRepo(id(c), await body<ConnectCiRepoRequest>(c)))));
  app.get('/repos/:id/branches', async (c) => c.json(success(await ci.branches(id(c)))));
  app.get('/repos/:id/pipelines', async (c) => c.json(success(await ci.pipelines(id(c), c.req.query('ref') || undefined))));
  app.post('/repos/:id/merge', async (c) => c.json(success(await ci.merge(id(c), await body<MergeCiRequest>(c)))));

  app.post('/validate', async (c) => c.json(success(ci.validate(await body<ValidateCiRequest>(c)))));

  return app;
}
