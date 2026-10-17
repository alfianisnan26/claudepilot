// Sign-in by email (owner, 2026-10-17: "multi user feature login by email"; T-118 MU1-min). An account is an email, a name and a password;
// signing in with it gives the same portal session the server code gives: every account acts as the owner until per-person permissions
// (MU2). The server code keeps working beside it (agents, scripts and the fallback when an email account is lost).

/** One sign-in account, as the Settings page shows it. Never a hash. */
export interface PortalUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  state: 'active' | 'disabled';
  createdAt: string;
  createdBy: string;
  lastLoginAt: string | null;
}

export interface CreatePortalUserRequest {
  email: string;
  displayName?: string;
  /** `admin`: full access, like the server code. `member` (the DEFAULT when omitted): no access until something is shared with it (MU2). */
  role?: 'admin' | 'member';
  /** At least 15 characters (PASSWORD); not a common password, not the email. */
  password: string;
}

export interface UpdatePortalUserRequest {
  displayName?: string;
  role?: 'admin' | 'member';
  state?: 'active' | 'disabled';
  /** A new password for the account (the same policy). */
  password?: string;
}

/** A plain check (one @, a dot in the domain, no spaces); the real check is that mail reaches it, which MU1-min does not send. */
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export const normalizeEmail = (raw: string): string => raw.normalize('NFKC').trim().toLowerCase();

/** `GET /api/me` (`SignedInAs`): who is signed in, for a member too: `{ kind: 'code' }` or `{ kind: 'account', user: PortalUser }`. */
export type SignedInAs = { kind: 'code' } | { kind: 'account'; user: PortalUser };

/** `POST /api/me/password`: change your own password; the other sessions of the account end. */
export interface ChangeMyPasswordRequest {
  current: string;
  next: string;
}

export const PORTAL_USER_API = {
  me: '/api/me',
  myPassword: '/api/me/password',
  /** GET: `PortalUser[]`. POST `CreatePortalUserRequest`: the new `PortalUser`. Signed in only. */
  list: '/api/admin/users',
  /** PATCH `UpdatePortalUserRequest`: `PortalUser`. DELETE: remove it. Signed in only. */
  one: (id: string) => `/api/admin/users/${encodeURIComponent(id)}`,
} as const;

/* ---------- Session sharing (owner, 2026-10-17): one session, to an account or a team, with what they may do and until when ---------- */

/** What a share allows on its session. `read` comes with every share; the others each add one act. */
export const SESSION_SHARE_CAPS = ['read', 'send', 'respond', 'stop'] as const;
export type SessionShareCap = (typeof SESSION_SHARE_CAPS)[number];
export const isSessionShareCap = (v: unknown): v is SessionShareCap => typeof v === 'string' && (SESSION_SHARE_CAPS as readonly string[]).includes(v);
/** The two presets the dialog offers first. */
export const SESSION_SHARE_PRESETS: Record<'view' | 'operate', SessionShareCap[]> = { view: ['read'], operate: ['read', 'send', 'respond', 'stop'] };

/** Kept for the delegate's page: `operate` when any act is allowed, else `view`. */
export type SessionGrantLevel = 'view' | 'operate';
export const levelOfCaps = (caps: readonly SessionShareCap[]): SessionGrantLevel => (caps.some((c) => c !== 'read') ? 'operate' : 'view');

export type ShareSubjectRef = { kind: 'user'; id: string } | { kind: 'team'; id: string };

export interface SessionShare {
  id: string;
  sessionId: string;
  subject: ShareSubjectRef;
  /** The account's email or the team's name, for the list. */
  subjectName: string;
  caps: SessionShareCap[];
  /** The owner accepted that `send` or `respond` may drive this session in Bypass. */
  bypassAck: boolean;
  /** ISO time it ends, or null (until revoked). An ended share is kept in the list as `expired` until removed. */
  expiresAt: string | null;
  expired: boolean;
  note: string | null;
  grantedBy: string;
  createdAt: string;
}

/** Back-compat name for older clients. */
export type SessionGrant = SessionShare;

