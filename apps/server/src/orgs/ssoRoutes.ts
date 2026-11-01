// Organization SSO, the HTTP routes (slice 10; ORGS_API.signIn … ssoPolicy; declared in ./authz.ts ORG_SSO_POLICIES). app.ts mounts them on
// the /api/orgs router behind `requireSession` (cookie only). The service (./sso.ts) decides every right on top of the declared `manage`.

import { success } from '@isnanme/core';
import type { OrgId, OrgSsoPolicyRequest, OrgSsoProviderRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf } from '../authz/seam.js';
import type { OrgSso } from './sso.js';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createOrgSsoRoutes(sso: OrgSso, redirectUri: (c: Context<any>) => string): Hono {
  const r = new Hono();
  const id = (c: Context) => c.req.param('id') as OrgId;
  r.get('/:id/sign-in', (c) => c.json(success(sso.settings(actorOf(c), id(c), redirectUri(c)))));
  r.post('/:id/domains', async (c) => c.json(success(sso.addDomain(actorOf(c), id(c), (await body(c)).domain)), 201));
  r.delete('/:id/domains/:domain', (c) => {
    sso.removeDomain(actorOf(c), id(c), c.req.param('domain'));
    return c.json(success({ removed: true }));
  });
  r.post('/:id/domains/:domain/check', async (c) => c.json(success(await sso.checkDomain(actorOf(c), id(c), c.req.param('domain')))));
  r.put('/:id/sso', async (c) => c.json(success(sso.putProvider(actorOf(c), id(c), (await body(c)) as OrgSsoProviderRequest, redirectUri(c)))));
  r.delete('/:id/sso', (c) => {
    sso.removeProvider(actorOf(c), id(c));
    return c.json(success({ removed: true }));
  });
  r.post('/:id/sso/test', async (c) => c.json(success(await sso.testProvider(actorOf(c), id(c)))));
  r.put('/:id/sso/policy', async (c) => c.json(success(sso.setPolicy(actorOf(c), id(c), (await body(c)) as OrgSsoPolicyRequest, redirectUri(c)))));
  return r;
}
