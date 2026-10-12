import { BellRing } from 'lucide-react';
import { lazy } from 'react';
import type { GlanceWidget } from '../../types';
import { useAttentionCompact } from './useAttention';

/**
 * What waits on you: requests (Allow or Deny right here, with the tool and its target in view), tickets assigned to a person and
 * failed CI runs. Its count is the installed app's badge (PRD glance-widgets §6.4).
 */
export const attentionWidget: GlanceWidget = {
  id: 'attention',
  label: 'Attention',
  icon: BellRing,
  about: 'Requests waiting for your answer (with what each asks), tickets assigned to you and CI runs that failed and have not run since. Its number is the installed app’s badge.',
  href: '/admin/sessions',
  badge: true,
  useCompact: useAttentionCompact,
  Full: lazy(() => import('./Full').then((m) => ({ default: m.AttentionFull }))),
};
