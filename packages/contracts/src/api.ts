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
} as const;
