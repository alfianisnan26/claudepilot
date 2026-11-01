// Usage spend: who is asking and what they may see (docs/prd/claude-usage.md §26.4, "Multi-user"). Every read takes the `actorId` it is for,
// what a person changes is audited with who, and the one place the visibility rule goes is `Visibility`. The service allows everything without
// one (module tests); the portal installs `seamVisibility` (org isolation, owner request 2026-11-01): a person sees the spend of the
// workspaces and Claudes they may view, so another org's numbers never reach them.

import { objectRef, workspaceRef, isUserId } from '@portal/contracts';
import { canUser, isPlatformAdmin } from '../authz/seam.js';

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

/**
 * The seam's rule: a workspace or a Claude (a budget's scope: the service asks about it) by `view` on it, which follows its org; a budget on
 * everything, and a row with no workspace, only for a platform admin. A session, a ticket, a persona and a spike are only ever asked about
 * together with their workspace, which decides (a session is not asked of the seam here: that would count as an org admin's transcript read).
 */
export const seamVisibility: Visibility = (actorId, object) => {
  if (!isUserId(actorId)) return false;
  if (object.kind === 'workspace') return object.id ? canUser(actorId, 'view', workspaceRef(object.id)) : isPlatformAdmin(actorId);
  if (object.kind === 'claude') return canUser(actorId, 'view', objectRef('claude', object.id));
  if (object.kind === 'budget') return isPlatformAdmin(actorId);
  return true;
};

/** Who made a change and how: `via` is `ui` or `portal-mcp:<token id>`. Recorded on the audit trail. */
export interface Who {
  actorId: string;
  via: string;
}

/** The owner at the keyboard: the default of the service's methods (module tests and the portal's own calls). */
export const UI_OWNER: Who = { actorId: OWNER_ACTOR, via: 'ui' };
