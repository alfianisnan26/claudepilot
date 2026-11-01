import { HubContext, InTabsContext } from '@isnanme/ui';
import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { isAdminState, useAuth } from '@/lib/auth';
import { pageScrollTop, scrollPageTo, scrollPane } from '@/lib/pane';
import { resolveTab, shownTabs, tabHref, tabSegment, type TabDef } from '@/lib/routedTabs';
import { TabBar, type TabItem } from './TabBar';

export interface RoutedTab extends TabDef, Omit<TabItem, 'id' | 'label'> {
  /** Mounted only while its tab is open, so a tab asks for its data when it is opened. */
  content: ReactNode;
}

/** The open tab's id for a page whose tabs live under `base` (the first id at the base itself), for a header action that follows the tab. */
export function useTabId(base: string, ids: readonly string[]): string {
  const seg = tabSegment(useLocation().pathname, base);
  return seg && ids.includes(seg) ? seg : (ids[0] ?? '');
}

/**
 * A portal page of several sections (docs/coord/UI-STANDARD.md §2): the shared TabBar under the title, ONE section at a time, each its own
 * sub-route (lib/routedTabs.ts). Only the open tab's content is mounted. A legacy `?tab=<id>` link moves to the sub-route; a tab this person
 * may not see goes to the first one. `hub`: each tab is a whole page of its own (Pools, Usage), so its page headers turn slim and nested
 * PageTabs stack (HubContext).
 */
export function RoutedTabs({ base, label, tabs, hub = false }: { base: string; label: string; tabs: readonly RoutedTab[]; hub?: boolean }) {
  const { state } = useAuth();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const shown = shownTabs(tabs, { admin: isAdminState(state) });
  const { active, redirect } = resolveTab(shown, base, pathname, search);
  const anchor = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const activeId = active?.id;

  // When the bar is stuck, the new tab's content starts right under it, not mid-scroll; a bar still in its place leaves the scroll alone.
  useEffect(() => {
    if (!activeId) return;
    if (first.current) return void (first.current = false);
    const bar = anchor.current?.parentElement?.querySelector<HTMLElement>('[data-tab-bar]');
    if (!bar || !anchor.current) return;
    const stick = parseFloat(getComputedStyle(bar).top) || 0;
    const origin = scrollPane()?.getBoundingClientRect().top ?? 0;
    if (bar.getBoundingClientRect().top - origin <= stick + 1) scrollPageTo(pageScrollTop() + anchor.current.getBoundingClientRect().top - origin - stick);
  }, [activeId]);

  if (redirect) return <Navigate to={`${redirect}${hash}`} replace />;
  if (!active) return null;

  return (
    <div data-routed-tabs="">
      <div ref={anchor} aria-hidden="true" />
      <TabBar label={label} tabs={shown} active={active.id} hrefOf={(id) => tabHref(base, shown, id)} onSelect={(id) => navigate(tabHref(base, shown, id))} />
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
