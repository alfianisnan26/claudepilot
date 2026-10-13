import { ticketsApi } from '@/features/tickets/api';
import { createLiveStore } from '../shared/liveStore';

/** The queue's counts and its three newest open tickets, loaded again on the live topic `tickets`. */
export const ticketsStore = createLiveStore({ load: () => ticketsApi.list({ sort: 'newest', limit: 3 }), topics: ['tickets'] });
