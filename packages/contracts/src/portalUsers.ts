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

/* ---------- Session delegation (owner, 2026-10-17) ---------- */

/** `view`: read the session live. `operate`: also send messages, stop a turn and answer its approvals. Nothing else of the workspace. */
export type SessionGrantLevel = 'view' | 'operate';

export interface SessionGrant {
  sessionId: string;
  userId: string;
  level: SessionGrantLevel;
  grantedBy: string;
  createdAt: string;
}

/** A session delegated to the signed-in account, as its own page shows it (no workspace detail beyond its name). */
export interface DelegatedSession {
  id: string;
  title: string;
  state: string;
  workspaceId: string;
  waiting: number;
  level: SessionGrantLevel;
}

export interface SessionGrantRequest {
  userId: string;
  level: SessionGrantLevel;
  acknowledgeBypass?: boolean;
}

/** The most events one delegate read returns (`?after=` or a page); past it, the newest. */
export const DELEGATED_EVENTS_MAX = 200;

export const SESSION_GRANT_API = {
  /**
   * Full session only. GET: `SessionGrant[]`. PUT `SessionGrantRequest`: the grant. Operate on a session in Bypass needs
   * `acknowledgeBypass: true` (whoever can message it can make the agent run any command in its workspace).
   */
  grants: (sessionId: string) => `/api/admin/session-grants/${encodeURIComponent(sessionId)}`,
  /** Full session only. DELETE: revoke one account's grant. */
  grant: (sessionId: string, userId: string) => `/api/admin/session-grants/${encodeURIComponent(sessionId)}/${encodeURIComponent(userId)}`,
  /** An account session. GET: `DelegatedSession[]` (what was delegated to me). */
  mine: '/api/me/sessions',
  /** An account session with a grant. GET: `DelegatedSession`. */
  one: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}`,
  /**
   * GET `?after=<seq>`: `ChatEvent[]` after a seq, at most `DELEGATED_EVENTS_MAX` (the newest when more); otherwise a `ChatEventPage`
   * (`?before=&limit=`). Only what the delegate's view shows: messages, tool names, approvals and errors of the main thread; no tool
   * output, thinking, inputs or sub-agent lines.
   */
  events: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/events`,
  /** POST `{ text, uuid }` (operate). */
  send: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/send`,
  /** POST `{ requestId, decision: 'allow' | 'deny', note? }` (operate). */
  respond: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/respond`,
  /** POST (operate): stop the running turn. */
  stop: (id: string) => `/api/me/sessions/${encodeURIComponent(id)}/stop`,
} as const;
