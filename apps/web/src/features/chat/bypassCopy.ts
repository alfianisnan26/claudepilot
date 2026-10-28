/**
 * PILOT-1008 (T-2884): what the Bypass dialog and the Bypass approval card say about when Bypass ends and when it comes back.
 * One source, so the two cannot drift, and it must match the server (`#keepBypass` in apps/server/src/chat/controller.ts,
 * chat-sessions PRD FR20/FR20a): kept across a move, a Restart and a recovery while the policy allows it; a sleep ends it except
 * for a lead, whose wake (and Keep going within 24 hours, PILOT-996) puts it back; a worker holds it only while its lead does
 * (PILOT-997); a person's switch-off ends it and nothing puts it back.
 */

/** The one line shown at the moment a person decides. */
export const BYPASS_LIFETIME = 'It stays on through a move or a restart, until you switch it off or the chat ends.';

/** The InfoTip behind it: every way it ends and every way it comes back. */
export const BYPASS_LIFETIME_ABOUT =
  'Deny rules still apply. Bypass comes back by itself after a move to another Claude, a Restart or a recovery, while the policy allows it. ' +
  'A sleep turns it off, except for a lead: its wake puts it back, and Keep going can within 24 hours. ' +
  'Workers keep it only while their lead is in it. When a person switches it off or ends the chat, it is gone for good.';
