// Enrollment tokens (docs/prd/targets-connect.md §10.1): `cpen_` plus 256 random bits. Only the SHA-256 is stored (with the last four characters
// for lists); the token itself is shown once, in the reply that made it, and is never written anywhere.

import { createHash, randomBytes } from 'node:crypto';
import { CONNECT_ID_PREFIX, CONNECT_TOKEN_PREFIX, isConnectToken, type ConnectEnrollment, type ConnectEnrollmentState } from '@portal/contracts';
import type { EnrollmentRow } from './store.js';

export const generateToken = (): string => `${CONNECT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const tokenLast4 = (token: string): string => token.slice(-4);
export const newNodeId = (): string => `${CONNECT_ID_PREFIX.node}${randomBytes(6).toString('hex')}`;
export const newEnrollmentId = (): string => `${CONNECT_ID_PREFIX.enrollment}${randomBytes(6).toString('hex')}`;

/** The token of an `Authorization: Bearer …` header, or null when the header is missing or is not shaped like a token (it is never echoed). */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m && isConnectToken(m[1]!) ? m[1]! : null;
}

/** `revoked` beats `used` beats `expired` beats `waiting`. */
export function enrollmentState(e: EnrollmentRow, now: Date): ConnectEnrollmentState {
  if (e.revokedAt) return 'revoked';
  if (e.uses >= e.maxUses) return 'used';
  if (Date.parse(e.expiresAt) <= now.getTime()) return 'expired';
  return 'waiting';
}

export const toEnrollment = (e: EnrollmentRow, now: Date): ConnectEnrollment => ({
  id: e.id,
  targetId: e.targetId,
  last4: e.last4,
  platform: e.platform,
  state: enrollmentState(e, now),
  uses: e.uses,
  maxUses: e.maxUses,
  expiresAt: e.expiresAt,
  createdAt: e.createdAt,
  createdBy: e.createdBy,
});
