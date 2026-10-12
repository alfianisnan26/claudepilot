// Identity and onboarding (docs/prd/identity-onboarding.md): accounts with a username and a password, the first-run setup, registration
// (closed, by invitation, or open with approval), the profile, the devices a person is signed in on, and the platform's audit of all of it.
// It REPLACES the one shared server code: nobody signs in with a code any more except through the dev seed (`devSeed`, off in production).
//
// What a reader must know:
// - The first account is the platform admin and has the id `u_owner` (authz.ts); it is created by `POST /api/setup` with a one-time setup
//   token (from the host: the CLI, or the masked line in the log) or, on an install that had one, the old server code, used ONCE.
// - A password is stored only as a scrypt hash with its parameters (see PASSWORD_HASH), compared in constant time, and changing it ends every
//   other sign-in. No email exists: an admin (or the CLI on the host) RESETS a password by making a one-time reset code; the old password stops
//   working at once and the person redeems the code to choose their own. Nobody is ever handed a temporary password.
// - Responses are uniform: a wrong username, a wrong password, a disabled or a pending account all answer the same 401, in the same time.
// - Nothing here is a secret in a response: a password, a hash, a session token, a setup token, an invitation code after it was shown once.

import type { SessionStatus } from './api.js';
import type { UserId, UserRole } from './authz.js';
import type { PlatformAuditEntry } from './notify.js';

/* ---------- Users ---------- */

/** `pending`: asked to register in open mode, waiting for an admin; cannot sign in. `disabled`: signed out everywhere, tokens dead, objects kept. */
export type UserState = 'active' | 'pending' | 'disabled';

/** What other people see of an account: enough to share with it and to recognise it, nothing more. */
export interface UserSummary {
  id: UserId;
  username: string;
  displayName: string;
  /** The sha256 of the re-encoded avatar (served at `IDENTITY_API.avatar(sha)`), or null: initials are drawn. */
  avatar: string | null;
}

/** An account as an admin sees it, and as its owner sees their own. */
export interface User extends UserSummary {
  role: UserRole;
  state: UserState;
  createdAt: string;
  lastLoginAt: string | null;
  passwordChangedAt: string;
  /** A reset code was made and not yet redeemed: the old password no longer works and the person cannot sign in until they redeem it (or an admin resets again). */
  resetPending: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  /** Who made the account: a user id, `setup`, `registration`, `invitation:<id>` or `cli`. */
  createdBy: string;
}

export type RegistrationMode = 'closed' | 'invitation' | 'open';

/* ---------- Names and passwords (one rule set, used by the server and by the forms) ---------- */

/** 3 to 32 characters, ASCII, starting with a letter: `a-z 0-9 . _ -`. Compared lowercase; there is no way to tell two spellings apart on the wire. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{2,31}$/;
export const DISPLAY_NAME_MAX = 60;
/** Names nobody may take: they look like the portal, a role or an id. */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin', 'administrator', 'root', 'system', 'portal', 'pilot', 'claude', 'claudepilot', 'owner', 'support', 'security', 'staff',
  'me', 'you', 'self', 'everyone', 'anyone', 'all', 'anonymous', 'guest', 'user', 'users', 'team', 'teams', 'null', 'undefined',
  'api', 'mcp', 'hooks', 'connect', 'login', 'logout', 'setup', 'register', 'invite', 'dev', 'test',
];

export const normalizeUsername = (raw: string): string => raw.normalize('NFKC').trim().toLowerCase();

/** Why a username can't be used, or null. The server answers the same `USERNAME_UNAVAILABLE` for a taken one and a reserved one. */
export function usernameProblem(raw: string): 'format' | 'reserved' | null {
  const name = normalizeUsername(raw);
  if (!USERNAME_PATTERN.test(name) || /^u_/.test(name)) return 'format';
  return RESERVED_USERNAMES.includes(name) ? 'reserved' : null;
}

/**
 * Password rules (NIST SP 800-63B-4 for a password used alone: at least 15 characters, no composition rules, no expiry, Unicode and spaces
 * allowed, a maximum of at least 64, no silent truncation, a block list). The strength is length, not symbols.
 */
export const PASSWORD = { min: 15, max: 128 } as const;

export type PasswordProblem = 'too_short' | 'too_long' | 'same_as_username' | 'same_as_name' | 'repeated' | 'sequence' | 'common';

