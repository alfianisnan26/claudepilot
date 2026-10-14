// T-102: what the "Tools changed" hint says and offers, from the session alone (pure, so each state is tested without a browser).
// The chip is one short line that can be tapped at any time; the sheet lists what changed and the actions for the state. Never a
// disabled button with the reason hidden: where something can't be done, the line says why.

import { RESTART_LONG_TURN_MS, type ChatConfigChange, type ChatSession } from '@portal/contracts';

/** What each area reads as in the sheet. */
export const CHANGE_LABELS: Record<ChatConfigChange, string> = {
  mcpset: 'MCP servers',
  settings: 'Settings',
  policy: 'Policy',
  secrets: 'Secrets & env',
  account: 'Account',
  persona: 'Persona',
  context: 'Context',
  skillset: 'Skills',
  browser: 'Browser',
  foundation: 'Portal files',
  portal_tools: 'Portal tools',
  other: 'Delivered files',
};

/**
 * `idle`: nothing runs, Restart now is one tap. `busy`: a turn or a task runs; after this turn, or now behind a confirmation.
 * `queued`: the person asked for after this turn. `auto`: the portal restarts by itself at the turn's end. `held`: it won't by itself
 * (Bypass could not be kept). `restarting`: under way.
 */
export type HintState = 'idle' | 'busy' | 'queued' | 'auto' | 'held' | 'restarting';

export interface HintView {
  state: HintState;
  /** The chip's one line. */
  line: string;
  /** The chip's own inline action, besides opening the sheet: Cancel for a queued restart, Restart now for an automatic one that waits long. */
  inline: 'cancel' | 'now' | null;
  /** The areas that changed, as labels, newest first. Empty for a restart the person queued without a change. */
  changes: string[];
  /** The turn has run longer than {@link RESTART_LONG_TURN_MS}: Restart now is offered prominently. */
  long: boolean;
  /** A restart now drops Bypass (the policy or the session can't keep it): the confirmation says so. */
  dropsBypass: boolean;
}

/** Whether a turn or a task runs (T-41: working while either does), or an approval waits. */
export const isBusy = (s: ChatSession) => s.state === 'working' || s.state === 'waiting';

/** The hint for a session, or null when there is nothing to show (no change, hidden, ended, moving). `now` in ms. */
export function restartHint(s: ChatSession | null | undefined, now: number): HintView | null {
  if (!s || s.state === 'ended' || s.switching) return null;
  const change = s.configChanged ?? (s.configChangedAt ? { at: s.configChangedAt, reasons: ['other' as const] } : null);
  const queued = s.restartQueued ?? null;
  if (!change && !queued && !s.restarting) return null;
  const hidden = !!change && !!s.configHiddenAt && Date.parse(change.at) <= Date.parse(s.configHiddenAt);
  // Hidden until the next change, unless the person queued a restart (its Cancel stays in reach) or one is under way.
  if (hidden && queued !== 'person' && !s.restarting) return null;
  const changes = (change?.reasons ?? []).map((r) => CHANGE_LABELS[r] ?? CHANGE_LABELS.other);
  const since = s.busySince ? Date.parse(s.busySince) : NaN;
  const long = isBusy(s) && Number.isFinite(since) && now - since > RESTART_LONG_TURN_MS;
  const dropsBypass = s.mode === 'bypassPermissions' && s.restartHeld === 'bypass';
  const base = { changes, long, dropsBypass };
  if (s.restarting) return { ...base, state: 'restarting', line: 'Restarting…', inline: null };
  if (s.restartHeld === 'bypass') return { ...base, state: 'held', line: 'Tools changed · restart by hand', inline: null };
  if (queued === 'person') return { ...base, state: 'queued', line: 'Restarts when the turn ends', inline: 'cancel' };
  if (queued === 'auto') return { ...base, state: 'auto', line: 'Restarts after this turn', inline: long ? 'now' : null };
  if (isBusy(s)) return { ...base, state: 'busy', line: s.state === 'waiting' ? 'Tools changed · approval waiting' : 'Tools changed · turn running', inline: null };
  return { ...base, state: 'idle', line: 'Tools changed', inline: null };
}

/** What "Restart now" stops, in plain words, for its confirmation; empty when nothing is lost (one tap). */
export function stopsNow(s: ChatSession, agents: string[], dropsBypass: boolean): string[] {
  const out: string[] = [];
  if (s.state === 'waiting') out.push('The approval waiting is dropped.');
  if (s.state === 'working' && !s.tasksOnly) out.push('The turn in flight is interrupted.');
  if (agents.length === 1) out.push(`${agents[0]} stops.`);
  else if (agents.length > 1) out.push(`${agents.length} agents stop: ${agents.slice(0, 3).join(', ')}${agents.length > 3 ? '…' : ''}.`);
  if (dropsBypass) out.push('Bypass turns off: it will ask before tools run.');
  return out;
}
