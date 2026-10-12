// Who may do what in Connect (docs/prd/authorization.md, the seam in ../authz/seam.ts). Targets are platform-owned: an admin manages them, and
// who may place a workspace on one is a right granted later (`operate` on the `target` object). Enrolled AND scanned targets are one object type
// to the rest of the portal (`Workspaces.create` asks `can(actor, 'operate', target)` for every target), so the resolver knows both. Nodes,
// enrollments and events have no object type of their own: they are reached through their target (and the `platform` area `targets`).
// The tunnel and the agents' credentials are not users: their routes are their own doors (a token, a signed challenge).

import { declarePolicies, registerResolver, type ResolvedObject } from '../authz/seam.js';
import { CONNECT_PUBLIC, type ObjectRef } from '@portal/contracts';
import type { Registry } from './registry.js';

export function registerConnectResolvers(deps: { registry: Registry; scannedIds(): string[] }): void {
  registerResolver({
    type: 'target',
    resolve(id): ResolvedObject | null {
      const ref: ObjectRef = { type: 'target', id };
      const enrolled = deps.registry.target(id);
      if (enrolled) return { ref, owner: { kind: 'platform' }, attrs: { source: 'enrolled', kind: enrolled.kind } };
      if (deps.scannedIds().includes(id)) return { ref, owner: { kind: 'platform' }, attrs: { source: 'scanned' } };
      return null;
    },
  });
}

const target = (verb: 'view' | 'operate' | 'manage') => ({ kind: 'objects' as const, checks: [{ type: 'target' as const, verb, from: 'path' as const, param: 'id' }] });

/** Every Connect route, declared (default deny once the layer lands). Keys are `METHOD /full/path` as the router lists them. */
export function declareConnectPolicies(): void {
  declarePolicies('connect', {
    'GET /api/connect/targets': { kind: 'signed-in', filter: 'target' },
    'POST /api/connect/targets': { kind: 'platform', area: 'targets', verb: 'manage', audit: 'connect.target.create' },
    'GET /api/connect/targets/:id': target('view'),
    'PATCH /api/connect/targets/:id': { ...target('manage'), audit: 'connect.target.update' },
    'DELETE /api/connect/targets/:id': { ...target('manage'), audit: 'connect.target.remove' },
    'POST /api/connect/targets/:id/check': target('view'),
    'GET /api/connect/targets/:id/enrollments': target('manage'),
    'POST /api/connect/targets/:id/enrollments': { ...target('manage'), audit: 'connect.enrollment.create' },
    'DELETE /api/connect/targets/:id/enrollments/:eid': { ...target('manage'), audit: 'connect.enrollment.revoke' },
    'GET /api/connect/targets/:id/enrollments/:eid/plan': target('manage'),
    'GET /api/connect/targets/:id/events': target('manage'),
    'PATCH /api/connect/nodes/:nid': { kind: 'platform', area: 'targets', verb: 'manage', audit: 'connect.node.update' },
    'DELETE /api/connect/nodes/:nid': { kind: 'platform', area: 'targets', verb: 'manage', audit: 'connect.node.revoke' },
    'POST /api/connect/nodes/:nid/rotate': { kind: 'platform', area: 'targets', verb: 'manage', audit: 'connect.node.rotate' },
    'PATCH /api/connect/scanned/:id': { kind: 'platform', area: 'targets', verb: 'manage' },
    'GET /api/connect/settings': { kind: 'platform', area: 'targets', verb: 'view' },
    'PUT /api/connect/settings': { kind: 'platform', area: 'targets', verb: 'manage', audit: 'connect.settings.update' },
    [`GET ${CONNECT_PUBLIC.health}`]: { kind: 'public', why: 'Liveness for `doctor` and the installer’s preflight: {ok, protocol, version}.' },
    [`POST ${CONNECT_PUBLIC.enroll}`]: { kind: 'bearer', why: 'An enrollment token (cpen_, 256 bits, hashed at rest, single use); the agent hands over its PUBLIC key.' },
    [`GET ${CONNECT_PUBLIC.enrollStatus}`]: { kind: 'bearer', why: 'The enrollment token, for 30 minutes after its last use, so the installer can wait for "connected".' },
    [`GET ${CONNECT_PUBLIC.tunnel}`]: { kind: 'handler', checks: ['A signed challenge: the agent proves its Ed25519 key (no cookie, no clock); one live connection per node.'] },
    'ALL /connect/*': { kind: 'public', why: 'Anything else under /connect/ answers 404.' },
  } as Parameters<typeof declarePolicies>[1]);
}
