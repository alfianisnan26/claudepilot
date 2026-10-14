// Keep going (T-259 slice 1, T-104, T-108 item 1; docs/prd/chat-sessions.md "Keep going (the watchdog)"): the portal keeps an autonomous chat
// going from the outside, with no person and no process on anybody's machine. A per-chat policy (off by default) and a deterministic sweep in
// the server: an idle chat is told to continue, an interrupted or sleeping one is woken, a question (AskUserQuestion, an elicitation) is told
// to decide by the written defaults, and what it may not repair (a tool approval waiting, a chat out of Bypass, a chat that ended) is reported
// ONCE: a notification `keepgoing_attention` and one ticket per chat and cause. A tool approval is never answered; Bypass is never re-entered.

/** The setting that stops every sweep at once (the kill switch). */
export const KEEPGOING_SETTING_KEYS = {
  enabled: 'keepgoing.enabled',
} as const;

/** Bounds and defaults of a policy. The defaults are the supervisor's (docs/dev-sessions/supervisor.mjs), not measurements. */
export const KEEPGOING_BOUNDS = {
  nudgeAfterMin: { min: 1, max: 240, default: 4 },
  maxNudgesPerDay: { min: 0, max: 500, default: 60 },
  maxWakesPerDay: { min: 0, max: 200, default: 20 },
  promptMax: 4000,
  statusFileMax: 200,
} as const;

/** Fixed numbers of the sweep (design choices). */
export const KEEPGOING_CONSTANTS = {
  /** A round every this many seconds; each chat is due again this long after its last look, plus a jitter. */
  roundSec: 60,
  /** Two nudges are at least this far apart (the supervisor's NUDGE_GAP_MIN). */
  nudgeGapMin: 10,
  /** A tool approval that has waited this long is reported (T-256 item 4). */
  approvalReportMin: 10,
  /** A chat ended this long ago and not started again is down (T-257 item 4). */
  downAfterMin: 15,
  /** After a failed action the chat is left alone this long. */
  backoffMin: 15,
} as const;

/** The default status file `{status}` names, relative to the chat's folder (the dev-sessions convention). */
export const KEEPGOING_DEFAULT_STATUS_FILE = 'docs/dev-sessions/status/orchestrator.md';

/**
 * The continuation prompt by default: the supervisor's CONTINUE text. `{status}` becomes the policy's status file, `{ticket}` the chat's ticket
 * (or "your ticket").
 */
export const KEEPGOING_DEFAULT_PROMPT =
  'Nobody is here to answer. Continue now: read your status file {status}, integrate what finished sub-agents brought, dispatch the next slices to up to three sub-agents in parallel, keep your status file current. If you asked a question, answer it yourself with the written default and go on. When the whole backlog is done, make TRACK COMPLETE the first line of your status file, commit and push it, and end with the final report. Do not stop to summarise or wait.';

/** What a person sets on a chat. */
export interface ChatKeepGoingPolicy {
  enabled: boolean;
  /** Nudge after this many idle minutes (T-41's idle: no turn, no task, nothing waiting, no move or restart). */
  nudgeAfterMin: number;
  /** The continuation prompt; null is the default (`KEEPGOING_DEFAULT_PROMPT`). */
  prompt: string | null;
  /** What `{status}` names; null is `KEEPGOING_DEFAULT_STATUS_FILE`. */
  statusFile: string | null;
  /** Caps per 24 hours. */
  maxNudgesPerDay: number;
  maxWakesPerDay: number;
}

/** What the sweep did. `reported` is a notification and a ticket; `stood_down` the policy turned itself off (a person closed the chat). */
export const KEEPGOING_ACTIONS = ['nudged', 'woke', 'answered', 'reported', 'failed', 'capped', 'stood_down', 'set'] as const;
export type KeepGoingActionKind = (typeof KEEPGOING_ACTIONS)[number];

/** What a report is about: one ticket per chat and cause, not repeated while the cause stands. */
export const KEEPGOING_CAUSES = ['approval', 'bypass', 'ended', 'down', 'cap', 'wake_failed'] as const;
export type KeepGoingCause = (typeof KEEPGOING_CAUSES)[number];

/** The words a cause reads as (notification, ticket title, Session info). */
export const KEEPGOING_CAUSE_TEXT: Record<KeepGoingCause, string> = {
  approval: 'a tool approval waits',
  bypass: 'out of Bypass',
  ended: 'ended',
  down: 'down',
  cap: 'cap reached',
  wake_failed: 'could not wake',
};

export interface KeepGoingAction {
  at: string;
  kind: KeepGoingActionKind;
  cause: KeepGoingCause | null;
  /** A fixed sentence the portal wrote (never message text). */
  reason: string;
}

/** A chat's policy as the session payload carries it (`ChatSession.keepGoing`), with today's counts and the last action. */
export interface ChatKeepGoing extends ChatKeepGoingPolicy {
  /** In the last 24 hours. */
  nudgesToday: number;
  wakesToday: number;
  last: KeepGoingAction | null;
  /** The kill switch `keepgoing.enabled` is off: nothing runs anywhere. */
  paused: boolean;
}

/** `PUT CHAT_API.keepGoing(id)`: each field optional; absent leaves it. `prompt: null` / `statusFile: null` go back to the default. */
export type UpdateKeepGoingRequest = Partial<ChatKeepGoingPolicy>;

/** The actor of everything the sweep does by itself (the transcript shows its messages as the portal's). */
export const KEEPGOING_ACTOR = 'portal:keepgoing';

/** The answer a question gets (what the supervisor wrote). */
export const KEEPGOING_QUESTION_ANSWER = 'Nobody is here to answer. Decide yourself by the written defaults, write the decision down where your work says, and go on.';
