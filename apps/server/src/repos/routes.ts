// Workspace git: the HTTP routes (docs/prd/workspace-git.md §14). No auth middleware here: app.ts mounts them under the session guard
// (`requireSession`), with the Origin check every mutating request already has. A person in the portal is the actor `ui`.

import { AppError, success } from '@isnanme/core';
import type { CreateRepoWorktreeRequest, RepoEventQuery, ScanReposRequest, SetRepoSyncRequest, UpdateRepoSettingsRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { workspaceGuard } from '../workspaces/authz.js';
import { declareWorkspaceReposPolicies } from './authz.js';
import type { ReposService } from './service.js';
import { REPO_ID } from './text.js';

const ACTOR = 'ui';

async function body<T>(c: Context, optional = false): Promise<Partial<T>> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (optional) return {};
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
  return v as Partial<T>;
}

function repoParam(c: Context): string {
  const id = c.req.param('id') ?? '';
  if (!REPO_ID.test(id)) throw new AppError('NOT_FOUND', 'No such repository.');
  return id;
}

/** `/api/repos`: every workspace's summary, the audit, and one repository (its scan, worktrees and sync). */
export function createReposRoutes(repos: ReposService): Hono {
  const r = new Hono();

  r.get('/', async (c) => c.json(success(await repos.overview())));

  // The audit and the timeline: GET /api/repos/events?workspaceId=&repoId=&kind=a,b&group=audit&before=&limit=
  r.get('/events', (c) => {
    const q: RepoEventQuery = {
      workspaceId: c.req.query('workspaceId') || undefined,
      repoId: c.req.query('repoId') || undefined,
      kind: c.req.query('kind') || undefined,
      group: c.req.query('group') === 'audit' ? 'audit' : undefined,
      before: c.req.query('before') || undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    };
    if (q.limit !== undefined && !Number.isFinite(q.limit)) throw new AppError('VALIDATION_FAILED', 'Check the limit.', { details: { limit: 'Expected a number.' } });
    return c.json(success(repos.events(q)));
  });

  r.get('/:id', (c) => c.json(success(repos.detail(repoParam(c)))));

  // Read it again, and what hangs off it. Answers with the repository as it is when the scan ends (or after a short wait).
  r.post('/:id/scan', async (c) => {
    const id = repoParam(c);
    const ws = repos.workspaceOf(id);
    await repos.requestScan(ws, ACTOR, id);
    return c.json(success(repos.detail(id).repo));
  });

  r.post('/:id/worktrees', async (c) => c.json(success(await repos.createWorktree(repoParam(c), await body<CreateRepoWorktreeRequest>(c, true), ACTOR)), 201));

  r.delete('/:id/worktree', async (c) => {
    const mode = c.req.query('mode') ?? 'safe';
    if (mode !== 'safe' && mode !== 'force') throw new AppError('VALIDATION_FAILED', 'Use mode safe or force.', { details: { mode: 'safe or force.' } });
    return c.json(success(await repos.removeWorktree(repoParam(c), mode, ACTOR)));
  });

  r.put('/:id/sync', async (c) => {
    const b = await body<SetRepoSyncRequest>(c);
    return c.json(success(repos.setSync(repoParam(c), b.enabled as boolean, ACTOR)));
  });
  r.post('/:id/sync', async (c) => c.json(success(await repos.syncNow(repoParam(c), ACTOR))));

  return r;
}

/** `/api/workspaces/:target/:name/repos…`: a workspace's tree, a scan, and its settings. Mounted in the workspaces group (its name guard applies). */
export function createWorkspaceReposRoutes(repos: ReposService): Hono {
  declareWorkspaceReposPolicies();
  const r = new Hono();
  const wid = (c: Context) => `${c.req.param('target')}/${c.req.param('name')}`;
  // T-531: the seam first, with the verb declared in ./authz.ts; a workspace the caller may not see is the same 404 as a missing one.
  const toView = workspaceGuard('view');
  const toOperate = workspaceGuard('operate');
  const toManage = workspaceGuard('manage');

  r.get('/:target/:name/repos', toView, async (c) => c.json(success(await repos.workspace(wid(c)))));

  r.post('/:target/:name/repos/scan', toOperate, async (c) => {
    const b = await body<ScanReposRequest>(c, true);
    if (b.repoId !== undefined && (typeof b.repoId !== 'string' || !REPO_ID.test(b.repoId))) throw new AppError('VALIDATION_FAILED', 'Check the repository.', { details: { repoId: 'Not a repository id.' } });
    return c.json(success(await repos.requestScan(wid(c), ACTOR, b.repoId)));
  });

  r.get('/:target/:name/repos/settings', toView, (c) => c.json(success(repos.settings(wid(c)))));
  r.put('/:target/:name/repos/settings', toManage, async (c) => c.json(success(repos.updateSettings(wid(c), await body<UpdateRepoSettingsRequest>(c), ACTOR))));

  return r;
}
