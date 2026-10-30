/**
 * PILOT-1008 (T-2884): what the Bypass dialog and the Bypass approval card say about when Bypass ends and when it comes back.
 * One source, so the two cannot drift, and it must match the server (`#keepBypass`, `#parentLeftBypass` and `BYPASS_LOST` in
 * apps/server/src/chat/controller.ts, chat-sessions PRD FR20/FR20a), for every way in: a person's dialog, an allowed approval card, a
 * worker that took it from its lead (`inherit`), a lead's wake and Keep going. Kept across a move, a Restart and a recovery while the
 * policy allows it; a sleep or a lost process ends it except for a lead a person put in it, whose wake (and Keep going within 24 hours,
 * PILOT-996) puts it back; only a worker that took it from its lead leaves it with the lead (PILOT-997); a switch-off, the policy turned
 * off and the chat's end are final (not in `BYPASS_LOST`).
 */

/** The one line shown at the moment a person decides. */
export const BYPASS_LIFETIME = 'A move or a restart keeps it on; once switched off, only a person turns it back on.';

/** The InfoTip behind it: every way it ends and every way it comes back. */
export const BYPASS_LIFETIME_ABOUT =
  'Deny rules still apply. A move to another Claude, a Restart or a recovery puts it back by itself while the policy allows it. ' +
  'A sleep or a lost process turns it off, except for a lead a person put in it: its wake puts it back, and Keep going can within 24 hours. ' +
  'A worker that got it from its lead leaves it when the lead does; one you turn on yourself keeps it. ' +
  'A switch-off, the policy turned off, or the chat ending is final: nothing puts it back by itself.';
