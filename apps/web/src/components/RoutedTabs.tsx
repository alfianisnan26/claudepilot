import { cn, HubContext, InTabsContext, useMediaQuery } from '@isnanme/ui';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { isAdminState, useAuth } from '@/lib/auth';
import { resolveTab, shownTabs, tabHref, tabLayout, tabSegment, type TabDef } from '@/lib/routedTabs';

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

const WIDE = '(min-width: 1024px)';

/** The open tab's id for a page whose tabs live under `base` (the first id at the base itself), for a header action that follows the tab. */
export function useTabId(base: string, ids: readonly string[]): string {
  const seg = tabSegment(useLocation().pathname, base);
  return seg && ids.includes(seg) ? seg : (ids[0] ?? '');
}

/**
 * A page's sections as tabs, each its own sub-route (lib/routedTabs.ts; owner request 2026-11-01). Phones and narrow screens: a sticky bar
 * under the title that scrolls sideways inside itself (the page never does). Wide screens: the same bar, or a side nav beside the content
 * when there are many sections (`SIDE_NAV_MIN`). Only the open tab's content is mounted. A legacy `?tab=<id>` link moves to the sub-route,
 * a tab this person may not see goes to the first one. `hub`: each tab is a whole page of its own (Pools, Usage), so its page headers turn
 * slim and nested PageTabs stack (HubContext).
 */
export function RoutedTabs({ base, label, tabs, hub = false }: { base: string; label: string; tabs: readonly RoutedTab[]; hub?: boolean }) {
  const { state } = useAuth();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const wide = useMediaQuery(WIDE);
  const shown = shownTabs(tabs, { admin: isAdminState(state) });
  const { active, redirect } = resolveTab(shown, base, pathname, search);
  const strip = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const activeId = active?.id;

  // The bar scrolls sideways on a phone: keep the open tab in view (a deep link to the sixth tab must not hide it off the edge). When the bar
  // is stuck under the header, the new tab's content starts right under it, not mid-scroll; a bar still in its place leaves the scroll alone.
  useEffect(() => {
    if (!activeId) return;
    const el = document.getElementById(`tab-${activeId}`);
    const s = strip.current;
    if (el && s && s.scrollWidth > s.clientWidth) {
      const a = el.getBoundingClientRect();
      const b = s.getBoundingClientRect();
      s.scrollTo({ left: s.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2 });
    }
    if (first.current) {
      first.current = false;
      return;
    }
    const bar = s?.parentElement;
    if (bar && anchor.current && getComputedStyle(bar).position === 'sticky') {
      const stick = parseFloat(getComputedStyle(bar).top) || 0;
      if (bar.getBoundingClientRect().top <= stick + 1) window.scrollTo({ top: window.scrollY + anchor.current.getBoundingClientRect().top - stick });
    }
  }, [activeId]);

  if (redirect) return <Navigate to={`${redirect}${hash}`} replace />;
  if (!active) return null;
  const side = wide && tabLayout(shown.length) === 'side';

  const go = (t: TabDef) => {
    navigate(tabHref(base, shown, t.id));
    requestAnimationFrame(() => document.getElementById(`tab-${t.id}`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    const i = shown.findIndex((t) => t.id === active.id);
    const prev = side ? 'ArrowUp' : 'ArrowLeft';
    const next = side ? 'ArrowDown' : 'ArrowRight';
    const to =
      e.key === next ? shown[(i + 1) % shown.length] : e.key === prev ? shown[(i - 1 + shown.length) % shown.length] : e.key === 'Home' ? shown[0] : e.key === 'End' ? shown[shown.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    go(to);
  };

  const tabLinks = shown.map((t) => {
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
          'press relative flex min-h-11 shrink-0 items-center gap-1.5 text-[14px] font-semibold whitespace-nowrap outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-accent',
          side ? 'w-full rounded-xl px-3 text-left' : 'rounded-full px-3.5',
          on ? (side ? 'bg-surface-2 text-ink' : 'bg-primary text-primary-ink') : t.danger ? 'text-danger hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-ink',
          on && side && t.danger && 'text-danger',
        )}
      >
        <span className={cn(side && 'min-w-0 flex-1 truncate')}>{t.label}</span>
        {/* Flex drops this space visually; it keeps the name "Label 2" for screen readers. */}
        {!!t.badge && ' '}
        {!!t.badge && (
          <span
            className={cn(
              'flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums',
              on && !side ? 'bg-white/25 text-primary-ink' : t.badgeTone === 'info' ? 'bg-surface-2 text-ink-soft' : 'bg-accent text-white',
            )}
          >
            {t.badge}
          </span>
        )}
      </Link>
    );
  });

  const panel = (
    <div key={active.id} id={`panel-${active.id}`} role="tabpanel" aria-labelledby={`tab-${active.id}`} data-tab-panel={active.id} className="min-w-0">
      {hub ? (
        <HubContext.Provider value={true}>
          <InTabsContext.Provider value={false}>{active.content}</InTabsContext.Provider>
        </HubContext.Provider>
      ) : (
        active.content
      )}
    </div>
  );

  if (side)
    return (
      <div data-routed-tabs="side" className="grid grid-cols-[11rem_minmax(0,1fr)] gap-8">
        <nav aria-label={label}>
          <div role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKey} className="sticky top-6 flex flex-col gap-1">
            {tabLinks}
          </div>
        </nav>
        {panel}
      </div>
    );

  return (
    <div data-routed-tabs="bar">
      <div ref={anchor} aria-hidden="true" />
      {/* Sticky under the phone's app bar (its 4 rem and the safe area), at the top on wider screens where there is none. */}
      <div className="sticky top-[calc(var(--safe-top)+4rem)] z-20 -mx-4 mb-4 border-b border-line bg-bg/90 backdrop-blur-md sm:top-0 sm:-mx-6">
        <div ref={strip} role="tablist" aria-label={label} onKeyDown={onKey} className="no-scrollbar flex gap-1 overflow-x-auto overscroll-x-contain px-3 py-1.5 sm:px-5">
          {tabLinks}
        </div>
      </div>
      {panel}
    </div>
  );
}
