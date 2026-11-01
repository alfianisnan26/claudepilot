// Organizations: the HTTP routes (docs/prd/organizations.md §10; ORGS_API in packages/contracts/src/orgs.ts; declared in ./authz.ts). No auth
// middleware here: app.ts mounts this under `requireSession` at /api/orgs. Who is asking comes from the seam (`actorOf`) once per request;
// the service decides every right (the org resolver through `can()`, the owner-only rules, the ability to create).

import { success } from '@isnanme/core';
import { Hono } from 'hono';
import type { ChangeOrgMemberRoleRequest, CreateOrgRequest, UpdateOrgRequest } from '@portal/contracts';
import { actorOf } from '../authz/seam.js';
import type { OrgsService } from './service.js';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createOrgRoutes(orgs: OrgsService): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(success(orgs.mine(actorOf(c)))));
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

  return r;
}
