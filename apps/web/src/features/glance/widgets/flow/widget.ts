import { Workflow } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { flowCompact, flowView } from './model';
import { flowStore } from './store';

const FlowCard = lazy(() => import('./Card').then((m) => ({ default: m.FlowCard })));

function useFlowCompact(): GlanceCompact {
  const { data, failed } = flowStore.use();
  return useMemo(() => flowCompact(data ? flowView(data) : null, failed), [data, failed]);
}

/** The flow watchdog (T-1966): what is stuck in each program and what the watchdog did about it. */
export const flowWidget: GlanceWidget = {
  id: 'flow',
  label: 'Flow',
  icon: Workflow,
  about: 'What is stuck in the programs the portal watches (to merge, without QA, idle leads, out of Bypass, stalled) and what the watchdog did last.',
  cardAbout:
    'Every 5 minutes the portal looks at each program (Settings, Flow) and messages the lead that can move a stuck ticket: a QA PASS not merged, a ticket nobody verifies, an idle lead with open work. A lead out of Bypass is only reported. You are notified only when nothing was done for hours after it nudged.',
  href: '/admin/settings',
  defaultHidden: true,
  useCompact: useFlowCompact,
  Full: FlowCard,
  Card: FlowCard,
};
