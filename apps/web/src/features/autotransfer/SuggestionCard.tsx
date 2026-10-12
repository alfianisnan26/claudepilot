// The card of `ask` mode (docs/prd/auto-transfer.md FR15), above the composer where the approval card sits: what is low, where the chat
// could go, Move · Later · Always automatic, and "Other…" among the alternatives. Move is the confirmation; the move shows in the chat.
import { Button, Menu, useToast } from '@isnanme/ui';
import { ArrowRightLeft, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { AutoSessionState } from '@portal/contracts';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { autoApi } from './api';
import { droppedText, headline, offer, reasonText } from './pure';

export function SuggestionCard({ state, allowAuto, disabled, onChange }: { state: AutoSessionState; allowAuto: boolean; disabled?: boolean; onChange: (s: AutoSessionState) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const s = state.pending;
  if (!s) return null;
  const act = (what: string, call: () => Promise<AutoSessionState>) => {
    setBusy(what);
    call().then(
      (next) => (setBusy(null), onChange(next)),
      (e: unknown) => (setBusy(null), toast(errorText(e, 'Couldn’t do that.'), 'error')),
    );
  };
  const dropped = droppedText(s.dropped);
  return (
    <div role="group" aria-label="Move suggested" className="rounded-2xl border border-line bg-surface p-4 shadow-lift">
      <div className="flex items-start gap-2.5">
        <ArrowRightLeft className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex min-w-0 items-center gap-1 text-sm font-semibold">
            <span className="truncate">{headline(s)}</span>
            <InfoTip label="Why this move">{reasonText(s)}</InfoTip>
          </p>
          <p className="truncate text-[13px] text-ink-soft">{offer(s)}</p>
          {dropped && <p className="text-xs font-medium text-danger">{dropped}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" loading={busy === 'move'} disabled={disabled || !!busy} onClick={() => act('move', () => autoApi.move(s.id))}>
          Move
        </Button>
        <Button size="sm" variant="secondary" loading={busy === 'later'} disabled={disabled || !!busy} onClick={() => act('later', () => autoApi.later(s.id))}>
          Later
        </Button>
        {allowAuto && (
          <Button size="sm" variant="secondary" loading={busy === 'always'} disabled={disabled || !!busy} onClick={() => act('always', () => autoApi.always(s.id))}>
            Always automatic
          </Button>
        )}
        {s.alternatives.length > 0 && (
          <Menu
            label="Other Claudes"
            trigger={
              <span className="press inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium text-ink-soft hover:bg-surface-2 hover:text-ink">
                Other <ChevronDown className="size-3.5" aria-hidden="true" />
              </span>
            }
            items={s.alternatives.map((a) => ({ label: `Move to ${a.name}`, onSelect: () => act('move', () => autoApi.move(s.id, a.id)), disabled: disabled || !!busy }))}
          />
        )}
      </div>
    </div>
  );
}
