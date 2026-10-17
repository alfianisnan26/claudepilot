export type { ApiErrorBody, ApiSuccess } from '@isnanme/core';

/** Where the current server code came from. */
export type CodeSource = 'env' | 'generated' | 'custom';

/** `GET /api/session`: public, tells the login page what to show. */
export interface SessionStatus {
  authenticated: boolean;
  /** Whether new sign-ins are accepted. */
  enabled: boolean;
  /** Whether at least one email account exists (the sign-in page then offers email first). Absent from an older server. */
  emailSignIn?: boolean;
  /** Signed in as a MEMBER account (MU2 S1a): `authenticated` is true but the admin app is closed to it; the web shows the member page. */
  member?: boolean;
}

/** Everything the admin view shows. */
export interface AdminState {
  code: string;
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

/** Sign in with the server code, or with an email account's email and password (T-118). */
export interface LoginRequest {
  code?: string;
  email?: string;
  password?: string;
}

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
