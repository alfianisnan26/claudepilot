import type { BadgeTone } from '@isnanme/ui';
import type { PortalAuditOutcome, PortalCallerScope, PortalScope, PortalToken } from '@portal/contracts';

export const SCOPE_LABEL: Record<PortalCallerScope, string> = { read: 'Read', operate: 'Operate', admin: 'Admin', agent: 'Agent' };

export const SCOPE_TONE: Record<PortalCallerScope, BadgeTone> = { read: 'neutral', operate: 'warning', admin: 'danger', agent: 'neutral' };

/** One terse line per scope, shown under the picker (the decision it informs). */
export const SCOPE_HELP: Record<PortalScope, string> = {
  read: 'Look, don’t touch.',
  operate: 'Start and stop, work tickets.',
  admin: 'Everything, with confirmations.',
};

export const OUTCOME: Record<PortalAuditOutcome, { label: string; tone: BadgeTone }> = {
  ok: { label: 'OK', tone: 'success' },
  error: { label: 'Error', tone: 'danger' },
  denied: { label: 'Denied', tone: 'danger' },
  rate_limited: { label: 'Limited', tone: 'warning' },
  confirmation_required: { label: 'Confirm', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'warning' },
};

export const DAYS = [7, 30, 90, 365] as const;

/** Whether a token can still be used, and the words for when it can't. */
export function tokenState(t: PortalToken, now = Date.now()): { live: boolean; label: string; tone: BadgeTone } {
  if (t.revokedAt) return { live: false, label: 'Revoked', tone: 'danger' };
  if (Date.parse(t.expiresAt) <= now) return { live: false, label: 'Expired', tone: 'warning' };
  const days = Math.ceil((Date.parse(t.expiresAt) - now) / 86_400_000);
  return { live: true, label: days <= 1 ? 'Expires today' : `${days} days left`, tone: days <= 7 ? 'warning' : 'neutral' };
}
