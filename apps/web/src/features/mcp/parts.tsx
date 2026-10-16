import { CopyButton, cn } from '@isnanme/ui';
import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

/** Code reads in a code font; the tokens' `font-mono` is the UI font. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/**
 * A command or URL exactly as a workspace runs it (MCP set PRD §15): wrapping, never truncated, with a
 * copy button. On phones it scrolls inside its own box.
 */
export function CodeBlock({ value, label = 'Copy' }: { value: string; label?: string }) {
  return (
    <div className="relative rounded-xl border border-line bg-surface-2/60">
      <pre className="max-h-56 overflow-auto px-3 py-2.5 pr-11 text-[12.5px] leading-relaxed break-all whitespace-pre-wrap" style={{ fontFamily: MONO }}>
        {value}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

/** A row that expands (MCP set PRD §15): the summary stays visible, the body opens under it. */
export function Disclosure({
  summary,
  trailing,
  children,
  defaultOpen = false,
  tone,
}: {
  summary: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  tone?: 'danger';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn('rounded-2xl border bg-surface', tone === 'danger' ? 'border-danger/40' : 'border-line')}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
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
