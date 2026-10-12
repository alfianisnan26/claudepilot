import { BROWSER_POOL_DEFAULTS, type BrowserPoolContent } from '@portal/contracts';
import { Globe } from 'lucide-react';
import { definePoolType } from '@/features/pools/definePoolType';
import { BrowserAddOn } from './BrowserAddOn';
import { BrowserConfiguration } from './BrowserConfiguration';
import { BrowserEditor } from './BrowserEditor';
import { poolSummary } from './summary';

/**
 * Browser & desktop's tab in the Pools hub (browser PRD §15.1): one browser per workspace (the pool kind is
 * `single`), with the shared editor, the Configuration row and the create dialog's Add-on.
 */
export const browserTab = definePoolType<BrowserPoolContent>({
  id: 'browser',
  label: 'Browser',
  type: 'browser',
  noun: { one: 'browser', other: 'browsers' },
  description: 'A browser beside each workspace that the agent drives and people can watch.',
  icon: Globe,
  emptyContent: () => structuredClone(BROWSER_POOL_DEFAULTS),
  Editor: BrowserEditor,
  single: true,
  summary: (p) => <span className="text-[13px] text-muted">{poolSummary(p)}</span>,
  ConfigurationDetail: BrowserConfiguration,
  AddOn: BrowserAddOn,
  deleteNote: 'Workspaces that use it lose their browser first.',
});
