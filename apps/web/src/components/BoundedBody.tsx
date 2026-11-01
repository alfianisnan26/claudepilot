import { cn, useMediaQuery } from '@isnanme/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { DESKTOP_MAX, edgesOf, PHONE_CUT_REM, type Edges } from '@/lib/bounded';

const NONE: Edges = { top: false, bottom: false, cut: false };

/**
 * The body of a card whose content grows (lib/bounded.ts; docs/prd/ui-layout.md). Desktop: it scrolls inside itself, filling its tile
 * (`fill`, a Home tile of fixed height) or up to `DESKTOP_MAX`, with a fade at an edge that has more behind it. Phone: the page is the one
 * scroll container, so it shows the first part and a "Show all" (`more` links to the full page instead of expanding in place).
 */
export function BoundedBody({ children, fill = false, more, className }: { children: ReactNode; fill?: boolean; more?: { to: string; label?: string }; className?: string }) {
  const desktop = useMediaQuery('(min-width: 1024px)');
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>(NONE);
  const [all, setAll] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setEdges((cur) => {
      const next = edgesOf(el);
      return cur.top === next.top && cur.bottom === next.bottom && cur.cut === next.cut ? cur : next;
    });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (inner.current) ro.observe(inner.current);
    el.addEventListener('scroll', read, { passive: true });
    return () => (ro.disconnect(), el.removeEventListener('scroll', read));
  }, [desktop, all]);

  const phoneCut = !desktop && !all;
  return (
    <div data-bounded={desktop ? (fill ? 'fill' : 'scroll') : all ? 'all' : 'cut'} className={cn('relative min-h-0', fill && desktop && 'flex flex-1 flex-col', className)}>
      <div
        ref={box}
        className={cn(desktop ? 'overflow-y-auto overscroll-contain [scrollbar-width:thin]' : phoneCut && 'overflow-hidden', fill && desktop && 'min-h-0 flex-1')}
        style={desktop ? (fill ? undefined : { maxHeight: DESKTOP_MAX }) : phoneCut ? { maxHeight: `${PHONE_CUT_REM}rem` } : undefined}
      >
        <div ref={inner}>{children}</div>
      </div>
      {/* The fades: only where there is more behind the edge. */}
      {desktop && edges.top && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-surface to-transparent" />}
      {(desktop ? edges.bottom : phoneCut && edges.cut) && (
        <div aria-hidden="true" className={cn('pointer-events-none absolute inset-x-0 h-8 bg-gradient-to-t from-surface to-transparent', desktop ? 'bottom-0' : 'bottom-11')} />
      )}
      {!desktop && (edges.cut || all) &&
        (more && !all ? (
          <Link to={more.to} className="press flex min-h-11 w-full items-center justify-center gap-1 rounded-xl text-sm font-semibold text-ink-soft outline-hidden hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
            {more.label ?? 'Show all'}
          </Link>
        ) : (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
            className="press flex min-h-11 w-full items-center justify-center gap-1 rounded-xl text-sm font-semibold text-ink-soft outline-hidden hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          >
            {all ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            {all ? 'Show less' : 'Show all'}
          </button>
        ))}
    </div>
  );
}
