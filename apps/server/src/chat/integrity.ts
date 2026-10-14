import { createHash } from 'node:crypto';
import type { ControlResponse } from './protocol.js';

/**
 * The integrity checks' accepted cases (chat-sessions PRD §10.4, T-136): the ONLY lines Claude Code writes that the controller believes
 * without the portal having sent them, each with what it rests on (the raw stream it was observed in) and its negative twin, which must
 * still end the session. The tests read this table: every entry has a positive and a negative fixture, built at runtime (integrity.test.ts).
 * Anything not listed here, or listed but without its evidence in the stream, ends the session. Nothing here loosens a check for input
 * the portal did not send: each case is a line Claude Code makes itself, tied to something this process did that the portal saw.
 */
export interface IntegrityCase {
  /** A stable name, used by the tests to find the case's fixtures. */
  id: string;
  /** Which line it is. */
  line: string;
  /** When it is accepted. */
  rule: string;
  /** What it rests on: what the real stream showed. */
  evidence: string;
  /** The twin that still ends the session. */
  negative: string;
}

export const INTEGRITY_CASES: readonly IntegrityCase[] = [
  {
    id: 'replay-task-notification',
    line: 'a replayed user line with origin {kind: "task-notification", producer: "session-task"}',
    rule: 'always: Claude Code reports a background command it started finishing',
    evidence: 'Claude Code 2.1.296: every background Bash command that finished wrote this line with a fresh uuid, then a turn of its own',
    negative: 'any other producer (mcp, none), any other kind (channel), or no origin at all',
  },
  {
    id: 'replay-peer',
    line: 'a replayed user line with origin {kind: "peer", senderTaskId, body}',
    rule:
      'only when, within PEER_CAUSE_MS before it, THIS process showed a SendMessage tool use by that same sub-agent (its agent_id equals ' +
      'senderTaskId, and the task ran in this process), the tool result of exactly that call said "Message queued for the main ' +
      'conversation\'s next turn.", and the message text equals the body; each cause is used once',
    evidence:
      'orchestrator fdb140be, 2026-10-13 15:45 (raw out.1.jsonl): assistant line {parent_tool_use_id: <Agent call>, agent_id: <task>, ' +
      'tool_use SendMessage {to: "main", message}} -> user line {tool_result for that call: {"success":true,"message":"Message queued for ' +
      'the main conversation\'s next turn."}} -> system/init -> user line {isReplay, origin: {kind: "peer", from, senderTaskId, name, body}} ' +
      'with body identical to the message; the portal ended the session there',
    negative: 'a peer line with no SendMessage before it, with another body, from another task, after the window, or a second time',
  },
  {
    id: 'replay-local-command',
    line: 'a replayed user line holding local command output (<local-command-stdout>) under an id of its own',
    rule: 'only while one of the portal\'s own slash commands (/compact, …) runs',
    evidence: '/compact echoes "Compacted" this way',
    negative: 'the same line while no slash command of the portal runs',
  },
  {
    id: 'replay-model-note',
    line: 'a replayed "Set model to …" local command line',
    rule: 'only within MODEL_NOTE_MS after the portal asked for a model change',
    evidence: 'Claude Code echoes set_model this way',
    negative: 'the same line when the portal asked for no model change',
  },
  {
    id: 'command-harness-started',
    line: 'a command_lifecycle "started" for a uuid the portal never sent (and the rest of that command\'s lifecycle)',
    rule: 'only when a sub-agent or background task ran in the current process (chat_tasks since the process start); T-99',
    evidence: 'Konfersi session, 2026-10-13 12:50: a role sub-agent finished, then started with no queued and no replayed line, then system/init',
    negative: 'the same line in a process that ran no task, or a "queued" state for an unknown uuid',
  },
  {
    id: 'control-duplicate',
    line: 'a second control_response for a request the portal asked, or for an answer it gave',
    rule: 'ignored and logged only when its content is identical to the first one read for that id',
    evidence:
      'orchestrator fe3df8bc, 2026-10-13: ended "a second control response for request …"; no request id appears twice in any raw ' +
      'out.*.jsonl on the dev workspace, so the second copy was the same line read again, not a second answer',
    negative: 'a second response with different content, or a response for an id the portal never asked or answered',
  },
  {
    id: 'control-replay-undigested',
    line: 'a second control_response for a request the portal asked (or an answer it gave) and completed before T-136, whose first copy kept no digest',
    rule:
      'ignored and logged only when it is a success whose body is one the portal\'s own requests produce (sameAnswer): empty (set_model, ' +
      'interrupt, apply_flag_settings, stop_task, cancel_async_message), {mode} for a mode the portal set or expects on this session ' +
      '(set_permission_mode), or only the keys get_settings, list_models or get_usage reply with; for an answer the portal gave, a ' +
      '{behavior} that is the outcome it recorded (allow, deny)',
    evidence:
      'orchestrator 5c9fcb5f, 2026-10-13 17:58 (raw out.1.jsonl): line 1, the set_permission_mode reply {mode: "bypassPermissions"} of ' +
      '15:46 (asked before migration 771, so no digest), read again when the follower replayed the file from byte 0 (T-265); the id ' +
      'appears once in the file, and the portal ended the session on it',
    negative:
      'a different mode, an error reply, a body of another shape, an echo whose behavior is not the recorded outcome, or an id the ' +
      'portal never asked or answered',
  },
];

