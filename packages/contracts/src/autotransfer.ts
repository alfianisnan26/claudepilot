// Auto transfer (docs/prd/auto-transfer.md): when the Claude a chat runs on is nearly out of plan quota, the chat can be moved to another
// Claude on the same workspace, through the Move flow that already exists (`ChatController.switchClaude`, workspace-claudes PRD).
// Off by default. Three modes: `off`, `ask` (a card with Move / Later / Always automatic) and `auto` (it moves by itself, with safeguards
// that are all checked BEFORE it acts). Every automatic move leaves an audit row, a card in the chat with an Undo, and a notification.
//
// MULTI-USER (PLAN-10): a move acts for the session's OWNER and only among Claudes that owner may use (`can(owner, 'operate', claude)`, on top of
// the Move flow's own check). The `automove.*` settings are the platform's defaults and caps (an admin's); a user's own choices
// (`AutoUserPrefs`) override the defaults and can only be stricter than a cap. Per-person rows carry `user_id TEXT NOT NULL DEFAULT 'u_owner'`.
//
// Numbers are never invented: a percent left is `measured` (a reading Claude Code gave); a projection is an `estimate`; a figure that is
// not available says why (`Figure`, claude-usage PRD section 20).

import { modelInfo } from './models.js';
import type { Figure } from './usage.js';

/** `off`: nothing. `ask`: a card in the chat. `auto`: it moves by itself. */
export const AUTO_MODES = ['off', 'ask', 'auto'] as const;
export type AutoMode = (typeof AUTO_MODES)[number];

/** Why a move is wanted: the fullest limit that stops the Claude has `thresholdPct` or less left, it is used up, or it is projected to run out before it resets. */
export const AUTO_REASONS = ['low', 'exhausted', 'projection'] as const;
export type AutoReason = (typeof AUTO_REASONS)[number];

/** Global settings (the Settings page lists them as the `automove` group; the module reads them with `settings.get`). */
export const AUTO_SETTING_KEYS = {
  /** Off: no mode applies anywhere. On with `automatic` off: `ask`. On with `automatic` on: `auto`. */
  enabled: 'automove.enabled',
  automatic: 'automove.automatic',
  /** Move when the fullest all-model window has this much or less left (percent). A Claude can override it. */
  thresholdPct: 'automove.thresholdPct',
  /** Also move when a window is projected to run out before it resets (an estimate: only with enough readings). */
  useProjection: 'automove.useProjection',
  /** Minutes before a chat may move again (from any move, suggestion answered or undo). */
  minPauseMin: 'automove.minPauseMin',
  maxPerSessionPerDay: 'automove.maxPerSessionPerDay',
  /** Automatic moves in all, per day. */
  maxPerDay: 'automove.maxPerDay',
  /** Sessions on one Claude (counting a move on its way) above which it is not chosen as a destination. */
  maxPerDestination: 'automove.maxPerDestination',
  /** Only to a Claude whose plan lets the chat's model run (never a downgrade). */
  sameModelOnly: 'automove.sameModelOnly',
  /** A Claude on a Console API key (billed per use) may be a destination. Off until a person turns it on. */
  allowApiKey: 'automove.allowApiKey',
  allowBypass: 'automove.allowBypass',
  /** The engine records what it WOULD do (moves, steers, continuations) and does none of it (T-105's live check). */
  dryRun: 'automove.dryRun',
  /** Models a chat may change to when only its own model's limit is low, best first (`sonnet`, `opus, sonnet, haiku`). Empty: never. */
  modelFallback: 'automove.modelFallback',
  /** When both are possible: keep the model and move to another Claude first (on), or stay on this Claude and change model first (off). */
  keepModelFirst: 'automove.keepModelFirst',
  /** A move (automatic or by a person) to a Claude that has the chat's original model goes back to it (T-109). Off by default. */
  returnToOriginalModel: 'automove.returnToOriginalModel',
  /** D-39 (T-105): the threshold rule moves a chat only when the Claude's projected use at its next reset is at least `paceMinPct`. */
  respectPace: 'automove.respectPace',
  paceMinPct: 'automove.paceMinPct',
} as const;

/** Defaults and bounds of the numeric settings. The defaults are design choices, not measurements. */
export const AUTO_BOUNDS = {
  thresholdPct: { min: 1, max: 50, default: 10 },
  minPauseMin: { min: 5, max: 720, default: 5 },
  maxPerSessionPerDay: { min: 1, max: 10, default: 8 },
  maxPerDay: { min: 1, max: 50, default: 30 },
  maxPerDestination: { min: 1, max: 10, default: 3 },
  /** D-39: under this projected use at the reset, a chat at the threshold stays (owner, 2026-10-13). */
  paceMinPct: { min: 50, max: 100, default: 90 },
} as const;

