// The Admin console (docs/prd/organizations.md §6.11, OD-2; slice 4): a separate console for instance admins on its own host
// (`PORTAL_ADMIN_HOST`, e.g. admin.pilot.ai.isnan.me). Its own session (`__Host-pilot_admin`, table admin_sessions), its own routes under
// /admin-api (declared in apps/server/src/admin/authz.ts), its own small UI bundle under /admin-ui. Nothing here is served on the main host.

import type { CodeSource } from './api.js';
import type { OrgId } from './authz.js';
import type { Ability, AdminOrgSummary, OrgInvitation, OrgMember } from './orgs.js';
import type { PlatformAuditEntry } from './notify.js';
import type { SsoProvider, SsoProviderRequest } from './portalUsers.js';
import type { WorkspaceStatus, WorkspaceTarget } from './workspace.js';

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
  /** GET -> `AdminUserDetail`; PATCH `AdminUpdateUserRequest` (step-up) -> `AdminUserRow`; DELETE (step-up): removes the account. */
  user: (id: string) => `/admin-api/users/${u(id)}`,
  /** POST (step-up) -> `AdminPasswordResult`: a new one-time password, shown ONCE; the account's sessions end. */
  password: (id: string) => `/admin-api/users/${u(id)}/password`,
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
  /** GET -> `AdminOrgSummary[]`; POST `AdminCreateOrgRequest` (step-up) -> `AdminOrgDetail`: an org whose first owner is the account picked. */
  orgs: '/admin-api/orgs',
  /** GET -> `AdminOrgDetail`; DELETE `AdminReasonRequest` (step-up): deletes an org that owns nothing (30 days of grace, then purged). */
  org: (id: OrgId) => `/admin-api/orgs/${u(id)}`,
  /** POST `AdminRecoverOwnerRequest` (step-up): makes an active account the owner of an org that has none. */
  recoverOwner: (id: OrgId) => `/admin-api/orgs/${u(id)}/recover-owner`,
  /** Slice 8. POST `{ reason? }` (step-up): suspends an org (its owners cannot resume it themselves); `resume` brings it back. */
  suspendOrg: (id: OrgId) => `/admin-api/orgs/${u(id)}/suspend`,
  resumeOrg: (id: OrgId) => `/admin-api/orgs/${u(id)}/resume`,
  /**
   * Slice 5 (§6.7, OD-4). POST `StartBreakGlassRequest` (step-up) -> `BreakGlassEntry`: one hour of `manage` on the org's content in the main
   * portal, never on personal objects; notifies the org's owners. DELETE: ends the caller's open entry on that org early.
   */
  breakGlass: (id: OrgId) => `/admin-api/orgs/${u(id)}/break-glass`,
  /** GET -> `BreakGlassEntry[]`: every entry, newest first. */
  breakGlassList: '/admin-api/break-glass',
  /** GET -> `SsoProvider[]` (no secret); POST `SsoProviderRequest` (step-up) -> `SsoProvider`: an instance-wide provider. */
  sso: '/admin-api/sso',
  /** PATCH `SsoProviderRequest` (step-up) -> `SsoProvider`: edit, or `{ enabled: false }` to turn it off. */
  ssoProvider: (id: string) => `/admin-api/sso/${u(id)}`,
  /** GET ?kind&severity&subject&actor&org&from&to&before&limit -> `PlatformAuditEntry[]` (newest first). */
  audit: '/admin-api/audit',
  /** GET -> `AdminWorkspaceRow[]`: every workspace on every target (names, owners, status, image; never content). */
  workspaces: '/admin-api/workspaces',
  /** POST (step-up): start or stop, as the main portal does; the seam decides (someone else's personal workspace is not the admin's: 404). */
  workspaceStart: (id: string) => `/admin-api/workspaces/${id.split('/').map(u).join('/')}/start`,
  workspaceStop: (id: string) => `/admin-api/workspaces/${id.split('/').map(u).join('/')}/stop`,
  /** GET -> `WorkspaceTarget[]`: every target (Docker, Kubernetes, This machine, Connect) with whether it answers. */
  targets: '/admin-api/targets',
  /** GET -> `AdminSignInConfig`: the server code switch (never the code), the console's OIDC allow list (env, read only). */
  signIn: '/admin-api/signin',
  /** PUT `AdminServerCodeRequest` (step-up) -> `AdminSignInConfig`: sign-in with the server code on or off. */
  serverCode: '/admin-api/signin/server-code',
  /** POST (step-up) -> `AdminRotatedCode`: a new server code, shown ONCE; every main-portal session ends. */
  rotateCode: '/admin-api/signin/server-code/rotate',
  /** GET -> `SettingsView`: the portal-wide settings (the same store as the main portal's Settings). */
  settings: '/admin-api/settings',
  /** PUT `SettingUpdate` (step-up) -> `SettingView`; a protective switch moved off needs `confirm: true` (409 CONFIRMATION_REQUIRED). */
  setting: (key: string) => `/admin-api/settings/${u(key)}`,
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
  /** Exactly the actor string (`user:u_…`, `anonymous`), or a prefix ending in `:` (`system:`). */
  actor?: string;
  /** The org a row is about (`org_…`). */
  org?: string;
  /** ISO dates or times: rows at or after `from`, and before `to` (a bare date `to` counts that whole day). */
  from?: string;
  to?: string;
  before?: number;
  limit?: number;
}