export interface SessionShareRequest {
  subject: ShareSubjectRef;
  caps: SessionShareCap[];
  /** ISO time, or null for until revoked. Must be in the future, at most `SESSION_SHARE_MAX_DAYS` away. */
  expiresAt?: string | null;
  note?: string | null;
  /** Required for `send` or `respond` on a session in Bypass. */
  acknowledgeBypass?: boolean;
}
/** The old body (`{ userId, level }`) still works: view = read, operate = all four. */
export interface SessionGrantRequest {
  userId: string;
  level: SessionGrantLevel;
  acknowledgeBypass?: boolean;
}
export const SESSION_SHARE_MAX_DAYS = 365;

/** A session shared with the signed-in account (directly or through a team), as its own page shows it. */
export interface DelegatedSession {
  id: string;
  title: string;
  state: string;
  workspaceId: string;
  waiting: number;
  level: SessionGrantLevel;
  /** What this account may do, every share it holds on the session together. */
  caps: SessionShareCap[];
  /** The soonest end of the shares that give it, or null. */
  expiresAt: string | null;
  /** `you` for a direct share, else the team names. */
  via: string[];
}

/** One row of the admin's access overview: every share, with its session's title. */
export interface SessionShareOverview extends SessionShare {
  sessionTitle: string | null;
  workspaceId: string | null;
}

/** The most events one delegate read returns (`?after=` or a page); past it, the newest. */
export const DELEGATED_EVENTS_MAX = 200;

export const SESSION_GRANT_API = {
  /**
   * Full session only. GET: `SessionShare[]` on a session. PUT `SessionShareRequest` (or the old `SessionGrantRequest`): create or replace
   * the share for that subject.
   */
  grants: (sessionId: string) => `/api/admin/session-grants/${encodeURIComponent(sessionId)}`,
  /** Full session only. DELETE: revoke one account's direct share (old path). */
  grant: (sessionId: string, userId: string) => `/api/admin/session-grants/${encodeURIComponent(sessionId)}/${encodeURIComponent(userId)}`,
  /** Full session only. GET: `SessionShareOverview[]`, every share on the portal. */
  all: '/api/admin/session-shares',
  /** Full session only. DELETE: revoke one share by id; PATCH `{ caps?, expiresAt?, note?, acknowledgeBypass? }`. */
  share: (shareId: string) => `/api/admin/session-shares/${encodeURIComponent(shareId)}`,
  /** An account session. GET: `DelegatedSession[]` (shared with me, directly or through my teams). */
  mine: '/api/me/sessions',
  /** An account session with a share. GET: `DelegatedSession`. */
  one: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}`,
  /**
   * GET `?after=<seq>`: `ChatEvent[]` after a seq, at most `DELEGATED_EVENTS_MAX` (the newest when more); otherwise a `ChatEventPage`
   * (`?before=&limit=`). Only what the delegate's view shows: messages, tool names, approvals and errors of the main thread; no tool
   * output, thinking, inputs or sub-agent lines.
   */
  events: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/events`,
  /** POST `{ text, uuid }` (cap `send`). */
  send: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/send`,
  /** POST `{ requestId, decision: 'allow' | 'deny', note? }` (cap `respond`). */
  respond: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/respond`,
  /** POST (cap `stop`): stop the running turn. */
  stop: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/stop`,
} as const;

/* ---------- Teams (owner, 2026-10-17: "team based multiaccount") ---------- */

export type PortalTeamRole = 'owner' | 'member';

export interface PortalTeam {
  id: string;
  name: string;
  description: string | null;
  members: number;
  createdAt: string;
  createdBy: string;
  /** The signed-in account's role in it (absent for the server code or an admin who is not in it). */
  myRole?: PortalTeamRole;
}

export interface PortalTeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: PortalTeamRole;
  addedAt: string;
}

export interface PortalTeamDetail extends PortalTeam {
  people: PortalTeamMember[];
  /** Sessions shared to the team (owners and admins see them). */
  shares: SessionShareOverview[];
}

export interface CreatePortalTeamRequest {
  name: string;
  description?: string | null;
  /** First owner(s) by account id; the creator when it is an account and none are named. */
  owners?: string[];
}
export interface UpdatePortalTeamRequest {
  name?: string;
  description?: string | null;
}
/** Add an existing account by email (or id), or change its role. */
export interface AddPortalTeamMemberRequest {
  email?: string;
  userId?: string;
  role?: PortalTeamRole;
}

export const PORTAL_TEAM_LIMITS = { nameMax: 40, descriptionMax: 200, maxMembers: 500, maxTeams: 200 } as const;

export const PORTAL_TEAM_API = {
  /** Admin. GET `PortalTeam[]` (all); POST `CreatePortalTeamRequest`. */
  teams: '/api/admin/teams',
  /** Admin. GET `PortalTeamDetail`; PATCH `UpdatePortalTeamRequest`; DELETE (its shares go with it). */
  team: (id: string) => `/api/admin/teams/${encodeURIComponent(id)}`,
  /** Admin or a team owner. POST `AddPortalTeamMemberRequest`. */
  members: (id: string) => `/api/teams/${encodeURIComponent(id)}/members`,
  /** Admin or a team owner. PATCH `{ role }`; DELETE removes. A team always keeps one owner. */
  member: (id: string, userId: string) => `/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
  /** An account. GET `PortalTeam[]`: my teams. */
  mine: '/api/me/teams',
  /** A member of the team (or an admin). GET `PortalTeamDetail` (shares only for owners and admins). */
  one: (id: string) => `/api/teams/${encodeURIComponent(id)}`,
} as const;