/** Constants, not settings (the PRD gives each one's reason). */
export const AUTO_CONSTANTS = {
  /** "Later" holds a suggestion back this long. */
  laterMin: 20,
  /** After an Undo, a chat does not move by itself for this long. */
  undoPauseMin: 120,
  /** A reading older than this does not start an automatic move (an Ask card may still be shown, saying the reading is old). */
  maxReadingAgeMin: 15,
  /** A projection counts only when the run-out is within this many minutes. */
  projectionHorizonMin: 120,
  /** A projection counts only when the source still has at most this much left (a blip on a full window never moves a chat). */
  projectionMaxLeftPct: 30,
  /** An automatic move waits for a quiet turn boundary (nothing queued, no approval open, no agent running) up to this long, then becomes a card. */
  deferMaxMin: 30,
  /** A destination the chat left is not chosen again for this long unless the one it left has reset. */
  pingPongMin: 240,
  /** A chat waiting for quota (no destination, a cap, a pause) and every chat at or under the threshold is looked at again this often (T-105). */
  waitRecheckMin: 2,
  /** T-781: a chat on an exhausted Claude that still shows `working` with no stored event for this long is stopped and moved (the hard move). */
  hardMoveIdleMin: 3,
} as const;

export interface AutoTransferSettings {
  mode: AutoMode;
  thresholdPct: number;
  useProjection: boolean;
  minPauseMin: number;
  maxPerSessionPerDay: number;
  maxPerDay: number;
  maxPerDestination: number;
  sameModelOnly: boolean;
  allowApiKey: boolean;
  /** A chat in Bypass may be moved by itself (the move keeps Bypass while the policy allows it; chat-sessions §21 FR20a). The platform's only; off by default. */
  allowBypass: boolean;
  /** Model families a chat may change to, best first (lower case: `opus`, `sonnet`, `haiku`); empty: a chat never changes model by itself. */
  modelFallback: string[];
  /** Keep the model and move first (true), or change model on the same Claude first (false). */
  keepModelFirst: boolean;
  /** Record what would happen, do nothing (T-105). */
  dryRun: boolean;
  /** D-39: the threshold rule waits for the pace (the projected use at the reset at least `paceMinPct`); exhausted always moves. */
  respectPace: boolean;
  paceMinPct: number;
}

/** Reads `automove.modelFallback`: a comma or space list of model families, lower case, known ones only, no repeats. */
export function parseModelFallback(raw: unknown): string[] {
  const out: string[] = [];
  // The families the model catalogue knows (T-109: Fable too).
  for (const w of String(typeof raw === 'string' ? raw : '').toLowerCase().split(/[\s,]+/)) if (modelInfo(w) && !out.includes(w)) out.push(w);
  return out;
}

/** The mode two booleans make. */
export const autoModeOf = (enabled: boolean, automatic: boolean): AutoMode => (!enabled ? 'off' : automatic ? 'auto' : 'ask');

/** Per Claude: its own threshold, and where its chats may go, in order of preference. */
export interface AutoClaudeConfig {
  claudeId: string;
  claudeName: string;
  workspaceId: string;
  /** Null: the global threshold. */
  thresholdPct: number | null;
  /**
   * Destination Claudes of the same workspace, best first. Empty: any Claude that can take the chat is eligible, ranked by the Usage
   * recommendation. Not empty: ONLY these are eligible (an allowlist), tried in this order among those that can take the chat now.
   */
  destinations: string[];
}

/**
 * A user's own choices, each null to follow the platform default (the `automove.*` settings). The caps (minimum pause, moves per day,
 * sessions per destination) are the platform's and cannot be raised here; `allowApiKey` is honoured only while the platform allows it.
 */
export interface AutoUserPrefs {
  mode: AutoMode | null;
  thresholdPct: number | null;
  useProjection: boolean | null;
  sameModelOnly: boolean | null;
  allowApiKey: boolean | null;
}

export interface UpdateAutoClaudeRequest {
  thresholdPct?: number | null;
  destinations?: string[];
}

/** Why a move did not happen, or is not possible for a chat now. Fixed codes; the page has one short line for each. */
export const AUTO_REFUSALS = [
  'mode_off',
  'pooled', // the workspace runs on an account pool: its Claudes share the pool's keys, there is no per-Claude quota to run out
  'no_plan_reading', // the chat's Claude is on an API key, signed out, or has no reading yet
  'stale_reading', // the reading is older than `maxReadingAgeMin`
  'above_threshold',
  'not_idle', // a turn is running: the move waits for the boundary
  'busy', // an approval is open, a message is queued or an agent is running: the move would drop it (waits, then becomes a card)
  'paused', // "Later", an Undo, or the minimum pause
  'session_cap',
  'day_cap',
  'no_destination', // no Claude can take the chat now (a warning only: nothing moves)
  'destination_busy', // every candidate already carries `maxPerDestination` sessions
  'not_signed_in',
  'owner_denied', // the session's owner may no longer operate it, or may not use that Claude: nothing moves
  'move_failed', // the Move flow refused or did not finish; the chat stays where it was
  'pace_under', // D-39: at the threshold, but the projected use at the reset is under `paceMinPct`: the chat stays (a move stops its agents)
  'folder_untrusted', // the Move flow refused because the chat's folder needs trusting again (its project settings changed)
] as const;
export type AutoRefusal = (typeof AUTO_REFUSALS)[number];

