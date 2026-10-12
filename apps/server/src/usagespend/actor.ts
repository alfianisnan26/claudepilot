// Usage spend: who is asking and what they may see (docs/prd/claude-usage.md §26.4, "Multi-user"). The portal has ONE owner today, `u_owner`, who sees
// and changes everything, and nothing below behaves differently for it. Several users are coming (round 10): so every read here takes the
// `actorId` it is for, a budget and a spike have an owner, what a person changes is audited with who, and the one place a visibility rule goes is
// `Visibility`. It is a seam, not a feature: the default allows everything, and the authz module's `can(actor, 'read', object)` plugs in here later.

/** The one owner of today's single-owner portal. */
export const OWNER_ACTOR = 'u_owner';

/** What a visibility rule is asked about. */
export interface SpendObject {
  kind: 'session' | 'workspace' | 'ticket' | 'persona' | 'claude' | 'budget' | 'spike';
  id: string;
}

/**
 * Whether `actorId` may see `object`. Asked about the workspace and the session of every request an attribution, a summary, a spike or an alert is
 * built from, and about every budget, so a user sees only what they own or were granted. Unset, everyone sees everything (the single owner).
 * Budgets per Claude are admin-managed and budgets per workspace belong to the workspace's managers: that is the rule a real `Visibility` will apply.
 */
export type Visibility = (actorId: string, object: SpendObject) => boolean;

/** Who made a change and how: `via` is `ui` or `portal-mcp:<token id>`. Recorded on the audit trail. */
export interface Who {
  actorId: string;
  via: string;
}

/** The owner at the keyboard: what every route uses until the portal knows who is signed in. */
export const UI_OWNER: Who = { actorId: OWNER_ACTOR, via: 'ui' };

/**
 * Who created a session (a user id), for usage per user (PLAN-12, after multi-user: `by=user`). The one helper that grouping resolves through, and
 * today the portal has one owner. A child session counts under the creator of its ROOT session (`rootOf` in attribution.ts), so a person is charged for
 * the helpers their session started. The number is an estimate of API-equivalent dollars; a plan's quota belongs to the Claude account, not to a user.
 */
export const creatorOf = (_session: { sessionId: string } | null | undefined): string => OWNER_ACTOR;