/** The checks every form can run without a list; the server adds `common` (a block list of the worst passwords) and runs these again. */
export function passwordProblems(password: string, who: { username?: string; displayName?: string } = {}): PasswordProblem[] {
  const out: PasswordProblem[] = [];
  const pw = password.normalize('NFKC');
  const chars = [...pw];
  if (chars.length < PASSWORD.min) out.push('too_short');
  if (chars.length > PASSWORD.max) out.push('too_long');
  const lower = pw.toLowerCase();
  if (who.username && lower.includes(normalizeUsername(who.username)) && normalizeUsername(who.username).length >= 3) out.push('same_as_username');
  if (who.displayName && who.displayName.trim().length >= 4 && lower.includes(who.displayName.trim().toLowerCase())) out.push('same_as_name');
  if (chars.length > 0 && new Set(chars).size <= 3) out.push('repeated');
  if (/^(?:0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiop|asdfghjkl|zxcvbnm)/.test(lower) && chars.length < 20) out.push('sequence');
  return out;
}

/* ---------- Limits and lifetimes (the server enforces; the pages only explain) ---------- */

/** How passwords are stored: `scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>`, base64url. The parameters travel with the hash so they can be raised: a hash with weaker ones is rehashed at the next sign-in. */
export const PASSWORD_HASH = { algorithm: 'scrypt', logN: 17, r: 8, p: 1, keyBytes: 32, saltBytes: 16, maxConcurrent: 2 } as const;

export const SESSION_LIFETIME = {
  /** A browser session: ends this long after sign-in. */
  shortMs: 12 * 60 * 60 * 1000,
  /** "Keep me signed in": ends after this long unused, or at the absolute cap, whichever is first. */
  keptIdleMs: 30 * 24 * 60 * 60 * 1000,
  keptAbsoluteMs: 90 * 24 * 60 * 60 * 1000,
  /** A password check (re-auth) counts this long: Bypass, tokens, sharing at manage, role changes. */
  reauthMs: 10 * 60 * 1000,
} as const;

/** Attempt limits. Per account AND per address; counted in the database, so a restart does not reset them. */
export const LOGIN_LIMITS = {
  /** Failures for one username (existing or not) in `windowMs` before it locks. */
  perUser: { failures: 5, windowMs: 15 * 60 * 1000, baseLockMs: 30 * 1000, maxLockMs: 15 * 60 * 1000 },
  perIp: { failures: 20, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 },
  register: { perIpPerHour: 5, pendingMax: 50 },
  invitation: { redeemFailuresPerIp: 10, windowMs: 10 * 60 * 1000 },
  reauth: { failures: 5, windowMs: 10 * 60 * 1000 },
  lookup: { perUserPerHour: 30 },
} as const;

export const INVITATION = { ttlDays: 7, maxTtlDays: 30, maxPending: 100, perInviterPerDay: 20, codePrefix: 'cpinv_', noteMax: 80 } as const;
/** A reset code: valid one hour, single use, the same door and limits as an invitation. */
export const RESET_CODE = { prefix: 'cprst_', ttlMs: 60 * 60 * 1000 } as const;

/** The one-time setup token: valid this long from each start, single use, hashed at rest, shown in full only by the CLI (and in the log only when asked). */
export const SETUP_TOKEN = { ttlMs: 60 * 60 * 1000, groups: 5, groupLength: 4 } as const;

/* ---------- Status, setup, sign-in ---------- */

/** What the setup screen needs, present only while no account exists. */
export interface SetupStatus {
  required: true;
  /** `server-code` only on an install that had `PORTAL_SERVER_CODE` set: the old code, once. */
  methods: ('token' | 'server-code')[];
  tokenExpiresAt: string | null;
}

/**
 * `GET /api/session` (public; the path is kept so every client and script that asks it still works): who is signed in, and what a signed-out
 * visitor may do. `enabled` stays for older clients (false only while sign-in is switched off).
 */
export interface AuthStatus extends SessionStatus {
  user: UserSummary | null;
  setup: SetupStatus | null;
  registration: RegistrationMode;
  /** The dev seed is on (never in production): the page shows a red banner and `POST /api/login` takes the seed code. */
  devSeed: boolean;
}

export interface SetupRequest {
  /** The setup token, or the old server code (the second only where `setup.methods` lists it). */
  credential: string;
  username: string;
  displayName: string;
  password: string;
}

export interface PasswordLoginRequest {
  username: string;
  password: string;
  /** "Keep me signed in on this device": 30 days unused instead of 12 hours. */
  keepSignedIn?: boolean;
}

export interface RegisterRequest {
  username: string;
  displayName: string;
  password: string;
}

/** Redeeming an invitation makes an ACTIVE account in one step (the invitation was the approval). */
export interface RedeemInvitationRequest extends RegisterRequest {
  code: string;
}

/** `registered`: signed in (setup, invitation). `pending`: an admin must approve first (open mode); the same answer whether or not the name was free. */
export type RegisterResult = { status: 'registered'; user: UserSummary } | { status: 'pending' };

