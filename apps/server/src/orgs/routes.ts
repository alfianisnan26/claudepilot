// Organizations: the HTTP routes (docs/prd/organizations.md §10; ORGS_API in packages/contracts/src/orgs.ts; declared in ./authz.ts). No auth
// middleware here: app.ts mounts this under `requireSession` at /api/orgs. Who is asking comes from the seam (`actorOf`) once per request;
// the service decides every right (the org resolver through `can()`, the owner-only rules, the ability to create).

import { AppError, success } from '@isnanme/core';
import { Hono, type Context } from 'hono';
import type {
  AcceptOrgInvitationRequest,
  CreateAccessRequest,
  DecideAccessRequest,
  ChangeOrgMemberRoleRequest,
  CreateOrgInvitationRequest,
  CreateOrgRequest,
  CreateOrgShareRequest,
  CreateOrgTeamRequest,
  MoveToOrgRequest,
  OrgId,
  MoveToOrgKind,
  UpdateOrgRequest,
} from '@portal/contracts';
import { actorOf } from '../authz/seam.js';
import type { OrgAccess } from './access.js';
import type { BreakGlassService } from './breakGlass.js';
import type { OrgInvitations } from './invitations.js';
import type { OrgsService } from './service.js';
import type { OrgSharing } from './sharing.js';
import type { OrgTransfers } from './transfer.js';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createOrgRoutes(orgs: OrgsService, breakGlass?: BreakGlassService, sharing?: OrgSharing, invitations?: OrgInvitations, access?: OrgAccess): Hono {
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
  r.get('/:id/audit', (c) => c.json(success(orgs.audit(actorOf(c), c.req.param('id'), { before: c.req.query('before'), limit: c.req.query('limit'), kind: c.req.query('kind') }))));

  r.get('/:id/break-glass', (c) => c.json(success(bg().forOrg(actorOf(c), c.req.param('id') as OrgId))));
  r.post('/:id/break-glass/:entryId/end', (c) => c.json(success(bg().endByOrgOwner(actorOf(c), c.req.param('id') as OrgId, c.req.param('entryId')))));

  // Slice 7: teams of the org, shares to the org or its teams, transcript reads (./sharing.ts). Always registered; 404 without the service.
  const sh = (): OrgSharing => {
    if (!sharing) throw new AppError('NOT_FOUND', 'Not found.');
    return sharing;
  };
  r.get('/:id/teams', (c) => c.json(success(sh().teams(actorOf(c), c.req.param('id') as OrgId))));
  r.post('/:id/teams', async (c) => c.json(success(sh().createTeam(actorOf(c), c.req.param('id') as OrgId, (await body(c)) as Partial<CreateOrgTeamRequest>)), 201));
  r.delete('/:id/teams/:teamId', (c) => {
    sh().removeTeam(actorOf(c), c.req.param('id') as OrgId, c.req.param('teamId'));
    return c.json(success({ removed: true }));
  });
  r.get('/:id/teams/:teamId/members', (c) => c.json(success(sh().teamMembers(actorOf(c), c.req.param('id') as OrgId, c.req.param('teamId')))));
  r.put('/:id/teams/:teamId/members/:uid', async (c) =>
    c.json(success(sh().setTeamMember(actorOf(c), c.req.param('id') as OrgId, c.req.param('teamId'), c.req.param('uid'), (await body(c)).role))),
  );
  r.delete('/:id/teams/:teamId/members/:uid', (c) => {
    sh().removeTeamMember(actorOf(c), c.req.param('id') as OrgId, c.req.param('teamId'), c.req.param('uid'));
    return c.json(success({ removed: true }));
  });
  r.get('/:id/shares', (c) => c.json(success(sh().shares(actorOf(c), c.req.param('id') as OrgId))));
  r.post('/:id/shares', async (c) => c.json(success(sh().share(actorOf(c), c.req.param('id') as OrgId, (await body(c)) as Partial<CreateOrgShareRequest>)), 201));
  r.delete('/:id/shares/:shareId', (c) => {
    sh().revoke(actorOf(c), c.req.param('id') as OrgId, c.req.param('shareId'));
    return c.json(success({ revoked: true }));
  });
  r.get('/:id/transcript-views', (c) => c.json(success(sh().transcriptViews(actorOf(c), c.req.param('id') as OrgId))));

  // Fine-grained access (docs/prd/access.md, ./access.ts): who reaches what and why, the catalog, access requests. Grants and revokes are
  // the shares routes above. Always registered; 404 without the service.
  const ac = (): OrgAccess => {
    if (!access) throw new AppError('NOT_FOUND', 'Not found.');
    return access;
  };
  r.get('/:id/access/catalog', (c) => c.json(success(ac().catalog(actorOf(c), c.req.param('id') as OrgId))));
  r.get('/:id/access/object', (c) => c.json(success(ac().object(actorOf(c), c.req.param('id') as OrgId, c.req.query('type'), c.req.query('id')))));
  r.get('/:id/access/people/:uid', (c) => c.json(success(ac().person(actorOf(c), c.req.param('id') as OrgId, c.req.param('uid')))));
  r.get('/:id/access/requests', (c) => c.json(success(ac().requests(actorOf(c), c.req.param('id') as OrgId))));
  r.post('/:id/access/requests', async (c) => c.json(success(ac().request(actorOf(c), c.req.param('id') as OrgId, (await body(c)) as Partial<CreateAccessRequest>)), 201));
  r.post('/:id/access/requests/:requestId/approve', async (c) =>
    c.json(success(ac().approve(actorOf(c), c.req.param('id') as OrgId, c.req.param('requestId'), (await body(c)) as Partial<DecideAccessRequest>))),
  );
  r.post('/:id/access/requests/:requestId/deny', async (c) =>
    c.json(success(ac().deny(actorOf(c), c.req.param('id') as OrgId, c.req.param('requestId'), (await body(c)) as Partial<DecideAccessRequest>))),
  );
  r.delete('/:id/access/requests/:requestId', (c) => {
    ac().cancel(actorOf(c), c.req.param('id') as OrgId, c.req.param('requestId'));
    return c.json(success({ cancelled: true }));
  });

  return r;
}

/**
 * Slice 5, Move to organization: `POST <path>/move-to-org` on the object's own router (app.ts mounts it on the workspaces router as
 * `/:ref/move-to-org`, on the tickets router as `/buckets/:key/move-to-org`, on the knowledge router as `/vaults/:id/move-to-org`, on the
 * pools router as `/:type/:id/move-to-org`, D-111 D2).
 */
export function createMoveToOrgRoute(transfers: OrgTransfers, kind: MoveToOrgKind, path: string, param: string): Hono {
  const r = new Hono();
  // A workspace id is `<target>/<name>`: its route takes both parts (`param` 'target+name'), since one path segment cannot hold the slash.
  // A set (D-111 D2, `param` 'type+id') is its id, under the type its URL names (the set's own type, else not found).
  const idOf = (c: Context): string =>
    param === 'target+name' ? `${c.req.param('target') ?? ''}/${c.req.param('name') ?? ''}` : param === 'type+id' ? (c.req.param('id') ?? '') : (c.req.param(param) ?? '');
  const poolTypeOf = (c: Context): string | undefined => (param === 'type+id' ? (c.req.param('type') ?? '') : undefined);
  r.post(path, async (c) => c.json(success(transfers.moveToOrg(actorOf(c), kind, idOf(c), (await body(c)) as Partial<MoveToOrgRequest>, poolTypeOf(c)))));
  return r;
}
