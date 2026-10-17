import type { TicketList } from '@portal/contracts';
import { ticketsApi } from '@/features/tickets/api';
import { createLiveStore } from '../shared/liveStore';

/** The queue's counts and its three newest open tickets, loaded again on the live topic `tickets`. */
export const ticketsStore = createLiveStore({
  // Page 1 carries `total` and `counts` (D-58); a first page always has them.
  load: async (): Promise<TicketList> => {
    const p = await ticketsApi.list({ sort: 'newest', limit: 3 });
    return { items: p.items, total: p.total ?? p.items.length, counts: p.counts! };
  },
  topics: ['tickets'],
});
