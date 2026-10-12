import { Gauge } from 'lucide-react';
import { lazy } from 'react';
import type { GlanceWidget } from '../../types';
import { QuotaSettings } from './Settings';
import { useQuotaCompact } from './useQuota';

// The full form loads when it is first opened (it brings the shared colour helper and the meters with it); the chip is always there.
const QuotaFull = lazy(() => import('./Full').then((m) => ({ default: m.QuotaFull })));

/** Percent left of the active Claude's plan, a meter per window, when it resets, how fast it goes and where it lands (PRD glance-widgets §6). */
export const quotaWidget: GlanceWidget = {
  id: 'quota',
  label: 'Quota',
  icon: Gauge,
  about: 'How much of the active Claude’s plan is left, per window, with when it resets, how fast it is being used and where that ends.',
  href: '/admin/usage?tab=claudes',
  useCompact: useQuotaCompact,
  Full: QuotaFull,
  Settings: QuotaSettings,
};
