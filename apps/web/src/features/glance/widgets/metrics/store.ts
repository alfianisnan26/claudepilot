import type { MetricsOverview } from '@portal/contracts';
import { metricsApi } from '@/features/lab/api';
import { createLiveStore } from '../shared/liveStore';

/** The pilot metrics of every program over the last 24 hours (T-2360): both scores, resolved, the median time to resolve. Loaded again on a ticket push. */
export const metricsStore = createLiveStore<MetricsOverview>({ load: () => metricsApi.overview('all', '24h'), topics: ['tickets'] });