/* ---------- SSO (owner, 2026-10-17: "support external SSO oauth"; OpenID Connect) ---------- */

/** A provider as the admin sees it. The client secret is write-only: only whether one is set. */
export interface SsoProvider {
  id: string;
  name: string;
  /** The issuer URL; its `/.well-known/openid-configuration` is read. */
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  /** Email domains that sign in through this provider (lowercase, no `@`). An email on one of them never uses a password. */
  domains: string[];
  scopes: string;
  /** Role of an account made on its first SSO sign-in. */
  defaultRole: 'admin' | 'member';
  /** A team an account made on its first SSO sign-in joins as a member, or null. */
  defaultTeamId: string | null;
  /** Make an account on the first sign-in (else only existing accounts may sign in). */
  autoCreate: boolean;
  /** Accept an email the provider does not mark `email_verified` (some providers never send it). Off by default. */
  trustUnverifiedEmail: boolean;
  /** The issuer may be on a private network (an in-house Keycloak). Off by default (the SSRF guard). */
  allowPrivateNetwork: boolean;
  enabled: boolean;
  /** What to register at the provider as the redirect (callback) URL. */
  redirectUri: string;
  createdAt: string;
  updatedAt: string;
}

export interface SsoProviderRequest {
  name?: string;
  issuer?: string;
  clientId?: string;
  /** Write-only. A string sets it, `null` clears it, absent keeps it. */
  clientSecret?: string | null;
  domains?: string[];
  scopes?: string;
  defaultRole?: 'admin' | 'member';
  defaultTeamId?: string | null;
  autoCreate?: boolean;
  trustUnverifiedEmail?: boolean;
  allowPrivateNetwork?: boolean;
  enabled?: boolean;
  /** Required to turn on `defaultRole: 'admin'` with `autoCreate`: every verified address of the domains becomes a full admin. */
  acknowledgeAdminAutoCreate?: boolean;
}

/** `POST SSO_API.discover { email }`: how this email signs in. */
export type SignInMethod = { method: 'password' } | { method: 'sso'; provider: string; name: string; start: string };

export const SSO_API = {
  /** No session needed. POST `{ email }` -> `SignInMethod`. */
  discover: '/api/auth/discover',
  /** No session needed. GET `?provider=&email=`: a redirect to the provider. */
  start: '/api/auth/sso/start',
  /** The provider's redirect back (`?code=&state=`); signs in and goes to the app. */
  callback: '/api/auth/sso/callback',
  /** Admin. GET `SsoProvider[]`; POST `SsoProviderRequest`. */
  providers: '/api/admin/sso',
  /** Admin. PATCH `SsoProviderRequest`; DELETE. */
  provider: (id: string) => `/api/admin/sso/${encodeURIComponent(id)}`,
  /** Admin. POST: read the issuer's discovery document now and say whether it works (no sign-in). */
  test: (id: string) => `/api/admin/sso/${encodeURIComponent(id)}/test`,
} as const;

/** Where an SSO sign-in that failed lands: `/login?sso_error=<code>`. Codes, so the copy lives in the page. */
export type SsoErrorCode = 'state' | 'provider' | 'token' | 'email' | 'domain' | 'no_account' | 'disabled' | 'unavailable';
