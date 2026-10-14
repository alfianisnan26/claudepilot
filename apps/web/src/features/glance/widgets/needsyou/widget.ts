import { Layers } from 'lucide-react';
import { lazy, useMemo } from 'react';
import { useAttention } from '@/features/attention/store';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { reviewCompact } from './model';

const ReviewCard = lazy(() => import('./Card').then((m) => ({ default: m.ReviewCard })));

function useReviewCompact(): GlanceCompact {
  const { list, failed } = useAttention();
  return useMemo(() => reviewCompact(list, failed), [list, failed]);
}

/**
 * Needs you's registry on Home (T-146 slice 2): how many things wait for a person, by source, and the newest one; a tap opens the deck.
 * The app icon already counts these (AttentionRoot), so this widget adds nothing to the badge.
 */
export const reviewWidget: GlanceWidget = {
  id: 'review',
  label: 'Review',
  icon: Layers,
  about: 'What waits for a person to decide, by source (MCP, skills, deploys, tickets, stuck approvals), and the newest one. A tap opens the deck.',
  cardAbout:
    'Everything that only a person may decide, counted by where it comes from, and the newest one. A tap on it opens the deck at that card; Open shows the whole deck. "-" means that source could not be read.',
  href: '/admin/attention',
  defaultHidden: true,
  useCompact: useReviewCompact,
  Full: ReviewCard,
  Card: ReviewCard,
};
