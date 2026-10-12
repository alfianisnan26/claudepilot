import { CopyButton, cn } from '@isnanme/ui';
import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

/** Code reads in a code font; the tokens' `font-mono` is the UI font. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** A command or URL exactly as it is typed: wrapping, never truncated, with a copy button. */
export function CodeBlock({ value, label = 'Copy', secret }: { value: string; label?: string; secret?: boolean }) {
  return (
    <div className="relative rounded-xl border border-line bg-surface-2/60">
      <pre
        className="max-h-56 overflow-auto px-3 py-2.5 pr-11 text-[12.5px] leading-relaxed break-all whitespace-pre-wrap"
        style={{ fontFamily: MONO }}
        data-secret={secret ? 'true' : undefined}
      >
        {value}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={value} label={label} showLabel={false} />
      </div>
    </div>
  );
}

/** A row that expands: the summary stays visible, the body opens under it. */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="rounded-2xl border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-2xl px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 text-sm font-semibold">{summary}</span>
      </button>
      {open && (
        <div id={id} className="border-t border-line px-3.5 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
