import { HubContext, InTabsContext, PageTabs } from '@isnanme/ui';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { POOL_TABS } from './registry';

/**
 * Pools, one destination for every pool type (Skillset PRD §18 A8): tabs everywhere (`stack="never"`),
 * the tab in `?tab=`. Inside a tab, page headers turn slim and nested tabs stack (HubContext); a type's
 * own pages are routes under `/admin/pools/<tab>/`, not nested tabs.
 */
export function PoolsHub() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab');
  // The tab strip scrolls sideways on a phone: keep the active tab in view when it changes, and when the page opens on `?tab=browser`.
  useEffect(() => {
    const el = document.getElementById(`tab-${tab ?? POOL_TABS[0]!.id}`);
    const strip = el?.parentElement;
    if (!el || !strip || strip.scrollWidth <= strip.clientWidth) return;
    const a = el.getBoundingClientRect();
    const b = strip.getBoundingClientRect();
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    strip.scrollTo({ left: strip.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2, behavior: reduce ? 'auto' : 'smooth' });
  }, [tab]);
  return (
    <>
      <PageHeader title="Pools" description="Bundles you manage once and assign to many workspaces." />
      <PageTabs
        label="Pool types"
        stack="never"
        value={tab}
        onChange={(id) => setParams(id ? { tab: id } : {}, { replace: true })}
        tabs={POOL_TABS.map((t) => ({
          id: t.id,
          label: t.label,
          // A hub tab is a whole page of sections, so their titles stay (a phone tab hides them because it names its one section).
          content: (
            <HubContext.Provider value={true}>
              <InTabsContext.Provider value={false}>{t.element}</InTabsContext.Provider>
            </HubContext.Provider>
          ),
        }))}
      />
    </>
  );
}
