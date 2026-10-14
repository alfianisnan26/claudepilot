import { chatApi } from '@/features/chat/api';
import { createLiveStore } from '../shared/liveStore';

/** The chats Keep going watches; loaded again on the live topic `keepgoing` (an action, or a watched chat's state changed). */
export const autonomyStore = createLiveStore({ load: () => chatApi.keepGoingList(), topics: ['keepgoing'] });
