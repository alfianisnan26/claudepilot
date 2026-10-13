// CI and the authorization seam (apps/server/src/authz/seam.ts): resolvers for `ci_run` and `ci_repo`, and the declaration of every route and
// tool. A run and a remote live in a workspace and hold its level (OBJECT_TYPES: inherit 'same'): view to read, operate to start, cancel, rerun
// or merge, manage to change a remote or an environment's protection and to APPROVE a deployment (PRD FR41). Approving and protection are a
// person's acts: the routes also refuse any actor that is not a signed-in user, and no Portal MCP tool reaches them, so an agent never approves.

import { FOUNDING_USER_ID, objectRef, workspaceRef, type RoutePolicies, type UserId } from '@portal/contracts';
import { declarePolicies, declareToolPolicies, registerResolver } from '../authz/seam.js';

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

const run = (verb: 'view' | 'operate' | 'manage') => ({ kind: 'objects' as const, checks: [{ type: 'ci_run' as const, verb, from: 'path' as const, param: 'id' }] });
const repo = (verb: 'view' | 'operate' | 'manage') => ({ kind: 'objects' as const, checks: [{ type: 'ci_repo' as const, verb, from: 'path' as const, param: 'id' }] });

/** The route table, exported for the tests that walk it. */
export const CI_POLICIES = {
  'GET /api/ci/runs': { kind: 'signed-in', filter: 'ci_run' },
  'POST /api/ci/runs': { kind: 'objects', checks: [{ type: 'ci_repo', verb: 'operate', from: 'body', param: 'repoId' }], creates: 'ci_run' },
  'GET /api/ci/runs/:id': run('view'),
  'GET /api/ci/runs/:id/log': run('view'),
  'POST /api/ci/runs/:id/cancel': run('operate'),
  'POST /api/ci/runs/:id/rerun': run('operate'),
  // A person only (the handler refuses tokens, agents and jobs); recorded in the platform audit.
  'POST /api/ci/runs/:id/approve': { ...run('manage'), audit: 'ci.deploy_approved' },
  'POST /api/ci/runs/:id/reject': { ...run('manage'), audit: 'ci.deploy_rejected' },
  'GET /api/ci/repos': { kind: 'signed-in', filter: 'ci_repo' },
  'POST /api/ci/repos': { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', from: 'body', param: 'workspaceId' }], creates: 'ci_repo' },
  'PATCH /api/ci/repos/:id': repo('manage'),
  'DELETE /api/ci/repos/:id': repo('manage'),
  'POST /api/ci/repos/:id/connect': repo('operate'),
  'GET /api/ci/repos/:id/branches': repo('view'),
  'GET /api/ci/repos/:id/pipelines': repo('view'),
  'POST /api/ci/repos/:id/merge': repo('operate'),
  'GET /api/ci/repos/:id/environments': repo('view'),
  'PUT /api/ci/repos/:id/environments/:name': { ...repo('manage'), audit: 'ci.environment_protection' },
  'POST /api/ci/validate': { kind: 'signed-in' },
} satisfies RoutePolicies;

export function declareCiPolicies(): void {
  declarePolicies('ci', CI_POLICIES);
  // The tools filter to the caller's own runs themselves (an agent: its branch, its ticket, its session's runs). None approves.
  declareToolPolicies('ci', {
    ci_runs_list: { kind: 'signed-in', filter: 'ci_run' },
    ci_run_get: { kind: 'objects', checks: [{ type: 'ci_run', verb: 'view', arg: 'id' }] },
    ci_run_logs: { kind: 'objects', checks: [{ type: 'ci_run', verb: 'view', arg: 'id' }] },
    ci_validate: { kind: 'signed-in' },
    ci_run_trigger: { kind: 'signed-in', creates: 'ci_run' },
    ci_run_cancel: { kind: 'objects', checks: [{ type: 'ci_run', verb: 'operate', arg: 'id' }] },
  });
}
