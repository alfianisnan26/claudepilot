// Auto move: the words and numbers the page shows, as pure functions (tested under Node).
import type { AutoMode, AutoSuggestion, AutoTransferEvent, Figure } from '@portal/contracts';

export const MODE_LABEL: Record<AutoMode, string> = { off: 'Off', ask: 'Ask', auto: 'Automatic' };

/** A percent with its basis: "8 %" measured, "8 % est." estimated, "–" unavailable. */
export function pctText(f: Figure | undefined | null): string {
  if (!f || f.value === null) return '–';
  const v = Math.round(f.value * 10) / 10;
  return `${v} %${f.basis === 'estimate' ? ' est.' : ''}`;
}

/** The card's first line: "Work is at 8 % left" (or "is used up"). */
export function headline(s: Pick<AutoSuggestion, 'from' | 'reason' | 'facts'>): string {
  if (s.reason === 'exhausted') return `${s.from.name} is used up`;
  return `${s.from.name} has ${pctText(s.facts.leftPct)} left`;
}

/** The card's second line: "Move to Home (40 % left)" or, for a Claude without plan limits, "Move to Console". */
export function offer(s: Pick<AutoSuggestion, 'to' | 'facts'>): string {
  const left = s.facts.destLeftPct && s.facts.destLeftPct.value !== null ? ` (${pctText(s.facts.destLeftPct)} left)` : '';
  return `Move to ${s.to.name}${left}`;
}

/** "Drops 1 approval, 2 messages" when a move would drop anything, else null. */
export function droppedText(d: AutoSuggestion['dropped']): string | null {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => k > 0 && parts.push(`${k} ${k === 1 ? one : many}`);
  n(d.approvals, 'approval', 'approvals');
  n(d.queued, 'message', 'messages');
  n(d.agents, 'agent', 'agents');
  return parts.length ? `Drops ${parts.join(', ')}` : null;
}

/** Why the card shows, in the ⓘ. */
export function reasonText(s: Pick<AutoSuggestion, 'reason' | 'facts' | 'handoff'>): string {
  const f = s.facts;
  const base =
    s.reason === 'exhausted'
      ? 'Its session or week limit is used up (measured).'
      : s.reason === 'low'
        ? `Its fullest limit has ${pctText(f.leftPct)} left (measured), at or under the threshold of ${f.thresholdPct} %.`
        : `At its current pace it runs out before it resets: ${pctText(f.projectedPct)} by the reset, out around ${f.etaAt?.value ? new Date(f.etaAt.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'} (an estimate from recent readings: used percent plus speed × time left).`;
  const handoff = s.handoff === 'skip' ? ' The stored conversation carries over; it can’t write a handoff now.' : ' It writes a handoff first.';
  return base + handoff;
}

/** The automatic moves of a chat in the last day, by the move's id (the "Moved to" divider's `handoffId`). */
export function autoMarks(events: AutoTransferEvent[], nowMs: number): Map<string, AutoTransferEvent> {
  const out = new Map<string, AutoTransferEvent>();
  const undone = new Set(events.filter((e) => e.kind === 'undone' && e.handoffId).map((e) => e.handoffId!));
  for (const e of events) {
    if (e.kind !== 'moved' || e.actor !== 'portal:autotransfer' || !e.handoffId) continue;
    if (nowMs - Date.parse(e.at) > 86_400_000) continue;
    if (!undone.has(e.handoffId)) out.set(e.handoffId, e);
  }
  return out;
}
