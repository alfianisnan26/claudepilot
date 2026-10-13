export type { ApiErrorBody, ApiSuccess } from '@isnanme/core';

/** Where the current server code came from. */
export type CodeSource = 'env' | 'generated' | 'custom';

/** `GET /api/session`: public, tells the login page what to show. */
export interface SessionStatus {
  authenticated: boolean;
  /** Whether new sign-ins are accepted. */
  enabled: boolean;
  /**
   * How this portal signs people in (T-118): `password` once an account exists (username and password; the server code is no longer a
   * credential), `code` only on a portal with no account yet (a fresh or scratch install). Absent from an older server: read it as `code`.
   */
  signIn?: 'password' | 'code';
  /** Who is signed in, when `authenticated` and signed in with a password; null for a code sign-in or nobody. */
  user?: SignedInUser | null;
}

/** The signed-in person as the app shell shows them. */
export interface SignedInUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
}

/** Everything the admin view shows. */
export interface AdminState {
  /** The server code; empty once accounts exist (T-118): it is no longer a credential and is not shown. */
  code: string;
  /** Whether the server code still signs in (only on a portal with no account yet, or `auth.codeLogin` on). */
  codeLogin?: boolean;
  source: CodeSource;
  enabled: boolean;
  /** ISO time the code was last set (startup or rotation). */
  codeUpdatedAt: string;
  /** Signed-in sessions, this one included. */
  sessions: number;
  /** When this session signed in (ISO). */
  signedInAt: string;
}

/** Whether the portal trusts its own state enough to change workspaces (foundation PRD §6.5). */
export type TrustState = 'ok' | 'locked' | 'frozen';

/** `GET /api/admin/system`: the portal's database, secret key and backups. */
export interface SystemStatus {
  portalId: string | null;
  schemaVersion: number | null;
  trust: { state: TrustState; reasons: { code: string; message: string }[] };
  /** "Resume delivery" can clear the freeze (a restore or an admin pause). */
  resumable: boolean;
  /** ISO time of the newest backup, any kind. */
  lastBackupAt: string | null;
  backups: number;
  secretKey: {
    /** Where the key in use came from; null while Locked. */
    source: 'env' | 'file' | 'panel' | null;
    /** The database never had a key: "Set up encryption" can create one. */
    canSetUp: boolean;
    /** The database has a key the portal doesn't have: "Unlock" with it. */
    canUnlock: boolean;
    /**
     * That key was lost but nothing was ever encrypted with it, so "Start over" can replace it
     * without losing anything. False as soon as one secret is stored.
     */
    canReset: boolean;
    /** PORTAL_SECRET_KEY_FILE, when set: a key set up or unlocked in the panel is saved there if it's empty. */
    keyFile: string | null;
  };
}

/** `POST /api/admin/system/key/setup`: the new key, shown once. */
export interface KeySetupResult {
  key: string;
  /** The key file it was saved to, or null when it's kept in memory until the portal restarts. */
  savedTo: string | null;
  status: SystemStatus;
}

export interface KeyUnlockResult {
  savedTo: string | null;
  status: SystemStatus;
}

/**
 * `POST /api/login`: a username and password (T-118), or the server code on a portal that has no account yet. Once an account exists a
 * code is refused with one clear message.
 */
export type LoginRequest = { username: string; password: string; keepSignedIn?: boolean } | { code: string };

/** Omit `code` to generate a new one. */
export interface RotateCodeRequest {
  code?: string;
}

export interface SetEnabledRequest {
  enabled: boolean;
}

export const API = {
  session: '/api/session',
  login: '/api/login',
  logout: '/api/logout',
  adminState: '/api/admin/state',
  rotateCode: '/api/admin/code',
  enabled: '/api/admin/enabled',
  system: '/api/admin/system',
  resumeDelivery: '/api/admin/system/resume',
  keySetup: '/api/admin/system/key/setup',
  keyUnlock: '/api/admin/system/key/unlock',
  keyReset: '/api/admin/system/key/reset',
} as const;
