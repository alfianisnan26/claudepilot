// Keep going (T-259 slice 1, T-104, T-108 item 1; docs/prd/chat-sessions.md "Keep going (the watchdog)"): the portal keeps an autonomous chat
// going from the outside, with no person and no process on anybody's machine. A per-chat policy (off by default) and a deterministic sweep in
// the server: an idle chat is told to continue, an interrupted or sleeping one is woken, a question (AskUserQuestion, an elicitation) is told
// to decide by the written defaults, and what it may not repair (a tool approval waiting, a chat out of Bypass, a chat that ended) is reported
// ONCE: a notification `keepgoing_attention` and one ticket per chat and cause. A tool approval is never answered; Bypass is never re-entered.

/** The setting that stops every sweep at once (the kill switch). */
export const KEEPGOING_SETTING_KEYS = {
  enabled: 'keepgoing.enabled',
  /** T-257 item 4: the coordinator's chat (a session id) that hears of a chat left down; empty: the chat's parent, if it has one. */
  coordinator: 'keepgoing.coordinator',
} as const;

/** Bounds and defaults of a policy. The defaults are the supervisor's (docs/dev-sessions/supervisor.mjs), not measurements. */
export const KEEPGOING_BOUNDS = {
  nudgeAfterMin: { min: 1, max: 240, default: 4 },
  maxNudgesPerDay: { min: 0, max: 500, default: 60 },
  maxWakesPerDay: { min: 0, max: 200, default: 20 },
  promptMax: 4000,
  statusFileMax: 200,
  /** A pause's reason (one line). */
  pauseReasonMax: 200,
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
  /** Two starts of a chat's lineage are at least this far apart (the supervisor's RESTART_GAP_MIN). */
  restartGapMin: 5,
} as const;

/**
 * Why an ended chat is started again, for the cap per root cause (T-257 item 2; the supervisor's numbers): an integrity ending T-136 calls
 * harmless (the harness's, not the chat's) counts only against its own ceiling; any other ending counts against the chat's cap, which is
 * lower after an integrity ending the portal calls suspicious.
 */
export const KEEPGOING_RESTART_CLASSES = ['harmless', 'integrity', 'other'] as const;
export type KeepGoingRestartClass = (typeof KEEPGOING_RESTART_CLASSES)[number];

/** Starts of a new chat per 24 hours over a lineage (`continuedFrom` back), by the class of the ending; harmless ones count only for themselves. */
export const KEEPGOING_RESTART_CAPS: Record<KeepGoingRestartClass, number> = { harmless: 12, integrity: 3, other: 6 };

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
  /**
   * The program the chat belongs to (the pause switch): a short slug like the supervisor's track keys (`orchestrator`, `konfersi`, `event`);
   * null for none. A pause of that program, or of all, holds the chat. Optional on the wire: absent leaves it.
   */
  program?: string | null;
}

/** A program's name: lowercase letters, digits and hyphens, 1 to 40, starting with a letter or digit. */
export const KEEPGOING_PROGRAM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The scope of a pause that holds every chat (the program `null`). */
export const KEEPGOING_PAUSE_ALL = '*';

/**
 * A pause (the program pause switch, T-259 slice 3): while it stands, Keep going starts no continuation, sends no nudge, wake or answer and
 * raises no report (ticket or push) for the chats it holds; it keeps looking (state, reports that clear, the Home card). Resume looks again at
 * once. Set by a platform admin (Home, Autonomy) or an admin token (`keepgoing_pause_set`), audited `keepgoing.pause`.
 */
export interface KeepGoingPause {
  /** The program, or null for every chat. */
  program: string | null;
  /** One line, a person's words (shown as text). */
  reason: string;
  since: string;
  /** Who paused it (an actor label: `user:<id>`, `portal-mcp:<token id>`). */
  by: string;
}

/** `PUT KEEPGOING_API.pauses`: pause or resume one program (`program: null` is all). `reason` is required to pause. */
export interface SetKeepGoingPauseRequest {
  program: string | null;
  paused: boolean;
  reason?: string;
}

/**
 * What the sweep did. `reported` is a notification and a ticket; `stood_down` the policy turned itself off (a person closed the chat, its
 * ticket closed). Slice 2: `recovered` an integrity ending brought back in place (T-136), `recover_refused` the portal would not (a new chat
 * follows), `restarted` a new chat continues an ended one (written on the ended one, with the class of its ending as the cause).
 * T-257 item 4: `escalated` a chat left down was told to the coordinator's chat.
 */
export const KEEPGOING_ACTIONS = ['nudged', 'woke', 'answered', 'reported', 'failed', 'capped', 'stood_down', 'set', 'recovered', 'recover_refused', 'restarted', 'escalated'] as const;
export type KeepGoingActionKind = (typeof KEEPGOING_ACTIONS)[number];

/**
 * What a report is about: one ticket per chat and cause, not repeated while the cause stands. Since slice 2 `ended` is a quiet mark (when the
 * sweep first saw the ending: no ticket, no notification; the chat is recovered or started again) and `down` is the one loud report: left
 * down by the cap, a refusal or a failed start (at once), or still ended 15 minutes after the mark.
 */
export const KEEPGOING_CAUSES = ['approval', 'bypass', 'ended', 'down', 'cap', 'wake_failed'] as const;
export type KeepGoingCause = (typeof KEEPGOING_CAUSES)[number];

/** The words a cause reads as (notification, ticket title, Session info). */
export const KEEPGOING_CAUSE_TEXT: Record<KeepGoingCause, string> = {
  approval: 'a tool approval waits',
  bypass: 'out of Bypass',
  ended: 'ended',
  down: 'left down',
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
  /** Nothing is done for this chat: the kill switch `keepgoing.enabled` is off, or a pause holds it (`pause`). */
  paused: boolean;
  /** The pause that holds it (all first, then its program); null when none does. */
  pause?: KeepGoingPause | null;
  /** The causes reported and still standing (slice 2; the quiet `ended` mark is not one). */
  standing?: KeepGoingCause[];
}

/** One chat Keep going watches, for the Home card (`GET KEEPGOING_API.list`). */
export interface KeepGoingChat {
  sessionId: string;
  /** Written by agents: shown as text, never as markup. */
  title: string;
  workspaceId: string;
  /** The chat's state as the list shows it (`asleep` for an idle chat whose process sleeps). */
  state: 'starting' | 'working' | 'idle' | 'asleep' | 'waiting' | 'interrupted' | 'ended';
  mode: string;
  keepGoing: ChatKeepGoing;
}

/** `GET KEEPGOING_API.list`: the caller's chats with Keep going on; the ones with a cause standing first, then by their last action, newest first. */
export interface KeepGoingList {
  /** The kill switch is off. */
  paused: boolean;
  /** The pauses that stand (all first, then by program); every caller sees them (a program name and a person's one-line reason). */
  pauses?: KeepGoingPause[];
  chats: KeepGoingChat[];
}

export const KEEPGOING_API = {
  list: '/api/keepgoing',
  pauses: '/api/keepgoing/pauses',
} as const;

/** `PUT CHAT_API.keepGoing(id)`: each field optional; absent leaves it. `prompt: null` / `statusFile: null` go back to the default. */
export type UpdateKeepGoingRequest = Partial<ChatKeepGoingPolicy>;

/** The actor of everything the sweep does by itself (the transcript shows its messages as the portal's). */
export const KEEPGOING_ACTOR = 'portal:keepgoing';

/** The answer a question gets (what the supervisor wrote). */
export const KEEPGOING_QUESTION_ANSWER = 'Nobody is here to answer. Decide yourself by the written defaults, write the decision down where your work says, and go on.';
