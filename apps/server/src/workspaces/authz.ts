// Workspaces: who may do what (docs/prd/authorization.md). EVERY route of the workspaces router (`/api/workspaces…`, app.ts) is declared here
// (T-531); the routes other modules mount on that router are declared in their own `authz.ts` (pools, secrets, browser, repos, claudeversion).
// The `ref` is a stable id (`ws_…`); the real layer resolves it through the manager's one resolver (`Workspaces.resolve`) to the workspace's
// `<target>/<name>` BEFORE it decides, as the handler does today with the single-owner seam.
//
// Enforced today, not only declared: each `…/:target/:name…` route runs `workspaceGuard(verb)` (below) with the verb declared here before its
// handler, so a workspace the actor may not see is the same 404 as one that does not exist (T-531). A test walks the app's route table and
// fails on a route under `/api/workspaces` with no declaration, and on a guard that asks another verb than the declared one.
// There is no resolver of the `workspace` type yet, so nothing behaves differently: the seam answers the one owner, and an agent only its own.

import { workspaceRef, type ObjectCheck, type RoutePolicies, type ToolPolicies, type Verb } from '@portal/contracts';
import { createMiddleware } from 'hono/factory';
import { actorOf, declarePolicies, declareToolPolicies, requireCan } from '../authz/seam.js';

const on = (verb: Verb, param: string, audit?: string): { kind: 'objects'; checks: ObjectCheck[]; audit?: string } => ({
  kind: 'objects',
  checks: [{ type: 'workspace', verb, from: 'path', param }],
  ...(audit ? { audit } : {}),
});
/** A route on one workspace written `/:target/:name…`: `verb` on it. Other modules that mount routes on the workspaces router declare with it. */
export const onWorkspacePath = (verb: Verb, audit?: string) => on(verb, 'target+name', audit);
const tn = onWorkspacePath;

const WS = '/api/workspaces/:target/:name';

export const WORKSPACE_POLICIES: RoutePolicies = {
  // Lists: the handler keeps the rows the actor may view (`visible`).
  'GET /api/workspaces': { kind: 'signed-in', filter: 'workspace' },
  'GET /api/workspaces/usage': { kind: 'signed-in', filter: 'workspace' },
  'GET /api/workspaces/targets': { kind: 'signed-in', filter: 'target' },
  'GET /api/workspaces/labels': { kind: 'signed-in', filter: 'workspace' },
  // Creating one needs `operate` on the target it runs on (the manager asks the seam).
  'POST /api/workspaces': { kind: 'objects', checks: [{ type: 'target', verb: 'operate', from: 'body', param: 'target' }], creates: 'workspace' },
  'GET /api/workspaces/:ref': on('view', 'ref'),
  [`GET ${WS}`]: tn('view'),
  'PATCH /api/workspaces/:ref': on('operate', 'ref', 'workspace.rename'),
  [`PATCH ${WS}`]: tn('operate', 'workspace.rename'),
  // T-98: CPU and memory of a Kubernetes workspace. Reading them is `view`; a change is `operate` (and never an agent's: the manager refuses
  // it, since a restart ends the agent's own session), audited.
  'GET /api/workspaces/:ref/resources': on('view', 'ref'),
  [`GET ${WS}/resources`]: tn('view'),
  'PATCH /api/workspaces/:ref/resources': on('operate', 'ref', 'workspace.resources'),
  [`PATCH ${WS}/resources`]: tn('operate', 'workspace.resources'),
  // T-531: the runtime. Start, stop and adopt run it (`operate`); removing deletes the workspace and its home volume (`manage`, the strongest
  // verb). Each writes its audit row on success. The preflight is a read.
  [`GET ${WS}/preflight`]: tn('view'),
  [`POST ${WS}/adopt`]: tn('operate', 'workspace.adopt'),
  [`POST ${WS}/start`]: tn('operate', 'workspace.start'),
  [`POST ${WS}/stop`]: tn('operate', 'workspace.stop'),
  [`DELETE ${WS}`]: tn('manage', 'workspace.remove'),
  // Which account pool's keys it runs on: a credential choice, so `manage`.
  [`PUT ${WS}/account`]: tn('manage'),
  // Claude Code's own sign-in in the workspace: reading the state is `view`; signing in or out changes whose account the workspace runs on (`manage`).
  [`GET ${WS}/claude-login`]: tn('view'),
  [`POST ${WS}/claude-login`]: tn('manage'),
  [`POST ${WS}/claude-login/code`]: tn('manage'),
  [`DELETE ${WS}/claude-login`]: tn('manage'),
  [`POST ${WS}/claude-logout`]: tn('manage'),
  // Terminals: using the workspace.
  [`GET ${WS}/terminals`]: tn('view'),
  [`POST ${WS}/terminals`]: tn('operate'),
  [`DELETE ${WS}/terminals/:term`]: tn('operate'),
  // The workspace's Claudes: a label is `operate`; removing one (its login with it) is `manage`.
  [`GET ${WS}/claudes`]: tn('view'),
  [`PATCH ${WS}/claudes/:claude`]: tn('operate'),
  [`DELETE ${WS}/claudes/:claude`]: tn('manage'),
};

/** `workspace_rename` is an admin token's tool (its scope); the seam is asked for `operate` on the workspace the id resolves to. */
export const WORKSPACE_TOOL_POLICIES: ToolPolicies = {
  workspace_rename: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id' }] },
  /** `workspace_resources` (T-98): an admin token's tool, `operate` on the workspace; a change is audited as `workspace.resources`. */
  workspace_resources: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id' }], confirm: true, audit: 'workspace.resources' },
};

/**
 * T-531: the seam, asked before a `…/:target/:name…` handler runs: `verb` on the workspace `<target>/<name>`, for the request's actor. A
 * workspace the actor may not see is `404 Not found.` (the same as a missing one), one it sees without the verb is the seam's 403, and a
 * caller that is not signed in is 401. Any module that mounts a route on the workspaces router uses this, with the verb it declared.
 * `alias`: for a route whose handler follows a label alias (`/docker/front` for `docker/api`, T-42), the same resolution, so the seam is
 * asked about the workspace the handler will act on; without it the path's `<target>/<name>` is the workspace (what the handler uses).
 */
export const workspaceGuard = (verb: Verb, alias?: (id: string) => string | null | undefined) =>
  createMiddleware(async (c, next) => {
    const given = `${c.req.param('target') ?? ''}/${c.req.param('name') ?? ''}`;
    const resolved = alias?.(given);
    requireCan(actorOf(c), verb, workspaceRef(typeof resolved === 'string' && resolved ? resolved : given));
    await next();
  });

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspacePolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('workspaces', WORKSPACE_POLICIES);
  declareToolPolicies('workspaces', WORKSPACE_TOOL_POLICIES);
}
