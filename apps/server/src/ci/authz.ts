// CI and the authorization seam (apps/server/src/authz/seam.ts): resolvers for `ci_run` and `ci_repo`, and the declaration of every route and
// tool. A run and a remote live in a workspace and hold its level (OBJECT_TYPES: inherit 'same'): view to read, operate to start, cancel, rerun
// or merge, manage to change a remote or an environment's protection and to APPROVE a deployment (PRD FR41). Approving and protection are a
// person's acts: the routes also refuse any actor that is not a signed-in user, and no Portal MCP tool reaches them, so an agent never approves.

import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, workspaceRef, type CiRepo, type RoutePolicies, type UserId } from '@portal/contracts';
import { declarePolicies, declareToolPolicies, registerResolver } from '../authz/seam.js';
import { branchProblem } from '../chat/worktrees.js';
import type { CiSession } from './sessions.js';

/** What the resolvers need: the workspace a run or a remote belongs to (null when there is none), and who owns a workspace. */
export interface CiAuthzFacts {
  workspaceOfRun(id: string): string | null;
  workspaceOfRepo(id: string): string | null;
}

/**
 * Registers the two resolvers. `ownerOf` answers who owns a workspace; until workspaces record an owner it is the founding user, and tests pass
 * two fake users (`u_a`, `u_b`) to prove a run or remote of one is the same 404 as a missing one to the other.
 */
export function registerCiAuthz(facts: CiAuthzFacts, ownerOf: (workspaceId: string) => UserId = () => FOUNDING_USER_ID): void {
  for (const type of ['ci_run', 'ci_repo'] as const) {
    registerResolver({
      type,
      resolve(id) {
        const ws = type === 'ci_run' ? facts.workspaceOfRun(id) : facts.workspaceOfRepo(id);
        return ws ? { ref: objectRef(type, id), owner: { kind: 'user', id: ownerOf(ws) }, parent: workspaceRef(ws), attrs: { workspaceId: ws } } : null;
      },
    });
  }
}

/** T-348: the tools' one answer for a run that is missing, not the agent's or refused (the dispatch's check and the handler's say the same). */
export const NO_RUN = 'No such run.';

/** ci_run_trigger's one answer for a remote that is missing, or (T-476) another program's remote a lead may not test on. */
export const noRemote = (repo: string, workspaceId: string): AppError => new AppError('NOT_FOUND', `There is no remote ${repo} in ${workspaceId}.`);

/** T-476: a branch a lead may test on its program's remote: `dev/<name>` or `ticket/<name>`, exactly as given (no `refs/` or other prefix, no `..`). */
export const isProgramBranch = (ref: string): boolean => /^(?:dev|ticket)\/[A-Za-z0-9_]/.test(ref) && branchProblem(ref) === null;

/** T-476: a lead's program remote is one whose working folder (its source, or a repository connected to it) is exactly the lead's folder. */
export const isProgramRemote = (repo: Pick<CiRepo, 'sourcePath' | 'connected'>, cwd: string): boolean => repo.sourcePath === cwd || repo.connected.includes(cwd);

/**
 * What an agent may start with ci_run_trigger (PRD §14, FR41; T-476), decided in one place:
 * - `own_branch`: the branch its session works on (its worktree's, or a worker's folder branch at its start): any pipeline;
 * - `program_branch`: a lead (no parent, holds a crew) on a `dev/*` or `ticket/*` branch of its program's remote: any pipeline, on that BRANCH
 *   only (`refs/heads/...`, never a tag of the same name);
 * - `deployment`: anything else: only a pipeline that deploys to an environment, whose deploying job the portal holds for a person (today's rule,
 *   unchanged). A lead asking it on another program's remote is refused exactly like a remote that does not exist.
 */
export type AgentStart = { rule: 'own_branch' | 'program_branch'; ref: string } | { rule: 'deployment'; ref: string; refusal: AppError };

/**
 * T-476: is `branch` the session's own, on this remote? A worktree branch (flag set by the session adapter) is its own anywhere; a folder
 * branch only on the folder's own remote and only as dev/* or ticket/*. A missing flag or a missing remote counts as no (fail closed).
 */
export function ownsBranchOn(me: CiSession | null | undefined, repo: Pick<CiRepo, 'sourcePath' | 'connected'> | undefined, branch: string | null): boolean {
  if (!me?.branch || !branch || branch !== me.branch) return false;
  if (me.branchFromWorktree) return true;
  return !!repo && !!me.cwd && isProgramRemote(repo, me.cwd) && isProgramBranch(branch);
}

/** T-476: a lead (no parent, holds a crew) on a remote of its own program: it may READ every run there, whoever started it (never cancel or start). */
export const leadReadsRemote = (me: CiSession | null | undefined, repo: Pick<CiRepo, 'sourcePath' | 'connected'> | undefined): boolean =>
  !!me?.lead && !!me.cwd && !!repo && isProgramRemote(repo, me.cwd);

