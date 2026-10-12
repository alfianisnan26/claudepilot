import { MessagesSquare } from 'lucide-react';
import { lazy } from 'react';
import type { GlanceWidget } from '../../types';
import { useSessionsCompact } from './useSessions';

/** How many sessions run and which wait for you, with the ones you used last; a tap opens the session (PRD glance-widgets §6.2). */
export const sessionsWidget: GlanceWidget = {
  id: 'sessions',
  label: 'Sessions',
  icon: MessagesSquare,
  about: 'How many sessions are running and which wait for you, with the ones you used last. Tap one to open it.',
  href: '/admin/sessions',
  // On the Sessions page and beside a composer it would only repeat what is already on screen.
  placements: ['header', 'dock'],
  useCompact: useSessionsCompact,
  Full: lazy(() => import('./Full').then((m) => ({ default: m.SessionsFull }))),
};
