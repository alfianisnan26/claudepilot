import { Ticket } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { ticketsCompact, ticketsView } from './model';
import { ticketsStore } from './store';

const TicketsCard = lazy(() => import('./Card').then((m) => ({ default: m.TicketsCard })));

function useTicketsCompact(): GlanceCompact {
  const { data, failed } = ticketsStore.use();
  return useMemo(() => ticketsCompact(data ? ticketsView(data) : null, failed), [data, failed]);
}

/** The ticket queue by status, the ones waiting for a person, the newest (PRD glance-widgets §18). */
export const ticketsWidget: GlanceWidget = {
  id: 'tickets',
  label: 'Tickets',
  icon: Ticket,
  about: 'Open tickets by status, how many wait for a person, and the newest.',
  href: '/admin/tickets',
  defaultHidden: true,
  useCompact: useTicketsCompact,
  Full: TicketsCard,
  Card: TicketsCard,
};
