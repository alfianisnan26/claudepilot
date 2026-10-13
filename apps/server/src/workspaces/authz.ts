// Workspaces: who may do what (docs/prd/authorization.md). Only the routes T-42 added are declared here so far: reading one workspace by
// either form of its id. The `ref` is a stable id (`ws_…`); the real layer resolves it through the manager's one resolver
// (`Workspaces.resolve`) to the workspace's `<target>/<name>` BEFORE it decides, as the handler does today with the single-owner seam.
// There is no resolver of the `workspace` type yet, so nothing behaves differently: the seam answers the one owner, and an agent only its own.

import type { ObjectCheck, RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const view = (param: string): { kind: 'objects'; checks: ObjectCheck[] } => ({ kind: 'objects', checks: [{ type: 'workspace', verb: 'view', from: 'path', param }] });

export const WORKSPACE_POLICIES: RoutePolicies = {
  'GET /api/workspaces/:ref': view('ref'),
  'GET /api/workspaces/:target/:name': view('target+name'),
};

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareWorkspacePolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('workspaces', WORKSPACE_POLICIES);
}
