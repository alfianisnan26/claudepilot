// The identity rows of the platform audit (identity PRD FR25, FR42): one thin call over the platform track's `PlatformAudit.record`,
// marking every row `protected` (append-only, kept a year by the triggers of migration 401). `detail` holds names, ids and numbers only:
// never a password, a hash, a token, a code or the text typed into a username field (a failed sign-in for an unknown name carries a
// fingerprint, FR25).

import { createHash } from 'node:crypto';
import { actorString, type Actor, type AuditAction } from '@portal/contracts';
import type { AuditInput, PlatformAudit } from '../platform/audit.js';

export interface SecurityEvent {
  action: AuditAction;
  /** Who did it: an actor, or a string the CLI and the seed write (`cli:<os user>`, `dev-seed`, `setup`). */
  actor: Actor | string;
  /** The person it concerns. */
  userId: string | null;
  /** `user:<id>`, `session:<id>`, `invitation:<id>`. */
  subject?: string | null;
  outcome?: 'ok' | 'denied' | 'failed';
  ip?: string | null;
  severity?: AuditInput['severity'];
  detail?: Record<string, unknown>;
}

export type RecordSecurity = (e: SecurityEvent) => void;

/** `unknown:` plus the first 8 hex of the SHA-256 of a normalised name that matched no account: the name itself is never stored. */
export const unknownName = (normalisedName: string): string => `unknown:${createHash('sha256').update(normalisedName).digest('hex').slice(0, 8)}`;

/** Makes the recorder over the platform audit. `audit` may be absent in a test; then nothing is written. */
export function securityRecorder(audit: Pick<PlatformAudit, 'record'> | null | undefined): RecordSecurity {
  return (e) => {
    if (!audit) return;
    audit.record({
      kind: e.action,
      actor: typeof e.actor === 'string' ? e.actor : actorString(e.actor),
      userId: e.userId,
      subject: e.subject ?? null,
      severity: e.severity ?? (e.outcome === 'denied' || e.outcome === 'failed' ? 'medium' : 'info'),
      outcome: e.outcome ?? 'ok',
      ip: e.ip ?? null,
      protected: true,
      detail: e.detail,
    });
  };
}
