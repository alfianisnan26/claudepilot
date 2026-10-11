// Chat sessions: which workspaces may host them (chat-sessions PRD §6 rule 1). Sessions are SDK-style
// use of Claude Code, so they run only on credentials the portal delivered through an Account Pool
// (Anthropic API keys or custom hosts, via the managed `apiKeyHelper`), never on a workspace's own
// Claude login. Eligibility comes from portal state alone, so nothing here reads the workspace.

import { AppError, defineErrorCodes } from '@isnanme/core';
import { CHAT_INELIGIBLE, type WorkspaceAccountState } from '@portal/contracts';
import type { DeliveryStatus } from '../delivery/reconciler.js';

/** The error code of a refused create, launch, resume or wake (409); its message is the reason. */
export { CHAT_INELIGIBLE };

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    CHAT_INELIGIBLE: true;
  }
}
defineErrorCodes({ [CHAT_INELIGIBLE]: { status: 409, message: 'Sessions can’t run in this workspace right now.' } });

/** No Account Pool assignment (none, or one being removed). */
export const NO_POOL = 'Sessions need an account pool on this workspace.';
/** The assignment waits for quota, or has no account to use. */
export const NO_KEY = "This workspace's pool has no usable key right now.";
/** What the pool delivers hasn't landed in the workspace (pending, failed, drifted, frozen, …). */
export const NOT_SYNCED = "Delivery to this workspace isn't up to date yet.";
/** `cp-session authcheck` failed: the account drop-in doesn't name Account Pool's helper. */
export const NOT_SET_UP = "This workspace isn't set up to use its pool's keys yet.";
/** The eligibility check itself failed (the database is unavailable, say). */
export const UNKNOWN = "Couldn't check this workspace's account pool. Try again.";

/** Whether a workspace may host sessions now, and why not. */
export type Eligibility = { ok: true } | { ok: false; reason: string };

/**
 * Rule 1 from portal state: an Account Pool assignment that is `active` (not `waiting` for quota, not
 * `removing`) and a delivery status of `synced`. Wire it as the controller's `eligibility` hook with
 * `pools.stateFor(id)` and `reconciler.row(id)?.status`.
 */
export function poolEligibility(account: Pick<WorkspaceAccountState, 'state'> | null, delivery: DeliveryStatus | null | undefined): Eligibility {
  if (!account || account.state === 'removing') return { ok: false, reason: NO_POOL };
  if (account.state !== 'active') return { ok: false, reason: NO_KEY };
  if (delivery !== 'synced') return { ok: false, reason: NOT_SYNCED };
  return { ok: true };
}

/** The refusal: 409 `CHAT_INELIGIBLE`, the reason as its message. */
export const ineligibleError = (reason: string): AppError => new AppError(CHAT_INELIGIBLE, reason);
