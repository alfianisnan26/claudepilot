// Whose preferences these are: the signed-in person (D-111 D6), set by OrgsProvider through ./layouts.ts (`syncLayouts`); the founding
// user's id until it is known. The keys carry it, so two people on one browser never read each other's choices.

import { layoutOwner } from './layouts';

/** The founding user (the one owner before accounts). */
export const OWNER_ID = 'u_owner';

export const currentUserId = (): string => layoutOwner().userId;

/** The localStorage key of one user's glance settings. */
export const glanceKey = (userId: string): string => `claudepilot.glance.${userId}`;
