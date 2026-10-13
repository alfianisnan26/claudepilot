// Workspaces: who may do what (docs/prd/authorization.md). Only the routes T-42 and T-98 added are declared here so far: reading one workspace by
// either form of its id, renaming it, and its CPU and memory (T-98) (its label only: `operate` on the workspace, audited). The `ref` is a stable id (`ws_…`); the real layer resolves it through the manager's one resolver
// (`Workspaces.resolve`) to the workspace's `<target>/<name>` BEFORE it decides, as the handler does today with the single-owner seam.
// There is no resolver of the `workspace` type yet, so nothing behaves differently: the seam answers the one owner, and an agent only its own.

import type { ObjectCheck, RoutePolicies, ToolPolicies, Verb } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

const on = (verb: Verb, param: string, audit?: string): { kind: 'objects'; checks: ObjectCheck[]; audit?: string } => ({
  kind: 'objects',
  checks: [{ type: 'workspace', verb, from: 'path', param }],
  ...(audit ? { audit } : {}),
});

export const WORKSPACE_POLICIES: RoutePolicies = {
  'GET /api/workspaces/labels': { kind: 'signed-in', filter: 'workspace' },
  'GET /api/workspaces/:ref': on('view', 'ref'),
  'GET /api/workspaces/:target/:name': on('view', 'target+name'),
  'PATCH /api/workspaces/:ref': on('operate', 'ref', 'workspace.rename'),
  'PATCH /api/workspaces/:target/:name': on('operate', 'target+name', 'workspace.rename'),
  // T-98: CPU and memory of a Kubernetes workspace. Reading them is `view`; a change is `operate` (and never an agent's: the manager refuses
  // it, since a restart ends the agent's own session), audited.
  'GET /api/workspaces/:ref/resources': on('view', 'ref'),
  'GET /api/workspaces/:target/:name/resources': on('view', 'target+name'),
  'PATCH /api/workspaces/:ref/resources': on('operate', 'ref', 'workspace.resources'),
  'PATCH /api/workspaces/:target/:name/resources': on('operate', 'target+name', 'workspace.resources'),
};

/** `workspace_rename` is an admin token's tool (its scope); the seam is asked for `operate` on the workspace the id resolves to. */
export const WORKSPACE_TOOL_POLICIES: ToolPolicies = {
  workspace_rename: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id' }] },
  /** `workspace_resources` (T-98): an admin token's tool, `operate` on the workspace; a change is audited as `workspace.resources`. */
  workspace_resources: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id' }], confirm: true, audit: 'workspace.resources' },
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspacePolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('workspaces', WORKSPACE_POLICIES);
  declareToolPolicies('workspaces', WORKSPACE_TOOL_POLICIES);
}
