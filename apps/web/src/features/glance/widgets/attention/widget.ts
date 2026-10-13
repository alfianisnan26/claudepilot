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
  about: 'Requests waiting for your answer (with what each asks), deploys waiting for your approval, tickets assigned to you and CI runs that failed and have not run since. Its number is the installed app’s badge.',
  href: '/admin/sessions',
  badge: true,
  useCompact: useAttentionCompact,
  Card: lazy(() => import('./Card').then((m) => ({ default: m.AttentionCard }))),
  cardLabel: 'Needs you',
  cardAbout: 'Everything waiting on a person, the most blocking first: approvals (a session is stopped on each), deploys to approve, interrupted sessions, CI runs that failed and have not run since, and tickets assigned to you. Answer an approval in its session or under Attention, where its whole text is shown.',
  Full: lazy(() => import('./Full').then((m) => ({ default: m.AttentionFull }))),
};