/** What the portal knows of a completed control line whose first response kept no digest (asked before migration 771). */
export type ControlExpectation = { kind: 'asked'; modes: readonly string[] } | { kind: 'answered'; outcome: string | null };

/** The keys of the replies the portal's own requests read (Claude Code 2.1.296): get_settings, list_models, get_usage. */
const REPLY_KEYS: readonly (readonly string[])[] = [['applied'], ['models'], ['session', 'subscription_type', 'rate_limits_available', 'rate_limits', 'behaviors']];

/**
 * Whether a second response for a control line that kept no digest is the same answer by shape (INTEGRITY_CASES
 * `control-replay-undigested`): a success, with a body the portal's own request can have produced, and for an echo of the portal's
 * answer, the behavior it recorded. Anything else is a different answer.
 */
export function sameAnswer(reply: ControlResponse, expect: ControlExpectation): boolean {
  if (!reply.ok) return false;
  const body = reply.response;
  const keys = Object.keys(body);
  if (expect.kind === 'answered') {
    const behavior = body.behavior;
    if (behavior === 'allow') return expect.outcome === 'allowed_once' || expect.outcome === 'allowed_session';
    if (behavior === 'deny') return expect.outcome === 'denied';
    return false;
  }
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === 'mode') return typeof body.mode === 'string' && expect.modes.includes(body.mode);
  return REPLY_KEYS.some((shape) => keys.every((k) => shape.includes(k)));
}

/** How long after a sub-agent's SendMessage was queued its peer line may arrive (observed: the same second). */
export const PEER_CAUSE_MS = 120_000;

/** What a sub-agent's SendMessage result says when the message waits for the main conversation (observed, Claude Code 2.1.296). */
export const PEER_QUEUED_MESSAGE = "Message queued for the main conversation's next turn.";

/** One sub-agent SendMessage this process showed: who sent it and a digest of its text (never the text). */
export interface PeerCause {
  toolUseId: string;
  taskId: string;
  digest: string;
  at: number;
  queued: boolean;
}

/** A digest of a control response as parsed (its id, outcome and body), so a second copy can be compared with the first. */
export function controlDigest(reply: unknown): string {
  return createHash('sha256').update(JSON.stringify(reply)).digest('hex');
}

/** A digest of a message's text (a sub-agent's SendMessage, a peer line's body): compared, never kept as text. */
export function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ---------- What an integrity ending was for (T-136 slice 2, recover in place) ---------- */

