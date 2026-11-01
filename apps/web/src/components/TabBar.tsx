import { useEffect, useRef, type KeyboardEvent } from 'react';

// No UI-kit import: the Admin console draws this bar too and keeps its bundle small.
const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export interface TabItem {
  id: string;
  label: string;
  /** A small count (or short text) on the tab. */
  badge?: number | string;
  /** attention (default): something waits on you, filled. info: a quiet count. */
  badgeTone?: 'attention' | 'info';
  /** A destructive section (an org's Danger zone): its label in the danger colour. */
  danger?: boolean;
}

/**
 * THE tab bar (docs/coord/UI-STANDARD.md §2; owner, 2026-11-01: "make standard as tabbed menu", the Usage pattern): pill tabs in one row,
 * sticky under the page title, scrolling sideways inside itself when they do not fit (the page never does), 44 px targets, arrow keys,
 * Home and End. Presentational and router-free, so the portal (RoutedTabs: each tab a path), the Admin console and the reporter panel draw
 * the same bar. `hrefOf` makes each tab a link (opened in place through `onSelect`, a new tab with a modifier key). The sticky offset and
 * the bleed to the page's edges come from `className` (the default fits the portal's frame).
 */
export function TabBar({
  label,
  tabs,
  active,
  onSelect,
  hrefOf,
  className = 'sticky top-[calc(var(--safe-top)+4rem)] z-20 -mx-4 mb-4 sm:top-0 sm:-mx-6 lg:-mx-8',
  innerClassName = 'px-3 sm:px-5 lg:px-7',
}: {
  label: string;
  tabs: readonly TabItem[];
  active: string;
  onSelect: (id: string) => void;
  hrefOf?: (id: string) => string;
  className?: string;
  innerClassName?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  // Keep the open tab in view (a deep link to the eighth tab must not hide it off the edge), again once the fonts are in.
  useEffect(() => {
    const center = () => {
      const el = strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`);
      const s = strip.current;
      if (!el || !s || s.scrollWidth <= s.clientWidth) return;
      const a = el.getBoundingClientRect();
      const b = s.getBoundingClientRect();
      s.scrollTo({ left: s.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2 });
    };
    center();
    let live = true;
    void document.fonts?.ready.then(() => live && center());
    return () => void (live = false);
  }, [active]);

  const pick = (id: string) => {
    onSelect(id);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    const n = tabs.length;
    const to = e.key === 'ArrowRight' ? tabs[(i + 1) % n] : e.key === 'ArrowLeft' ? tabs[(i - 1 + n) % n] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[n - 1] : null;
    if (!to) return;
    e.preventDefault();
    pick(to.id);
  };

  return (
    <div data-tab-bar="" className={cn('border-b border-line bg-bg/90 backdrop-blur-md', className)}>
      <div ref={strip} role="tablist" aria-label={label} onKeyDown={onKey} className={cn('no-scrollbar flex gap-1 overflow-x-auto overscroll-x-contain py-1.5', innerClassName)}>
        {tabs.map((t) => {
          const on = t.id === active;
          const look = cn(
            'press flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold whitespace-nowrap outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-accent',
            on ? (t.danger ? 'bg-danger text-white' : 'bg-primary text-primary-ink') : t.danger ? 'text-danger hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-ink',
          );
          const body = (
            <>
              <span>{t.label}</span>
              {/* Flex drops this space visually; it keeps the name "Label 2" for screen readers. */}
              {!!t.badge && ' '}
              {!!t.badge && (
                <span
                  className={cn(
                    'flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums',
                    on ? 'bg-white/25 text-primary-ink' : t.badgeTone === 'info' ? 'bg-surface-2 text-ink-soft' : 'bg-accent text-white',
                  )}
                >
                  {t.badge}
                </span>
              )}
            </>
          );
          const common = { id: `tab-${t.id}`, role: 'tab', 'aria-selected': on, 'aria-controls': `panel-${t.id}`, tabIndex: on ? 0 : -1, 'data-tab': t.id, className: look } as const;
          return hrefOf ? (
            <a
              key={t.id}
              {...common}
              href={hrefOf(t.id)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                if (!on) onSelect(t.id);
              }}
            >
              {body}
            </a>
          ) : (
            <button key={t.id} type="button" {...common} onClick={() => !on && onSelect(t.id)}>
              {body}
            </button>
          );
        })}
      </div>
    </div>
  );
}
