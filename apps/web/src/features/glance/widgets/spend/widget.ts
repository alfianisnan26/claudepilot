import { ChartColumn } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { spendCompact, spendView } from './model';
import { spendStore } from './store';

const SpendCard = lazy(() => import('./Card').then((m) => ({ default: m.SpendCard })));

function useSpendCompact(): GlanceCompact {
  const { data, failed } = spendStore.use();
  return useMemo(() => spendCompact(data ? spendView(data) : null, failed), [data, failed]);
}

/** Today's and this week's usage: estimated dollars, tokens and requests (PRD glance-widgets §18). */
export const spendWidget: GlanceWidget = {
  id: 'usage',
  label: 'Usage',
  icon: ChartColumn,
  about: 'What the recorded requests used today and this week: estimated dollars, tokens and requests.',
  href: '/admin/usage',
  defaultHidden: true,
  useCompact: useSpendCompact,
  Full: SpendCard,
  Card: SpendCard,
};
