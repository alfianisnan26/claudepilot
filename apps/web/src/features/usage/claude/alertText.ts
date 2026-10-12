// What a toast says about a Claude usage alert (docs/prd/claude-usage.md §12 and §20.4). Pure, so the wording is tested.

import type { ClaudeUsageAlert, SpendAlert } from '@portal/contracts';
import { localTime, pctText } from './format';

type Clock = (iso: string | null) => string;

/**
 * One alert in a few words. A threshold alert: "Satria: week 95 %", or for a window that stops the Claude "Satria: out until 14:20". A
 * projection alert (the window is estimated to run out before it resets) is worded from its estimate, never as a threshold: "Satria: session
 * out ~06:56 · resets 07:26".
 */
export function alertWords(a: ClaudeUsageAlert, clock: Clock = (iso) => localTime(iso)): string {
  if (a.kind === 'projection') return `${a.claudeName}: ${a.label.toLowerCase()} out${a.etaAt ? ` ~${clock(a.etaAt)}` : ''}${a.resetsAt ? ` · resets ${clock(a.resetsAt)}` : ''}`;
  if (a.level === 'exhausted') return a.window === 'session' || a.window === 'week' ? `${a.claudeName}: out${a.resetsAt ? ` until ${clock(a.resetsAt)}` : ''}` : `${a.claudeName}: ${a.label.toLowerCase()} used up`;
  return `${a.claudeName}: ${a.label.toLowerCase()} ${pctText(a.usedPct)}`;
}

/** The words of several alerts as one toast: the first two, and how many more. */
function joinWords(words: string[]): string {
  const [a, b] = words;
  return words.length > 2 ? `${a} · ${b} · +${words.length - 2}` : words.length === 2 ? `${a} · ${b}` : (a ?? '');
}

/** The text of one toast for the plan alerts that are new here: the first two, and how many more. */
export function alertToast(alerts: ClaudeUsageAlert[], clock?: Clock): string {
  return joinWords(alerts.map((a) => alertWords(a, clock)));
}

/**
 * One toast for the new plan alerts and the new budget and spike alerts together (docs/prd/claude-usage.md §23.4, §24.2): the portal words a
 * spend alert itself in one terse line ("api daily: 95 %", "Satria: 24 requests in 10 min"), shown as it is, after the plan alerts.
 */
export function alertsToast(plan: ClaudeUsageAlert[], spend: Pick<SpendAlert, 'summary'>[], clock?: Clock): string {
  return joinWords([...plan.map((a) => alertWords(a, clock)), ...spend.map((a) => a.summary)]);
}

/** Where a toast's View goes: the tab of the first alert it names (a budget, a spike, else the Claudes). */
export function alertsTab(plan: ClaudeUsageAlert[], spend: Pick<SpendAlert, 'kind'>[]): 'claudes' | 'budgets' | 'spikes' {
  if (plan.length) return 'claudes';
  return spend[0]?.kind === 'spike' ? 'spikes' : spend[0]?.kind === 'budget' ? 'budgets' : 'claudes';
}
