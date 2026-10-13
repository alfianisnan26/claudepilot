import { NOTIFY_KIND_INFO, type MuteDuration, type MuteScopeType, type NotifyDestination, type NotifyMute } from '@portal/contracts';

/** The subjects a rule can be narrowed to by hand, in the order the picker lists them. */
export const MUTE_SCOPE_LABEL: Record<MuteScopeType, string> = {
  workspace: 'Workspace',
  repo: 'Repository',
  pipeline: 'Pipeline',
  environment: 'Environment',
  session: 'Session',
  ticket: 'Ticket',
  ci_run: 'CI run',
  claude: 'Claude',
  trigger: 'Trigger',
  trigger_run: 'Trigger run',
  budget: 'Budget',
};
export const HAND_SCOPES: MuteScopeType[] = ['workspace', 'repo', 'pipeline', 'environment', 'session', 'ticket'];

/** What to type for each subject (the id the portal matches). */
export const SCOPE_HINT: Partial<Record<MuteScopeType, string>> = {
  workspace: 'kubernetes/dev',
  repo: 'claudepilot',
  pipeline: 'repo/pipeline',
  environment: 'repo/environment',
  session: 'Session id',
  ticket: 'T-12',
};

export const DURATION_LABEL: Record<MuteDuration, string> = { '1h': '1 hour', '1d': '1 day', forever: 'Forever' };

/** A rule in words: "CI failed · claudepilot · deploy", or "CI failed · all". */
export const muteLine = (m: Pick<NotifyMute, 'kind' | 'scope'>): string => `${NOTIFY_KIND_INFO[m.kind].label} · ${m.scope ? m.scope.label : 'all'}`;

/** Where it applies: every device and channel, or one by name ("a removed device" when it is gone). */
export const muteWhere = (m: Pick<NotifyMute, 'destinationId'>, destinations: readonly Pick<NotifyDestination, 'id' | 'name'>[]): string =>
  m.destinationId ? (destinations.find((d) => d.id === m.destinationId)?.name ?? 'A removed device') : 'Everywhere';

/** "Forever", or what is left: "45 min left", "5 h left", "2 d left". */
export function expiryText(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return 'Forever';
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return 'Ended';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min left`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h left`;
  return `${Math.round(h / 24)} d left`;
}

/** "Hushed 3", or "None hushed yet". */
export const hushedText = (n: number): string => (n > 0 ? `Hushed ${n}` : 'None hushed yet');
