// Personas (organizations slice 1, P4): every route under /api/personas, enforced centrally (authz/routeGuard.ts). A persona is a set
// (`pools` of type 'persona', its owner from migration 410): reading its policy and revisions is `view`, changing its policy or avatar is
// `manage`. The portal's default persona is a setting (platform `settings`). A proposal is decided by whoever manages what it changes.

import type { RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const persona = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'pool', verb, from: 'path', param: 'id' }] });

export const PERSONA_POLICIES: RoutePolicies = {
  'GET /api/personas/workspaces/:target/:name': { kind: 'objects', checks: [{ type: 'workspace', verb: 'view', from: 'path', param: 'target+name' }] },
  'GET /api/personas/identities': { kind: 'signed-in' },
  'GET /api/personas/pools': { kind: 'signed-in' },
  'GET /api/personas/default': { kind: 'signed-in' },
  'PUT /api/personas/default': { kind: 'platform', area: 'settings', verb: 'manage' },
  'GET /api/personas/pools/:id/policy': persona('view'),
  'PUT /api/personas/pools/:id/policy': persona('manage'),
  'GET /api/personas/pools/:id/revisions': persona('view'),
  'GET /api/personas/pools/:id/revisions/:rev': persona('view'),
  'POST /api/personas/pools/:id/avatar': persona('manage'),
  'DELETE /api/personas/pools/:id/avatar': persona('manage'),
  // An avatar image by its content hash: what every persona card shows (no persona data).
  'GET /api/personas/avatars/:sha': { kind: 'signed-in' },
  'GET /api/personas/proposals': { kind: 'signed-in', filter: 'proposal' },
  'POST /api/personas/proposals/:id/:verb': { kind: 'objects', checks: [{ type: 'proposal', verb: 'manage', from: 'path', param: 'id' }] },
};

export function declarePersonaPolicies(): void {
  declarePolicies('personas', PERSONA_POLICIES);
}
