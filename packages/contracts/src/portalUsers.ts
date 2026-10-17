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
  /** At least 15 characters (PASSWORD); not a common password, not the email. */
  password: string;
}

export interface UpdatePortalUserRequest {
  displayName?: string;
  state?: 'active' | 'disabled';
  /** A new password for the account (the same policy). */
  password?: string;
}

/** A plain check (one @, a dot in the domain, no spaces); the real check is that mail reaches it, which MU1-min does not send. */
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export const normalizeEmail = (raw: string): string => raw.normalize('NFKC').trim().toLowerCase();

export const PORTAL_USER_API = {
  /** GET: `PortalUser[]`. POST `CreatePortalUserRequest`: the new `PortalUser`. Signed in only. */
  list: '/api/admin/users',
  /** PATCH `UpdatePortalUserRequest`: `PortalUser`. DELETE: remove it. Signed in only. */
  one: (id: string) => `/api/admin/users/${encodeURIComponent(id)}`,
} as const;