export interface Me {
  user: User;
  session: LoginSession;
  /** Until when a recent password check still counts, or null. */
  reauthUntil: string | null;
}

export interface UpdateProfileRequest {
  displayName?: string;
}

export interface ChangePasswordRequest {
  current: string;
  next: string;
  /** Also revoke this person's Portal MCP tokens and agent tokens (an admin's reset always does). Every other sign-in ends either way. */
  revokeTokens?: boolean;
}

/** `POST /api/auth/reauth`: the password again, for a sensitive action; counts `SESSION_LIFETIME.reauthMs`. */
export interface PasswordCheckRequest {
  password: string;
}

/** One sign-in of the person: a browser or an installed app on a device. */
export interface LoginSession {
  id: string;
  current: boolean;
  /** `Chrome on Linux`, from the User-Agent; text the person recognises, clipped. */
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  kept: boolean;
  /** The first-party client this sign-in belongs to (`vscode`, `cli`), or null for a browser. Clients sign in by the device flow and hold a token, not a cookie. */
  client: string | null;
}

/* ---------- Administration (platform admins) ---------- */

// An admin makes an account by making an INVITATION bound to its username and role (`CreateInvitationRequest`): the person redeems it and chooses
// their own password. There is no "create a user with a password" request.

export interface UpdateUserRequest {
  displayName?: string;
  role?: UserRole;
  state?: 'active' | 'disabled';
  /** Required when disabling; kept in the audit. */
  reason?: string;
}

/** `POST /api/users/:id/reset-password`: the old password dies and every sign-in and token of the person ends at once; the code is shown once. */
export interface ResetPasswordResult {
  /** `cprst_` plus 256 bits; the link is `<origin>/reset#<code>`. Single use, stored as a hash. */
  code: string;
  expiresAt: string;
}

/** `POST /api/auth/reset`: public and throttled like an invitation. Signs the person in on success. */
export interface RedeemResetRequest {
  code: string;
  password: string;
}

/** What an admin moves when a person leaves: every object the disabled user owns, to one user, audited object by object. */
export interface ReassignRequest {
  to: UserId;
}
export interface ReassignResult {
  moved: Record<string, number>;
}

export type InvitationState = 'pending' | 'used' | 'expired' | 'revoked';

export interface Invitation {
  id: string;
  createdBy: UserSummary;
  createdAt: string;
  expiresAt: string;
  role: UserRole;
  /** The username the invitation is for, or null: whoever holds the code picks one. */
  username: string | null;
  note: string | null;
  state: InvitationState;
  usedBy: UserSummary | null;
  usedAt: string | null;
}

export interface CreateInvitationRequest {
  role?: UserRole;
  username?: string;
  note?: string;
  ttlDays?: number;
}
export interface CreatedInvitation {
  invitation: Invitation;
  /** Shown once. The link is `<origin>/invite#<code>`: the code stays in the fragment, so no server, proxy or Referer sees it. */
  code: string;
}

export interface PendingRegistration {
  id: UserId;
  username: string;
  displayName: string;
  requestedAt: string;
}

export interface IdentitySettings {
  registration: RegistrationMode;
  /** Members (not only admins) may make invitations, within `INVITATION.perInviterPerDay`. */
  membersMayInvite: boolean;
  invitationTtlDays: number;
  /** Sign-in is accepted (false = nobody new signs in; people already signed in stay). */
  signInEnabled: boolean;
  /** Which shares to another user wait for that person to accept (sharing PRD FR8): `view` and above, `operate` and above (default), or none. Team shares never wait. */
  sharingAcceptance: 'always' | 'operate' | 'never';
}

/* ---------- Audit ---------- */

