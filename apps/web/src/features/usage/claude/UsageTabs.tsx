import { HubContext, InTabsContext, PageTabs } from '@isnanme/ui';
import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { LabTab } from '@/features/lab/LabTab';
import { AttributionTab } from '../spend/AttributionTab';
import { BudgetsTab } from '../spend/BudgetsTab';
import { SpikesTab } from '../spend/SpikesTab';
import { useSpendSummary } from '../spend/useSpendSummary';
import { attentionCount, ClaudesTab } from './ClaudesTab';
import { useClaudeUsage } from './useClaudeUsage';

/**
 * The Usage page's tabs: what requests cost (the page as it was), what each Claude's plan has left, who spent what, the budgets and the
 * spikes. The tab is in `?tab=`. Inside a tab the page headers turn slim (HubContext), like the Pools hub.
 */
export function UsageTabs({ requests, top }: { requests: ReactNode; top?: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const { report } = useClaudeUsage();
  const attention = report ? attentionCount(report.claudes) : 0;
  const spend = useSpendSummary();
  // Budgets that are near, high or used up; spikes of the last day (the portal says each is a rule of thumb).
  const budgets = spend ? spend.budgets.near + spend.budgets.high + spend.budgets.exhausted : 0;
  const spikes = spend?.spikes24h ?? 0;
  const tab = params.get('tab');
  // Six tabs do not fit a phone's bar, which scrolls sideways: bring the open one into view (a link to `?tab=spikes` must not hide it off the edge).
  // Again once the fonts are in and when a badge changes a tab's width, since the first measure is of narrower tabs.
  useEffect(() => {
    const show = () => document.getElementById(`tab-${tab ?? 'requests'}`)?.scrollIntoView({ inline: 'center', block: 'nearest' });
    show();
    let live = true;
    void document.fonts?.ready.then(() => live && show());
    return () => void (live = false);
  }, [tab, attention, budgets, spikes]);
  const hub = (node: ReactNode) => (
    <HubContext.Provider value={true}>
      <InTabsContext.Provider value={false}>{node}</InTabsContext.Provider>
    </HubContext.Provider>
  );
  return (
    <>
      <PageHeader title="Usage" />
      {top}
      <PageTabs
        label="Usage"
        stack="never"
        value={params.get('tab')}
        onChange={(id) => setParams(id ? { tab: id } : {}, { replace: true })}
        tabs={[
          { id: 'requests', label: 'Requests', content: hub(requests) },
          { id: 'claudes', label: 'Claudes', badge: attention || undefined, content: hub(<ClaudesTab />) },
          { id: 'attribution', label: 'Attribution', content: hub(<AttributionTab />) },
          { id: 'budgets', label: 'Budgets', badge: budgets || undefined, content: hub(<BudgetsTab />) },
          { id: 'spikes', label: 'Spikes', badge: spikes || undefined, badgeTone: 'info', content: hub(<SpikesTab />) },
          { id: 'lab', label: 'Lab', content: hub(<LabTab />) },
        ]}
      />
    </>
  );
}
