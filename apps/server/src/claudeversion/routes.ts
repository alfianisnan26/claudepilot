// Claude Code version pinning: the HTTP routes (docs/prd/claude-version-pinning.md §10, CLAUDE_VERSION_API). No auth middleware here: app.ts mounts
// these under guarded groups (`requireSession`, the Origin check on mutating calls) like every other module. Each handler reads who is asking once
// (`actorOf`) and asks the seam before it acts: platform-level things need `manage` on the platform area `version`, a workspace's upgrade and rollback
// need `manage` on that workspace.

import { AppError, success } from '@isnanme/core';
import { isExactClaudeVersion, platformRef, workspaceRef, type ClaudeApplyRequest, type ClaudeBuildRequest, type ClaudeCanaryRequest, type ClaudeDefaultRequest, type ClaudeImagePruneRequest, type ClaudeRollbackRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, requireCan } from '../authz/seam.js';
import type { ClaudeVersions } from './service.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

const area = platformRef('version');
const text = (v: unknown, field: string, max = 80): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new AppError('VALIDATION_FAILED', `${field} must be short text.`, { details: { [field]: `Up to ${max} characters.` } });
  return v;
};

/** `/api/claude-version`: the platform's view, the canary, the images and the default pin. */
export function createClaudeVersionRoutes(svc: ClaudeVersions): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'view', area);
    return c.json(success(await svc.overview(actor)));
  });
  r.get('/features', (c) => (requireCan(actorOf(c), 'view', area), c.json(success(svc.features()))));
  r.get('/checks', (c) => (requireCan(actorOf(c), 'view', area), c.json(success(svc.checks()))));
  r.get('/warnings', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'view', area);
    return c.json(success(await svc.warnings(actor)));
  });
  // Every workspace's version: only the workspaces the asker may view (the service filters).
  r.get('/workspaces', async (c) => c.json(success(await svc.infos(actorOf(c)))));
  r.get('/candidate', async (c) => (requireCan(actorOf(c), 'view', area), c.json(success(await svc.candidate(false)))));
  r.post('/candidate', async (c) => (requireCan(actorOf(c), 'manage', area), c.json(success(await svc.candidate(true)))));

  r.get('/canary', (c) => {
    requireCan(actorOf(c), 'view', area);
    const limit = Number(c.req.query('limit'));
    return c.json(success(svc.runs(Number.isFinite(limit) && limit > 0 ? limit : 30)));
  });
  r.get('/canary/:id', (c) => {
    requireCan(actorOf(c), 'view', area);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) throw new AppError('NOT_FOUND', 'No such canary run.');
    return c.json(success(svc.run(id)));
  });
  r.post('/canary', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', area);
    const req = await body<ClaudeCanaryRequest>(c);
    const subject = req.subject;
    if (subject !== 'installed' && subject !== 'candidate' && subject !== 'target') throw new AppError('VALIDATION_FAILED', 'Pick installed, candidate or target.', { details: { subject: 'installed, candidate or target.' } });
    if (subject === 'target' && !isExactClaudeVersion(req.version)) throw new AppError('VALIDATION_FAILED', 'Use an exact version such as 2.1.296.', { details: { version: 'An exact x.y.z.' } });
    const run = await svc.startCanary({ subject, version: req.version, target: text(req.target, 'target') }, { trigger: 'manual', actor });
    return c.json(success(run), 202);
  });

  r.get('/images', async (c) => (requireCan(actorOf(c), 'view', area), c.json(success(await svc.images(text(c.req.query('target'), 'target'))))));
  r.post('/images', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', area);
    const req = await body<ClaudeBuildRequest>(c);
    if (!isExactClaudeVersion(req.version)) throw new AppError('VALIDATION_FAILED', 'Use an exact version such as 2.1.296.', { details: { version: 'An exact x.y.z.' } });
    return c.json(success(await svc.buildImage(req.version, actor, text(req.target, 'target'))), 202);
  });
  r.post('/images/prune', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', area);
    const req = await body<ClaudeImagePruneRequest>(c);
    const refs = Array.isArray(req.refs) ? req.refs.filter((x): x is string => typeof x === 'string' && x.length < 200).slice(0, 50) : undefined;
    return c.json(success(await svc.prune({ refs, dryRun: req.dryRun === true, target: text(req.target, 'target') }, actor)));
  });
  r.put('/default', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', area);
    const req = await body<ClaudeDefaultRequest>(c);
    return c.json(success(await svc.setDefault(String(req.version ?? ''), actor)));
  });
  return r;
}

/** `/api/workspaces/<target>/<name>/claude-version…`: one workspace's version, plan, apply, rollback and history. Mounted on the workspaces' router. */
export function createWorkspaceClaudeVersionRoutes(svc: ClaudeVersions): Hono {
  const r = new Hono();
  const idOf = (c: Context) => `${c.req.param('target')}/${c.req.param('name')}`;
  const BASE = '/:target/:name/claude-version';

  r.get(BASE, async (c) => {
    const id = idOf(c);
    requireCan(actorOf(c), 'view', workspaceRef(id));
    return c.json(success({ info: await svc.info(id), history: svc.history(id) }));
  });
  r.get(`${BASE}/history`, (c) => {
    const id = idOf(c);
    requireCan(actorOf(c), 'view', workspaceRef(id));
    return c.json(success(svc.history(id)));
  });
  r.get(`${BASE}/plan`, async (c) => {
    const actor = actorOf(c);
    const id = idOf(c);
    requireCan(actor, 'view', workspaceRef(id));
    return c.json(success(await svc.plan(id, c.req.query('version') ?? '', actor)));
  });
  r.post(`${BASE}/apply`, async (c) => {
    const actor = actorOf(c);
    const id = idOf(c);
    requireCan(actor, 'manage', workspaceRef(id));
    const req = await body<ClaudeApplyRequest>(c);
    const accept = Array.isArray(req.acceptFailed) ? req.acceptFailed.filter((x): x is string => typeof x === 'string' && x.length < 60).slice(0, 30) : undefined;
    const run = typeof req.canaryRunId === 'number' && Number.isInteger(req.canaryRunId) ? req.canaryRunId : null;
    return c.json(success(await svc.apply(id, { version: String(req.version ?? ''), canaryRunId: run, acceptFailed: accept, confirm: req.confirm === true }, actor)), 202);
  });
  r.post(`${BASE}/rollback`, async (c) => {
    const actor = actorOf(c);
    const id = idOf(c);
    requireCan(actor, 'manage', workspaceRef(id));
    const req = await body<ClaudeRollbackRequest>(c);
    return c.json(success(await svc.rollback(id, { confirm: req.confirm === true }, actor)), 202);
  });
  return r;
}
