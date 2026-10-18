// Workspaces: who may do what (docs/prd/authorization.md). EVERY route of the workspaces router (`/api/workspaces…`, app.ts) is declared here
// (T-531); the routes other modules mount on that router are declared in their own `authz.ts` (pools, secrets, browser, repos, claudeversion).
// The `ref` is a stable id (`ws_…`); the real layer resolves it through the manager's one resolver (`Workspaces.resolve`) to the workspace's
// `<target>/<name>` BEFORE it decides, as the handler does today with the single-owner seam.
//
// Enforced today, not only declared: each `…/:target/:name…` route runs `workspaceGuard(verb)` (below) with the verb declared here before its
// handler (and `childGuard` for a second object), each `/:ref…` route `workspaceRefGuard`, and `POST /` `targetBodyGuard`, so a workspace the
// actor may not see is the same 404 as one that does not exist (T-531). `routeAuthz.test.ts` walks the app's route table: it fails on a route
// with no declaration, on a declaration that differs from the PRD's Appendix A row (unless §B.2 names the difference), and on a declared
// check that is not asked, in order, before the handler.
// There is no resolver of the `workspace` type yet, so nothing behaves differently: the seam answers the one owner, and an agent only its own.

import { AppError } from '@isnanme/core';
import { isStableWorkspaceId, objectRef, workspaceRef, type ObjectCheck, type RoutePolicies, type ToolPolicies, type Verb } from '@portal/contracts';
import { createMiddleware } from 'hono/factory';
import { actorOf, declarePolicies, declareToolPolicies, requireCan } from '../authz/seam.js';
import type { SocketPolicies } from '../authz/socketGuard.js';

const on = (verb: Verb, param: string, audit?: string): { kind: 'objects'; checks: ObjectCheck[]; audit?: string } => ({
  kind: 'objects',
  checks: [{ type: 'workspace', verb, from: 'path', param }],
  ...(audit ? { audit } : {}),
});
/** A route on one workspace written `/:target/:name…`: `verb` on it. Other modules that mount routes on the workspaces router declare with it. */
export const onWorkspacePath = (verb: Verb, audit?: string) => on(verb, 'target+name', audit);
const tn = onWorkspacePath;
const wsCheck = (verb: Verb): ObjectCheck => ({ type: 'workspace', verb, from: 'path', param: 'target+name' });
const claudeCheck = (verb: Verb): ObjectCheck => ({ type: 'claude', verb, from: 'path', param: 'claude' });

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
  // T-531: the runtime. Start and stop run it (`operate`: a start undoes a stop); the preflight runs a shell script in it (`operate`). Adopting
  // takes it over from another portal, overwrites its manifest and queues file removals (`manage`); removing deletes the workspace and its
  // home volume (`manage`). Each runtime action writes its audit row on success.
  [`GET ${WS}/preflight`]: tn('operate'),
  [`POST ${WS}/adopt`]: tn('manage', 'workspace.adopt'),
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
  // Terminals: a shell in the workspace, so even the list is `operate`. Closing one also needs `manage` on that terminal (`<target>/<name>/<term>`):
  // its creator or a manager of the workspace (the PRD). The workspace check stays first: it is the terminal's parent guard.
  [`GET ${WS}/terminals`]: tn('operate'),
  [`POST ${WS}/terminals`]: tn('operate'),
  [`DELETE ${WS}/terminals/:term`]: { kind: 'objects', checks: [wsCheck('operate'), { type: 'terminal', verb: 'manage', from: 'path', param: 'target+name+term' }] },
  // The workspace's Claudes: renaming one is `manage` on that Claude, with `operate` on the workspace (its parent guard). Removing one (its login
  // with it) is `manage` on the Claude and, stricter than the PRD's parent guard, `manage` on the workspace.
  [`GET ${WS}/claudes`]: tn('view'),
  [`PATCH ${WS}/claudes/:claude`]: { kind: 'objects', checks: [wsCheck('operate'), claudeCheck('manage')] },
  [`DELETE ${WS}/claudes/:claude`]: { kind: 'objects', checks: [wsCheck('manage'), claudeCheck('manage')] },
};

/** The terminal socket's path (shell.ts), as the socket guard matches it. */
export const SHELL_SOCKET_PATH = `${WS}/shell`;

/**
 * T-1043 S0b: the terminal socket. A shell in the workspace is `operate` on it (as listing and opening terminals are); `?term=` attaches to a
 * terminal that outlives the socket, so it is `operate` on that terminal (`<target>/<name>/<term>`) too. Its frames (keystrokes, output,
 * resize) act on that shell only.
 */
