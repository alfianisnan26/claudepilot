import { cn } from '@isnanme/ui';
import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** Code and prose Claude reads read in a code font; the tokens' `font-mono` is the UI font. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** A field's label with its note behind an ⓘ (the text diet), and what's on the right of it (a counter, an Add button). */
export function LabelRow({ label, htmlFor, tip, tipLabel, right }: { label: string; htmlFor?: string; tip?: ReactNode; tipLabel?: string; right?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-1">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-soft">
        {label}
      </label>
      {tip && <InfoTip label={tipLabel ?? `About ${label.toLowerCase()}`}>{tip}</InfoTip>}
      {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
    </div>
  );
}

/** A row that opens under its summary: the list rows of the styles and subagents editors. */
export function Disclosure({
  summary,
  trailing,
  children,
  defaultOpen = false,
  tone,
  onOpenChange,
}: {
  summary: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  tone?: 'danger';
  /** Told when it opens or closes: for content that loads on demand. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = (next: (o: boolean) => boolean) => {
    const value = next(open);
    setOpenState(value);
    onOpenChange?.(value);
  };
  const id = useId();
  return (
    <div className={cn('rounded-2xl border bg-surface', tone === 'danger' ? 'border-danger/40' : 'border-line')}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronRight className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
          <span className="min-w-0 flex-1">{summary}</span>
        </button>
        {trailing}
      </div>
      {open && (
        <div id={id} className="border-t border-line px-3.5 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