export function agentStart(me: CiSession | null, repo: Pick<CiRepo, 'name' | 'workspaceId' | 'sourcePath' | 'connected'>, ref: string): AgentStart {
  const branch = ref.replace(/^refs\/heads\//, '');
  if (me?.branch && branch === me.branch) {
    if (me.branchFromWorktree) return { rule: 'own_branch', ref };
    // Fail closed: unless the adapter marked the branch as its own worktree's, it is a worker's folder branch (possibly the lead's): only on that folder's own remote, and only dev/* or ticket/*.
    if (!me.cwd || !isProgramRemote(repo, me.cwd)) return { rule: 'deployment', ref, refusal: noRemote(repo.name, repo.workspaceId) };
    if (isProgramBranch(branch)) return { rule: 'own_branch', ref };
  }
  if (me?.lead && me.cwd) {
    if (!isProgramRemote(repo, me.cwd)) return { rule: 'deployment', ref, refusal: noRemote(repo.name, repo.workspaceId) };
    if (isProgramBranch(ref)) return { rule: 'program_branch', ref: `refs/heads/${ref}` };
  }
  const own = me?.branch ? ` (${me.branch})` : ', and this session has no worktree branch';
  return { rule: 'deployment', ref, refusal: new AppError('FORBIDDEN', `An agent can start a run only on the branch its own session works on${own}, or a pipeline that deploys to an environment.`) };
}

const run = (verb:'view' | 'operate' | 'manage') => ({ kind: 'objects' as const, checks: [{ type: 'ci_run' as const, verb, from: 'path' as const, param: 'id' }] });
const repo = (verb: 'view' | 'operate' | 'manage') => ({ kind: 'objects' as const, checks: [{ type: 'ci_repo' as const, verb, from: 'path' as const, param: 'id' }] });

/** The route table, exported for the tests that walk it. */
export const CI_POLICIES = {
  'GET /api/ci/runs': { kind: 'signed-in', filter: 'ci_run' },
  'POST /api/ci/runs': { kind: 'objects', checks: [{ type: 'ci_repo', verb: 'operate', from: 'body', param: 'repoId' }], creates: 'ci_run' },
  'GET /api/ci/runs/:id': run('view'),
  'GET /api/ci/runs/:id/log': run('view'),
  'POST /api/ci/runs/:id/cancel': run('operate'),
  'POST /api/ci/runs/:id/rerun': run('operate'),
  // Bump (FR37a): the picker lists only sessions the person may operate; the bump needs operate on the run AND on the session.
  'GET /api/ci/runs/:id/bump': { ...run('operate'), filter: 'session' },
  'POST /api/ci/runs/:id/bump': { kind: 'objects', checks: [{ type: 'ci_run', verb: 'operate', from: 'path', param: 'id' }, { type: 'session', verb: 'operate', from: 'body', param: 'sessionId' }], audit: 'ci.run_bumped' },
  // A person only (the handler refuses tokens, agents and jobs); recorded in the platform audit.
  'POST /api/ci/runs/:id/approve': { ...run('manage'), audit: 'ci.deploy_approved' },
  'POST /api/ci/runs/:id/reject': { ...run('manage'), audit: 'ci.deploy_rejected' },
  'GET /api/ci/repos': { kind: 'signed-in', filter: 'ci_repo' },
  'POST /api/ci/repos': { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', from: 'body', param: 'workspaceId' }], creates: 'ci_repo' },
  // Its `upstream` (FR8a, T-486) is a person's setting only: the handler refuses tokens and agents; the service audits it.
  'PATCH /api/ci/repos/:id': repo('manage'),
  // Sync now (FR8a): what the loop does every 30 s; audited by the service when a branch moved.
  'POST /api/ci/repos/:id/sync': repo('operate'),
  'DELETE /api/ci/repos/:id': repo('manage'),
  'POST /api/ci/repos/:id/connect': repo('operate'),
  'GET /api/ci/repos/:id/branches': repo('view'),
  'GET /api/ci/repos/:id/pipelines': repo('view'),
  'POST /api/ci/repos/:id/merge': repo('operate'),
  'GET /api/ci/repos/:id/environments': repo('view'),
  'PUT /api/ci/repos/:id/environments/:name': { ...repo('manage'), audit: 'ci.environment_protection' },
  // The auto-approve rule (T-110, FR41a): a person with manage only (the handler refuses tokens and agents); no tool reaches it.
  'PUT /api/ci/repos/:id/environments/:name/auto-approve': { ...repo('manage'), audit: 'ci.environment_auto_approve' },
  'POST /api/ci/validate': { kind: 'signed-in' },
} satisfies RoutePolicies;

export function declareCiPolicies(): void {
  declarePolicies('ci', CI_POLICIES);
  // The tools filter to the caller's own runs themselves (an agent: its branch, its ticket, its session's runs). None approves.
  declareToolPolicies('ci', {
    ci_runs_list: { kind: 'signed-in', filter: 'ci_run' },
    ci_run_get: { kind: 'objects', checks: [{ type: 'ci_run', verb: 'view', arg: 'id', notFound: NO_RUN }] },
    ci_run_logs: { kind: 'objects', checks: [{ type: 'ci_run', verb: 'view', arg: 'id', notFound: NO_RUN }] },
    ci_validate: { kind: 'signed-in' },
    ci_run_trigger: { kind: 'signed-in', creates: 'ci_run' },
    ci_run_cancel: { kind: 'objects', checks: [{ type: 'ci_run', verb: 'operate', arg: 'id', notFound: NO_RUN }] },
    ci_run_bump: {
      kind: 'objects',
      checks: [
        { type: 'ci_run', verb: 'operate', arg: 'id', notFound: NO_RUN },
        { type: 'session', verb: 'operate', arg: 'session_id', optional: true },
      ],
      confirm: true,
      audit: 'ci.run_bumped',
    },
  });
}
