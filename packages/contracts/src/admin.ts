// The Admin console (docs/prd/organizations.md §6.11, OD-2; slice 4): a separate console for instance admins on its own host
// (`PORTAL_ADMIN_HOST`, e.g. admin.pilot.ai.isnan.me). Its own session (`__Host-pilot_admin`, table admin_sessions), its own routes under
// /admin-api (declared in apps/server/src/admin/authz.ts), its own small UI bundle under /admin-ui. Nothing here is served on the main host.

import type { OrgId } from './authz.js';
import type { Ability, AdminOrgSummary } from './orgs.js';
import type { PlatformAuditEntry } from './notify.js';
import type { SsoProvider } from './portalUsers.js';

/** The admin session's cookie: host-only (`__Host-`: Secure, Path=/, no Domain), HttpOnly, SameSite=Strict. Never the main portal's. */
export const ADMIN_COOKIE = '__Host-pilot_admin';

/** Idle timeout, absolute lifetime, and how long a step-up (password re-entered) counts. */
export const ADMIN_SESSION_LIMITS = {
  idleMs: 15 * 60_000,
  absoluteMs: 2 * 60 * 60_000,
  stepUpMs: 5 * 60_000,
} as const;

/** The console's UI bundle is served under this prefix, on the admin host only. */
export const ADMIN_UI_BASE = '/admin-ui/';

const u = (id: string) => encodeURIComponent(id);

export const ADMIN_API = {
  /** POST `AdminSignInRequest` -> `AdminMe` (sets the cookie); GET -> `AdminMe`; DELETE: signs out. */
  session: '/admin-api/session',
  /** POST `AdminStepUpRequest` -> `AdminMe`: the password again; the actions marked step-up work for 5 minutes after it. */
  stepUp: '/admin-api/session/step-up',
  /** GET (no session) -> `AdminSignInMethods`: whether the sign-in page offers the OIDC button. */
  methods: '/admin-api/session/methods',
  /**
   * GET (a browser navigation, owner 2026-11-01): starts sign-in through the console's OIDC provider (git.isnan.me) and redirects to it.
   * `?for=step-up` (needs the admin session) re-authenticates instead; `next` names the console section to come back to.
   */
  oidcStart: '/admin-api/session/oidc/start',
  /** GET: where the provider sends the browser back (the redirect URI registered at the provider is this on the admin host). */
  oidcCallback: '/admin-api/session/oidc/callback',
  /** GET -> `AdminUserRow[]`. */
  users: '/admin-api/users',
  /** GET -> `AdminUserDetail`. */
  user: (id: string) => `/admin-api/users/${u(id)}`,
  /** POST `AdminReasonRequest` (step-up): disables the account, ends its sessions and tokens. */
  suspend: (id: string) => `/admin-api/users/${u(id)}/suspend`,
  /** POST `AdminReasonRequest` (step-up). */
  resume: (id: string) => `/admin-api/users/${u(id)}/resume`,
  /** POST (step-up): ends every portal and admin session of the account. */
  endSessions: (id: string) => `/admin-api/users/${u(id)}/sessions/end`,
  /** DELETE (step-up): revokes one token the account minted. */
  token: (id: string, tokenId: string) => `/admin-api/users/${u(id)}/tokens/${u(tokenId)}`,
  /** PUT / DELETE (step-up): grants or revokes one ability. */
  ability: (id: string, ability: Ability) => `/admin-api/users/${u(id)}/abilities/${u(ability)}`,
  /** GET -> `AdminOrgSummary[]`. */
  orgs: '/admin-api/orgs',
  /** POST `AdminRecoverOwnerRequest` (step-up): makes an active account the owner of an org that has none. */
  recoverOwner: (id: OrgId) => `/admin-api/orgs/${u(id)}/recover-owner`,
  /**
   * Slice 5 (§6.7, OD-4). POST `StartBreakGlassRequest` (step-up) -> `BreakGlassEntry`: one hour of `manage` on the org's content in the main
   * portal, never on personal objects; notifies the org's owners. DELETE: ends the caller's open entry on that org early.
   */
  breakGlass: (id: OrgId) => `/admin-api/orgs/${u(id)}/break-glass`,
  /** GET -> `BreakGlassEntry[]`: every entry, newest first. */
  breakGlassList: '/admin-api/break-glass',
  /** GET -> `SsoProvider[]` (read only; no secret). */
  sso: '/admin-api/sso',
  /** GET ?kind&severity&subject&before&limit -> `PlatformAuditEntry[]` (newest first). */
  audit: '/admin-api/audit',
} as const;

export interface AdminSignInRequest {
  email: string;
  password: string;
}

/** How one can sign in to the console. `oidc` is null when it is not configured (the button is hidden). */
export interface AdminSignInMethods {
  password: true;
  oidc: { name: string } | null;
}

/** The query the console's page is opened with after a refused OIDC sign-in or step-up (the same neutral answer for every reason). */
export const ADMIN_OIDC_RESULT = { param: 'oidc', refused: 'refused', unavailable: 'unavailable' } as const;

export interface AdminStepUpRequest {
  password: string;
}

export interface AdminReasonRequest {
  reason?: string;
}

export interface AdminRecoverOwnerRequest {
  userId: string;
  /** At least 10 characters. */
  reason: string;
}

/** The signed-in admin and the session's clocks (ISO times). */
export interface AdminMe {
  userId: string;
  email: string;
  displayName: string;
  /** The absolute end (2 h after sign-in). */
  expiresAt: string;
  /** When the session ends if nothing happens (15 min after the last request). */
  idleExpiresAt: string;
  /** Until when step-up actions are allowed without the password again; null: not now. */
  freshUntil: string | null;
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  state: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  /** Abilities held by a row (an admin holds every ability without one). */
  abilities: Ability[];
}

export interface AdminUserToken {
  kind: 'pmcp' | 'reporter';
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AdminUserDetail extends AdminUserRow {
  /** Live sessions: the main portal's and the Admin console's. */
  sessions: { portal: number; admin: number };
  tokens: AdminUserToken[];
}

export type AdminAuditEntry = PlatformAuditEntry;
export type AdminSsoProvider = SsoProvider;
export type AdminOrg = AdminOrgSummary;

export interface AdminAuditQuery {
  /** A kind or a kind prefix (`account` matches `account.*`). */
  kind?: string;
  severity?: 'info' | 'medium' | 'high';
  /** Exactly `user:<id>` or `org:<id>`. */
  subject?: string;
  before?: number;
  limit?: number;
}
