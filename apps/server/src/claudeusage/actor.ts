// Claude usage: who is asking (PLAN-10, multi-user). The reports, the summary and the recommendation take an `actorId` and filter through
// `UsageOptions.canUseClaude`; the portal installs `seamCanUseClaude` (org isolation, owner request 2026-11-01): a Claude's usage is visible to
// the people who may use it, which follows its workspace and so its org (authz/owners.ts). No actor is the portal itself (docs §20.14).

import { isUserId, objectRef } from '@portal/contracts';
import { canUser } from '../authz/seam.js';

/** The seam's rule: `operate` on the Claude (its workspace's people who may use it). */
export const seamCanUseClaude = (actorId: string, claudeId: string): boolean => isUserId(actorId) && canUser(actorId, 'operate', objectRef('claude', claudeId));

/** The one user until multi-user: what the routes and the tools pass as `actorId`. */
export const OWNER_ACTOR = 'u_owner';
