import { cn, HubContext, InTabsContext } from '@isnanme/ui';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { isAdminState, useAuth } from '@/lib/auth';
import { pageScrollTop, scrollPageTo, scrollPane } from '@/lib/pane';
import { resolveTab, shownTabs, tabHref, tabSegment, type TabDef } from '@/lib/routedTabs';

export interface RoutedTab extends TabDef {
  /** Mounted only while its tab is open, so a tab asks for its data when it is opened. */
  content: ReactNode;
  /** A small count (or short text) on the tab. */
  badge?: number | string;
  /** attention (default): something waits on you, filled. info: a quiet count. */
  badgeTone?: 'attention' | 'info';
  /** A destructive section (an org's Danger zone): its label in the danger colour. */
  danger?: boolean;
}

/** The open tab's id for a page whose tabs live under `base` (the first id at the base itself), for a header action that follows the tab. */
export function useTabId(base: string, ids: readonly string[]): string {
  const seg = tabSegment(useLocation().pathname, base);
  return seg && ids.includes(seg) ? seg : (ids[0] ?? '');
}

/**
 * The standard for every page of several sections (owner, 2026-11-01: "make standard as tabbed menu", the Usage page's pattern): a bar of
 * pill tabs under the title, sticky, ONE section at a time, each its own sub-route (lib/routedTabs.ts). The bar scrolls sideways inside itself
 * when the tabs do not fit (the page never does). Only the open tab's content is mounted. A legacy `?tab=<id>` link moves to the sub-route;
 * a tab this person may not see goes to the first one. `hub`: each tab is a whole page of its own (Pools, Usage), so its page headers turn
 * slim and nested PageTabs stack (HubContext).
 */
export function RoutedTabs({ base, label, tabs, hub = false }: { base: string; label: string; tabs: readonly RoutedTab[]; hub?: boolean }) {
  const { state } = useAuth();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const shown = shownTabs(tabs, { admin: isAdminState(state) });
  const { active, redirect } = resolveTab(shown, base, pathname, search);
  const strip = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const activeId = active?.id;

  // Keep the open tab in view in the bar (a deep link to the eighth tab must not hide it off the edge), again once the fonts are in. When
  // the bar is stuck, the new tab's content starts right under it, not mid-scroll; a bar still in its place leaves the scroll alone.
  useEffect(() => {
    if (!activeId) return;
    const center = () => {
      const el = document.getElementById(`tab-${activeId}`);
      const s = strip.current;
      if (!el || !s || s.scrollWidth <= s.clientWidth) return;
      const a = el.getBoundingClientRect();
      const b = s.getBoundingClientRect();
      s.scrollTo({ left: s.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2 });
    };
    center();
    let live = true;
    void document.fonts?.ready.then(() => live && center());
    if (first.current) first.current = false;
    else if (bar.current && anchor.current) {
      const stick = parseFloat(getComputedStyle(bar.current).top) || 0;
      const origin = scrollPane()?.getBoundingClientRect().top ?? 0;
      const barTop = bar.current.getBoundingClientRect().top - origin;
      if (barTop <= stick + 1) scrollPageTo(pageScrollTop() + anchor.current.getBoundingClientRect().top - origin - stick);
    }
    return () => void (live = false);
  }, [activeId]);

  if (redirect) return <Navigate to={`${redirect}${hash}`} replace />;
  if (!active) return null;

  const go = (t: TabDef) => {
    navigate(tabHref(base, shown, t.id));
    requestAnimationFrame(() => document.getElementById(`tab-${t.id}`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    const i = shown.findIndex((t) => t.id === active.id);
    const to =
      e.key === 'ArrowRight'
        ? shown[(i + 1) % shown.length]
        : e.key === 'ArrowLeft'
          ? shown[(i - 1 + shown.length) % shown.length]
          : e.key === 'Home'
            ? shown[0]
            : e.key === 'End'
              ? shown[shown.length - 1]
              : null;
    if (!to) return;
    e.preventDefault();
    go(to);
  };

  return (
    <div data-routed-tabs="">
      <div ref={anchor} aria-hidden="true" />
      {/* Sticky under the phone's app bar (its 4 rem and the safe area); at the top of the content pane on wider screens, where there is none. */}
      <div ref={bar} className="sticky top-[calc(var(--safe-top)+4rem)] z-20 -mx-4 mb-4 border-b border-line bg-bg/90 backdrop-blur-md sm:top-0 sm:-mx-6 lg:-mx-8">
        <div ref={strip} role="tablist" aria-label={label} onKeyDown={onKey} className="no-scrollbar flex gap-1 overflow-x-auto overscroll-x-contain px-3 py-1.5 sm:px-5 lg:px-7">
          {shown.map((t) => {
            const on = t.id === active.id;
            return (
              <Link
                key={t.id}
                id={`tab-${t.id}`}
                to={tabHref(base, shown, t.id)}
                role="tab"
                aria-selected={on}
                aria-controls={`panel-${t.id}`}
                tabIndex={on ? 0 : -1}
                data-tab={t.id}
                className={cn(
                  'press flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold whitespace-nowrap outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                  on ? (t.danger ? 'bg-danger text-white' : 'bg-primary text-primary-ink') : t.danger ? 'text-danger hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
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
              </Link>
            );
          })}
        </div>
      </div>
      <div key={active.id} id={`panel-${active.id}`} role="tabpanel" aria-labelledby={`tab-${active.id}`} data-tab-panel={active.id} className="min-w-0">
        {hub ? (
          <HubContext.Provider value={true}>
            <InTabsContext.Provider value={false}>{active.content}</InTabsContext.Provider>
          </HubContext.Provider>
        ) : (
          active.content
        )}
      </div>
    </div>
  );
}