export const AUDIT_ACTIONS = [
  'setup.token_issued', 'setup.completed',
  'auth.login', 'auth.login_failed', 'auth.lockout', 'auth.logout', 'auth.password_changed', 'auth.password_check_failed',
  'auth.session_revoked', 'auth.sessions_revoked_all',
  'user.registered', 'user.approved', 'user.rejected', 'user.created', 'user.disabled', 'user.enabled', 'user.role_changed',
  'user.password_reset', 'user.reset_redeemed', 'user.reassigned', 'user.deleted', 'user.profile_changed',
  'invitation.created', 'invitation.redeemed', 'invitation.revoked', 'invitation.failed',
  'registration.mode_changed',
  'share.created', 'share.accepted', 'share.declined', 'share.updated', 'share.revoked', 'share.left', 'share.expired',
  'team.created', 'team.renamed', 'team.deleted', 'team.invited', 'team.invite_accepted', 'team.invite_declined', 'team.invite_revoked',
  'team.member_removed', 'team.left', 'team.role_changed',
  'object.claimed', 'object.reassigned', 'object.created', 'object.deleted',
  'authz.denied', 'authz.no_policy',
  'token.created', 'token.revoked', 'token.dead_owner_disabled',
  'bypass.entered', 'bypass.left', 'approval.decided', 'setting.changed',
  'terminal.opened', 'credential.exposed', 'secret.assigned', 'secret.rotated', 'secret.revoked',
  'dev_seed.login',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * A row of the PLATFORM AUDIT (`platform_audit`, the table the platform track made: `PlatformAuditEntry` in notify.ts, written by
 * `PlatformAudit.record`, read at `NOTIFY_API.audit`: a person reads their own rows, an admin all). Identity, sharing, teams and denied decisions write
 * their rows there too, with `kind` = an `AuditAction`, `actor` = `actorString(...)`, `userId` = the person it concerns, `subject` = `<type>:<id>`.
 * Two columns are added for them: `outcome` and `ip`; security rows are `protected` (append-only, kept a year).
 */
export interface AuditRow extends PlatformAuditEntry {
  outcome: 'ok' | 'denied' | 'failed';
  ip: string | null;
}

/** Filters of `GET /api/platform/audit` that identity adds (kind prefix, person, outcome); the route is `NOTIFY_API.audit`. */
export interface AuditQuery {
  action?: string;
  actor?: UserId;
  objectType?: string;
  objectId?: string;
  outcome?: AuditRow['outcome'];
  before?: number;
  limit?: number;
}

/* ---------- Routes ---------- */

export const IDENTITY_API = {
  /** Public. The path every client already uses (see AuthStatus). */
  status: '/api/session',
  /** Public until the first account exists, then 404 for ever. GET: the status; POST: SetupRequest -> signs in. */
  setup: '/api/setup',
  /** PasswordLoginRequest -> Me. Public; throttled per username and per address. */
  login: '/api/auth/login',
  /** The dev seed's sign-in (`{ code, as? }`), answered only while the seed is on; 404 otherwise. The recipe scratch portals and QA scripts use. */
  devLogin: '/api/login',
  logout: '/api/auth/logout',
  /** The old path, kept for scripts: the same as `logout`. */
  logoutLegacy: '/api/logout',
  register: '/api/auth/register',
  redeem: '/api/auth/invitation',
  /** Redeem a reset code (`RedeemResetRequest`): public, throttled. */
  reset: '/api/auth/reset',
  me: '/api/auth/me',
  avatar: (sha: string) => `/api/users/avatars/${sha}`,
  myAvatar: '/api/auth/me/avatar',
  password: '/api/auth/password',
  reauth: '/api/auth/reauth',
  sessions: '/api/auth/sessions',
  sessionOne: (id: string) => `/api/auth/sessions/${id}`,
  revokeOthers: '/api/auth/sessions/revoke-others',
  /** An exact username (case-insensitive) -> UserSummary or 404: what sharing and team invitations use. Throttled per person. */
  lookup: (username: string) => `/api/users/by-username/${encodeURIComponent(username)}`,

  users: '/api/users',
  user: (id: UserId) => `/api/users/${id}`,
  resetPassword: (id: UserId) => `/api/users/${id}/reset-password`,
  reassign: (id: UserId) => `/api/users/${id}/reassign`,
  registrations: '/api/registrations',
  approve: (id: UserId) => `/api/registrations/${id}/approve`,
  reject: (id: UserId) => `/api/registrations/${id}/reject`,
  invitations: '/api/invitations',
  invitation: (id: string) => `/api/invitations/${id}`,
  settings: '/api/identity/settings',
  /** Objects with no owner (found in a runtime or restored): an admin lists and claims them. */
  unclaimed: '/api/admin/unclaimed',
} as const;

/* ---------- Error codes ---------- */

export const IDENTITY_ERROR_CODES = {
  /** Sign-in or registration before the first account exists: go to setup (409). */
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  /** `/api/setup` after the first account exists (404, the same as no such route). */
  SETUP_DONE: 'SETUP_DONE',
  /** An invitation or a reset code that is unknown, used, expired or revoked: one answer for all four (400). */
  INVITE_INVALID: 'INVITE_INVALID',
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  /** Taken or reserved: one answer (409). */
  USERNAME_UNAVAILABLE: 'USERNAME_UNAVAILABLE',
  /** The last active admin cannot be disabled, demoted or deleted (409). */
  LAST_ADMIN: 'LAST_ADMIN',
  /** The password breaks a rule: `details.problems` is a PasswordProblem[] (422). */
  PASSWORD_REJECTED: 'PASSWORD_REJECTED',
  /** Too many failures for this name or address (429 with Retry-After); the same text whether or not the account exists. */
  LOCKED_OUT: 'LOCKED_OUT',
} as const;
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[keyof typeof IDENTITY_ERROR_CODES];
