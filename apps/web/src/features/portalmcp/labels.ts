import type { BadgeTone } from '@isnanme/ui';
import type { PortalAuditOutcome, PortalCallerScope, PortalScope, PortalToken, PortalTokenLifetime } from '@portal/contracts';

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

/** The picker's lifetimes (T-258): the short ones are for automation. */
export const LIFETIMES: { value: PortalTokenLifetime; label: string }[] = [
  { value: '15m', label: '15 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '365 days' },
];

/** Whether a token can still be used, and the words for when it can't. */
export function tokenState(t: PortalToken, now = Date.now()): { live: boolean; label: string; tone: BadgeTone } {
  if (t.revokedAt) return { live: false, label: 'Revoked', tone: 'danger' };
  if (Date.parse(t.expiresAt) <= now) return { live: false, label: 'Expired', tone: 'warning' };
  return { live: true, label: `${timeLeft(Date.parse(t.expiresAt) - now)} left`, tone: Date.parse(t.expiresAt) - now <= 7 * 86_400_000 ? 'warning' : 'neutral' };
}

/** `14 min`, `5 h`, `30 days`: rounded up, so a token never looks shorter-lived than it is. */
export function timeLeft(ms: number): string {
  if (ms <= 3_600_000) return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
  if (ms <= 86_400_000) return `${Math.ceil(ms / 3_600_000)} h`;
  const days = Math.ceil(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** The tokens of one label (a label names one client): newest first, the live ones, the newest expiry and the last use of any. */
export interface TokenGroup {
  label: string;
  tokens: PortalToken[];
  live: PortalToken[];
  /** The latest expiry among the live tokens; null when none is live. */
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** Groups tokens by label, the groups in the order of their newest token (the list comes newest first). */
export function groupTokens(tokens: PortalToken[], now = Date.now()): TokenGroup[] {
  const groups = new Map<string, TokenGroup>();
  const sorted = [...tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const t of sorted) {
    let g = groups.get(t.label);
    if (!g) groups.set(t.label, (g = { label: t.label, tokens: [], live: [], expiresAt: null, lastUsedAt: null }));
    g.tokens.push(t);
    if (tokenState(t, now).live) {
      g.live.push(t);
      if (!g.expiresAt || t.expiresAt > g.expiresAt) g.expiresAt = t.expiresAt;
    }
    if (t.lastUsedAt && (!g.lastUsedAt || t.lastUsedAt > g.lastUsedAt)) g.lastUsedAt = t.lastUsedAt;
  }
  return [...groups.values()];
}
