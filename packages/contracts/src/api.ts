export type { ApiErrorBody, ApiSuccess } from '@isnanme/core';

/** Where the current server code came from. */
export type CodeSource = 'env' | 'generated' | 'custom';

/** `GET /api/session`: public, tells the login page what to show. */
export interface SessionStatus {
  authenticated: boolean;
  /** Whether new sign-ins are accepted. */
  enabled: boolean;
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
}

export interface LoginRequest {
  code: string;
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
} as const;
