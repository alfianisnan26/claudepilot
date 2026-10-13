// Workspaces: who may do what (docs/prd/authorization.md). Only the routes T-42 added are declared here so far: reading one workspace by
// either form of its id, and renaming it (its label only: `operate` on the workspace, audited). The `ref` is a stable id (`ws_…`); the real layer resolves it through the manager's one resolver
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
};

/** `workspace_rename` is an admin token's tool (its scope); the seam is asked for `operate` on the workspace the id resolves to. */
export const WORKSPACE_TOOL_POLICIES: ToolPolicies = {
  workspace_rename: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id' }] },
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspacePolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('workspaces', WORKSPACE_POLICIES);
  declareToolPolicies('workspaces', WORKSPACE_TOOL_POLICIES);
}