/** A Claude as the cards name it. */
export interface AutoClaudeRef {
  id: string;
  name: string;
  /** The model family the chat runs on there when the move changes it (`sonnet`); absent or null: the model stays. A ref with the
   * chat's own Claude and a model is a model change in place (no move, no handoff). */
  model?: string | null;
}

/** Which limit a decision is about: `shared` stops every model on that Claude (the session, the week); `model` stops only one model. */
export interface AutoLimit {
  key: string;
  label: string;
  kind: 'shared' | 'model';
}

/** The facts behind a suggestion or a move, each with its basis. */
export interface AutoFacts {
  /** Percent left of the fullest limit that stops the source Claude. Measured. */
  leftPct: Figure;
  thresholdPct: number;
  /** When that limit resets. Measured (a time Claude Code reported). */
  resetsAt: Figure<string>;
  /** `projection` only: where it is heading at its pace, and when it runs out. Estimates. */
  projectedPct?: Figure;
  etaAt?: Figure<string>;
  /**
   * The destination's percent left, when it has plan limits: over the limits that would stop the chat there (its model's and the shared ones).
   * Unavailable (with why) when its usage is unknown (T-255): such a Claude is chosen only when no measured one qualifies, and the chat is
   * watched there (a limit answer moves it on at once).
   */
  destLeftPct?: Figure;
  /** The limit that is low on the source, and whether it stops every model or only the chat's. */
  limit?: AutoLimit;
  /**
   * D-39, with `respectPace`: how the pace rule judged a chat at the threshold. `over`: projected at least `paceMinPct` at the reset (it
   * moves); `under`: projected below it (it stays); `unavailable`: no confident projection (a short span, one reading), so the threshold
   * rule alone decided. `projectedPct` is that projection when there is one.
   */
  pace?: { verdict: 'over' | 'under' | 'unavailable'; minPct: number };
}

export const AUTO_SUGGESTION_STATES = ['open', 'moved', 'later', 'always', 'expired', 'superseded'] as const;
export type AutoSuggestionState = (typeof AUTO_SUGGESTION_STATES)[number];

/** The card of `ask` mode: one at a time per chat. */
export interface AutoSuggestion {
  /** `sug_` + 12 hex. */
  id: string;
  sessionId: string;
  at: string;
  reason: AutoReason;
  from: AutoClaudeRef;
  to: AutoClaudeRef;
  /** Other eligible Claudes, best first, for the "Other…" choice. */
  alternatives: AutoClaudeRef[];
  facts: AutoFacts;
  /** `ask`: the Claude it leaves writes a handoff first. `skip`: it cannot (used up), so the move carries the stored conversation. */
  handoff: 'ask' | 'skip';
  /** What the move drops (`ChatSwitchOptions.dropped`): the card says it in one line when any is not zero. */
  dropped: { approvals: number; queued: number; agents: number };
  state: AutoSuggestionState;
}

/**
 * `waiting`: no Claude to move to (or a cap or pause holds the chat) while the source is at or under the threshold: the engine looks again
 * every `AUTO_CONSTANTS.waitRecheckMin` minutes by itself (T-105). `resumed`: that wait ended (a move, or the source recovered). `steered`:
 * the chat was told, mid-turn, to finish its step and stop so it can be moved. `continued`: after an automatic move the chat was told to
 * go on. `dry_run`: what the engine would have done with `automove.dryRun` on.
 */
export const AUTO_EVENT_KINDS = ['suggested', 'moved', 'declined', 'deferred', 'warned', 'refused', 'failed', 'undone', 'mode_set', 'waiting', 'resumed', 'steered', 'continued', 'dry_run'] as const;
export type AutoEventKind = (typeof AUTO_EVENT_KINDS)[number];

/** One row of the trail (`GET AUTOTRANSFER_API.events`); the same facts go to the platform audit. Kept 90 days. */
export interface AutoTransferEvent {
  id: number;
  at: string;
  /** The session's owner: the person the event is about and the one who hears of it. */
  userId: string;
  sessionId: string;
  workspaceId: string;
  kind: AutoEventKind;
  /** The mode in force when it happened. */
  mode: AutoMode;
  reason: AutoReason | null;
  from: AutoClaudeRef | null;
  to: AutoClaudeRef | null;
  facts: AutoFacts | null;
  handoff: 'ask' | 'skip' | null;
  /** The move's id in the transcript (`ChatTransferContext.handoffId`), so the divider "Moved to ..." can carry the "auto" mark and the Undo. */
  handoffId: string | null;
  /** Why it was refused, deferred or failed. */
  code: AutoRefusal | null;
  /** `portal:autotransfer`, or `ui` for an answer a person gave. */
  actor: string;
}

