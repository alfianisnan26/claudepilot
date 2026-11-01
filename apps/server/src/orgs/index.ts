// Organizations (docs/prd/organizations.md), slice 3: the core. `createOrgs` declares the routes, makes the abilities and the org service (which
// registers the `org` resolver with the seam) and writes their audit rows to the platform audit. app.ts mounts `createOrgRoutes` at /api/orgs.

import { PlatformAudit } from '../platform/audit.js';
import type { Store } from '../store/store.js';
import { UserAbilities } from './abilities.js';
import { declareOrgPolicies } from './authz.js';
import { OrgsService } from './service.js';

export { UserAbilities, requireInstanceAdmin } from './abilities.js';
export { ORG_ROUTE_POLICIES, orgLevel, orgResolver } from './authz.js';
export { createOrgRoutes } from './routes.js';
export { OrgsService } from './service.js';

export function createOrgs(deps: { store: Store; now?: () => Date }): { orgs: OrgsService; abilities: UserAbilities } {
  declareOrgPolicies();
  const audit = new PlatformAudit(deps.store, deps.now);
  const db = () => deps.store.db;
  const writable = () => (deps.store.writable ? deps.store.db : null);
  const record = (e: Parameters<PlatformAudit['record']>[0]) => audit.record(e);
  const abilities = new UserAbilities({ db, writable, audit: record, now: deps.now });
  const orgs = new OrgsService({ db, writable, abilities, audit: record, now: deps.now });
  return { orgs, abilities };
}
