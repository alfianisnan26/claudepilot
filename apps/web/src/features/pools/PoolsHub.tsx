import { PageHeader } from '@/components/PageHeader';
import { RoutedTabs } from '@/components/RoutedTabs';
import { POOL_TABS } from './registry';

/**
 * Pools, one destination for every pool type (Skillset PRD §18 A8): a tab per type, each its own path (`/admin/pools/skills`; Accounts at
 * `/admin/pools`). Inside a tab, page headers turn slim and nested tabs stack (HubContext); a type's own pages are routes under
 * `/admin/pools/<tab>/`, not nested tabs.
 */
export function PoolsHub() {
  return (
    <>
      <PageHeader title="Pools" description="Bundles you manage once and assign to many workspaces." />
      <RoutedTabs base="/admin/pools" label="Pool types" hub tabs={POOL_TABS.map((t) => ({ id: t.id, label: t.label, content: t.element }))} />
    </>
  );
}
