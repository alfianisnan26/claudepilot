import { Repeat } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { autonomyCompact, autonomyView } from './model';
import { autonomyStore } from './store';

const AutonomyCard = lazy(() => import('./Card').then((m) => ({ default: m.AutonomyCard })));

function useAutonomyCompact(): GlanceCompact {
  const { data, failed } = autonomyStore.use();
  return useMemo(() => autonomyCompact(data ? autonomyView(data) : null, failed), [data, failed]);
}

/** The chats the portal keeps going, how each stands and what Keep going did last (T-259 slice 2). */
export const autonomyWidget: GlanceWidget = {
  id: 'autonomy',
  label: 'Autonomy',
  icon: Repeat,
  about: 'The chats the portal keeps going (Keep going): how each stands, what it did last, and which are left down.',
  cardAbout:
    'Chats with Keep going on. Every minute the portal tells an idle one to continue, wakes an interrupted one, answers its questions with the written defaults, and brings an ended one back (in place, or as a new chat). It never answers a tool approval and never turns Bypass on: those, and a chat left down, are reported to you.',
  href: '/admin/sessions',
  defaultHidden: true,
  useCompact: useAutonomyCompact,
  Full: AutonomyCard,
  Card: AutonomyCard,
};
