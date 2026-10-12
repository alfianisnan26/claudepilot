import { cn } from '@isnanme/ui';
import { USAGE_THRESHOLDS, type Headroom } from '@portal/contracts';
import { headroomLine, TONE_TEXT, type Tone } from './format';
import { Bar } from './Meter';
import { headroomOfClaude, useClaudeRow, useNow } from './useClaudeUsage';

/** What a Claude has left as the portal's `headroom(claudeId)` says it, or null while the snapshot loads or the Claude isn't listed. */
export function useHeadroom(claudeId: string): Headroom | null {
  const row = useClaudeRow(claudeId);
  const now = useNow(60_000);
  return row ? headroomOfClaude(row, now) : null;
}

const toneOfPct = (pct: number): Tone => (pct >= USAGE_THRESHOLDS.critical ? 'danger' : pct >= USAGE_THRESHOLDS.warn ? 'gold' : 'ok');

/**
 * One terse line: how much of its fullest window a Claude has used and when that resets ("Session 41 % · resets 14:20"),
 * "Out until 14:20", "No plan limits" or "Not signed in". For the switch dialog, so a person sees the destination's headroom
 * before moving a chat. Dimmed when the reading is old. Reads the shared snapshot: it asks the portal for nothing.
 */
export function ClaudeHeadroom({ claudeId, className }: { claudeId: string; className?: string }) {
  const h = useHeadroom(claudeId);
  const now = useNow(60_000);
  if (!h) return null;
  const tone: Tone = h.kind === 'plan' && h.limiting ? (h.exhausted ? 'danger' : toneOfPct(h.limiting.usedPct)) : 'quiet';
  const line = headroomLine(h, now);
  return (
    <span className={cn('inline-flex items-center gap-2 text-[12.5px]', TONE_TEXT[tone], h.stale && 'opacity-60', className)} title={h.blockedModels.length ? `${h.blockedModels.join(', ')} used up` : undefined}>
      {h.kind === 'plan' && h.limiting && <Bar pct={h.exhausted ? 100 : h.limiting.usedPct} tone={tone} className="w-8" />}
      <span>{line}</span>
    </span>
  );
}