export const SHELL_SOCKET_POLICIES: SocketPolicies = {
  [SHELL_SOCKET_PATH]: {
    connect: { kind: 'objects', checks: [wsCheck('operate'), { type: 'terminal', verb: 'operate', from: 'path', param: 'target+name+term', optional: true }] },
    messages: {},
    frames: 'terminal bytes both ways and resize, on the shell the handshake opened',
  },
};

/** What a workspace tool answers for a workspace it can't find (tools/common.ts `resolveWorkspace`): a refusal reads the same (decision 10605). */
export const NO_WORKSPACE = 'No workspace “{arg}”. List them with workspace_list.';
const onTool = (verb: Verb, arg = 'id'): { kind: 'objects'; checks: [{ type: 'workspace'; verb: Verb; arg: string; notFound: string }] } => ({
  kind: 'objects',
  checks: [{ type: 'workspace', verb, arg, notFound: NO_WORKSPACE }],
});

/**
 * The workspace tools, as their routes (T-1043 S0c): the dispatch asks the seam about the form given, and the handler asks again about the
 * workspace it resolved, out of the ones the actor may view (tools/workspaces.ts), so a name or a label never reaches one it may not see.
 * `workspace_rename` and `workspace_resources` (T-98) are admin tokens' tools; a resources change is audited as `workspace.resources`.
 */
export const WORKSPACE_TOOL_POLICIES: ToolPolicies = {
  workspace_list: { kind: 'signed-in', filter: 'workspace' },
  workspace_get: onTool('view'),
  workspace_create: { kind: 'objects', checks: [{ type: 'target', verb: 'operate', arg: 'target' }], creates: 'workspace' },
  workspace_rename: onTool('operate'),
  workspace_resources: { ...onTool('operate'), confirm: true, audit: 'workspace.resources' },
  workspace_start: onTool('operate'),
  workspace_stop: onTool('operate'),
  workspace_sync: onTool('operate'),
  workspace_delete: onTool('manage'),
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

/**
 * T-531 S2: the second object of a route on one workspace, asked after `workspaceGuard` (its parent guard): `verb` on the Claude named by the
 * path's `:claude` (a Claude id is unique across workspaces), or on the terminal `<target>/<name>/<term>`. The seam has both types; with no
 * resolver for them yet, the single-owner seam answers the one owner and caps an agent at `operate` (so an agent cannot rename or close here).
 */
export const childGuard = (type: 'claude' | 'terminal', verb: Verb) =>
  createMiddleware(async (c, next) => {
    const p = (k: string) => c.req.param(k) ?? '';
    requireCan(actorOf(c), verb, objectRef(type, type === 'claude' ? p('claude') : `${p('target')}/${p('name')}/${p('term')}`));
    await next();
  });

/**
 * T-531 S2: a route written `/:ref…` asks the seam at the router, before its handler, about the workspace a stable id (`ws_…`) resolves to (its
 * `<target>/<name>`, as the manager's own check does). A `ref` that is not a stable id goes on untouched (the handler answers 404, or the
 * `/:target/:name` route takes it); a stable id the resolver does not know goes on to the manager, which lists once and answers 404.
 */
export const workspaceRefGuard = (verb: Verb, resolve: (ref: string) => string | null | undefined) =>
  createMiddleware(async (c, next) => {
    const ref = c.req.param('ref') ?? '';
    const known = isStableWorkspaceId(ref) ? resolve(ref) : null;
    if (known) requireCan(actorOf(c), verb, workspaceRef(known));
    await next();
  });

/**
 * T-531 S2: `POST /api/workspaces` asks the seam for `verb` on the target named in the body BEFORE its handler reads anything (the account
 * pools, the add-on sets), not only inside the manager. No target is the manager's own answer, given here. A body that is not JSON goes on to
 * the handler, which refuses it first thing.
 */
export const targetBodyGuard = (verb: Verb) =>
  createMiddleware(async (c, next) => {
    let req: unknown;
    try {
      req = await c.req.json();
    } catch {
      return next();
    }
    const target = req && typeof req === 'object' ? (req as { target?: unknown }).target : undefined;
    if (typeof target !== 'string' || !target) throw new AppError('VALIDATION_FAILED', 'Pick where it runs.', { details: { target: 'Pick a target.' } });
    requireCan(actorOf(c), verb, objectRef('target', target));
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
