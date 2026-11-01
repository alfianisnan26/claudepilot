// Skills (organizations slice 1, P4): every route under /api/skills, enforced centrally (authz/routeGuard.ts). The library is the
// platform's reviewed one (`library`): importing, reviewing, revoking and removing a source are an admin's; reading a version is open to
// whoever may use the library; a workspace's skills follow the workspace.

import type { RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const library = (verb: Verb): RoutePolicy => ({ kind: 'platform', area: 'library', verb });
const version = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'skill_version', verb, from: 'path', param: 'id' }] });
const ws = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'workspace', verb, from: 'path', param: 'target+name' }] });

export const SKILL_POLICIES: RoutePolicies = {
  'GET /api/skills/library': { kind: 'signed-in', filter: 'skill_source' },
  'POST /api/skills/import': library('manage'),
  'GET /api/skills/versions/:id': version('view'),
  'GET /api/skills/versions/:id/file': version('view'),
  'POST /api/skills/versions/:id/review': library('manage'),
  'POST /api/skills/versions/:id/revoke': library('manage'),
  'DELETE /api/skills/sources/:id': library('manage'),
  'GET /api/skills/workspaces/:target/:name': ws('view'),
  'POST /api/skills/workspaces/:target/:name/verify': ws('operate'),
};

export function declareSkillPolicies(): void {
  declarePolicies('skills', SKILL_POLICIES);
}