/** `POST ADMIN_API.users`: a new account. The server makes its password and shows it ONCE in the answer. */
export interface AdminCreateUserRequest {
  email: string;
  displayName?: string;
  role?: 'admin' | 'member';
}

/** The answer to creating an account or resetting its password: the one-time password, shown once, never kept in clear. */
export interface AdminPasswordResult {
  user: AdminUserRow;
  password: string;
}

export interface AdminUpdateUserRequest {
  role?: 'admin' | 'member';
  displayName?: string;
}

export interface AdminCreateOrgRequest {
  name: string;
  slug: string;
  /** The account that becomes its first owner (any active account; the signed-in admin when absent). */
  ownerId?: string;
}

/** One object an org owns: kind, id and name, never content. */
export interface AdminOrgObject {
  kind: 'workspace' | 'ticket_bucket' | 'vault' | 'pool' | 'account' | 'endpoint';
  id: string;
  name: string;
}

/** An org as the console shows it: the summary, members and roles, what it owns, invitations, its SSO and domains where built. */
export interface AdminOrgDetail extends AdminOrgSummary {
  memberList: OrgMember[];
  objects: AdminOrgObject[];
  invitations: OrgInvitation[];
  /** null: this portal has no org SSO yet (organizations slice 10). */
  sso: { id: string; name: string; enabled: boolean }[] | null;
  /** null: this portal has no org domains yet (organizations slice 10). */
  domains: { domain: string; verified: boolean }[] | null;
  /** Break-glass entries open on it now. */
  breakGlassOpen: { adminUserId: string; expiresAt: string }[];
}

/** A workspace in the console's list: where, who owns it, its state and image. Never its files, sessions or credentials. */
export interface AdminWorkspaceRow {
  id: string;
  stableId: string | null;
  label: string;
  target: string;
  image: string;
  status: WorkspaceStatus;
  detail: string | null;
  createdAt: string;
  owner: { kind: 'user' | 'team' | 'org' | 'platform' | 'none'; id: string | null; name: string | null };
}

export type AdminTarget = WorkspaceTarget;

/** The instance's sign-in switches. Never the server code itself. */
export interface AdminSignInConfig {
  serverCode: { enabled: boolean; source: CodeSource; codeUpdatedAt: string; sessions: number } | null;
  /** The console's own OIDC sign-in (env PORTAL_ADMIN_OIDC_*): who may sign in; changed in the deployment, not here. */
  adminOidc: { issuer: string; name: string; allow: string[] } | null;
  adminHost: string | null;
}

export interface AdminServerCodeRequest {
  enabled: boolean;
}

export interface AdminRotatedCode {
  /** The new server code, shown once. */
  code: string;
  config: AdminSignInConfig;
}

export type AdminSsoRequest = SsoProviderRequest;
