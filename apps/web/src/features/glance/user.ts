// Whose glance preferences these are. Today the portal has one shared sign-in, so there is one owner and this is a constant. With
// accounts (docs/prd: multi-user, round 10) it becomes the signed-in user's id from the auth context; the settings keys below carry
// it already, so two people on one browser never read each other's choices, and the settings object is plain JSON that can move to
// the portal, per user, without changing shape.

/** The one owner of a single-user portal. */
export const OWNER_ID = 'u_owner';

export const currentUserId = (): string => OWNER_ID;

/** The localStorage key of one user's glance settings. */
export const glanceKey = (userId: string): string => `claudepilot.glance.${userId}`;
