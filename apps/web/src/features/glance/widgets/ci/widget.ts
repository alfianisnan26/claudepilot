import { Workflow } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { useGlance } from '../shared/store';
import { ciCompact, ciView } from './model';
import { ciStore } from './store';

const CiCard = lazy(() => import('./Card').then((m) => ({ default: m.CiCard })));

function useCiCompact(): GlanceCompact {
  const { data, failed } = ciStore.use();
  const glance = useGlance();
  return useMemo(() => ciCompact(data ? ciView(data, glance.data) : null, failed), [data, glance.data, failed]);
}

/** The last CI runs, the failures that still stand and the deploys waiting for approval (PRD glance-widgets §18). */
export const ciWidget: GlanceWidget = {
  id: 'ci',
  label: 'CI',
  icon: Workflow,
  about: 'The last pipeline runs, the failures that still stand and the deploys waiting for your approval.',
  href: '/admin/ci',
  defaultHidden: true,
  useCompact: useCiCompact,
  Full: CiCard,
  Card: CiCard,
};
