import { ciApi } from '@/features/ci/api';
import { createLiveStore } from '../shared/liveStore';

/** The newest CI runs (and how many are not finished), loaded again on the live topic `ci`. */
export const ciStore = createLiveStore({ load: () => ciApi.runs({ limit: 5 }), topics: ['ci'] });
