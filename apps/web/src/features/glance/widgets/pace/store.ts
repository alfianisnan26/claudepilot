import { labApi } from '@/features/lab/api';
import { createLiveStore } from '../shared/liveStore';

/** The Crew scorecard's summary for the day with the day before it (T-600); loaded again on a usage or ticket push. */
export const paceStore = createLiveStore({ load: () => labApi.scorecard('day', true), topics: ['claudeusage', 'tickets'] });
