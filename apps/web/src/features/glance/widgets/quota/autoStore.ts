import { autoApi } from '@/features/autotransfer/api';
import { createLiveStore } from '../shared/liveStore';

/** Auto move as it applies to the viewer, and their latest moves; loaded again on the live topic `autotransfer`. */
export const autoStore = createLiveStore({
  load: async () => {
    const [overview, moves] = await Promise.all([autoApi.overview(), autoApi.moves(20)]);
    return { effective: overview.effective, moves };
  },
  topics: ['autotransfer'],
});
