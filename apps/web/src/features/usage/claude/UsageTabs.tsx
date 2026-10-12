import { HubContext, InTabsContext, PageTabs } from '@isnanme/ui';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { attentionCount, ClaudesTab } from './ClaudesTab';
import { useClaudeUsage } from './useClaudeUsage';

/**
 * The Usage page's tabs: what requests cost (the page as it was) and what each Claude's plan has left. The tab is in `?tab=`.
 * Inside a tab the page headers turn slim (HubContext), like the Pools hub.
 */
export function UsageTabs({ requests }: { requests: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const { report } = useClaudeUsage();
  const attention = report ? attentionCount(report.claudes) : 0;
  const hub = (node: ReactNode) => (
    <HubContext.Provider value={true}>
      <InTabsContext.Provider value={false}>{node}</InTabsContext.Provider>
    </HubContext.Provider>
  );
  return (
    <>
      <PageHeader title="Usage" />
      <PageTabs
        label="Usage"
        stack="never"
        value={params.get('tab')}
        onChange={(id) => setParams(id ? { tab: id } : {}, { replace: true })}
        tabs={[
          { id: 'requests', label: 'Requests', content: hub(requests) },
          { id: 'claudes', label: 'Claudes', badge: attention || undefined, content: hub(<ClaudesTab />) },
        ]}
      />
    </>
  );
}
