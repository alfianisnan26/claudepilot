// CI: the portal UI's routes (`/api/ci`, CI_API). A person is signed in, so every call is the person's. No auth middleware
// here: app.ts mounts this under a guarded group, as it does every /api route. Each handler asks the authorization seam about the run or
// remote it names (ci/authz.ts declares the table); approving a deployment and its environment's protection are a person's acts only.

import { AppError, success } from '@isnanme/core';
import {
  actorString,
  actorUserId,
  CI_STATUSES,
  objectRef,
  workspaceRef,
  type Actor,
  type CiApprovalRequest,
  type UpdateCiEnvironmentRequest,
  type ConnectCiRepoRequest,
  type CreateCiRepoRequest,
  type MergeCiRequest,
  type StartCiRunRequest,
  type UpdateCiRepoRequest,
  type ValidateCiRequest,
  type CiStatus,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, requireCan, visible } from '../authz/seam.js';
import { declareCiPolicies, registerCiAuthz } from './authz.js';
import type { CiDecider, CiService } from './service.js';

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

/** A person deciding: never a Portal MCP token, an agent's session or a job, whatever their scope. */
function person(actor: Actor): CiDecider {
  if (actor.kind !== 'user') throw new AppError('FORBIDDEN', 'Only a person signed in to the portal can do this.');
  return { actor: actorString(actor), userId: actorUserId(actor) };
}

export function createCiRoutes(ci: CiService): Hono {
  registerCiAuthz(ci);
  declareCiPolicies();
  const app = new Hono();
  const id = (c: Context) => c.req.param('id') ?? '';
  const runRef = (c: Context) => objectRef('ci_run', id(c));
  const repoRef = (c: Context) => objectRef('ci_repo', id(c));
  /** The actor, after the check on the run or remote the path names. */
  const may = (c: Context, verb: 'view' | 'operate' | 'manage', ref: (c: Context) => ReturnType<typeof objectRef>): Actor => {
    const actor = actorOf(c);
    requireCan(actor, verb, ref(c));
    return actor;
  };

  app.get('/runs', async (c) => {
    const q = c.req.query();
    const status = q.status
      ? q.status.split(',').map((s) => {
          if (!(CI_STATUSES as readonly string[]).includes(s)) throw new AppError('VALIDATION_FAILED', `Unknown status “${s.slice(0, 20)}”.`, { details: { status: `Use: ${CI_STATUSES.join(', ')}.` } });
          return s as CiStatus;
        })
      : undefined;
    const actor = actorOf(c);
    const list = await ci.runs({ workspace: q.workspace || undefined, repo: q.repo || undefined, pipeline: q.pipeline || undefined, branch: q.branch || undefined, status, ticket: q.ticket || undefined, session: q.session || undefined, before: q.before || undefined, limit: int(q.limit) });
    const items = visible(actor, 'ci_run', list.items, (r) => r.id);
    return c.json(success(items.length === list.items.length ? list : { ...list, items, total: items.length, active: items.filter((r) => r.status === 'queued' || r.status === 'running').length }));
  });
  app.post('/runs', async (c) => {
    const req = await body<StartCiRunRequest>(c);
    if (typeof req.repoId === 'string') requireCan(actorOf(c), 'operate', objectRef('ci_repo', req.repoId));
    return c.json(success(await ci.startRun(req)), 201);
  });
  app.get('/runs/:id', async (c) => (may(c, 'view', runRef), c.json(success(await ci.show(id(c))))));
  app.get('/runs/:id/log', async (c) => (may(c, 'view', runRef), c.json(success(await ci.log(id(c), c.req.query('job'), c.req.query('step'), c.req.query('offset'))))));
  app.post('/runs/:id/cancel', async (c) => (may(c, 'operate', runRef), c.json(success(await ci.cancel(id(c))))));
  app.post('/runs/:id/rerun', async (c) => (may(c, 'operate', runRef), c.json(success(await ci.rerun(id(c))), 201)));
  // A deployment's approval (PRD FR41): a person with manage on the run, never a token or an agent. There is no tool for it.
  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/runs/:id/${decision}`, async (c) => {
      const by = person(may(c, 'manage', runRef));
      const req = await body<CiApprovalRequest>(c);
      return c.json(success(await ci.decide(id(c), req.job, decision, by)));
    });
  }

  app.get('/repos', async (c) => {
    const repos = await ci.repos(c.req.query('workspace') || undefined);
    return c.json(success(visible(actorOf(c), 'ci_repo', repos, (r) => r.id)));
  });
  app.post('/repos', async (c) => {
    const req = await body<CreateCiRepoRequest>(c);
    if (typeof req.workspaceId === 'string') requireCan(actorOf(c), 'operate', workspaceRef(req.workspaceId));
    return c.json(success(await ci.createRepo(req)), 201);
  });
  app.patch('/repos/:id', async (c) => (may(c, 'manage', repoRef), c.json(success(await ci.updateRepo(id(c), await body<UpdateCiRepoRequest>(c))))));
  app.delete('/repos/:id', async (c) => {
    may(c, 'manage', repoRef);
    await ci.deleteRepo(id(c));
    return c.json(success({ ok: true }));
  });
  app.post('/repos/:id/connect', async (c) => (may(c, 'operate', repoRef), c.json(success(await ci.connectRepo(id(c), await body<ConnectCiRepoRequest>(c))))));
  app.get('/repos/:id/branches', async (c) => (may(c, 'view', repoRef), c.json(success(await ci.branches(id(c))))));
  app.get('/repos/:id/pipelines', async (c) => (may(c, 'view', repoRef), c.json(success(await ci.pipelines(id(c), c.req.query('ref') || undefined)))));
  app.post('/repos/:id/merge', async (c) => (may(c, 'operate', repoRef), c.json(success(await ci.merge(id(c), await body<MergeCiRequest>(c))))));
  app.get('/repos/:id/environments', (c) => (may(c, 'view', repoRef), c.json(success(ci.environments(id(c))))));
  app.put('/repos/:id/environments/:name', async (c) => {
    const by = person(may(c, 'manage', repoRef));
    return c.json(success(ci.setEnvironment(id(c), c.req.param('name'), await body<UpdateCiEnvironmentRequest>(c), by)));
  });

  app.post('/validate', async (c) => c.json(success(ci.validate(await body<ValidateCiRequest>(c)))));

  return app;
}
