// Organizations: the HTTP routes (docs/prd/organizations.md §10; ORGS_API in packages/contracts/src/orgs.ts; declared in ./authz.ts). No auth
// middleware here: app.ts mounts this under `requireSession` at /api/orgs. Who is asking comes from the seam (`actorOf`) once per request;
// the service decides every right (the org resolver through `can()`, the owner-only rules, the ability to create).

import { AppError, success } from '@isnanme/core';
import { Hono } from 'hono';
import type {
  AcceptOrgInvitationRequest,
  ChangeOrgMemberRoleRequest,
  CreateOrgInvitationRequest,
  CreateOrgRequest,
  MoveToOrgRequest,
  OrgId,
  OrgTransferKind,
  UpdateOrgRequest,
} from '@portal/contracts';
import { actorOf } from '../authz/seam.js';
import type { BreakGlassService } from './breakGlass.js';
import type { OrgInvitations } from './invitations.js';
import type { OrgsService } from './service.js';
import type { OrgTransfers } from './transfer.js';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createOrgRoutes(orgs: OrgsService, breakGlass?: BreakGlassService, invitations?: OrgInvitations): Hono {
  const r = new Hono();
  const inv = (): OrgInvitations => {
    if (!invitations) throw new AppError('NOT_FOUND', 'Not found.');
    return invitations;
  };
  // Slice 8, before `/:id`: accepting is not about an org id the caller names (the code names it).
  r.post('/invitations/accept', async (c) => c.json(success(inv().accept(actorOf(c), (await body(c)) as Partial<AcceptOrgInvitationRequest>))));

  // Slice 5: before `/:id`, so the banner's path is never read as an org id. Always registered (the route table does not depend on the
  // wiring); without the service they answer 404.
  const bg = (): BreakGlassService => {
    if (!breakGlass) throw new AppError('NOT_FOUND', 'Not found.');
    return breakGlass;
  };
  r.get('/break-glass', (c) => c.json(success(bg().mine(actorOf(c)))));

  r.get('/', (c) => c.json(success(orgs.mine(actorOf(c)))));
  // Before `/:id`, so `abilities` is never read as an org id (the route guard takes the first match, too).
  r.get('/abilities', (c) => c.json(success(orgs.myAbilities(actorOf(c)))));
  r.post('/', async (c) => c.json(success(orgs.create(actorOf(c), (await body(c)) as Partial<CreateOrgRequest>)), 201));
  r.get('/:id', (c) => c.json(success(orgs.get(actorOf(c), c.req.param('id')))));
  r.patch('/:id', async (c) => c.json(success(orgs.update(actorOf(c), c.req.param('id'), (await body(c)) as Partial<UpdateOrgRequest>))));
  r.get('/:id/members', (c) => c.json(success(orgs.members(actorOf(c), c.req.param('id')))));
  r.patch('/:id/members/:uid', async (c) => {
    const b = (await body(c)) as Partial<ChangeOrgMemberRoleRequest>;
    orgs.setRole(actorOf(c), c.req.param('id'), c.req.param('uid'), b.role as ChangeOrgMemberRoleRequest['role']);
    return c.json(success(orgs.members(actorOf(c), c.req.param('id'))));
  });
  r.delete('/:id/members/:uid', (c) => {
    orgs.removeMember(actorOf(c), c.req.param('id'), c.req.param('uid'));
    return c.json(success({ removed: true }));
  });
  r.post('/:id/leave', (c) => {
    orgs.leave(actorOf(c), c.req.param('id'));
    return c.json(success({ left: true }));
  });

  // Slice 8 (§6.8-§6.10): invitations, suspension, deletion, the org's audit. The service decides who (owner-only acts by role).
  r.get('/:id/invitations', (c) => c.json(success(inv().list(actorOf(c), c.req.param('id')))));
  r.post('/:id/invitations', async (c) => c.json(success(inv().create(actorOf(c), c.req.param('id'), (await body(c)) as Partial<CreateOrgInvitationRequest>)), 201));
  r.delete('/:id/invitations/:invitationId', (c) => {
    inv().revoke(actorOf(c), c.req.param('id'), c.req.param('invitationId'));
    return c.json(success({ revoked: true }));
  });
  r.post('/:id/suspend', async (c) => {
    orgs.suspend(actorOf(c), c.req.param('id'), { by: 'owner', reason: (await body(c)).reason });
    return c.json(success(orgs.get(actorOf(c), c.req.param('id'))));
  });
  r.post('/:id/resume', (c) => {
    orgs.resume(actorOf(c), c.req.param('id'), { by: 'owner' });
    return c.json(success(orgs.get(actorOf(c), c.req.param('id'))));
  });
  r.delete('/:id', (c) => {
    orgs.delete(actorOf(c), c.req.param('id'));
    return c.json(success({ deleted: true }));
  });
  r.get('/:id/audit', (c) => c.json(success(orgs.audit(actorOf(c), c.req.param('id'), { before: c.req.query('before'), limit: c.req.query('limit') }))));

  r.get('/:id/break-glass', (c) => c.json(success(bg().forOrg(actorOf(c), c.req.param('id') as OrgId))));
  r.post('/:id/break-glass/:entryId/end', (c) => c.json(success(bg().endByOrgOwner(actorOf(c), c.req.param('id') as OrgId, c.req.param('entryId')))));

  return r;
}

/**
 * Slice 5, Move to organization: `POST <path>/move-to-org` on the object's own router (app.ts mounts it on the workspaces router as
 * `/:ref/move-to-org`, on the tickets router as `/buckets/:key/move-to-org`, on the knowledge router as `/vaults/:id/move-to-org`).
 */
export function createMoveToOrgRoute(transfers: OrgTransfers, kind: OrgTransferKind, path: string, param: string): Hono {
  const r = new Hono();
  r.post(path, async (c) => c.json(success(transfers.moveToOrg(actorOf(c), kind, c.req.param(param) ?? '', (await body(c)) as Partial<MoveToOrgRequest>))));
  return r;
}
