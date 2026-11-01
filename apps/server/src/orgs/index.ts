// Organizations (docs/prd/organizations.md). Slice 3, the core: `createOrgs` declares the routes, makes the abilities and the org service
// (which registers the `org` resolver with the seam) and writes their audit rows to the platform audit. Slice 5: org-owned objects (the
// seam's `OrgAuthority`: roles, grants, break-glass), Move to organization and break-glass. app.ts mounts `createOrgRoutes` at /api/orgs
// and the move routes on the workspaces, tickets and knowledge routers. Slice 7: teams of an org, shares to an org or its teams, and the
// audit of org owners and admins reading members' sessions (./sharing.ts).

import type { UserId } from '@portal/contracts';
import { Grants } from '../authz/grants.js';
import { useOrgAuthority } from '../authz/seam.js';
import { PlatformAudit } from '../platform/audit.js';
import type { Store } from '../store/store.js';
import { UserAbilities } from './abilities.js';
import { orgAuthority } from './authority.js';
import { declareOrgPolicies } from './authz.js';
import { BreakGlassService, type BreakGlassNotice } from './breakGlass.js';
import { OrgsService } from './service.js';
import { OrgSharing } from './sharing.js';
import { OrgTransfers, type WorkspaceCredentials } from './transfer.js';

export { UserAbilities, requireInstanceAdmin } from './abilities.js';
export { ORG_ROUTE_POLICIES, ORG_TRANSFER_POLICIES, orgLevel, orgResolver } from './authz.js';
export { BreakGlassService, type BreakGlassNotice } from './breakGlass.js';
export { createMoveToOrgRoute, createOrgRoutes } from './routes.js';
export { OrgsService } from './service.js';
export { OrgSharing } from './sharing.js';
export { OrgTransfers, type WorkspaceCredentials } from './transfer.js';

export interface OrgsModule {
  orgs: OrgsService;
  abilities: UserAbilities;
  grants: Grants;
  breakGlass: BreakGlassService;
  transfers: OrgTransfers;
  sharing: OrgSharing;
}

export function createOrgs(deps: {
  store: Store;
  now?: () => Date;
  /** Slice 5: the credential sets of a workspace (the consent screen of Move to organization); app.ts wires the pools service. */
  credentials?: () => WorkspaceCredentials | null;
  /** Slice 5: tells an org's owners that a break-glass entry started. */
  notifyBreakGlass?: (owners: UserId[], notice: BreakGlassNotice) => void;
}): OrgsModule {
  declareOrgPolicies();
  const audit = new PlatformAudit(deps.store, deps.now);
  const db = () => deps.store.db;
  const writable = () => (deps.store.writable ? deps.store.db : null);
  const record = (e: Parameters<PlatformAudit['record']>[0]) => audit.record(e);
  const abilities = new UserAbilities({ db, writable, audit: record, now: deps.now });
  const orgs = new OrgsService({ db, writable, abilities, audit: record, now: deps.now });
  const grants = new Grants({ db, now: deps.now });
  const breakGlass = new BreakGlassService({ db, writable, orgs, audit: record, notify: (o, n) => deps.notifyBreakGlass?.(o, n), now: deps.now });
  const credentials: WorkspaceCredentials = {
    list: (key) => deps.credentials?.()?.list(key) ?? [],
    remove: (key, ids) => deps.credentials?.()?.remove(key, ids),
  };
  const transfers = new OrgTransfers({ db, writable, orgs, grants, audit: record, credentials, now: deps.now });
  // The seam decides org-owned objects, grants and break-glass through this, read on every call (§6.5).
  const sharing = new OrgSharing({ db, writable, orgs, grants, audit: record, credentials, now: deps.now });
  useOrgAuthority(orgAuthority({ db, orgs, grants, breakGlass, sharing }));
  return { orgs, abilities, grants, breakGlass, transfers, sharing };
}
