// btw: a side question inside a chat session (docs/prd/chat-sessions.md §20). The person asks one question about the session so far; a SEPARATE
// Claude Code run with every tool off answers it once, from the session's redacted transcript up to that moment. It never touches the session:
// not its running turn, its queue, its counters, its transcript or Claude's context. The answer is a temporary card; "Pin" copies the question and
// answer into the transcript as a card Claude never sees.
//
// Transport: the existing chat socket (CHAT_SOCKET_PATH), nothing new. The tab sends `btw_ask`, `btw_cancel`, `btw_close` and `btw_pin`
// (ChatClientMessage); the portal sends `btw` (the whole state of one btw: at the start, at every change, at the end, and again when a tab
// subscribes) and `btw_delta` (streamed answer text) to the ASKING person's tabs only, never to everyone subscribed to the session
// (docs/prd/multi-user.md: a btw belongs to the person who asked). A refusal that creates no btw (malformed, not allowed, no such session)
// comes back as an `ack` with `ok: false` keyed by the btw id.
//
// Honesty: every number a btw reports is an ESTIMATE (the CLI's own list-price arithmetic, never the bill, and for a plan never the quota used).

import type { Verb } from './authz.js';

/** The chat command that starts one. The composer offers it when the text starts with "/". */
export const BTW_COMMAND = '/btw';

/** A question longer than this is refused (`VALIDATION_FAILED`); the answer is cut here with a mark. */
export const BTW_QUESTION_MAX = 2_000;
export const BTW_ANSWER_MAX = 12_000;

/** `running` until it ends; then one of the other three. */
export const BTW_STATUSES = ['running', 'answered', 'failed', 'cancelled'] as const;
export type BtwStatus = (typeof BTW_STATUSES)[number];

/**
 * Why a btw did not give an answer (`status: 'failed'`). Codes, not sentences: the card says one short line from {@link BTW_REASON_TEXT} (the
 * wording of the person's language is the UI's) and never shows raw API text.
 *
 * - `rate_limit` the portal's own limit for this session (N a window): `retryAfterMs` says when one more may start.
 * - `busy` one side question per session at a time: another is still running.
 * - `no_quota` the Claude's plan or the portal's budget has nothing left (Anthropic's usage limit, or a paused budget).
 * - `api_limit` Anthropic rate-limited the call (HTTP 429): a short wait helps.
 * - `signed_out` the session's Claude is not signed in, or its credential was refused (401, 403).
 * - `overloaded` Anthropic is overloaded or failing (529, 5xx).
 * - `timeout` it took longer than the time limit.
 * - `workspace` the workspace is not running, or Claude Code can't be run in it.
 * - `unsafe` the run reported a tool, an MCP server or a hook it should not have: its answer is dropped (a guard that should never fire).
 * - `empty` the run finished without an answer.
 * - `disabled` the admin turned side questions off.
 * - `error` anything else; the portal's log has the detail.
 */
export const BTW_REASONS = ['rate_limit', 'busy', 'no_quota', 'api_limit', 'signed_out', 'overloaded', 'timeout', 'workspace', 'unsafe', 'empty', 'disabled', 'error'] as const;
export type BtwReason = (typeof BTW_REASONS)[number];

/** The default one-line wording of each reason (UI text diet: a short sentence, no raw API text). A UI may shorten or translate it. */
export const BTW_REASON_TEXT: Record<BtwReason, string> = {
  rate_limit: 'Too many side questions. Wait a moment.',
  busy: 'One side question at a time.',
  no_quota: 'No quota left on this Claude.',
  api_limit: 'Rate limited. Try again soon.',
  signed_out: 'This Claude is signed out.',
  overloaded: 'Claude is busy. Try again.',
  timeout: 'Took too long.',
  workspace: 'The workspace is not reachable.',
  unsafe: 'Stopped: tools were not off.',
  empty: 'No answer came back.',
  disabled: 'Side questions are off.',
  error: 'Something went wrong.',
};

/**
 * What a btw used. ALWAYS an estimate: `costUsd` is Claude Code's list-price arithmetic for the run (`basis: 'reported'`), or the portal's guess from
 * the size of what it sent (`basis: 'estimated'`, before the run reports, or when it did not); it is not the bill and, on a plan, not the quota used.
 */
