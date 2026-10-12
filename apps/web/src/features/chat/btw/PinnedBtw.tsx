import { cn } from '@isnanme/ui';
import type { ChatPinnedBtw } from '@portal/contracts';
import { ChevronDown, Pin } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '../Markdown';

/** A btw pinned to the transcript: the question on one line, the answer behind it. Claude never saw it; it is the person's record. */
export function PinnedBtw({ btw }: { btw: ChatPinnedBtw }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="press flex min-h-11 w-full min-w-0 items-center gap-3 px-3.5 py-2 text-left">
        <Pin className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-muted">btw</span>
          <span className="block truncate text-[14px] font-semibold text-ink">{btw.question}</span>
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="max-h-[60vh] overflow-y-auto border-t border-line px-3.5 py-3 [overflow-wrap:anywhere]">
          <Markdown text={btw.answer} className="text-[14px] leading-relaxed text-ink-soft" />
        </div>
      )}
    </div>
  );
}
