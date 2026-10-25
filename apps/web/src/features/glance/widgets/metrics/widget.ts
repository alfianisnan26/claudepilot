import { ChartNoAxesCombined } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { metricsCompact } from './model';
import { metricsStore } from './store';

const MetricsCard = lazy(() => import('./Card').then((m) => ({ default: m.MetricsCard })));

function useMetricsCompact(): GlanceCompact {
  const { data, failed } = metricsStore.use();
  return useMemo(() => metricsCompact(data, failed), [data, failed]);
}

/** Efficiency and effectiveness, tickets resolved and the median time to resolve, over the last 24 hours (T-2360). */
export const metricsWidget: GlanceWidget = {
  id: 'metrics',
  label: 'Metrics',
  icon: ChartNoAxesCombined,
  about:
    'The pilot’s efficiency and effectiveness scores, tickets resolved in the last 24 hours and the median time to resolve one, for all programs.',
  href: '/admin/usage?tab=metrics',
  defaultHidden: true,
  useCompact: useMetricsCompact,
  Full: MetricsCard,
  Card: MetricsCard,
};