/**
 * The cases an integrity ending is recorded under (`chat_sessions.ended_for`), and whether each is HARMLESS: a near miss of an accepted
 * case above, where the line still came from this process's own machinery. Only a harmless ending may be recovered by an agent (the MCP
 * tool, the supervisor); a suspicious one needs a person, after a sheet that shows the origin and this classification. Default suspicious.
 */
export const ENDING_CASES = {
  /** A peer line from a sub-agent that ran in THIS process, whose SendMessage cause was not matched (the window, the body): `replay-peer`'s near miss. */
  'replay-peer': { classified: 'harmless', origin: 'a sub-agent of this process' },
  /** The same control response read twice by the portal before T-265 healed the follower (5c9fcb5f, fe3df8bc): `control-duplicate`. Legacy rows only. */
  'control-duplicate': { classified: 'harmless', origin: 'the portal read the same line twice' },
  'replay-peer-unknown': { classified: 'suspicious', origin: 'peer: not a task of this process' },
  'replay-unknown': { classified: 'suspicious', origin: 'unknown origin' },
  'command-unknown': { classified: 'suspicious', origin: 'a command this portal never sent' },
  'control-different': { classified: 'suspicious', origin: 'a different control answer' },
  'control-unknown': { classified: 'suspicious', origin: 'a control answer for an id never asked' },
  'request-duplicate': { classified: 'suspicious', origin: 'a tool request id seen twice' },
  'session-id': { classified: 'suspicious', origin: 'another Claude Code session' },
  'mode-bypass': { classified: 'suspicious', origin: 'Bypass the portal did not enter' },
  'mode-changed': { classified: 'suspicious', origin: 'a mode the portal did not set' },
  unknown: { classified: 'suspicious', origin: 'unclassified' },
} as const satisfies Record<string, { classified: 'harmless' | 'suspicious'; origin: string }>;

export type EndingCase = keyof typeof ENDING_CASES;

/** What is stored with an integrity ending: the case, the classification, the origin in words, and whether the session was in Bypass. */
export interface EndingRecord {
  case: EndingCase;
  classified: 'harmless' | 'suspicious';
  origin: string;
  bypass: boolean;
}

export function endingRecord(c: EndingCase, o: { origin?: string; bypass: boolean }): EndingRecord {
  const d = ENDING_CASES[c] ?? ENDING_CASES.unknown;
  return { case: c, classified: d.classified, origin: o.origin ?? d.origin, bypass: o.bypass };
}

/**
 * The record of an ending as stored, or, for a row that ended before slice 2 (none stored), read from its reason: only the pre-T-265
 * "a second control response" (the same line read twice; evidence on T-136 and T-265) is harmless; every other legacy reason is
 * suspicious. Null when the row did not end for integrity.
 */
export function readEnding(endedReason: string | null | undefined, stored: string | null | undefined): EndingRecord | null {
  if (!endedReason?.startsWith('integrity: ')) return null;
  if (stored) {
    try {
      const v = JSON.parse(stored) as Partial<EndingRecord>;
      if (v && typeof v.case === 'string' && v.case in ENDING_CASES) return endingRecord(v.case as EndingCase, { origin: typeof v.origin === 'string' ? v.origin.slice(0, 80) : undefined, bypass: v.bypass === true });
    } catch {
      // unreadable: classified from the reason below
    }
  }
  const why = endedReason.slice('integrity: '.length);
  if (/^a second control response for request \S+$/.test(why)) return endingRecord('control-duplicate', { bypass: false });
  if (/^a message this portal didn't send reached Claude Code/.test(why)) return endingRecord('replay-unknown', { bypass: false });
  if (/^Claude Code queued a message this portal didn't send/.test(why)) return endingRecord('command-unknown', { bypass: false });
  if (/^a tool request id arrived twice/.test(why)) return endingRecord('request-duplicate', { bypass: false });
  return endingRecord('unknown', { bypass: false });
}