export interface BtwUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** null when neither the run nor the portal can say. */
  costUsd: number | null;
  /** Always true: the UI labels the numbers as estimates (a "≈" and an InfoTip). */
  estimate: true;
  basis: 'reported' | 'estimated';
}

/** What the answer was given from. */
export interface BtwContext {
  /** Chat messages (yours and Claude's) in what Claude saw, and whether older ones were left out to keep it within the limit. */
  messages: number;
  truncated: boolean;
  /** The session's newest stored event when it was cut: nothing after it was seen. */
  lastSeq: number;
  /** Characters sent after redaction: the transcript and the question, with their tags (the fixed instructions are not counted). */
  chars: number;
}

/** The whole state of one btw, as the asking person's tabs get it. */
export interface ChatBtw {
  /** The id the tab chose when it asked (a UUID); unique per person and session. */
  id: string;
  /** The session's current id (a folded session's old id resolves to it). */
  session: string;
  /** As asked: trimmed, at most {@link BTW_QUESTION_MAX}. */
  question: string;
  status: BtwStatus;
  /** The answer so far while `running` (what the `btw_delta`s added), the whole answer when `answered`; redacted, plain text or the markdown the chat renders. */
  answer: string;
  /** Why it failed: only with `status: 'failed'`. */
  reason?: BtwReason;
  /** One short plain sentence when the reason needs one ("Try again in 40 s"); never raw API text. */
  note?: string;
  /** With `rate_limit` and `api_limit`: milliseconds until a retry can work. */
  retryAfterMs?: number;
  askedAt: string;
  /** When it ended. */
  settledAt?: string;
  /** The model that answered. */
  model?: string;
  context?: BtwContext;
  usage?: BtwUsage;
  /** The transcript card it was pinned as (its event's `seq`). */
  pinnedSeq?: number;
  /** The person closed the card: tabs drop it; it is no longer sent when a tab subscribes. */
  closed?: boolean;
}

/** What a pinned btw is in the transcript: a `system` event with this field (and `text` as the plain fallback for a UI that doesn't know it). */
export interface ChatPinnedBtw {
  id: string;
  question: string;
  answer: string;
  model?: string;
  askedAt: string;
  usage?: BtwUsage;
  /** Who asked, as an actor string (`user:<id>`): a shared session shows whose side question it was. */
  askedBy: string;
}

/* ---------- Socket: browser → portal (added to ChatClientMessage) ---------- */

/** Ask. `btw` is the tab's new UUID (a retry with the same id never asks twice). Starts a run unless refused: the answer is a `btw` message either way. */
export interface BtwAsk {
  type: 'btw_ask';
  session: string;
  btw: string;
  question: string;
}
/** Stop a running one. The card stays, `cancelled`, and "Ask again" is a new `btw_ask`. */
export interface BtwCancel {
  type: 'btw_cancel';
  session: string;
  btw: string;
}
/** Close the card: stops it when still running, and the portal stops sending it. */
export interface BtwClose {
  type: 'btw_close';
  session: string;
  btw: string;
}
/** Pin an answered btw to the transcript as one card. Only what the portal kept is pinned (never text from the tab); once per btw. Answered with an `ack` keyed by `uuid`, then the card arrives as a stored event. */
export interface BtwPin {
  type: 'btw_pin';
  session: string;
  btw: string;
  uuid: string;
}
export type BtwClientMessage = BtwAsk | BtwCancel | BtwClose | BtwPin;

/* ---------- Socket: portal → browser (added to ChatServerMessage) ---------- */

export type BtwServerMessage =
  /** The whole state of one btw; replaces what the tab has. Sent at the start, at every change and the end, and for each open one when a tab subscribes. */
  | { type: 'btw'; session: string; item: ChatBtw }
  /** Answer text as it streams: append `text` to the card's answer. `seq` counts from 1 per btw so a gap is visible; the final `btw` message has the whole answer. */
  | { type: 'btw_delta'; session: string; btw: string; text: string; seq: number };

/* ---------- Usage ---------- */

/** The `kind` a side question's row carries in the usage metrics (`chat_usage.kind`); a turn's is `turn`. Reports that add everything up include it; one that splits shows it as "Side questions". */
export const BTW_USAGE_KIND = 'side';

/** The right a btw needs on its session: it reads the session (an answer is built from its transcript) and spends its Claude's quota, so it takes `operate`, like sending a message. */
export const BTW_REQUIRED_LEVEL: Verb = 'operate';
