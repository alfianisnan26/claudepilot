// The line above the composer while the engine holds a chat (T-105): waiting for quota, or a move at the end of this turn. Read only:
// nothing to press; the ⓘ says why and what happens next.
import { Hourglass } from 'lucide-react';
import type { AutoSessionState } from '@portal/contracts';
import { InfoTip } from '@/components/InfoTip';
import { holdLine } from './pure';

export function HoldLine({ state }: { state: AutoSessionState | null }) {
  const line = holdLine(state, Date.now());
  if (!line) return null;
  return (
    <div role="status" className="flex min-w-0 items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-2.5">
      <Hourglass className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[13px] font-medium [overflow-wrap:anywhere] text-ink-soft">{line.title}</p>
      <InfoTip label="About this wait">{line.tip}</InfoTip>
    </div>
  );
}
