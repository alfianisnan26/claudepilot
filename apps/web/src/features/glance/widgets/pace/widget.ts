import { Gauge } from 'lucide-react';
import { lazy, useMemo } from 'react';
import { paceCompact } from '@/features/lab/summaryModel';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { paceStore } from './store';

const PaceCard = lazy(() => import('./Card').then((m) => ({ default: m.PaceCard })));

function usePaceCompact(): GlanceCompact {
  const { data, failed } = paceStore.use();
  return useMemo(() => {
    const c = paceCompact(data?.headline ?? null, failed);
    return { value: c.value, level: c.level, title: c.title, loading: !data && !failed };
  }, [data, failed]);
}

/** The crew's pace against an even spend of the quota, with usage, resolved, per cost and created per closed (T-600). */
export const paceWidget: GlanceWidget = {
  id: 'pace',
  label: 'Pace',
  icon: Gauge,
  about: 'How the crew spends its quota (1 : 1 is exactly by the reset), what it used, and how many tickets it resolved, at what cost, and created per closed.',
  href: '/admin/usage?tab=crew',
  defaultHidden: true,
  useCompact: usePaceCompact,
  Full: PaceCard,
  Card: PaceCard,
};
