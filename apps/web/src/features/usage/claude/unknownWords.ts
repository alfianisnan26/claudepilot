// T-255: what the usage page says for a Claude whose usage is not known, and for a limit a chat reported. Pure, so it is tested.
// Text diet: one or two words on the row, the detail in an InfoTip. A number shown has a source: an unknown reading is never "0 %".

import { reasonText, type ClaudeUsage, type ClaudeUsageWindow } from '@portal/contracts';

/** The short reason a row shows after "Unavailable:". */
const SHORT: Partial<Record<NonNullable<ClaudeUsage['unavailable']>, string>> = {
  signed_out: 'not signed in',
  no_usage_endpoint: 'no usage endpoint',
  no_reading: 'not read yet',
  no_reset_time: 'no reset time',
  no_window: 'no session window',
  no_number: 'no number',
  period_reset: 'window reset',
};

/** "Unavailable: no reset time", with the detail; null when the usage is measured (or the Claude has no plan limits). */
export function unavailableWords(c: Pick<ClaudeUsage, 'unavailable' | 'runsOn'>): { line: string; tip: string } | null {
  const why = c.unavailable;
  if (!why || c.runsOn === 'pool' || c.runsOn === 'key') return null;
  const tip =
    why === 'no_reset_time'
      ? 'Claude Code gave its session window no reset time (it says 0 % that way both for an unused window and when it can’t tell), so its usage is unknown. Auto move never prefers it to a Claude with a measured reading.'
      : `${reasonText(why)} Auto move never prefers it to a Claude with a measured reading.`;
  return { line: `Unavailable: ${SHORT[why] ?? 'unknown'}`, tip };
}

/** A window whose number has no basis: 0 % with no reset time is not a reading. */
export const blindWindow = (w: Pick<ClaudeUsageWindow, 'usedPct' | 'resetsAt'>): boolean => w.resetsAt === null && (w.usedPct ?? 0) === 0;

const clock = (iso: string, nowMs: number) => {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return new Date(nowMs).toDateString() === t.toDateString() ? hm : `${t.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
};

/** "Limit hit · until 23:00", with its source; null without a report (or once it ran out). */
export function limitReportWords(c: Pick<ClaudeUsage, 'limitReport'>, nowMs: number): { line: string; tip: string } | null {
  const r = c.limitReport;
  if (!r || Date.parse(r.until) <= nowMs) return null;
  const until = clock(r.until, nowMs);
  const source = r.guessed ? 'The message gave no time the portal could read, so it counts as used up until the next 5-hour boundary (a guess).' : 'Until: the reset time that message stated.';
  return {
    line: `Limit hit · until ${until}`,
    tip: `Limit reported by a chat at ${clock(r.at, nowMs)}, until ${until}: Claude Code answered a turn with its limit message (${r.label}). ${source} Auto move treats this Claude as used up until then.`,
  };
}
