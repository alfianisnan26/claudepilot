import { usageSpendApi } from '@/features/usage/spend/api';
import { createLiveStore } from '../shared/liveStore';

/** What was spent today, this week and this month; loaded again on the live topic `claudeusage` (a request finished, a budget moved). */
export const spendStore = createLiveStore({ load: () => usageSpendApi.summary(), topics: ['claudeusage'] });
