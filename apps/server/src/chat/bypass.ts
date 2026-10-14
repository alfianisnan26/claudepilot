// Bypass permissions in chat (chat-sessions PRD FR20, §6 rule 5, C5). Claude runs every tool without asking, so it
// is never one tap and never on by itself. It needs all of: the policy allows it (an interim global switch until
// Settings & policies exists: `sessions.allowBypass`, off, audited, a confirmation to turn on); the session is
// bypass-capable (the person opted in when starting it, or restarted it for Bypass); a confirmation that says
// what is true of the workspace; and a fresh re-check of the server code (web-app-pwa §12.5). Capability is
// never inherited and never granted to another module's request: only the person's own request through the app's
// route sets it. Wakes and resumes never restore Bypass; a deliberate restart (a move, a Restart) keeps it while the
// policy allows it (FR20a, `#keepBypass` in the controller). Entering and leaving it is audited.

import { defineErrorCodes } from '@isnanme/core';
import { BYPASS_BLOCKED, BYPASS_NOT_CAPABLE, BYPASS_NOT_KEPT, REAUTH_REQUIRED } from '@portal/contracts';
import { defineSetting } from '../settings/registry.js';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    BYPASS_BLOCKED: true;
    BYPASS_NOT_CAPABLE: true;
    BYPASS_NOT_KEPT: true;
    REAUTH_REQUIRED: true;
  }
}
defineErrorCodes({
  [BYPASS_BLOCKED]: { status: 403, message: 'Bypass is blocked by policy.' },
  [BYPASS_NOT_CAPABLE]: { status: 409, message: 'This session wasn’t started to allow Bypass.' },
  // T-102: a queued or automatic restart that could not keep Bypass is refused; a person restarts it by hand.
  [BYPASS_NOT_KEPT]: { status: 409, message: 'A restart can’t keep Bypass here: restart it yourself.' },
  [REAUTH_REQUIRED]: { status: 403, message: 'Enter the server code again.' },
});

/** The interim policy: a global switch, read through the shared settings store, replaced by Settings & policies later. */
export const BYPASS_SETTING = 'sessions.allowBypass';

defineSetting({
  key: BYPASS_SETTING,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'sessions',
  order: 10,
  label: 'Bypass in chat',
  help: 'Lets a chat session turn on Bypass permissions, where Claude runs every tool without asking. Each session still needs its own opt-in when it starts, a confirmation and a fresh check of the server code. Deny rules still apply. Workspaces have internet access and delivered credentials.',
  protective: false,
});

/** What is true of a workspace, for the confirmation: only what the portal knows is claimed. */
export interface BypassFacts {
  workspaceId: string;
  /** Workspaces are containers with the default network: they can reach the internet. False only where the portal knows they can't. */
  internet: boolean;
  /** Credentials the portal delivered into it (an account pool's key, Secrets & env values), by kind. */
  credentials: string[];
}

/** `GET /api/chat/sessions/:id/bypass`: where a session stands with Bypass, for the mode picker and the confirmation. */
export interface BypassState {
  /** The policy allows Bypass in chat. */
  allowed: boolean;
  /** The session was started with, or restarted for, Bypass. Only then can it be entered. */
  capable: boolean;
  /** It is on now. */
  active: boolean;
  /** The session is working or waiting: restarting it for Bypass has to wait for its turn to end. */
  busy: boolean;
  facts: BypassFacts;
  /** The signed-in session passed the re-check of the server code lately, so entering needs no new code. */
  reauthed: boolean;
}

/** Why a Bypass request was refused, for the audit trail and the error code. */
export type BypassRefusal = 'policy' | 'not_capable' | 'no_acknowledgement' | 'no_reauth' | 'control' | 'busy' | 'not_live';
