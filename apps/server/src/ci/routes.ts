// CI: the portal UI's routes (`/api/ci`, CI_API). A person is signed in, so every call is the person's. No auth middleware
// here: app.ts mounts this under a guarded group, as it does every /api route. Each handler asks the authorization seam about the run or
// remote it names (ci/authz.ts declares the table); approving a deployment and its environment's protection are a person's acts only.

import { AppError, success } from '@isnanme/core';
import {
  actorString,
  actorUserId,
  CI_STATUSES,
  objectRef,
  sessionRef,
  workspaceRef,
  type Actor,
  type BumpRequest,
  type CiApprovalRequest,
  type CiBranchBackfillRequest,
  type CiReleaseReportSetting,
  type UpdateCiEnvironmentRequest,
  type UpdateCiAutoApproveRequest,
  type ConnectCiRepoRequest,
  type CreateCiRepoRequest,
  type MergeCiRequest,
  type StartCiRunRequest,
  type UpdateCiRepoRequest,
  type ValidateCiRequest,
  type UpsertCiRunnerRequest,
  type CiStatus,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, can, requireCan, seesEverything, visible } from '../authz/seam.js';
import { declareCiPolicies, registerCiAuthz, requireVaultWrite } from './authz.js';
import type { CiDecider, CiService } from './service.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

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
          if (!(CI_STATUSES as readonly string[]).includes(s))
            throw new AppError('VALIDATION_FAILED', `Unknown status “${s.slice(0, 20)}”.`, {
              details: { status: `Use: ${CI_STATUSES.join(', ')}.` },
            });
          return s as CiStatus;
        })
      : undefined;
    const actor = actorOf(c);
    // D-58: one page, `{ items, next }` (25 by default, 100 at most); every run is checked with `view` before it is shown, `next` points at the
    // last run shown, and the cursor is bound to the caller and every filter (a bad or foreign one is a 400). `total` and `active` ride on page 1.
    // A caller no policy can hide a run from (the founding user) gets no `keep`: the counts come from SQL. Anyone else is checked run by run, and
    // the counts of page 1 then come from a bounded scan (exact when the list fits in it, else null: unavailable).
    const check = (r: { id: string }) => visible(actor, 'ci_run', [r], (x) => x.id).length > 0;
    const keep = seesEverything(actor) ? undefined : check;
    return c.json(
      success(
        ci.listPage(
          {
            workspace: q.workspace || undefined,
            repo: q.repo || undefined,
            pipeline: q.pipeline || undefined,
            branch: q.branch || undefined,
            status,
            ticket: q.ticket || undefined,
            session: q.session || undefined,
          },
          { caller: actorString(actor), cursor: q.cursor || undefined, limit: q.limit, keep },
        ),
      ),
    );
  });
  app.post('/runs', async (c) => {
    const req = await body<StartCiRunRequest>(c);
    if (typeof req.repoId === 'string') requireCan(actorOf(c), 'operate', objectRef('ci_repo', req.repoId));
    return c.json(success(await ci.startRun(req)), 201);
  });
  app.get('/runs/:id', async (c) => (may(c, 'view', runRef), c.json(success(await ci.show(id(c))))));
  app.get(
    '/runs/:id/log',
    async (c) => (
      may(c, 'view', runRef),
      c.json(success(await ci.log(id(c), c.req.query('job'), c.req.query('step'), c.req.query('offset'))))
    ),
  );
  // The UI is a person (runs they start say `ui`; a cancel says the same, T-95).
  app.post('/runs/:id/cancel', async (c) => (may(c, 'operate', runRef), c.json(success(await ci.cancel(id(c), { actor: 'ui' })))));
  app.post('/runs/:id/rerun', async (c) => (may(c, 'operate', runRef), c.json(success(await ci.rerun(id(c))), 201)));
  // Bump (FR37a): operate on the run, and on the session it goes into; the picker lists only sessions the person may operate.
  app.get('/runs/:id/bump', (c) => {
    const actor = may(c, 'operate', runRef);
    return c.json(success(ci.bumpTargets(id(c)).filter((t) => can(actor, 'operate', sessionRef(t.id)).allow)));
  });
  app.post('/runs/:id/bump', async (c) => {
    const actor = may(c, 'operate', runRef);
    const req = await body<BumpRequest>(c);
    if (typeof req.sessionId === 'string' && req.sessionId.trim()) requireCan(actor, 'operate', sessionRef(req.sessionId.trim()));
    return c.json(success(await ci.bump(id(c), req, { actor: 'ui', label: null, userId: actorUserId(actor) })));
  });
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
  app.patch('/repos/:id', async (c) => {
    const actor = may(c, 'manage', repoRef);
    const req = await body<UpdateCiRepoRequest>(c);
    // The upstream (FR8a) a remote follows, and the secret NAME that reads it: a person's setting only (403 for tokens and agents), audited.
    return c.json(success(await ci.updateRepo(id(c), req, req.upstream !== undefined ? person(actor) : undefined)));
  });
  // Sync with the upstream now (FR8a; the Needs you item's action). Operate: it only does what the loop does every 30 s.
  app.post('/repos/:id/sync', async (c) => {
    const actor = may(c, 'operate', repoRef);
    return c.json(success(await ci.syncUpstream(id(c), { actor: actorString(actor), userId: actorUserId(actor) })));
  });
  // Runners (T-557). The id is the workspace's (`<target>/<name>`, encoded as one path segment).
  app.get('/runners', async (c) => {
    const actor = actorOf(c);
    const all = await ci.runners();
    return c.json(success(all.filter((r) => can(actor, 'view', workspaceRef(r.workspaceId)))));
  });
  app.put('/runners/:id', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', workspaceRef(id(c)));
    const req = await body<UpsertCiRunnerRequest>(c);
    return c.json(success(await ci.upsertRunner(id(c), req, person(actor))));
  });
  app.delete('/runners/:id', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', workspaceRef(id(c)));
    await ci.removeRunner(id(c), person(actor));
    return c.json(success({ ok: true }));
  });
  app.delete('/repos/:id', async (c) => {
    may(c, 'manage', repoRef);
    await ci.deleteRepo(id(c));
    return c.json(success({ ok: true }));
  });
  app.post(
    '/repos/:id/connect',
    async (c) => (may(c, 'operate', repoRef), c.json(success(await ci.connectRepo(id(c), await body<ConnectCiRepoRequest>(c))))),
  );
  app.get('/repos/:id/branches', async (c) => (may(c, 'view', repoRef), c.json(success(await ci.branches(id(c))))));
  app.get(
    '/repos/:id/pipelines',
    async (c) => (may(c, 'view', repoRef), c.json(success(await ci.pipelines(id(c), c.req.query('ref') || undefined)))),
  );
  app.post(
    '/repos/:id/merge',
    async (c) => (may(c, 'operate', repoRef), c.json(success(await ci.merge(id(c), await body<MergeCiRequest>(c))))),
  );
  app.get('/repos/:id/environments', (c) => (may(c, 'view', repoRef), c.json(success(ci.environments(id(c))))));
  app.put('/repos/:id/environments/:name', async (c) => {
    const by = person(may(c, 'manage', repoRef));
    return c.json(success(ci.setEnvironment(id(c), c.req.param('name'), await body<UpdateCiEnvironmentRequest>(c), by)));
  });
  // The auto-approve rule (FR41a): a person with manage, never a token or an agent (403 as for protection); audited by the service.
  app.put('/repos/:id/environments/:name/auto-approve', async (c) => {
    const by = person(may(c, 'manage', repoRef));
    return c.json(success(ci.setAutoApprove(id(c), c.req.param('name'), await body<UpdateCiAutoApproveRequest>(c), by)));
  });

  // Release reports (T-591): where a remote's passed releases are written (a vault and a folder). The setting is a person's only (403 for
  // tokens and agents); audited. The backfill takes a run id and nothing else: the vault and folder are always the remote's own setting.
  app.get('/repos/:id/release-report', (c) => (may(c, 'view', repoRef), c.json(success(ci.releaseReportSetting(id(c))))));
  app.put('/repos/:id/release-report', async (c) => {
    const actor = may(c, 'manage', repoRef);
    const by = person(actor);
    const req = await body<{ setting: CiReleaseReportSetting | null }>(c);
    if (req.setting !== null && (typeof req.setting !== 'object' || req.setting === undefined))
      throw new AppError('VALIDATION_FAILED', 'Send { "setting": { pipeline, vaultId, folder } } or { "setting": null }.');
    // The note is written as the portal later, so the person must be able to write that vault themselves (404 otherwise, as for one they cannot see).
    const vaultId = typeof req.setting?.vaultId === 'string' ? req.setting.vaultId.trim() : '';
    if (req.setting && vaultId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(vaultId))
      requireVaultWrite(actor, vaultId, (v) => ci.vaultExists(v));
    return c.json(success(ci.setReleaseReport(id(c), req.setting, by)));
  });
  // T-1079 S3: the notes of the branch's last heads. The body is the count only; the vault and folder are the setting's.
  app.post('/repos/:id/release-report/backfill', async (c) => {
    person(may(c, 'manage', repoRef));
    const req = await body<CiBranchBackfillRequest>(c);
    return c.json(success(await ci.backfillBranchReport(id(c), req.count)));
  });
  app.post('/runs/:id/release-report', async (c) => {
    person(may(c, 'manage', runRef));
    return c.json(success(await ci.reportRelease(id(c))));
  });

  app.post('/validate', async (c) => c.json(success(ci.validate(await body<ValidateCiRequest>(c)))));

  return app;
}
