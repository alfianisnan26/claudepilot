// The "auto" mark and Undo on the "Moved to" divider (FR18, FR19): Undo opens the normal Move dialog with the Claude the chat left
// already chosen; it is disabled when that Claude can't take the chat now, and the reason is in the ⓘ beside it (a title never shows on touch).
import { Undo2 } from 'lucide-react';
import type { AutoTransferEvent } from '@portal/contracts';
import { InfoTip } from '@/components/InfoTip';

export function DividerMark({ event, undo, onUndo }: { event: AutoTransferEvent; undo: { ok: boolean; reason: string | null } | null; onUndo: (claudeId: string) => void }) {
  const from = event.from;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-automove-mark>
      <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-semibold text-accent">auto</span>
      <InfoTip label="About this move">
        Auto move moved this chat{from ? ` from ${from.name}` : ''} because its quota was low.{undo ? ' Undo moves it back through the Move dialog.' : ''}
        {undo && !undo.ok && undo.reason ? ` Undo is unavailable now: ${undo.reason}` : ''}
      </InfoTip>
      {undo && from && (
        <button
          type="button"
          disabled={!undo.ok}
          aria-label={undo.ok ? `Undo: move back to ${from.name}` : `Undo unavailable: ${undo.reason ?? ''}`}
          onClick={() => onUndo(from.id)}
          className="press inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-ink-soft hover:bg-surface-2 hover:text-ink disabled:opacity-50 tap:-my-2 tap:h-11 tap:px-3"
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          Undo
        </button>
      )}
    </span>
  );
}