/** `GET AUTOTRANSFER_API.session(id)`: what the chat's page needs. */
export interface AutoSessionState {
  sessionId: string;
  /** This chat's own mode, or null to follow the global one. */
  mode: AutoMode | null;
  effectiveMode: AutoMode;
  /** Whether the feature can act on this chat at all, and if not why (`pooled`, `no_plan_reading`). */
  applicable: boolean;
  why: AutoRefusal | null;
  /** The open suggestion: the card above the composer. */
  pending: AutoSuggestion | null;
  /** No move by itself before this time (after "Later", an Undo, or a move). */
  pausedUntil: string | null;
  movesToday: number;
  /** The last automatic move of this chat within a day, with whether it can be undone now. */
  lastMove: { event: AutoTransferEvent; undo: { ok: boolean; reason: string | null } } | null;
  /**
   * The chat is at or under the threshold and nothing can take it yet (T-105 R3): why, since when, and the soonest moment a delegated
   * Claude or the source frees up (the earliest reset among their binding windows; null when none is known). The engine looks again by itself.
   */
  waiting: { since: string; code: AutoRefusal; nextFreeAt: string | null } | null;
  /** A move decided while the chat works: it happens when this turn ends (the chat was told to finish its step and stop). */
  pendingMove: { to: AutoClaudeRef; reason: AutoReason; steeredAt: string | null } | null;
}

/** `GET AUTOTRANSFER_API.state`: what the engine waits for, per live chat of the caller (T-105 item 5). */
export interface AutoEngineState {
  dryRun: boolean;
  sessions: { sessionId: string; workspaceId: string; claudeId: string; state: string; leftPct: number | null; last: { act: string; code: string | null } | null; waiting: AutoSessionState['waiting']; pendingMove: AutoSessionState['pendingMove'] }[];
}

export interface SetAutoSessionRequest {
  /** Null: follow the global mode. */
  mode: AutoMode | null;
}

export const AUTOTRANSFER_API = {
  /** GET: `{ platform: AutoTransferSettings, prefs: AutoUserPrefs, effective: AutoTransferSettings, claudes: AutoClaudeConfig[] }` for the caller. The platform values change through the Settings page (an admin's; `PUT /api/settings/:key`). */
  settings: '/api/autotransfer',
  /** PUT `AutoUserPrefs`: the caller's own choices; `{ prefs, effective }`. */
  prefs: '/api/autotransfer/prefs',
  /** PUT `UpdateAutoClaudeRequest`: `AutoClaudeConfig`. */
  claude: (claudeId: string) => `/api/autotransfer/claudes/${encodeURIComponent(claudeId)}`,
  /** GET: `AutoEngineState`, what the engine waits for per live chat of the caller. */
  state: '/api/autotransfer/state',
  /** GET: `AutoSessionState`. PUT `SetAutoSessionRequest`: `AutoSessionState`. */
  session: (sessionId: string) => `/api/autotransfer/sessions/${encodeURIComponent(sessionId)}`,
  /** POST `{ to?: string }`: Move now (the suggestion's Claude, or another of its alternatives); `AutoSessionState`. The card is the confirmation. */
  move: (suggestionId: string) => `/api/autotransfer/suggestions/${encodeURIComponent(suggestionId)}/move`,
  /** POST: Later; the suggestion is held back `AUTO_CONSTANTS.laterMin` minutes. */
  later: (suggestionId: string) => `/api/autotransfer/suggestions/${encodeURIComponent(suggestionId)}/later`,
  /** POST: set THIS chat's mode to `auto` (not the global one), and move now. */
  always: (suggestionId: string) => `/api/autotransfer/suggestions/${encodeURIComponent(suggestionId)}/always`,
  /** GET `?session=&kind=moved,undone&limit=&before=`: `AutoTransferEvent[]` (the caller's), newest first; `kind` keeps only those kinds. */
  events: '/api/autotransfer/events',
  /** GET `?model=`: `AutoLeaving`, the Claudes of the caller that auto move would leave now, by the one projection rule (T-460). */
  leaving: '/api/autotransfer/leaving',
} as const;

/** `GET AUTOTRANSFER_API.leaving` (T-460): per Claude, whether auto move would leave it now for a chat on `model`; a caller never starts work where this is true. */
export interface AutoLeaving {
  claudes: { claudeId: string; claudeName: string; workspaceId: string; leaves: boolean; thresholdPct: number }[];
}
