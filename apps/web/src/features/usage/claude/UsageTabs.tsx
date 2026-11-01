import type { ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { RoutedTabs, useTabId } from '@/components/RoutedTabs';
import { LabTab } from '@/features/lab/LabTab';
import { MetricsTab } from '@/features/lab/MetricsTab';
import { ScorecardTab } from '@/features/lab/ScorecardTab';
import { AttributionTab } from '../spend/AttributionTab';
import { BudgetsTab } from '../spend/BudgetsTab';
import { SpikesTab } from '../spend/SpikesTab';
import { useSpendSummary } from '../spend/useSpendSummary';
import { attentionCount, ClaudesTab } from './ClaudesTab';
import { useClaudeUsage } from './useClaudeUsage';

const BASE = '/admin/usage';
const IDS = ['requests', 'claudes', 'attribution', 'budgets', 'spikes', 'lab', 'crew', 'metrics'] as const;

/** The open Usage tab (`/admin/usage/<tab>`; Requests at `/admin/usage`). */
export const useUsageTab = () => useTabId(BASE, IDS);

/**
 * The Usage page's tabs, each its own path (`/admin/usage/claudes`; owner request 2026-11-01): what requests cost (the page as it was), what
 * each Claude’s plan has left, who spent what, the budgets and the spikes, the lab. Eight tabs in a bar that
 * scrolls sideways on a phone (RoutedTabs). Inside a tab the page headers turn slim (`hub`), like the Pools hub.
 */
export function UsageTabs({ requests, top }: { requests: ReactNode; top?: ReactNode }) {
  const { report } = useClaudeUsage();
  const attention = report ? attentionCount(report.claudes) : 0;
  const spend = useSpendSummary();
  // Budgets that are near, high or used up; spikes of the last day (the portal says each is a rule of thumb).
  const budgets = spend ? spend.budgets.near + spend.budgets.high + spend.budgets.exhausted : 0;
  const spikes = spend?.spikes24h ?? 0;
  return (
    <>
      <PageHeader title="Usage" description="What your Claudes spent and on what: requests, plan quota per Claude, who it went to, budgets and unusual spend." />
      {top}
      <RoutedTabs
        base={BASE}
        label="Usage"
        hub
        tabs={[
          { id: 'requests', label: 'Requests', content: requests },
          { id: 'claudes', label: 'Claudes', badge: attention || undefined, content: <ClaudesTab /> },
          { id: 'attribution', label: 'Attribution', content: <AttributionTab /> },
          { id: 'budgets', label: 'Budgets', badge: budgets || undefined, content: <BudgetsTab /> },
          { id: 'spikes', label: 'Spikes', badge: spikes || undefined, badgeTone: 'info', content: <SpikesTab /> },
          { id: 'lab', label: 'Lab', content: <LabTab /> },
          { id: 'crew', label: 'Crew', content: <ScorecardTab /> },
          { id: 'metrics', label: 'Metrics', content: <MetricsTab /> },
        ]}
      />
    </>
  );
}
