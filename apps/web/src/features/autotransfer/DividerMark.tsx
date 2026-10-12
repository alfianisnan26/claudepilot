// The "auto" mark and Undo on the "Moved to" divider (FR18, FR19): Undo opens the normal Move dialog with the Claude the chat left
// already chosen; it is disabled, with the reason, when that Claude can't take the chat now.
import { Undo2 } from 'lucide-react';
import type { AutoTransferEvent } from '@portal/contracts';

export function DividerMark({ event, undo, onUndo }: { event: AutoTransferEvent; undo: { ok: boolean; reason: string | null } | null; onUndo: (claudeId: string) => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-semibold text-accent" title="Moved by auto move">
        auto
      </span>
      {undo && event.from && (
        <button
          type="button"
          disabled={!undo.ok}
          title={undo.ok ? `Move back to ${event.from.name}` : (undo.reason ?? undefined)}
          aria-label={undo.ok ? `Undo: move back to ${event.from.name}` : `Undo unavailable: ${undo.reason ?? ''}`}
          onClick={() => event.from && onUndo(event.from.id)}
          className="press inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-ink-soft hover:bg-surface-2 hover:text-ink disabled:opacity-50 tap:h-9"
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          Undo
        </button>
      )}
    </span>
  );
}
